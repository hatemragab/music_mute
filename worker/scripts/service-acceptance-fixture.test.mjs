import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAcceptanceFixture } from "./service-acceptance-fixture.mjs";

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "musicmute-acceptance-"));
  const credential = randomBytes(32).toString("base64url");
  const input = Buffer.from("synthetic test audio");
  const outputPath = join(directory, "result");
  let enabled = false;
  const fixture = createAcceptanceFixture({
    config: { machineId: randomUUID() },
    credential,
    input,
    outputPath,
    recipes: ["kim-vocals-v2", "kim-vocals-v2-trim"].map((recipeId) => ({
      recipeId,
      recipeDigest: "a".repeat(64),
      modelDigest: "b".repeat(64),
    })),
    claimsEnabled: () => enabled,
    ...options,
  });
  fixture.server.listen(0, "127.0.0.1");
  await once(fixture.server, "listening");
  t.after(async () => {
    await new Promise((resolve) => {
      fixture.server.close(resolve);
      fixture.server.closeAllConnections();
    });
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${fixture.server.address().port}`;
  const request = async (path, body, authenticated = true) => {
    const response = await fetch(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${credential}` } : {}),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const session = { session_id: randomUUID(), incarnation: randomUUID() };
  assert.equal((await request("/worker/sessions", session)).status, 200);
  const slots = await Promise.all(
    [0, 1].map(async (slot_index) => {
      const slot = {
        ...session,
        worker_id: randomUUID(),
        slot_index,
        gpu_id: "gpu0",
      };
      assert.equal((await request("/worker/slots", slot)).status, 200);
      return slot;
    }),
  );
  return {
    ...fixture,
    input,
    outputPath,
    request,
    slots,
    credential,
    enable: () => {
      enabled = true;
    },
  };
}

test("two-slot fixture gates claims, authenticates, and replays the same attempt", async (t) => {
  const f = await setup(t);
  assert.equal(
    (await f.request("/worker/config", undefined, false)).status,
    401,
  );
  assert.equal((await f.request("/worker/config")).body.claim_allowed, false);
  const request = { ...f.slots[0], request_id: randomUUID() };
  assert.equal((await f.request("/worker/claims", request)).body.claim, null);
  f.enable();
  assert.equal((await f.request("/worker/claims", request)).body.claim, null);
  const claims = [];
  for (const slot of f.slots) {
    const body = { ...slot, request_id: randomUUID() };
    const first = await f.request("/worker/claims", body);
    const replay = await f.request("/worker/claims", body);
    assert.equal(first.status, 200);
    assert.equal(replay.body.claim.attempt_id, first.body.claim.attempt_id);
    assert.equal(replay.body.claim.replayed, true);
    claims.push(first.body.claim);
  }
  assert.notEqual(claims[0].attempt_id, claims[1].attempt_id);
  assert.equal(f.snapshot().maxActiveAttempts, 2);
  assert.equal((await f.request("/worker/config")).body.claim_allowed, false);
  const evidence = await readFile(`${f.outputPath}.evidence.json`, "utf8");
  assert.ok(!evidence.includes(f.credential));
  assert.ok(!evidence.includes("?grant="));
});

test("fixture verifies transfer capabilities, conditional checksummed uploads, and completion", async (t) => {
  const f = await setup(t);
  f.enable();
  const owner = { ...f.slots[0], request_id: randomUUID() };
  const {
    body: { claim },
  } = await f.request("/worker/claims", owner);
  const path = `/worker/attempts/${claim.attempt_id}`;
  const complete = {
    ...owner,
    version_id: "acceptance-output-0-v1",
    recipe_id: claim.recipe.recipe_id,
    recipe_digest: claim.recipe.recipe_digest,
    model_digest: claim.recipe.model_digest,
  };
  assert.equal((await f.request(`${path}/completions`, complete)).status, 409);
  assert.equal(
    (
      await f.request(`${path}/input-grants`, {
        ...f.slots[1],
        request_id: randomUUID(),
      })
    ).status,
    409,
  );
  const input = await f.request(`${path}/input-grants`, owner);
  assert.equal(
    (await fetch(input.body.grant.url.replace(/grant=.*/u, "grant=wrong")))
      .status,
    403,
  );
  assert.deepEqual(
    Buffer.from(await (await fetch(input.body.grant.url)).arrayBuffer()),
    f.input,
  );
  await f.request(`${path}/progress-events`, {
    ...owner,
    sequence: 1,
    phase: "separating",
  });
  assert.equal(typeof f.snapshot().jobs[0].separationObservedAtMs, "number");
  const output = Buffer.from("synthetic MP3 bytes");
  const sha256 = createHash("sha256").update(output).digest("base64");
  const grant = (
    await f.request(`${path}/output-grants`, {
      ...owner,
      bytes: output.length,
      sha256,
      measured_duration_seconds: 12,
    })
  ).body.grant;
  assert.equal(
    (await fetch(grant.url, { method: "PUT", body: output })).status,
    400,
  );
  assert.equal(
    (
      await fetch(grant.url, {
        method: "PUT",
        headers: grant.headers,
        body: Buffer.alloc(output.length),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(grant.url, {
        method: "PUT",
        headers: grant.headers,
        body: output,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(grant.url, {
        method: "PUT",
        headers: grant.headers,
        body: output,
      })
    ).status,
    412,
  );
  assert.equal(
    (
      await f.request(`${path}/completions`, {
        ...complete,
        model_digest: "wrong",
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.request(`${path}/completions`, complete)).body.status,
    "ready",
  );
  assert.equal(
    (await f.request(`${path}/completions`, complete)).body.replayed,
    true,
  );
  assert.deepEqual(await readFile(`${f.outputPath}.0.mp3`), output);
  assert.equal(f.snapshot().jobs[0].upload.sha256, sha256);
});

test("corrupt-input fixture preserves advertised checksum and records worker failure", async (t) => {
  const f = await setup(t, { corruptInputSlot: 0 });
  f.enable();
  const owner = { ...f.slots[0], request_id: randomUUID() };
  const {
    body: { claim },
  } = await f.request("/worker/claims", owner);
  const path = `/worker/attempts/${claim.attempt_id}`;
  const input = (await f.request(`${path}/input-grants`, owner)).body;
  const downloaded = Buffer.from(
    await (await fetch(input.grant.url)).arrayBuffer(),
  );
  assert.notEqual(
    createHash("sha256").update(downloaded).digest("base64"),
    input.object.sha256,
  );
  assert.equal(
    (
      await f.request(`${path}/failures`, {
        ...owner,
        code: "INPUT_CHECKSUM_MISMATCH",
      })
    ).body.status,
    "failed",
  );
  assert.equal(f.snapshot().jobs[0].failureCode, "INPUT_CHECKSUM_MISMATCH");
  assert.equal(f.snapshot().jobs[0].upload, null);
});

test("cancellation is issued through an owned lease after separation and prevents publication", async (t) => {
  const f = await setup(t, { cancelOnSeparationSlot: 0 });
  f.enable();
  const owner = { ...f.slots[0], request_id: randomUUID() };
  const {
    body: { claim },
  } = await f.request("/worker/claims", owner);
  const path = `/worker/attempts/${claim.attempt_id}`;
  const lease = {
    job_id: claim.job_id,
    attempt_id: claim.attempt_id,
    worker_id: owner.worker_id,
  };
  const renewal = {
    session_id: owner.session_id,
    incarnation: owner.incarnation,
    request_id: randomUUID(),
    leases: [lease],
  };
  assert.equal(
    (await f.request("/worker/leases/renewals", renewal)).body.results[0]
      .disposition,
    "accepted",
  );
  await f.request(`${path}/progress-events`, {
    ...owner,
    sequence: 1,
    phase: "separating",
  });
  const foreign = await f.request("/worker/leases/renewals", {
    ...renewal,
    session_id: randomUUID(),
  });
  assert.equal(foreign.body.results[0].disposition, "revoked");
  assert.equal(f.snapshot().jobs[0].status, "running");
  const result = (await f.request("/worker/leases/renewals", renewal)).body
    .results[0];
  assert.equal(result.disposition, "cancelled");
  assert.equal(result.lease_expires_at, null);
  assert.equal(typeof f.snapshot().jobs[0].cancellationIssuedAtMs, "number");
  assert.equal(f.snapshot().jobs[0].completedAtMs, null);
  assert.equal((await f.request(`${path}/output-grants`, owner)).status, 409);
  assert.equal((await f.request(`${path}/completions`, owner)).status, 409);
  assert.equal(f.snapshot().jobs[0].upload, null);
});

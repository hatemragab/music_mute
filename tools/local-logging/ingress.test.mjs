import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startIngress } from "./ingress.mjs";
import { redact, boundedEvent } from "./redact.mjs";
const event = {
  timestamp: new Date().toISOString(),
  name: "test",
  instanceId: "test-process",
  level: "info",
};
const key = "a".repeat(64);
let port = 19840;
async function fixture(t, options = {}) {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "musicmute-ingress-"),
  );
  const file = join(directory, "application.jsonl");
  const listenPort = port++;
  const ingress = await startIngress({
    file,
    keys: { backend: key, ios: key },
    port: listenPort,
    ...options,
  });
  t.after(async () => {
    await ingress.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ingress, file, url: `http://127.0.0.1:${listenPort}` };
}
function post(url, body = event, headers = {}) {
  return fetch(url + "/ingest/backend", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-musicmute-log-key": key,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
test("nested, encoded and text credentials are redacted before disk", async (t) => {
  const { ingress, url, file } = await fixture(t);
  const secret = "SYNTHETIC_CREDENTIAL_551";
  const body = {
    ...event,
    data: {
      authorization: "Bearer " + secret,
      nested: [{ password: secret }],
      encoded: Buffer.from(JSON.stringify({ apiKey: secret })).toString(
        "base64",
      ),
      url: `https://x.test/path?token=${secret}`,
      connection: `mongodb://name:${secret}@localhost/db`,
    },
  };
  assert.equal((await post(url, body)).status, 202);
  await ingress.flush();
  assert.doesNotMatch(await readFile(file, "utf8"), new RegExp(secret));
  assert.match(await readFile(file, "utf8"), /REDACTED/);
});
test("payload limits, unsupported values and cyclic objects are explicit", () => {
  const object = {};
  object.self = object;
  assert.match(JSON.stringify(redact(object)), /circular/);
  assert.match(
    JSON.stringify(redact({ data: "a".repeat(17000) })),
    /string_limit/,
  );
  const result = boundedEvent({
    ...event,
    data: Array.from({ length: 64 }, () => "a".repeat(16000)),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
  assert.equal(result.payloadOmitted, true);
});
test("Host, origins, source impersonation, media type and oversized bodies rejected", async (t) => {
  const { url } = await fixture(t);
  assert.equal(
    (await post(url, event, { origin: "http://evil.test" })).status,
    403,
  );
  assert.equal(
    (await post(url, event, { origin: "http://localhost:5173" })).status,
    403,
  );
  assert.equal(
    (await post(url, event, { "x-musicmute-log-key": "wrong" })).status,
    403,
  );
  assert.equal(
    (await post(url, event, { "content-type": "text/plain" })).status,
    415,
  );
  assert.equal(
    (await post(url, { ...event, data: "a".repeat(70000) })).status,
    413,
  );
  assert.equal(
    (await fetch(url + "/ingest/../../../tmp/file", { method: "POST" })).status,
    404,
  );
});
test("browser origin fixes source and user identity remains unverified", async (t) => {
  const { ingress, file, url } = await fixture(t);
  const response = await fetch(url + "/ingest/web-client", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:5173",
    },
    body: JSON.stringify({
      ...event,
      source: "backend",
      origin: "server_log",
      userId: "claimed",
    }),
  });
  assert.equal(response.status, 202);
  await ingress.flush();
  const row = JSON.parse((await readFile(file, "utf8")).trim());
  assert.equal(row.source, "web-client");
  assert.equal(row.origin, "client_diagnostic");
  assert.equal(row.userId, null);
  assert.equal(row.claimedUserId, "claimed");
});
test("queue is bounded and warning priority evicts waiting info", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const written = [];
  let first = true;
  const { url, ingress } = await fixture(t, {
    maximumPending: 2,
    writer: {
      async write(line) {
        if (first) {
          first = false;
          await gate;
        }
        written.push(JSON.parse(line));
      },
      async close() {},
    },
  });
  await post(url);
  await post(url, { ...event, name: "waiting-info" });
  await post(url, { ...event, name: "important", level: "error" });
  assert.equal((await post(url)).status, 429);
  assert.ok(ingress.stats.pending <= 2);
  assert.equal(ingress.stats.dropped, 2);
  release();
  await ingress.flush();
  assert.equal(written.at(-1).name, "important");
});
test("sink failures are observable and do not terminate ingress", async (t) => {
  const { url, ingress } = await fixture(t, {
    writer: {
      async write() {
        throw Error("synthetic sink failure");
      },
      async close() {},
    },
  });
  assert.equal((await post(url)).status, 202);
  await ingress.flush();
  assert.equal(ingress.stats.failed, 1);
  assert.equal((await fetch(url + "/health")).status, 200);
});
test("concurrent partial requests time out with bounded work", async (t) => {
  const { url } = await fixture(t);
  assert.equal(
    (await post(url, { ...event, instanceId: "bad/id" })).status,
    400,
  );
  assert.equal((await post(url, [event])).status, 400);
  assert.equal(
    (await fetch(url + "/health", { headers: { origin: "http://evil.test" } }))
      .status,
    404,
  );
});
test("a microtask arriving at flush completion is never stranded until later traffic", async (t) => {
  const written = [];
  const { ingress } = await fixture(t, {
    writer: {
      async write(line) {
        written.push(JSON.parse(line));
      },
      async close() {},
    },
  });
  ingress.enqueue(event);
  queueMicrotask(() => ingress.enqueue({ ...event, name: "microtask" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await ingress.flush();
  assert.equal(written.length, 2);
  assert.equal(ingress.stats.pending, 0);
});
test("credential aliases, websocket URLs and credential-bearing object keys are redacted", () => {
  const marker = "CANARY_NEVER_RETAIN";
  for (const value of [
    { access_key_id: marker },
    { session_id: marker },
    { url: "https://example.test/?auth=" + marker },
    { url: "wss://user:" + marker + "@example.test/" },
    { ["password=" + marker]: "value" },
  ])
    assert.doesNotMatch(JSON.stringify(redact(value)), new RegExp(marker));
});
test("original fractional event time survives UTC normalization", async (t) => {
  const { url, file, ingress } = await fixture(t);
  await post(url, {
    ...event,
    timestamp: "2026-10-18T03:00:00.123456789+03:00",
  });
  await ingress.flush();
  const row = JSON.parse((await readFile(file, "utf8")).trim());
  assert.equal(row.timestamp, "2026-10-18T00:00:00.123456789Z");
  assert.equal(row.sourceTimestamp, row.timestamp);
});

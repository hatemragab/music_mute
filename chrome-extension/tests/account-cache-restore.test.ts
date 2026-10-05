import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  symlink,
  link,
  chmod,
  mkdir,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCOUNT_RESTORE_DEADLINE_MS,
  AccountCacheRestoreQueue,
} from "../src/companion/account-cache-restore.js";
import { withCacheMutation } from "../src/companion/cache-mutator.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(timeout = ACCOUNT_RESTORE_DEADLINE_MS) {
  const root = await mkdtemp(join(tmpdir(), "mm-restore-queue-"));
  roots.push(root);
  const owner = { uid: "fixture-owner", session_generation: randomUUID() },
    request = {
      owner,
      request_id: randomUUID(),
      video_id: "bZxrIoCPsOc",
      duration_seconds: 3,
    };
  const queue = new AccountCacheRestoreQueue(root, { timeout_ms: timeout });
  const recordPath = (id = request.request_id) =>
    join(
      root,
      createHash("sha256").update(owner.uid).digest("hex"),
      id,
      "record.json",
    );
  return { root, owner, request, queue, recordPath };
}
describe("token-free bounded account cache restore queue", () => {
  it("pins the foreground lookup deadline at five seconds", async () => {
    expect(ACCOUNT_RESTORE_DEADLINE_MS).toBe(5_000);
    await expect(fixture(5_001)).rejects.toMatchObject({
      code: "ACCOUNT_RESTORE_UNSAFE",
    });
  });
  it("wakes from one filesystem receipt with no polling and keeps the original deadline during claim", async () => {
    const env = await fixture(),
      pending = await env.queue.stage(env.request);
    expect(pending.expires_at - pending.created_at).toBe(
      ACCOUNT_RESTORE_DEADLINE_MS,
    );
    const controller = new AbortController();
    const wait = env.queue.waitForReceipt(
      env.owner,
      env.request.request_id,
      controller.signal,
      () => true,
    );
    const attempt = await env.queue.claimOne(env.owner);
    expect(attempt?.expires_at).toBe(pending.expires_at);
    expect(await env.queue.claimOne(env.owner)).toBeNull();
    await env.queue.assertActive(attempt!);
    await env.queue.complete(attempt!, {
      state: "ready",
      cache_key: "a".repeat(64),
      job_id: "b".repeat(24),
    });
    await expect(wait).resolves.toMatchObject({
      state: "ready",
      cache_key: "a".repeat(64),
      job_id: "b".repeat(24),
    });
    await expect(
      env.queue.complete(attempt!, { state: "missing" }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await env.queue.hasPending(env.owner)).toBe(false);
    const record = await readFile(env.recordPath(), "utf8");
    for (const secret of [
      "id_token",
      "authorization",
      "https:",
      "source_path",
      "grant",
      "signature",
    ])
      expect(record).not.toContain(secret);
  });
  it("deduplicates one request and refuses changed identity or body", async () => {
    const env = await fixture();
    const first = await env.queue.stage(env.request);
    expect(await env.queue.stage(env.request)).toEqual(first);
    await expect(
      env.queue.stage({ ...env.request, video_id: "abcdefghijk" }),
    ).rejects.toMatchObject({ code: "ACCOUNT_RESTORE_CONFLICT" });
    await expect(
      env.queue.stage({
        ...env.request,
        owner: { ...env.owner, session_generation: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    await expect(
      env.queue.stage({ ...env.request, duration_seconds: 1201 }),
    ).rejects.toMatchObject({ code: "ACCOUNT_RESTORE_UNSAFE" });
    await expect(
      env.queue.stage({
        ...env.request,
        url: "https://private.invalid",
      } as typeof env.request),
    ).rejects.toMatchObject({ code: "ACCOUNT_RESTORE_UNSAFE" });
  });
  it("returns a bounded deadline miss, cancels the ticket and never reclaims an expired attempt", async () => {
    const env = await fixture(500);
    await env.queue.stage(env.request);
    const attempt = await env.queue.claimOne(env.owner);
    const value = await env.queue.waitForReceipt(
      env.owner,
      env.request.request_id,
      new AbortController().signal,
      () => true,
    );
    expect(value).toBeNull();
    await expect(env.queue.assertActive(attempt!)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await expect(
      env.queue.complete(attempt!, {
        state: "ready",
        cache_key: "a".repeat(64),
        job_id: "b".repeat(24),
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await env.queue.claimOne(env.owner)).toBeNull();
    expect(await env.queue.hasPending(env.owner)).toBe(false);
  });
  it("fences a persisted twenty-second active record from an older build instead of poisoning the queue", async () => {
    const env = await fixture();
    const pending = await env.queue.stage(env.request);
    await writeFile(
      env.recordPath(),
      JSON.stringify({
        ...pending,
        expires_at: pending.created_at + 20_000,
      }),
      { mode: 0o600 },
    );
    await expect(env.queue.claimOne(env.owner)).resolves.toBeNull();
    await expect(env.queue.hasPending(env.owner)).resolves.toBe(false);
    expect(JSON.parse(await readFile(env.recordPath(), "utf8"))).toMatchObject({
      state: "cancelled",
      expires_at: pending.created_at + 20_000,
    });
    await writeFile(
      env.recordPath(),
      JSON.stringify({
        ...pending,
        expires_at: pending.created_at + 20_001,
      }),
      { mode: 0o600 },
    );
    await expect(env.queue.claimOne(env.owner)).rejects.toMatchObject({
      code: "ACCOUNT_RESTORE_UNSAFE",
    });
  });
  it("persists cancellation even while another operation owns the queue lock", async () => {
    const env = await fixture();
    await env.queue.stage(env.request);
    const attempt = await env.queue.claimOne(env.owner);
    await withCacheMutation(env.root, async () => {
      await env.queue.cancel(env.owner, env.request.request_id);
      await expect(env.queue.assertActive(attempt!)).rejects.toMatchObject({
        code: "CANCELLED",
      });
    });
    expect(await env.queue.hasPending(env.owner)).toBe(false);
    expect(JSON.parse(await readFile(env.recordPath(), "utf8")).state).toBe(
      "cancelled",
    );
  });
  it("ignores only Finder metadata in an owner namespace", async () => {
    const env = await fixture();
    await env.queue.stage(env.request);
    const ownerRoot = dirname(dirname(env.recordPath()));
    await writeFile(join(ownerRoot, ".DS_Store"), "finder metadata", {
      mode: 0o644,
    });
    await expect(env.queue.claimOne(env.owner)).resolves.toMatchObject({
      state: "restoring",
      request_id: env.request.request_id,
    });
    await env.queue.cancel(env.owner, env.request.request_id);
    await writeFile(join(ownerRoot, ".DS_Store.evil"), "unknown", {
      mode: 0o600,
    });
    await expect(env.queue.hasPending(env.owner)).rejects.toMatchObject({
      code: "ACCOUNT_RESTORE_UNSAFE",
    });
  });
  it("atomically persists concurrent cancellation markers without a partially readable receipt", async () => {
    const env = await fixture();
    await env.queue.stage(env.request);
    const attempt = await env.queue.claimOne(env.owner);
    await Promise.all([
      env.queue.cancel(env.owner, env.request.request_id),
      env.queue.cancel(env.owner, env.request.request_id),
    ]);
    await expect(env.queue.assertActive(attempt!)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect((await readdir(dirname(env.recordPath()))).sort()).toEqual([
      "cancelled.json",
      "record.json",
    ]);
    expect(
      JSON.parse(
        await readFile(
          join(dirname(env.recordPath()), "cancelled.json"),
          "utf8",
        ),
      ).state,
    ).toBe("cancelled");
  });
  it("prunes bounded terminal receipts and removes only owned orphan temporary metadata", async () => {
    const env = await fixture();
    const first = await env.queue.stage(env.request);
    await env.queue.cancel(env.owner, env.request.request_id);
    const ownerRoot = dirname(dirname(env.recordPath()));
    for (let i = 0; i < 127; i++) {
      const request_id = randomUUID(),
        root = join(ownerRoot, request_id);
      await mkdir(root, { mode: 0o700 });
      await writeFile(
        join(root, "record.json"),
        JSON.stringify({ ...first, request_id, state: "missing" }),
        { mode: 0o600 },
      );
    }
    const orphan = join(ownerRoot, randomUUID());
    await mkdir(orphan, { mode: 0o700 });
    await writeFile(
      join(orphan, `.record-${randomUUID()}.tmp`),
      "interrupted metadata",
      { mode: 0o600 },
    );
    await env.queue.stage({ ...env.request, request_id: randomUUID() });
    expect(await readdir(ownerRoot)).toHaveLength(128);
    await expect(readdir(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    const unknown = join(ownerRoot, randomUUID());
    await mkdir(unknown, { mode: 0o700 });
    await writeFile(join(unknown, "unowned.txt"), "preserve", { mode: 0o600 });
    await expect(
      env.queue.stage({ ...env.request, request_id: randomUUID() }),
    ).rejects.toMatchObject({ code: "ACCOUNT_RESTORE_UNSAFE" });
    expect(await readFile(join(unknown, "unowned.txt"), "utf8")).toBe(
      "preserve",
    );
  });
  it.each(["abort", "account"])(
    "fences %s while waiting before any ready receipt",
    async (kind) => {
      const env = await fixture();
      await env.queue.stage(env.request);
      const controller = new AbortController();
      if (kind === "abort") controller.abort();
      await expect(
        env.queue.waitForReceipt(
          env.owner,
          env.request.request_id,
          controller.signal,
          () => kind !== "account",
        ),
      ).rejects.toMatchObject({
        code: kind === "abort" ? "CANCELLED" : "ACCOUNT_CHANGED",
      });
      expect(await env.queue.claimOne(env.owner)).toBeNull();
    },
  );
  it("fences old generations and ignores another owner's pending requests", async () => {
    const env = await fixture();
    await env.queue.stage(env.request);
    expect(
      await env.queue.hasPending({ ...env.owner, uid: "other-owner" }),
    ).toBe(false);
    const latest = { ...env.owner, session_generation: randomUUID() };
    expect(await env.queue.claimOne(latest)).toBeNull();
    expect(await env.queue.hasPending(latest)).toBe(false);
    expect(JSON.parse(await readFile(env.recordPath(), "utf8")).state).toBe(
      "cancelled",
    );
  });
  it("bounds distinct outstanding requests at32 while allowing a new request after cancellation", async () => {
    const env = await fixture();
    for (let i = 0; i < 32; i++)
      await env.queue.stage({
        ...env.request,
        request_id: i === 0 ? env.request.request_id : randomUUID(),
      });
    await expect(
      env.queue.stage({ ...env.request, request_id: randomUUID() }),
    ).rejects.toMatchObject({ code: "ACCOUNT_RESTORE_FULL" });
    await env.queue.cancel(env.owner, env.request.request_id);
    await expect(
      env.queue.stage({ ...env.request, request_id: randomUUID() }),
    ).resolves.toMatchObject({ state: "pending" });
  });
  it.each(["symlink", "hardlink", "permissions", "body"])(
    "refuses unsafe %s receipts without altering the external file",
    async (kind) => {
      const env = await fixture();
      await env.queue.stage(env.request);
      const before = await readFile(env.recordPath()),
        external = join(env.root, "outside.json");
      await writeFile(external, before, { mode: 0o600 });
      if (kind === "permissions") await chmod(env.recordPath(), 0o644);
      else if (kind === "body")
        await writeFile(
          env.recordPath(),
          JSON.stringify({ token: "untrusted" }),
          { mode: 0o600 },
        );
      else {
        await rm(env.recordPath());
        if (kind === "symlink") await symlink(external, env.recordPath());
        else await link(external, env.recordPath());
      }
      await expect(env.queue.claimOne(env.owner)).rejects.toMatchObject({
        code: "ACCOUNT_RESTORE_UNSAFE",
      });
      expect(await readFile(external)).toEqual(before);
    },
  );
});

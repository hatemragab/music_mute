import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalSyncCaptureQueue,
  type LocalSyncCaptureInput,
  type LocalSyncCaptureAttempt,
} from "../src/companion/local-sync-capture.js";
import type { LocalLibraryOwner } from "../src/companion/sync-outbox.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function account(uid = "firebase-user-a"): LocalLibraryOwner {
  return { uid, session_generation: randomUUID() };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mm-capture-"));
  roots.push(root);
  const cache = join(root, "cache"),
    queueRoot = join(root, "sync-captures"),
    owner = account(),
    queue = new LocalSyncCaptureQueue(queueRoot, cache);
  async function input(): Promise<LocalSyncCaptureInput> {
    const key = createHash("sha256").update(randomUUID()).digest("hex"),
      vocals = join(cache, "vocals", key);
    await mkdir(vocals, { recursive: true, mode: 0o700 });
    await writeFile(join(vocals, "vocals.mp3"), "fixture vocals", {
      mode: 0o600,
    });
    return {
      owner: { ...owner },
      request_id: randomUUID(),
      cache_key: key,
      video_id: "abcdefghijk",
    };
  }
  function recordPath(value: LocalSyncCaptureInput) {
    return join(
      queueRoot,
      createHash("sha256").update(value.owner.uid).digest("hex"),
      value.request_id,
      "record.json",
    );
  }
  async function dead(attempt: LocalSyncCaptureAttempt) {
    const record = { ...attempt, attempt_pid: 2_147_483_647 };
    await writeFile(recordPath(record), JSON.stringify(record), {
      mode: 0o600,
    });
    const marker = join(queue.attemptRoot(record), "capture-attempt.json"),
      value = JSON.parse(await readFile(marker, "utf8"));
    await writeFile(marker, JSON.stringify({ ...value, pid: 2_147_483_647 }), {
      mode: 0o600,
    });
    return record;
  }
  return { root, cache, queueRoot, owner, queue, input, recordPath, dead };
}

describe("durable owner-bound warm-cache source acquisition", () => {
  it("captures accepted identity, remains idempotent per account/cache key and keeps all paths and credentials outside metadata", async () => {
    const e = await fixture(),
      input = await e.input(),
      accepted = e.queue.stage(input);
    input.owner.uid = "other-account";
    const record = await accepted;
    expect(record.owner.uid).toBe(e.owner.uid);
    expect(
      await e.queue.stage({
        ...record,
        request_id: randomUUID(),
        owner: account(e.owner.uid),
      } as LocalSyncCaptureInput),
    ).toBeDefined();
    const rows = await e.queue.list({
      ...e.owner,
      session_generation: randomUUID(),
    });
    expect(rows).toHaveLength(1);
    expect(await e.queue.list(account("firebase-user-b"))).toEqual([]);
    expect(await e.queue.pinnedCacheKeys()).toEqual(
      new Set([record.cache_key]),
    );
    const text = await readFile(e.recordPath(record), "utf8");
    expect(text).not.toContain(e.root);
    expect(text).not.toContain("youtube.com");
    expect(text).not.toContain("token");
  });
  it("creates a durable private acquisition lease and preserves live ownership across another process incarnation", async () => {
    const e = await fixture(),
      record = await e.queue.stage(await e.input()),
      attempt = await e.queue.beginAttempt(e.owner, record.request_id),
      path = e.queue.attemptRoot(attempt);
    const marker = JSON.parse(
      await readFile(join(path, "capture-attempt.json"), "utf8"),
    );
    expect(marker).toEqual({
      version: 1,
      pid: process.pid,
      attempt_id: attempt.attempt_id,
      ticket_id: record.request_id,
      incarnation: attempt.attempt_incarnation,
    });
    expect((await lstat(path)).mode & 0o077).toBe(0);
    expect((await lstat(join(path, "capture-attempt.json"))).mode & 0o077).toBe(
      0,
    );
    await writeFile(join(path, "source.m4a.part"), "partial original", {
      mode: 0o600,
    });
    const other = new LocalSyncCaptureQueue(e.queueRoot, e.cache);
    await other.recover();
    expect((await other.list(e.owner))[0]?.attempt_id).toBe(attempt.attempt_id);
    await expect(
      other.beginAttempt(e.owner, record.request_id),
    ).rejects.toThrow("CAPTURE_BUSY");
    await expect(
      other.completeAttempt(e.owner, record.request_id, attempt.attempt_id),
    ).rejects.toThrow("CAPTURE_STALE_ATTEMPT");
    expect(await readFile(join(path, "source.m4a.part"), "utf8")).toBe(
      "partial original",
    );
  });
  it("recovers dead acquisition scratch and lets only the same UID with current generation resume", async () => {
    const e = await fixture(),
      record = await e.queue.stage(await e.input()),
      attempt = await e.queue.beginAttempt(e.owner, record.request_id),
      path = e.queue.attemptRoot(attempt);
    await writeFile(join(path, "source.webm.part"), "partial audio", {
      mode: 0o600,
    });
    await e.dead(attempt);
    const resumed = new LocalSyncCaptureQueue(e.queueRoot, e.cache);
    await resumed.recover();
    expect((await resumed.list(e.owner))[0]).toMatchObject({
      state: "deferred",
      error_code: "CAPTURE_INTERRUPTED",
    });
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      resumed.beginAttempt(account("firebase-user-b"), record.request_id),
    ).rejects.toThrow("CAPTURE_TICKET_MISSING");
    const renewed = { ...e.owner, session_generation: randomUUID() },
      current = await resumed.beginAttempt(renewed, record.request_id);
    expect(current.attempt_generation).toBe(renewed.session_generation);
    await expect(
      resumed.completeAttempt(e.owner, record.request_id, current.attempt_id),
    ).rejects.toThrow("CAPTURE_STALE_ATTEMPT");
    expect(
      (
        await resumed.completeAttempt(
          renewed,
          record.request_id,
          current.attempt_id,
        )
      ).state,
    ).toBe("completed");
    expect(await resumed.pinnedCacheKeys()).toEqual(new Set());
    expect(
      (
        await resumed.completeAttempt(
          renewed,
          record.request_id,
          current.attempt_id,
        )
      ).state,
    ).toBe("completed");
  });
  it("distinguishes deferred retry from permanent rejection and removes only verified acquisition artifacts", async () => {
    const e = await fixture(),
      record = await e.queue.stage(await e.input());
    let attempt = await e.queue.beginAttempt(e.owner, record.request_id),
      path = e.queue.attemptRoot(attempt);
    await writeFile(join(path, "source.m4a.part-Frag1"), "fragment", {
      mode: 0o600,
    });
    await writeFile(
      join(path, "source.m4a.part-Frag2.part"),
      "partial fragment",
      {
        mode: 0o600,
      },
    );
    await writeFile(join(path, "source.m4a.ytdl"), Buffer.alloc(8192), {
      mode: 0o600,
    });
    expect(
      (
        await e.queue.failAttempt(
          e.owner,
          record.request_id,
          "NETWORK_UNAVAILABLE",
          attempt.attempt_id,
        )
      ).state,
    ).toBe("deferred");
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await e.queue.pinnedCacheKeys()).toEqual(
      new Set([record.cache_key]),
    );
    attempt = await e.queue.beginAttempt(e.owner, record.request_id);
    path = e.queue.attemptRoot(attempt);
    await writeFile(join(path, "source.opus"), "owned original", {
      mode: 0o600,
    });
    expect(
      (
        await e.queue.failAttempt(
          e.owner,
          record.request_id,
          "SOURCE_IDENTITY_MISMATCH",
          attempt.attempt_id,
          true,
        )
      ).state,
    ).toBe("rejected");
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await e.queue.pinnedCacheKeys()).toEqual(new Set());
    expect(
      await readFile(
        join(e.cache, "vocals", record.cache_key, "vocals.mp3"),
        "utf8",
      ),
    ).toBe("fixture vocals");
  });
  it("refuses unsafe persisted identity and paths rather than submitting another account's ticket", async () => {
    const e = await fixture(),
      record = await e.queue.stage(await e.input()),
      path = e.recordPath(record);
    await writeFile(
      path,
      JSON.stringify({ ...record, id_token: "synthetic-forbidden" }),
      { mode: 0o600 },
    );
    await expect(e.queue.list(e.owner)).rejects.toThrow(
      "CAPTURE_RECORD_INVALID",
    );
    await writeFile(path, JSON.stringify(record), { mode: 0o600 });
    await chmod(path, 0o644);
    await expect(e.queue.list(e.owner)).rejects.toThrow("CAPTURE_UNSAFE");
    expect(
      await readFile(
        join(e.cache, "vocals", record.cache_key, "vocals.mp3"),
        "utf8",
      ),
    ).toBe("fixture vocals");
  });
  it.each(["unknown", "symlink", "hardlink"])(
    "preserves unfamiliar or linked acquisition files during recovery: %s",
    async (kind) => {
      const e = await fixture(),
        record = await e.queue.stage(await e.input()),
        attempt = await e.queue.beginAttempt(e.owner, record.request_id),
        path = e.queue.attemptRoot(attempt),
        outside = join(e.root, "user-original.m4a");
      await writeFile(outside, "keep user audio", { mode: 0o600 });
      if (kind === "unknown")
        await writeFile(join(path, "user-file.txt"), "keep foreign data", {
          mode: 0o600,
        });
      else if (kind === "symlink")
        await symlink(outside, join(path, "source.m4a"));
      else await link(outside, join(path, "source.m4a"));
      await e.dead(attempt);
      await expect(e.queue.recover()).rejects.toThrow(
        /CAPTURE_UNSAFE|CACHE_UNSAFE/,
      );
      expect(await readFile(outside, "utf8")).toBe("keep user audio");
      expect(await readdir(path)).toContain(
        kind === "unknown" ? "user-file.txt" : "source.m4a",
      );
    },
  );
  it("promotes a fully durable ticket after a crash before publishing its account directory", async () => {
    const e = await fixture(),
      record = await e.queue.stage(await e.input()),
      final = dirname(e.recordPath(record)),
      pending = join(dirname(final), `.ticket-${record.request_id}`);
    await rename(final, pending);
    await expect(e.queue.list(e.owner)).rejects.toThrow(
      "CAPTURE_RECOVERY_REQUIRED",
    );
    await e.queue.recover();
    expect((await e.queue.list(e.owner))[0]).toEqual(record);
  });
  it("finishes a fsynced atomic ticket record after a crash before its rename", async () => {
    const e = await fixture(),
      record = await e.queue.stage(await e.input()),
      final = dirname(e.recordPath(record)),
      pending = join(dirname(final), `.ticket-${record.request_id}`);
    await rename(final, pending);
    await rename(
      join(pending, "record.json"),
      join(pending, `.record-${randomUUID()}.tmp`),
    );
    await e.queue.recover();
    expect((await e.queue.list(e.owner))[0]).toEqual(record);
  });
  it("discards only incomplete private ticket metadata while preserving complete invalid identities", async () => {
    const e = await fixture(),
      record = await e.queue.stage(await e.input()),
      final = dirname(e.recordPath(record)),
      pending = join(dirname(final), `.ticket-${record.request_id}`);
    await rename(final, pending);
    const temporary = join(pending, `.record-${randomUUID()}.tmp`);
    await rename(join(pending, "record.json"), temporary);
    await writeFile(temporary, '{"version":', { mode: 0o600 });
    await e.queue.recover();
    expect(await e.queue.list(e.owner)).toEqual([]);
    expect(await readdir(join(e.cache, "vocals", record.cache_key))).toContain(
      "vocals.mp3",
    );
    await mkdir(pending, { mode: 0o700 });
    await writeFile(
      temporary,
      JSON.stringify({ ...record, owner: account("other-owner") }),
      { mode: 0o600 },
    );
    await expect(e.queue.recover()).rejects.toThrow("CAPTURE_RECORD_INVALID");
    expect(await readFile(temporary, "utf8")).toContain("other-owner");
  });
  it.each(["empty", "partial"])(
    "recovers a dead attempt interrupted before atomic marker publication: %s",
    async (layout) => {
      const e = await fixture(),
        record = await e.queue.stage(await e.input()),
        attempt = await e.queue.beginAttempt(e.owner, record.request_id),
        path = e.queue.attemptRoot(attempt);
      await e.dead(attempt);
      await rm(join(path, "capture-attempt.json"));
      if (layout === "partial")
        await writeFile(
          join(path, `.capture-attempt-${attempt.attempt_id}.tmp`),
          '{"version":',
          { mode: 0o600 },
        );
      await e.queue.recover();
      expect((await e.queue.list(e.owner))[0]?.state).toBe("deferred");
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("preserves any source file in an unmarked attempt instead of inferring ownership", async () => {
    const e = await fixture(),
      record = await e.queue.stage(await e.input()),
      attempt = await e.queue.beginAttempt(e.owner, record.request_id),
      path = e.queue.attemptRoot(attempt);
    await e.dead(attempt);
    await rm(join(path, "capture-attempt.json"));
    await writeFile(join(path, "source.m4a"), "preserve unmarked audio", {
      mode: 0o600,
    });
    await expect(e.queue.recover()).rejects.toThrow("CAPTURE_UNSAFE");
    expect(await readFile(join(path, "source.m4a"), "utf8")).toBe(
      "preserve unmarked audio",
    );
  });
  it("limits unfinished capture intentions without sacrificing local vocals and frees admission after permanent rejection", async () => {
    const e = await fixture();
    for (let index = 0; index < 32; index++)
      await e.queue.stage(await e.input());
    const rejectedInput = await e.input();
    await expect(e.queue.stage(rejectedInput)).rejects.toThrow("CAPTURE_FULL");
    const [first] = await e.queue.list(e.owner),
      attempt = await e.queue.beginAttempt(e.owner, first!.request_id);
    await e.queue.failAttempt(
      e.owner,
      first!.request_id,
      "SOURCE_UNAVAILABLE",
      attempt.attempt_id,
      true,
    );
    expect((await e.queue.stage(rejectedInput)).state).toBe("pending");
    expect(await e.queue.pinnedCacheKeys()).toHaveProperty("size", 32);
    expect(
      await readFile(
        join(e.cache, "vocals", rejectedInput.cache_key, "vocals.mp3"),
        "utf8",
      ),
    ).toBe("fixture vocals");
  });
  it("compacts terminal receipts independently of retained vocals and canonical library metadata", async () => {
    const e = await fixture(),
      input = await e.input(),
      record = await e.queue.stage(input),
      attempt = await e.queue.beginAttempt(e.owner, record.request_id),
      completed = await e.queue.completeAttempt(
        e.owner,
        record.request_id,
        attempt.attempt_id,
      );
    for (let index = 0; index < 127; index++) {
      const row = {
        ...completed,
        request_id: randomUUID(),
        cache_key: createHash("sha256").update(String(index)).digest("hex"),
        created_at: index,
        updated_at: index,
      };
      const path = e.recordPath(row);
      await mkdir(dirname(path), { mode: 0o700 });
      await writeFile(path, JSON.stringify(row), { mode: 0o600 });
    }
    await e.queue.stage(await e.input());
    expect(await e.queue.list(e.owner)).toHaveLength(128);
    expect(
      await readFile(
        join(e.cache, "vocals", input.cache_key, "vocals.mp3"),
        "utf8",
      ),
    ).toBe("fixture vocals");
  });
});

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalSyncOutbox,
  OFFLINE_VOCALS_BUDGET_BYTES,
  PENDING_ORIGINALS_BUDGET_BYTES,
  preserveLocalPairRecovery,
  type LocalLibraryOwner,
  type LocalSyncStage,
} from "../src/companion/sync-outbox.js";
import type { LocalAudioArtifact } from "../src/shared/protocol.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: vi.fn(actual.link),
    lstat: vi.fn(actual.lstat),
    open: vi.fn(actual.open),
  };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.link).mockReset();
  vi.mocked(fs.lstat).mockReset();
  vi.mocked(fs.open).mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const account = (): LocalLibraryOwner => ({
  uid: "firebase-account-a",
  session_generation: randomUUID(),
});
const confirmed = () => ({
  sync_id: randomUUID(),
  job_id: "a".repeat(24),
  committed: true as const,
});
async function fixture(
  limits: ConstructorParameters<typeof LocalSyncOutbox>[2] = {},
) {
  const root = await mkdtemp(join(tmpdir(), "mm-outbox-"));
  roots.push(root);
  const cache = join(root, "cache");
  const queue = join(root, "outbox");
  const owner = account();
  const cacheKey = createHash("sha256").update(randomUUID()).digest("hex");
  const work = join(cache, "jobs", randomUUID());
  const vocals = join(cache, "vocals", cacheKey);
  await mkdir(work, { recursive: true, mode: 0o700 });
  await mkdir(vocals, { recursive: true, mode: 0o700 });
  async function item(
    path: string,
    bytes: string,
  ): Promise<LocalAudioArtifact> {
    await writeFile(path, bytes, { mode: 0o600 });
    return {
      path,
      extension: "mp3",
      content_type: "audio/mpeg",
      bytes: Buffer.byteLength(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      duration_seconds: 10,
    };
  }
  const original = await item(
    join(work, "source.mp3"),
    "original fixture audio",
  );
  const vocal = await item(
    join(vocals, "vocals.mp3"),
    "processed fixture voice",
  );
  const stage: LocalSyncStage = {
    owner,
    request_id: randomUUID(),
    cache_key: cacheKey,
    original,
    vocals: vocal,
    source: {
      kind: "youtube",
      video_id: "abcdefghijk",
      format_id: "140",
      audio_track_id: null,
      audio_is_default: null,
      language: "en",
    },
  };
  const outbox = new LocalSyncOutbox(queue, cache, {
    minimum_free_bytes: 0,
    ...limits,
  });
  return { root, cache, queue, owner, stage, outbox };
}

describe("account-bound durable local pair staging", () => {
  it("recovers a native source ticket after a crash before outbox staging without inferring another owner", async () => {
    const env = await fixture();
    const stage = {
      ...env.stage,
      request_id: basename(dirname(env.stage.original.path)),
    };
    await preserveLocalPairRecovery(env.cache, stage);
    const work = dirname(stage.original.path);
    const temporary = join(work, `.local-sync-${randomUUID()}.tmp`);
    await rename(join(work, "local-sync-recovery.json"), temporary);
    await expect(env.outbox.assertAdmission(1)).rejects.toThrow(
      "OUTBOX_RECOVERY_REQUIRED",
    );
    await env.outbox.recover();
    const [record] = await env.outbox.list(env.owner);
    expect(record?.request_id).toBe(stage.request_id);
    expect(await readFile(record!.original.path, "utf8")).toBe(
      "original fixture audio",
    );
    expect(await readdir(join(env.cache, "jobs"))).toEqual([]);
    expect(
      await env.outbox.list({ ...env.owner, uid: "firebase-account-b" }),
    ).toEqual([]);
  });
  it("refuses path-bearing, oversized or corrupted native recovery tickets while preserving the original", async () => {
    const env = await fixture();
    const stage = {
      ...env.stage,
      request_id: basename(dirname(env.stage.original.path)),
    };
    await preserveLocalPairRecovery(env.cache, stage);
    const path = join(dirname(stage.original.path), "local-sync-recovery.json");
    const record = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      path,
      JSON.stringify({
        ...record,
        original: {
          ...record.original,
          path: "/private/other-user-source.mp3",
        },
      }),
      { mode: 0o600 },
    );
    await expect(env.outbox.recover()).rejects.toThrow(
      "OUTBOX_RECOVERY_INVALID",
    );
    expect(await readFile(stage.original.path, "utf8")).toBe(
      "original fixture audio",
    );
    await writeFile(path, Buffer.alloc(17 * 1024), { mode: 0o600 });
    await expect(env.outbox.pinnedCacheKeys()).rejects.toThrow("OUTBOX_UNSAFE");
    expect(await readFile(stage.original.path, "utf8")).toBe(
      "original fixture audio",
    );
  });
  it("keeps a bounded recovery source when admission is full and lets an existing upload free capacity", async () => {
    const env = await fixture({ pending_original_bytes: 30 });
    const first = await env.outbox.stage(env.stage);
    const stage = {
      ...env.stage,
      request_id: basename(dirname(env.stage.original.path)),
    };
    await preserveLocalPairRecovery(env.cache, stage);
    await env.outbox.recover();
    expect(
      (await env.outbox.list(env.owner)).map((record) => record.request_id),
    ).toEqual([first.request_id]);
    expect(await readFile(stage.original.path, "utf8")).toBe(
      "original fixture audio",
    );
    await expect(env.outbox.assertAdmission(1)).rejects.toThrow("OUTBOX_FULL");
    const attempt = await env.outbox.beginAttempt(env.owner, first.request_id);
    await env.outbox.commit(
      env.owner,
      first.request_id,
      confirmed(),
      attempt.attempt_id!,
    );
    await env.outbox.recover();
    const pending = (await env.outbox.list(env.owner)).filter(
      (record) => record.state !== "committed",
    );
    expect(pending.map((record) => record.request_id)).toEqual([
      stage.request_id,
    ]);
    expect(await readFile(pending[0]!.original.path, "utf8")).toBe(
      "original fixture audio",
    );
    expect(await readdir(join(env.cache, "jobs"))).toEqual([]);
  });
  it("snapshots accepted owner and artifact declarations before asynchronous storage admission", async () => {
    const env = await fixture();
    const accepted = env.outbox.stage(env.stage);
    env.stage.owner.uid = "firebase-other-account";
    env.stage.vocals.sha256 = "f".repeat(64);
    const record = await accepted;
    expect(record.owner.uid).toBe("firebase-account-a");
    expect(record.vocals.sha256).toBe(
      createHash("sha256").update("processed fixture voice").digest("hex"),
    );
    expect(await readFile(record.original.path, "utf8")).toBe(
      "original fixture audio",
    );
  });
  it("shares vocals by reference and deletes the temporary original only after confirmed durable commit", async () => {
    const env = await fixture();
    expect(OFFLINE_VOCALS_BUDGET_BYTES).toBe(2_000_000_000);
    expect(PENDING_ORIGINALS_BUDGET_BYTES).toBe(256 * 1024 ** 2);
    const record = await env.outbox.stage(env.stage);
    await rm(dirname(env.stage.original.path), { recursive: true });
    expect(await readFile(record.original.path, "utf8")).toBe(
      "original fixture audio",
    );
    expect(await readdir(dirname(record.original.path))).toEqual([
      "original.mp3",
      "record.json",
    ]);
    expect(record.vocals.path).toBe(env.stage.vocals.path);
    expect(await env.outbox.pinnedCacheKeys()).toEqual(
      new Set([env.stage.cache_key]),
    );
    let attempt = await env.outbox.beginAttempt(env.owner, record.request_id);
    await env.outbox.failAttempt(
      env.owner,
      record.request_id,
      "NETWORK_UNAVAILABLE",
      attempt.attempt_id!,
    );
    expect(await readFile(record.original.path, "utf8")).toBe(
      "original fixture audio",
    );
    expect(await readFile(record.vocals.path, "utf8")).toBe(
      "processed fixture voice",
    );
    attempt = await env.outbox.beginAttempt(env.owner, record.request_id);
    const receipt = confirmed();
    await env.outbox.commit(
      env.owner,
      record.request_id,
      receipt,
      attempt.attempt_id!,
    );
    await expect(readFile(record.original.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(record.vocals.path, "utf8")).toBe(
      "processed fixture voice",
    );
    expect(await env.outbox.pinnedCacheKeys()).toEqual(new Set());
    const journal = JSON.parse(
      await readFile(
        join(dirname(record.original.path), "record.json"),
        "utf8",
      ),
    );
    expect(journal.state).toBe("committed");
    expect(journal.receipt).toEqual(receipt);
    expect(
      await env.outbox.commit(
        env.owner,
        record.request_id,
        receipt,
        attempt.attempt_id!,
      ),
    ).toEqual(journal);
    await expect(
      env.outbox.commit(
        env.owner,
        record.request_id,
        confirmed(),
        attempt.attempt_id!,
      ),
    ).rejects.toThrow("OUTBOX_RECEIPT_CONFLICT");
  });
  it("keeps requests idempotent and refuses replacement bytes under the same operation", async () => {
    const env = await fixture();
    const first = await env.outbox.stage(env.stage);
    expect(await env.outbox.stage(env.stage)).toEqual(first);
    await expect(
      env.outbox.stage({
        ...env.stage,
        original: { ...env.stage.original, sha256: "b".repeat(64) },
      }),
    ).rejects.toThrow("OUTBOX_REQUEST_CONFLICT");
    expect(await env.outbox.list(env.owner)).toHaveLength(1);
  });
  it("cannot resume, fail or commit account A's operation as B or a stale authorization generation", async () => {
    const env = await fixture();
    const record = await env.outbox.stage(env.stage);
    const other = { ...account(), uid: "firebase-account-b" };
    expect(await env.outbox.list(other)).toEqual([]);
    await expect(
      env.outbox.beginAttempt(other, record.request_id),
    ).rejects.toMatchObject({ code: "ENOENT" });
    let attempt = await env.outbox.beginAttempt(env.owner, record.request_id);
    const renewed = { ...env.owner, session_generation: randomUUID() };
    await expect(
      env.outbox.commit(
        renewed,
        record.request_id,
        confirmed(),
        attempt.attempt_id!,
      ),
    ).rejects.toThrow("OUTBOX_STALE_ATTEMPT");
    await expect(
      env.outbox.failAttempt(
        renewed,
        record.request_id,
        "NETWORK_UNAVAILABLE",
        attempt.attempt_id!,
      ),
    ).rejects.toThrow("OUTBOX_STALE_ATTEMPT");
    expect(await readFile(record.original.path, "utf8")).toBe(
      "original fixture audio",
    );
    await env.outbox.failAttempt(
      env.owner,
      record.request_id,
      "ACCOUNT_CHANGED",
      attempt.attempt_id!,
    );
    attempt = await env.outbox.beginAttempt(renewed, record.request_id);
    await env.outbox.commit(
      renewed,
      record.request_id,
      confirmed(),
      attempt.attempt_id!,
    );
  });
  it("recovers interrupted uploading and applies a persisted commit before removing its original", async () => {
    const env = await fixture();
    const record = await env.outbox.stage(env.stage);
    const active = await env.outbox.beginAttempt(env.owner, record.request_id);
    await expect(
      env.outbox.beginAttempt(env.owner, record.request_id),
    ).rejects.toThrow("OUTBOX_BUSY");
    const manifest = join(dirname(record.original.path), "record.json");
    await writeFile(
      manifest,
      JSON.stringify({ ...active, attempt_pid: 2147483647 }),
      { mode: 0o600 },
    );
    const resumed = new LocalSyncOutbox(env.queue, env.cache, {
      minimum_free_bytes: 0,
    });
    await resumed.recover();
    const [pending] = await resumed.list(env.owner);
    expect(pending?.state).toBe("pending");
    expect(pending?.attempt_generation).toBeUndefined();
    const path = join(dirname(record.original.path), "record.json");
    await writeFile(
      path,
      JSON.stringify({ ...pending, state: "committed", receipt: confirmed() }),
      { mode: 0o600 },
    );
    await resumed.recover();
    await expect(readFile(record.original.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(record.vocals.path, "utf8")).toBe(
      "processed fixture voice",
    );
  });
  it("promotes a fully durable staged pair after a crash before directory publication", async () => {
    const env = await fixture();
    const record = await env.outbox.stage(env.stage);
    const final = dirname(record.original.path);
    const staging = join(dirname(final), `.pending-${record.request_id}`);
    await rename(final, staging);
    await expect(env.outbox.assertAdmission(1)).rejects.toThrow(
      "OUTBOX_RECOVERY_REQUIRED",
    );
    await env.outbox.recover();
    expect((await env.outbox.list(env.owner))[0]).toEqual(record);
    expect(await readFile(record.original.path, "utf8")).toBe(
      "original fixture audio",
    );
  });
  it("leaves a live upload owner untouched during startup recovery and rejects another uploader instance", async () => {
    const env = await fixture();
    const record = await env.outbox.stage(env.stage);
    const active = await env.outbox.beginAttempt(env.owner, record.request_id);
    const other = new LocalSyncOutbox(env.queue, env.cache, {
      minimum_free_bytes: 0,
    });
    await other.recover();
    expect((await other.list(env.owner))[0]?.attempt_id).toBe(
      active.attempt_id,
    );
    await expect(
      other.beginAttempt(env.owner, record.request_id),
    ).rejects.toThrow("OUTBOX_BUSY");
    await expect(
      other.commit(
        env.owner,
        record.request_id,
        confirmed(),
        active.attempt_id!,
      ),
    ).rejects.toThrow("OUTBOX_STALE_ATTEMPT");
    expect(await readFile(record.original.path, "utf8")).toBe(
      "original fixture audio",
    );
  });
  it("bounds committed recovery receipts without deleting cached vocals or server history", async () => {
    const env = await fixture({ max_records: 1 });
    const first = await env.outbox.stage(env.stage);
    const attempt = await env.outbox.beginAttempt(env.owner, first.request_id);
    await env.outbox.commit(
      env.owner,
      first.request_id,
      confirmed(),
      attempt.attempt_id!,
    );
    await env.outbox.assertAdmission(1);
    expect(await readFile(first.vocals.path, "utf8")).toBe(
      "processed fixture voice",
    );
    const second = await env.outbox.stage({
      ...env.stage,
      request_id: randomUUID(),
    });
    expect(
      (await env.outbox.list(env.owner)).map((record) => record.request_id),
    ).toEqual([second.request_id]);
    await expect(
      readFile(join(dirname(first.original.path), "record.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("bounds originals independently of offline vocals and rejects storage admission without losing previous local results", async () => {
    const env = await fixture({ pending_original_bytes: 30 });
    const first = await env.outbox.stage(env.stage);
    await expect(
      env.outbox.stage({ ...env.stage, request_id: randomUUID() }),
    ).rejects.toThrow("OUTBOX_FULL");
    expect(await readFile(first.original.path, "utf8")).toBe(
      "original fixture audio",
    );
    expect(await readFile(first.vocals.path, "utf8")).toBe(
      "processed fixture voice",
    );
    await expect(env.outbox.assertAdmission(31)).rejects.toThrow("OUTBOX_FULL");
    const lowDisk = new LocalSyncOutbox(join(env.root, "low-disk"), env.cache, {
      minimum_free_bytes: Number.MAX_SAFE_INTEGER,
    });
    await expect(lowDisk.stage(env.stage)).rejects.toThrow("DISK_SPACE_LOW");
  });
  it.each(["symlink", "hardlink", "bad-hash"])(
    "refuses an unsafe %s artifact",
    async (type) => {
      const env = await fixture();
      if (type === "symlink") {
        const owned = env.stage.original.path;
        await rename(owned, `${owned}.owned`);
        await symlink(`${owned}.owned`, owned);
      } else if (type === "hardlink")
        await link(env.stage.original.path, `${env.stage.original.path}.link`);
      else env.stage.original.sha256 = "b".repeat(64);
      await expect(env.outbox.stage(env.stage)).rejects.toThrow(
        /OUTBOX_(UNSAFE|ARTIFACT_INVALID)|ELOOP/,
      );
      expect(await readFile(env.stage.vocals.path, "utf8")).toBe(
        "processed fixture voice",
      );
      expect(await env.outbox.list(env.owner)).toEqual([]);
    },
  );
  it("fails closed on corrupt or unexpected manifest fields without retaining grants or tokens", async () => {
    const env = await fixture();
    const record = await env.outbox.stage(env.stage);
    const path = join(dirname(record.original.path), "record.json");
    await writeFile(
      path,
      JSON.stringify({
        ...record,
        upload_grant: "https://private.invalid/?token=private",
      }),
    );
    await expect(env.outbox.list(env.owner)).rejects.toThrow(
      "OUTBOX_RECORD_INVALID",
    );
    expect(await readFile(record.original.path, "utf8")).toBe(
      "original fixture audio",
    );
  });
  it("fences another process owner and recovers a dead process lock", async () => {
    const env = await fixture();
    await env.outbox.list(env.owner);
    const lock = join(env.queue, ".writer.lock");
    await writeFile(lock, String(process.pid), { mode: 0o600 });
    const started = performance.now();
    await expect(
      new LocalSyncOutbox(env.queue, env.cache).list(env.owner),
    ).rejects.toThrow("OUTBOX_BUSY");
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_950);
    expect(await readFile(lock, "utf8")).toBe(String(process.pid));
    expect(
      (await readdir(env.queue)).filter((name) => name.startsWith(".writer-")),
    ).toEqual([]);
    await unlink(lock);
    await writeFile(lock, "2147483647", { mode: 0o600 });
    expect(await env.outbox.list(env.owner)).toEqual([]);
    await expect(readFile(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("waits for a brief live staging writer before reading its protected cache pins", async () => {
    const env = await fixture();
    const other = new LocalSyncOutbox(env.queue, env.cache, {
      minimum_free_bytes: 0,
    });
    const copying = env.outbox as unknown as {
      copyOriginal(item: LocalAudioArtifact, target: string): Promise<void>;
    };
    const original = copying.copyOriginal.bind(copying);
    let entered!: () => void;
    const held = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(copying, "copyOriginal").mockImplementationOnce(
      async (...args) => {
        entered();
        await released;
        return original(...args);
      },
    );
    const staged = env.outbox.stage(env.stage);
    await held;
    let finished = false;
    const pins = other.pinnedCacheKeys().then((value) => {
      finished = true;
      return value;
    });
    try {
      await delay(75);
      expect(finished).toBe(false);
    } finally {
      release();
    }
    const record = await staged;
    expect(await pins).toEqual(new Set([env.stage.cache_key]));
    expect(await readFile(record.original.path, "utf8")).toBe(
      "original fixture audio",
    );
    await expect(lstat(join(env.queue, ".writer.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("retries exclusive publication when a writer disappears after EEXIST before open", async () => {
    const env = await fixture();
    await env.outbox.list(env.owner);
    const lock = join(env.queue, ".writer.lock");
    await writeFile(lock, String(process.pid), { mode: 0o600 });
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    let released = false;
    vi.mocked(fs.link).mockImplementation(async (existing, target) => {
      try {
        return await actual.link(existing, target);
      } catch (error) {
        if (target === lock && !released) {
          released = true;
          await unlink(lock);
        }
        throw error;
      }
    });
    expect(await env.outbox.list(env.owner)).toEqual([]);
    expect(released).toBe(true);
    expect(await readdir(env.queue)).toEqual([]);
  });
  it("retries when a writer disappears between open and the identity check", async () => {
    const env = await fixture();
    await env.outbox.list(env.owner);
    const lock = join(env.queue, ".writer.lock");
    await writeFile(lock, String(process.pid), { mode: 0o600 });
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    let released = false;
    vi.mocked(fs.lstat).mockImplementation(async (...args) => {
      if (args[0] === lock && !released) {
        released = true;
        await unlink(lock);
      }
      return actual.lstat(...args);
    });
    expect(await env.outbox.list(env.owner)).toEqual([]);
    expect(released).toBe(true);
    expect(await readdir(env.queue)).toEqual([]);
  });
  it("retries a normally released writer whose opened handle now has no links", async () => {
    const env = await fixture();
    await env.outbox.list(env.owner);
    const lock = join(env.queue, ".writer.lock");
    await writeFile(lock, String(process.pid), { mode: 0o600 });
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    let released = false;
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (args[0] === lock && !released) {
        released = true;
        await unlink(lock);
        expect((await handle.stat()).nlink).toBe(0);
      }
      return handle;
    });
    expect(await env.outbox.list(env.owner)).toEqual([]);
    expect(released).toBe(true);
    expect(await readdir(env.queue)).toEqual([]);
  });
  it.each(["", "not-a-pid", "0", "-1", "2147483648"])(
    "preserves a malformed writer PID %j rather than reclaiming it",
    async (value) => {
      const env = await fixture();
      await env.outbox.list(env.owner);
      const lock = join(env.queue, ".writer.lock");
      await writeFile(lock, value, { mode: 0o600 });
      await expect(env.outbox.list(env.owner)).rejects.toThrow("OUTBOX_BUSY");
      expect(await readFile(lock, "utf8")).toBe(value);
      expect(await readdir(env.queue)).toEqual([".writer.lock"]);
    },
  );
  it("refuses a symlink writer without touching its target", async () => {
    const env = await fixture();
    await env.outbox.list(env.owner);
    const target = join(env.root, "untouched-writer");
    await writeFile(target, String(process.pid), { mode: 0o600 });
    const lock = join(env.queue, ".writer.lock");
    await symlink(target, lock);
    await expect(env.outbox.list(env.owner)).rejects.toThrow("OUTBOX_UNSAFE");
    expect((await lstat(lock)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe(String(process.pid));
  });
  it("does not reclaim a live replacement of an observed dead writer", async () => {
    const env = await fixture();
    await env.outbox.list(env.owner);
    const lock = join(env.queue, ".writer.lock");
    const old = join(env.root, "observed-dead-writer");
    await writeFile(lock, "2147483647", { mode: 0o600 });
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    let replaced = false;
    vi.mocked(fs.lstat).mockImplementation(async (...args) => {
      if (args[0] === lock && !replaced) {
        replaced = true;
        await rename(lock, old);
        await writeFile(lock, String(process.pid), { mode: 0o600 });
      }
      return actual.lstat(...args);
    });
    await expect(env.outbox.list(env.owner)).rejects.toThrow("OUTBOX_BUSY");
    expect(replaced).toBe(true);
    expect(await readFile(lock, "utf8")).toBe(String(process.pid));
    expect(await readFile(old, "utf8")).toBe("2147483647");
  });
  it("refuses to remove a replacement when releasing its own writer", async () => {
    const env = await fixture();
    const lock = join(env.queue, ".writer.lock");
    const old = join(env.root, "replaced-owned-writer");
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    let replaced = false;
    vi.mocked(fs.lstat).mockImplementation(async (...args) => {
      if (args[0] === lock && !replaced) {
        replaced = true;
        await rename(lock, old);
        await writeFile(lock, String(process.pid), { mode: 0o600 });
      }
      return actual.lstat(...args);
    });
    await expect(env.outbox.list(env.owner)).rejects.toThrow("OUTBOX_UNSAFE");
    expect(replaced).toBe(true);
    expect(await readFile(lock, "utf8")).toBe(String(process.pid));
    expect(await readFile(old, "utf8")).toBe(String(process.pid));
  });
  it("serializes concurrent staging instances and rejects malformed owner identities", async () => {
    const env = await fixture();
    const records = await Promise.all([
      env.outbox.stage(env.stage),
      env.outbox.stage(env.stage),
    ]);
    expect(records[0]).toEqual(records[1]);
    await expect(
      env.outbox.list({ ...env.owner, session_generation: "1" }),
    ).rejects.toThrow("OUTBOX_ACCOUNT_INVALID");
    await expect(
      env.outbox.stage({
        ...env.stage,
        owner: { ...env.owner, uid: "\nunsafe" },
      }),
    ).rejects.toThrow("OUTBOX_RECORD_INVALID");
  });
});

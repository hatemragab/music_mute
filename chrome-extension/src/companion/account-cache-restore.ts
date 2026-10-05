import { randomUUID, createHash } from "node:crypto";
import { constants, watch, type FSWatcher } from "node:fs";
import {
  lstat,
  open,
  readdir,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { desktopRecord, desktopUuid } from "../shared/desktop-protocol.js";
import { isVideoId, MVP_MAX_DURATION_SECONDS } from "../shared/protocol.js";
import { DesktopApiError } from "./account-api.js";
import { privateDirectory } from "./app-setup.js";
import { withCacheMutation } from "./cache-mutator.js";
import type { LocalLibraryOwner } from "./sync-outbox.js";

const MAX_PENDING = 32,
  MAX_RECEIPTS = 128,
  MAX_RECORD_BYTES = 4096;
// Account reuse is an optimization. A slow or unavailable account lookup must
// not hold the user's explicitly selected local processing path for a full
// network timeout.
export const ACCOUNT_RESTORE_DEADLINE_MS = 5_000;
// Version 1 records created by builds before the foreground deadline was
// shortened can remain on disk across an ordinary app update. Accept their
// bounded shape long enough to fence them as cancelled instead of letting one
// stale receipt poison the queue.
const LEGACY_ACCOUNT_RESTORE_DEADLINE_MS = 20_000;
const HASH = /^[a-f0-9]{64}$/,
  JOB = /^[a-f0-9]{24}$/;
export interface AccountRestoreInput {
  owner: LocalLibraryOwner;
  request_id: string;
  video_id: string;
  duration_seconds: number;
}
export interface AccountRestoreRecord extends AccountRestoreInput {
  version: 1;
  state:
    "pending" | "restoring" | "ready" | "missing" | "deferred" | "cancelled";
  created_at: number;
  updated_at: number;
  expires_at: number;
  attempt_id?: string;
  attempt_pid?: number;
  cache_key?: string;
  job_id?: string;
}
export interface AccountRestoreAttempt extends AccountRestoreRecord {
  state: "restoring";
  attempt_id: string;
  attempt_pid: number;
}
type Outcome =
  | { state: "ready"; cache_key: string; job_id: string }
  | { state: "missing" | "deferred" };
function sameOwner(a: LocalLibraryOwner, b: LocalLibraryOwner): boolean {
  return a.uid === b.uid && a.session_generation === b.session_generation;
}
function inputValid(value: unknown): value is AccountRestoreInput {
  return (
    desktopRecord(value) &&
    desktopRecord(value.owner) &&
    Object.keys(value.owner).length === 2 &&
    typeof value.owner.uid === "string" &&
    /^[A-Za-z0-9_.:@+-]{1,128}$/.test(value.owner.uid) &&
    desktopUuid(value.owner.session_generation) &&
    desktopUuid(value.request_id) &&
    isVideoId(value.video_id) &&
    typeof value.duration_seconds === "number" &&
    Number.isFinite(value.duration_seconds) &&
    value.duration_seconds > 0 &&
    value.duration_seconds <= MVP_MAX_DURATION_SECONDS
  );
}
function validRecord(value: unknown): value is AccountRestoreRecord {
  if (!inputValid(value) || !desktopRecord(value)) return false;
  const state = value.state;
  return (
    Object.keys(value).every((key) =>
      [
        "version",
        "owner",
        "request_id",
        "video_id",
        "duration_seconds",
        "state",
        "created_at",
        "updated_at",
        "expires_at",
        "attempt_id",
        "attempt_pid",
        "cache_key",
        "job_id",
      ].includes(key),
    ) &&
    value.version === 1 &&
    [
      "pending",
      "restoring",
      "ready",
      "missing",
      "deferred",
      "cancelled",
    ].includes(String(state)) &&
    typeof value.created_at === "number" &&
    Number.isSafeInteger(value.created_at) &&
    value.created_at >= 0 &&
    typeof value.updated_at === "number" &&
    Number.isSafeInteger(value.updated_at) &&
    value.updated_at >= value.created_at &&
    typeof value.expires_at === "number" &&
    Number.isSafeInteger(value.expires_at) &&
    value.expires_at > value.created_at &&
    value.expires_at - value.created_at <= LEGACY_ACCOUNT_RESTORE_DEADLINE_MS &&
    (value.attempt_id === undefined
      ? value.attempt_pid === undefined && state !== "restoring"
      : desktopUuid(value.attempt_id) &&
        typeof value.attempt_pid === "number" &&
        Number.isSafeInteger(value.attempt_pid) &&
        value.attempt_pid > 0 &&
        value.attempt_pid <= 2147483647) &&
    (state === "ready"
      ? typeof value.cache_key === "string" &&
        HASH.test(value.cache_key) &&
        typeof value.job_id === "string" &&
        JOB.test(value.job_id)
      : value.cache_key === undefined && value.job_id === undefined)
  );
}
async function privateRecord(
  path: string,
): Promise<AccountRestoreRecord | null> {
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new DesktopApiError("ACCOUNT_RESTORE_UNSAFE");
  }
  try {
    const info = await file.stat(),
      named = await lstat(path);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      info.size <= 0 ||
      info.size > MAX_RECORD_BYTES ||
      named.isSymbolicLink() ||
      info.ino !== named.ino ||
      info.dev !== named.dev
    )
      throw new DesktopApiError("ACCOUNT_RESTORE_UNSAFE");
    const value: unknown = JSON.parse(await file.readFile("utf8"));
    if (!validRecord(value))
      throw new DesktopApiError("ACCOUNT_RESTORE_UNSAFE");
    return value;
  } catch {
    throw new DesktopApiError("ACCOUNT_RESTORE_UNSAFE");
  } finally {
    await file.close();
  }
}
async function syncDirectory(path: string): Promise<void> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
/** One token-free account download request. This queue never acquires the audio cache lease. */
export class AccountCacheRestoreQueue {
  private readonly deadline: number;
  constructor(
    private readonly root: string,
    options: { timeout_ms?: number } = {},
  ) {
    this.deadline = options.timeout_ms ?? ACCOUNT_RESTORE_DEADLINE_MS;
    if (
      !isAbsolute(root) ||
      !Number.isSafeInteger(this.deadline) ||
      this.deadline < 10 ||
      this.deadline > ACCOUNT_RESTORE_DEADLINE_MS
    )
      throw new DesktopApiError("ACCOUNT_RESTORE_UNSAFE");
  }
  private namespace(owner: LocalLibraryOwner): string {
    return createHash("sha256").update(owner.uid).digest("hex");
  }
  private path(owner: LocalLibraryOwner, id: string): string {
    return join(this.root, this.namespace(owner), id);
  }
  private async directory(path: string): Promise<void> {
    await privateDirectory(path);
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077
    )
      throw new DesktopApiError("ACCOUNT_RESTORE_UNSAFE");
  }
  private async read(
    owner: LocalLibraryOwner,
    id: string,
  ): Promise<AccountRestoreRecord | null> {
    if (
      !desktopUuid(id) ||
      !inputValid({
        owner,
        request_id: id,
        video_id: "abcdefghijk",
        duration_seconds: 1,
      })
    )
      throw new DesktopApiError("ACCOUNT_RESTORE_UNSAFE");
    for (const path of [
      this.root,
      join(this.root, this.namespace(owner)),
      this.path(owner, id),
    ]) {
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!info) return null;
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077
      )
        throw new DesktopApiError("ACCOUNT_RESTORE_UNSAFE");
    }
    const record = await privateRecord(
      join(this.path(owner, id), "record.json"),
    );
    if (record && (!sameOwner(record.owner, owner) || record.request_id !== id))
      throw new DesktopApiError("ACCOUNT_CHANGED");
    const cancelled = await privateRecord(
      join(this.path(owner, id), "cancelled.json"),
    );
    if (cancelled) {
      if (
        !record ||
        cancelled.state !== "cancelled" ||
        !sameOwner(cancelled.owner, owner) ||
        cancelled.request_id !== id ||
        cancelled.video_id !== record.video_id ||
        cancelled.duration_seconds !== record.duration_seconds ||
        cancelled.expires_at !== record.expires_at
      )
        throw new DesktopApiError("ACCOUNT_RESTORE_UNSAFE");
      return cancelled;
    }
    if (
      record &&
      record.expires_at - record.created_at > ACCOUNT_RESTORE_DEADLINE_MS &&
      ["pending", "restoring"].includes(record.state)
    )
      return {
        ...record,
        state: "cancelled",
        updated_at: Math.max(Date.now(), record.updated_at),
      };
    return record;
  }
  private async write(record: AccountRestoreRecord): Promise<void> {
    if (!validRecord(record))
      throw new DesktopApiError("ACCOUNT_RESTORE_UNSAFE");
    const ownerRoot = join(this.root, this.namespace(record.owner)),
      directory = this.path(record.owner, record.request_id);
    await this.directory(ownerRoot);
    await this.directory(directory);
    const target = join(directory, "record.json"),
      temporary = join(directory, `.record-${randomUUID()}.tmp`);
    await this.read(record.owner, record.request_id);
    const file = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, target);
      await syncDirectory(directory);
      await syncDirectory(ownerRoot);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private async all(): Promise<AccountRestoreRecord[]> {
    const namespaces = (await readdir(this.root)).filter((name) =>
      HASH.test(name),
    );
    if (namespaces.length > 256)
      throw new DesktopApiError("ACCOUNT_RESTORE_FULL");
    const records: AccountRestoreRecord[] = [];
    for (const namespace of namespaces) {
      const directory = join(this.root, namespace);
      await this.directory(directory);
      // Finder can add this inert metadata file when the private support tree is
      // inspected. It is never opened or removed by the queue; every other
      // unexpected child still fails closed.
      const names = (await readdir(directory)).filter(
        (name) => name !== ".DS_Store",
      );
      if (names.length > MAX_PENDING + MAX_RECEIPTS)
        throw new DesktopApiError("ACCOUNT_RESTORE_FULL");
      for (const id of names) {
        if (!desktopUuid(id))
          throw new DesktopApiError("ACCOUNT_RESTORE_UNSAFE");
        const path = join(directory, id);
        await this.directory(path);
        const record = await privateRecord(join(path, "record.json"));
        if (!record) {
          await this.removeDirectory(path, false);
          continue;
        }
        if (
          record.request_id !== id ||
          this.namespace(record.owner) !== namespace
        )
          throw new DesktopApiError("ACCOUNT_RESTORE_UNSAFE");
        const current = (await this.read(record.owner, id))!;
        if (
          current.state === "cancelled" &&
          ["pending", "restoring"].includes(record.state) &&
          record.expires_at - record.created_at > ACCOUNT_RESTORE_DEADLINE_MS
        )
          await this.write(current);
        records.push(current);
        if (records.length > MAX_PENDING + MAX_RECEIPTS)
          throw new DesktopApiError("ACCOUNT_RESTORE_FULL");
      }
    }
    return records;
  }
  private async removeDirectory(path: string, published = true): Promise<void> {
    const names = await readdir(path);
    if (names.length > 16) throw new DesktopApiError("ACCOUNT_RESTORE_UNSAFE");
    for (const name of names) {
      if (
        !(published && ["record.json", "cancelled.json"].includes(name)) &&
        !(
          name.startsWith(".record-") &&
          name.endsWith(".tmp") &&
          desktopUuid(name.slice(8, -4))
        )
      )
        throw new DesktopApiError("ACCOUNT_RESTORE_UNSAFE");
      const info = await lstat(join(path, name));
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077 ||
        info.size > MAX_RECORD_BYTES
      )
        throw new DesktopApiError("ACCOUNT_RESTORE_UNSAFE");
    }
    await rm(path, { recursive: true });
  }
  async stage(input: AccountRestoreInput): Promise<AccountRestoreRecord> {
    input = { ...input, owner: { ...input.owner } };
    if (
      !inputValid(input) ||
      Object.keys(input).length !== 4 ||
      Object.keys(input).some(
        (key) =>
          !["owner", "request_id", "video_id", "duration_seconds"].includes(
            key,
          ),
      )
    )
      throw new DesktopApiError("ACCOUNT_RESTORE_UNSAFE");
    return await withCacheMutation(this.root, async () => {
      const existing = await this.read(input.owner, input.request_id);
      if (existing) {
        if (
          existing.video_id !== input.video_id ||
          existing.duration_seconds !== input.duration_seconds
        )
          throw new DesktopApiError("ACCOUNT_RESTORE_CONFLICT");
        return existing;
      }
      const records = await this.all(),
        now = Date.now();
      for (const record of records)
        if (
          ["pending", "restoring"].includes(record.state) &&
          record.expires_at <= now
        ) {
          record.state = "cancelled";
          record.updated_at = Math.max(now, record.updated_at);
          await this.write(record);
        }
      if (
        records.filter((record) =>
          ["pending", "restoring"].includes(record.state),
        ).length >= MAX_PENDING
      )
        throw new DesktopApiError("ACCOUNT_RESTORE_FULL");
      const receipts = records
        .filter((record) => !["pending", "restoring"].includes(record.state))
        .sort((a, b) => a.updated_at - b.updated_at);
      for (const record of receipts.slice(
        0,
        Math.max(0, receipts.length - MAX_RECEIPTS + 1),
      ))
        await this.removeDirectory(this.path(record.owner, record.request_id));
      const record: AccountRestoreRecord = {
        ...input,
        version: 1,
        state: "pending",
        created_at: now,
        updated_at: now,
        expires_at: now + this.deadline,
      };
      await this.write(record);
      return record;
    });
  }
  async claimOne(
    owner: LocalLibraryOwner,
  ): Promise<AccountRestoreAttempt | null> {
    return await withCacheMutation(this.root, async () => {
      const records = await this.all(),
        now = Date.now();
      for (const record of records.filter(
        (value) =>
          value.owner.uid === owner.uid &&
          ["pending", "restoring"].includes(value.state),
      )) {
        if (!sameOwner(record.owner, owner) || record.expires_at <= now) {
          record.state = "cancelled";
          record.updated_at = Math.max(now, record.updated_at);
          await this.write(record);
        }
      }
      const record = records
        .filter(
          (value) => sameOwner(value.owner, owner) && value.state === "pending",
        )
        .sort((a, b) => a.created_at - b.created_at)[0];
      if (!record) return null;
      const attempt: AccountRestoreAttempt = {
        ...record,
        state: "restoring",
        attempt_id: randomUUID(),
        attempt_pid: process.pid,
        updated_at: Math.max(now, record.updated_at),
      };
      await this.write(attempt);
      return attempt;
    });
  }
  async hasPending(owner: LocalLibraryOwner): Promise<boolean> {
    return await withCacheMutation(this.root, async () => {
      const records = await this.all(),
        now = Date.now();
      for (const record of records.filter(
        (value) => value.owner.uid === owner.uid,
      )) {
        if (
          (["pending", "restoring"].includes(record.state) &&
            (!sameOwner(record.owner, owner) || record.expires_at <= now)) ||
          record.state === "cancelled"
        ) {
          record.state = "cancelled";
          record.updated_at = Math.max(now, record.updated_at);
          await this.write(record);
        }
      }
      return records.some(
        (record) =>
          sameOwner(record.owner, owner) && record.state === "pending",
      );
    });
  }
  async assertActive(attempt: AccountRestoreAttempt): Promise<void> {
    const current = await this.read(attempt.owner, attempt.request_id);
    if (
      !current ||
      current.state !== "restoring" ||
      current.attempt_id !== attempt.attempt_id ||
      current.attempt_pid !== attempt.attempt_pid ||
      current.expires_at <= Date.now() ||
      current.video_id !== attempt.video_id ||
      current.duration_seconds !== attempt.duration_seconds
    )
      throw new DesktopApiError("CANCELLED");
  }
  async complete(
    attempt: AccountRestoreAttempt,
    outcome: Outcome,
  ): Promise<void> {
    return await withCacheMutation(this.root, async () => {
      await this.assertActive(attempt);
      await this.write({
        ...attempt,
        ...outcome,
        updated_at: Math.max(Date.now(), attempt.updated_at),
      });
    });
  }
  async cancel(owner: LocalLibraryOwner, id: string): Promise<void> {
    const record = await this.read(owner, id);
    if (!record || !["pending", "restoring"].includes(record.state)) return;
    const cancelled: AccountRestoreRecord = {
      ...record,
      state: "cancelled",
      updated_at: Math.max(Date.now(), record.updated_at),
    };
    const directory = this.path(owner, id),
      temporary = join(directory, `.record-${randomUUID()}.tmp`);
    const file = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(JSON.stringify(cancelled));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await this.read(owner, id);
      await rename(temporary, join(directory, "cancelled.json"));
      await syncDirectory(directory);
    } finally {
      await rm(temporary, { force: true });
    }
    // The marker fences a live download even if another process owns the short metadata lock.
    try {
      await withCacheMutation(this.root, () => this.write(cancelled));
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "LOCAL_COMPANION_BUSY")
        throw error;
    }
  }
  async waitForReceipt(
    owner: LocalLibraryOwner,
    id: string,
    signal: AbortSignal,
    isCurrent: () => boolean | Promise<boolean>,
  ): Promise<AccountRestoreRecord | null> {
    const initial = await this.read(owner, id);
    if (!initial) return null;
    return await new Promise((resolve, reject) => {
      let settled = false,
        reading = false,
        again = false;
      let stopping: Promise<void> | undefined;
      let watcher: FSWatcher | undefined;
      const finish = (value: AccountRestoreRecord | null, error?: unknown) => {
        if (settled) return;
        settled = true;
        watcher?.close();
        clearTimeout(deadline);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(value);
      };
      const stop = async (error?: unknown) => {
        stopping ??= (async () => {
          try {
            await this.cancel(owner, id);
          } catch {
            /* A vanished receipt never authorizes playback. */
          }
          finish(null, error);
        })();
        await stopping;
      };
      const abort = () => {
        void stop(new DesktopApiError("CANCELLED"));
      };
      const deadline = setTimeout(
        () => {
          void stop();
        },
        Math.max(1, Math.min(this.deadline, initial.expires_at - Date.now())),
      );
      const read = async () => {
        if (settled) return;
        if (reading) {
          again = true;
          return;
        }
        reading = true;
        try {
          do {
            again = false;
            if (signal.aborted) {
              await stop(new DesktopApiError("CANCELLED"));
              return;
            }
            if (!(await isCurrent())) {
              await stop(new DesktopApiError("ACCOUNT_CHANGED"));
              return;
            }
            const record = await this.read(owner, id);
            if (
              record &&
              record.expires_at > Date.now() &&
              !["pending", "restoring"].includes(record.state)
            ) {
              finish(record);
              return;
            }
            if (!record || record.expires_at <= Date.now()) {
              await stop();
              return;
            }
          } while (again && !settled);
        } catch (error) {
          await stop(error);
        } finally {
          reading = false;
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        watcher = watch(this.path(owner, id), { persistent: false }, () => {
          void read();
        });
        watcher.on("error", () => {
          void stop(new DesktopApiError("ACCOUNT_RESTORE_UNAVAILABLE"));
        });
      } catch {
        void stop(new DesktopApiError("ACCOUNT_RESTORE_UNAVAILABLE"));
        return;
      }
      void read();
    });
  }
}

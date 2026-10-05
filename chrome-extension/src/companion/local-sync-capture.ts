import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { assertCacheDirectory, cacheFileBytes } from "./cache-budget.js";
import { withCacheMutation } from "./cache-mutator.js";
import { isVideoId } from "../shared/protocol.js";
import type { LocalLibraryOwner } from "./sync-outbox.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const MAX_UNFINISHED = 32;
const MAX_RECEIPTS = 128;
const MAX_RECORD_BYTES = 4096;
const MAX_SOURCE_BYTES = 256 * 1024 ** 2;
const MAX_RESUME_BYTES = 64 * 1024;
const ATTEMPT_MARKER = "capture-attempt.json";
const SOURCE =
  /^source\.(m4a|mp3|webm|opus|ogg|aac|wav|flac)(?:\.(?:part|ytdl|temp)|\.part-Frag\d{1,5}(?:\.part)?)?$/;

export interface LocalSyncCaptureInput {
  owner: LocalLibraryOwner;
  request_id: string;
  cache_key: string;
  video_id: string;
}
export interface LocalSyncCaptureRecord extends LocalSyncCaptureInput {
  version: 1;
  state: "pending" | "capturing" | "deferred" | "rejected" | "completed";
  created_at: number;
  updated_at: number;
  error_code?: string;
  attempt_id?: string;
  attempt_generation?: string;
  attempt_pid?: number;
  attempt_incarnation?: string;
}
export interface LocalSyncCaptureAttempt extends LocalSyncCaptureRecord {
  state: "capturing";
  attempt_id: string;
  attempt_generation: string;
  attempt_pid: number;
  attempt_incarnation: string;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validOwner(value: unknown): value is LocalLibraryOwner {
  return (
    object(value) &&
    Object.keys(value).every((key) =>
      ["uid", "session_generation"].includes(key),
    ) &&
    typeof value.uid === "string" &&
    value.uid.length > 0 &&
    value.uid.length <= 128 &&
    !/\p{Cc}/u.test(value.uid) &&
    typeof value.session_generation === "string" &&
    UUID.test(value.session_generation)
  );
}
function terminal(record: LocalSyncCaptureRecord): boolean {
  return record.state === "rejected" || record.state === "completed";
}
function live(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
async function privateJson(
  path: string,
): Promise<{ value: unknown; file: FileHandle }> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error("CAPTURE_UNSAFE");
  });
  try {
    const before = await file.stat(),
      named = await lstat(path);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      before.mode & 0o077 ||
      before.size > MAX_RECORD_BYTES ||
      named.isSymbolicLink() ||
      named.ino !== before.ino ||
      named.dev !== before.dev
    )
      throw new Error("CAPTURE_UNSAFE");
    const value: unknown = JSON.parse(await file.readFile("utf8")),
      after = await file.stat(),
      namedAfter = await lstat(path);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== namedAfter.ino ||
      before.dev !== namedAfter.dev ||
      namedAfter.isSymbolicLink()
    )
      throw new Error("CAPTURE_UNSAFE");
    return { value, file };
  } catch (error) {
    await file.close();
    if (error instanceof SyntaxError) throw new Error("CAPTURE_RECORD_INVALID");
    throw error;
  }
}
async function syncDirectory(path: string) {
  const file = await open(path, constants.O_RDONLY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Durable owner-scoped acquisition intentions; playback and authorization stay with the caller. */
export class LocalSyncCaptureQueue {
  private serial: Promise<unknown> = Promise.resolve();
  private readonly incarnation = randomUUID();
  constructor(
    private readonly root: string,
    private readonly cacheRoot: string,
  ) {
    if (!isAbsolute(root) || !isAbsolute(cacheRoot) || root === cacheRoot)
      throw new Error("CAPTURE_UNSAFE");
  }
  private uidKey(uid: string) {
    return createHash("sha256").update(uid).digest("hex");
  }
  private recordRoot(
    input: Pick<LocalSyncCaptureInput, "owner" | "request_id">,
  ) {
    return join(this.root, this.uidKey(input.owner.uid), input.request_id);
  }
  private locked<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.serial.then(() =>
      withCacheMutation(this.root, operation),
    );
    this.serial = task.catch(() => {});
    return task;
  }
  private validate(value: unknown): LocalSyncCaptureRecord {
    if (
      !object(value) ||
      Object.keys(value).some(
        (key) =>
          ![
            "version",
            "owner",
            "request_id",
            "cache_key",
            "video_id",
            "state",
            "created_at",
            "updated_at",
            "error_code",
            "attempt_id",
            "attempt_generation",
            "attempt_pid",
            "attempt_incarnation",
          ].includes(key),
      ) ||
      value.version !== 1 ||
      !validOwner(value.owner) ||
      typeof value.request_id !== "string" ||
      !UUID.test(value.request_id) ||
      typeof value.cache_key !== "string" ||
      !HASH.test(value.cache_key) ||
      !isVideoId(value.video_id) ||
      !["pending", "capturing", "deferred", "rejected", "completed"].includes(
        String(value.state),
      ) ||
      !Number.isSafeInteger(value.created_at) ||
      Number(value.created_at) < 0 ||
      !Number.isSafeInteger(value.updated_at) ||
      Number(value.updated_at) < Number(value.created_at) ||
      (value.error_code !== undefined &&
        (typeof value.error_code !== "string" || !CODE.test(value.error_code)))
    )
      throw new Error("CAPTURE_RECORD_INVALID");
    const attempt = [
      value.attempt_id,
      value.attempt_generation,
      value.attempt_pid,
      value.attempt_incarnation,
    ];
    if (attempt.some((field) => field !== undefined)) {
      if (
        typeof value.attempt_id !== "string" ||
        !UUID.test(value.attempt_id) ||
        typeof value.attempt_generation !== "string" ||
        !UUID.test(value.attempt_generation) ||
        !Number.isSafeInteger(value.attempt_pid) ||
        Number(value.attempt_pid) < 1 ||
        Number(value.attempt_pid) > 2_147_483_647 ||
        typeof value.attempt_incarnation !== "string" ||
        !UUID.test(value.attempt_incarnation) ||
        value.state === "pending"
      )
        throw new Error("CAPTURE_RECORD_INVALID");
    } else if (value.state === "capturing")
      throw new Error("CAPTURE_RECORD_INVALID");
    return value as unknown as LocalSyncCaptureRecord;
  }
  private async read(path: string): Promise<LocalSyncCaptureRecord> {
    await assertCacheDirectory(this.root, path);
    const { value, file } = await privateJson(join(path, "record.json"));
    try {
      return this.validate(value);
    } finally {
      await file.close();
    }
  }
  private async write(path: string, record: LocalSyncCaptureRecord) {
    this.validate(record);
    const bytes = Buffer.from(JSON.stringify(record));
    if (bytes.length > MAX_RECORD_BYTES)
      throw new Error("CAPTURE_RECORD_INVALID");
    const temporary = join(path, `.record-${randomUUID()}.tmp`),
      file = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, join(path, "record.json"));
      await syncDirectory(path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private async all(): Promise<LocalSyncCaptureRecord[]> {
    const accounts = await readdir(this.root);
    if (accounts.length > 256) throw new Error("CAPTURE_FULL");
    const records: LocalSyncCaptureRecord[] = [];
    for (const uid of accounts) {
      if (!HASH.test(uid)) continue;
      const path = join(this.root, uid);
      await assertCacheDirectory(this.root, path);
      const names = await readdir(path);
      if (names.length > MAX_UNFINISHED + MAX_RECEIPTS + 32)
        throw new Error("CAPTURE_FULL");
      for (const id of names) {
        if (id.startsWith(".ticket-") && UUID.test(id.slice(8)))
          throw new Error("CAPTURE_RECOVERY_REQUIRED");
        if (!UUID.test(id)) continue;
        if (records.length >= MAX_UNFINISHED + MAX_RECEIPTS)
          throw new Error("CAPTURE_FULL");
        const record = await this.read(join(path, id));
        if (record.request_id !== id || this.uidKey(record.owner.uid) !== uid)
          throw new Error("CAPTURE_RECORD_INVALID");
        records.push(record);
      }
    }
    return records;
  }
  private withoutAttempt(
    record: LocalSyncCaptureRecord,
  ): LocalSyncCaptureRecord {
    const {
      attempt_id: _id,
      attempt_generation: _generation,
      attempt_pid: _pid,
      attempt_incarnation: _incarnation,
      ...next
    } = record;
    return next;
  }
  private async compact(records: LocalSyncCaptureRecord[]) {
    const receipts = records
      .filter(terminal)
      .sort((a, b) => a.updated_at - b.updated_at);
    while (receipts.length >= MAX_RECEIPTS) {
      const record = receipts.shift()!;
      if (record.attempt_id) continue;
      const path = this.recordRoot(record),
        names = await readdir(path);
      if (names.some((name) => name !== "record.json"))
        throw new Error("CAPTURE_UNSAFE");
      await this.read(path);
      await rm(path, { recursive: true });
      await syncDirectory(join(this.root, this.uidKey(record.owner.uid)));
      records.splice(records.indexOf(record), 1);
    }
  }
  async stage(input: LocalSyncCaptureInput): Promise<LocalSyncCaptureRecord> {
    input = { ...input, owner: { ...input.owner } };
    const now = Date.now(),
      record = this.validate({
        ...input,
        version: 1,
        state: "pending",
        created_at: now,
        updated_at: now,
      });
    return this.locked(async () => {
      const records = await this.all(),
        existing = records.find(
          (entry) =>
            entry.owner.uid === input.owner.uid &&
            entry.cache_key === input.cache_key,
        );
      if (existing) {
        if (existing.video_id !== input.video_id)
          throw new Error("CAPTURE_REQUEST_CONFLICT");
        return existing;
      }
      if (
        records.some(
          (entry) =>
            entry.owner.uid === input.owner.uid &&
            entry.request_id === input.request_id,
        )
      )
        throw new Error("CAPTURE_REQUEST_CONFLICT");
      if (records.filter((entry) => !terminal(entry)).length >= MAX_UNFINISHED)
        throw new Error("CAPTURE_FULL");
      const vocals = join(this.cacheRoot, "vocals", input.cache_key);
      if (
        !(await assertCacheDirectory(this.cacheRoot, this.cacheRoot)) ||
        !(await assertCacheDirectory(
          this.cacheRoot,
          join(this.cacheRoot, "vocals"),
        )) ||
        !(await assertCacheDirectory(this.cacheRoot, vocals))
      )
        throw new Error("CAPTURE_CACHE_MISSING");
      const bytes = await cacheFileBytes(
        this.cacheRoot,
        join(vocals, "vocals.mp3"),
      );
      if (bytes === null || bytes <= 0 || bytes > 60 * 1024 ** 2)
        throw new Error("CAPTURE_CACHE_MISSING");
      await this.compact(records);
      const final = this.recordRoot(record),
        account = join(this.root, this.uidKey(input.owner.uid));
      await assertCacheDirectory(this.root, account, true);
      const temporary = join(account, `.ticket-${input.request_id}`);
      await mkdir(temporary, { mode: 0o700 });
      await this.write(temporary, record);
      await rename(temporary, final);
      await syncDirectory(account);
      return record;
    });
  }
  async list(owner: LocalLibraryOwner): Promise<LocalSyncCaptureRecord[]> {
    owner = { ...owner };
    if (!validOwner(owner)) throw new Error("CAPTURE_ACCOUNT_INVALID");
    return this.locked(async () =>
      (await this.all()).filter((record) => record.owner.uid === owner.uid),
    );
  }
  async pinnedCacheKeys(): Promise<Set<string>> {
    return this.locked(
      async () =>
        new Set(
          (await this.all())
            .filter((record) => !terminal(record))
            .map((record) => record.cache_key),
        ),
    );
  }
  attemptRoot(record: LocalSyncCaptureRecord): string {
    this.validate(record);
    if (!record.attempt_id) throw new Error("CAPTURE_STALE_ATTEMPT");
    return join(this.cacheRoot, "capture-attempts", record.attempt_id);
  }
  private marker(record: LocalSyncCaptureRecord) {
    return {
      version: 1,
      pid: record.attempt_pid,
      attempt_id: record.attempt_id,
      ticket_id: record.request_id,
      incarnation: record.attempt_incarnation,
    };
  }
  private async createAttempt(record: LocalSyncCaptureAttempt) {
    const path = this.attemptRoot(record);
    await assertCacheDirectory(this.cacheRoot, path, true);
    const temporary = join(path, `.capture-attempt-${record.attempt_id}.tmp`);
    const file = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await file.writeFile(JSON.stringify(this.marker(record)));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(path, ATTEMPT_MARKER));
    await syncDirectory(path);
    await syncDirectory(join(this.cacheRoot, "capture-attempts"));
  }
  private async cleanupAttempt(record: LocalSyncCaptureRecord) {
    if (!record.attempt_id) return;
    const path = this.attemptRoot(record);
    if (
      !(await assertCacheDirectory(this.cacheRoot, this.cacheRoot)) ||
      !(await assertCacheDirectory(
        this.cacheRoot,
        join(this.cacheRoot, "capture-attempts"),
      )) ||
      !(await assertCacheDirectory(this.cacheRoot, path))
    )
      return;
    const directory = await lstat(path),
      names = await readdir(path);
    if (!names.includes(ATTEMPT_MARKER)) {
      // No acquisition can start before beginAttempt returns. A crash while
      // publishing its marker can therefore leave only this private temp.
      const temporary = `.capture-attempt-${record.attempt_id}.tmp`;
      if (names.some((name) => name !== temporary))
        throw new Error("CAPTURE_UNSAFE");
      if (names.length) {
        const bytes = await cacheFileBytes(
          this.cacheRoot,
          join(path, temporary),
        );
        if (bytes === null || bytes > MAX_RECORD_BYTES)
          throw new Error("CAPTURE_UNSAFE");
      }
      const current = await lstat(path);
      if (current.ino !== directory.ino || current.dev !== directory.dev)
        throw new Error("CAPTURE_UNSAFE");
      await rm(path, { recursive: true });
      await syncDirectory(join(this.cacheRoot, "capture-attempts"));
      return;
    }
    const { value, file } = await privateJson(join(path, ATTEMPT_MARKER));
    let marker;
    try {
      marker = await file.stat();
    } finally {
      await file.close();
    }
    const expected = this.marker(record);
    if (
      !object(value) ||
      Object.keys(value).length !== 5 ||
      Object.entries(expected).some(([key, field]) => value[key] !== field)
    )
      throw new Error("CAPTURE_UNSAFE");
    if (
      names.length > 64 ||
      names.some((name) => name !== ATTEMPT_MARKER && !SOURCE.test(name))
    )
      throw new Error("CAPTURE_UNSAFE");
    let total = 0;
    for (const name of names) {
      const size = await cacheFileBytes(this.cacheRoot, join(path, name));
      if (
        size === null ||
        size >
          (name === ATTEMPT_MARKER
            ? MAX_RECORD_BYTES
            : name.endsWith(".ytdl")
              ? MAX_RESUME_BYTES
              : MAX_SOURCE_BYTES)
      )
        throw new Error("CAPTURE_UNSAFE");
      if (name !== ATTEMPT_MARKER && !name.endsWith(".ytdl")) total += size;
    }
    if (total > MAX_SOURCE_BYTES) throw new Error("CAPTURE_SOURCE_LIMIT");
    const named = await lstat(join(path, ATTEMPT_MARKER)),
      current = await lstat(path);
    if (
      named.ino !== marker.ino ||
      named.dev !== marker.dev ||
      current.ino !== directory.ino ||
      current.dev !== directory.dev
    )
      throw new Error("CAPTURE_UNSAFE");
    await rm(path, { recursive: true });
    await syncDirectory(join(this.cacheRoot, "capture-attempts"));
  }
  private attemptOwner(
    record: LocalSyncCaptureRecord,
    owner: LocalLibraryOwner,
    id: string,
  ) {
    if (
      record.state !== "capturing" ||
      record.owner.uid !== owner.uid ||
      record.attempt_generation !== owner.session_generation ||
      record.attempt_id !== id ||
      record.attempt_pid !== process.pid ||
      record.attempt_incarnation !== this.incarnation
    )
      throw new Error("CAPTURE_STALE_ATTEMPT");
  }
  async beginAttempt(
    owner: LocalLibraryOwner,
    id: string,
  ): Promise<LocalSyncCaptureAttempt> {
    owner = { ...owner };
    if (!validOwner(owner) || !UUID.test(id))
      throw new Error("CAPTURE_ACCOUNT_INVALID");
    return this.locked(async () => {
      const records = await this.all(),
        record = records.find(
          (entry) => entry.owner.uid === owner.uid && entry.request_id === id,
        );
      if (!record) throw new Error("CAPTURE_TICKET_MISSING");
      if (terminal(record)) throw new Error("CAPTURE_ALREADY_FINISHED");
      for (const entry of records) {
        if (!entry.attempt_id) continue;
        if (entry.state === "capturing" && live(entry.attempt_pid!))
          throw new Error("CAPTURE_BUSY");
        if (
          entry.request_id !== record.request_id ||
          entry.owner.uid !== record.owner.uid
        ) {
          await this.cleanupAttempt(entry);
          await this.write(this.recordRoot(entry), {
            ...this.withoutAttempt(entry),
            ...(entry.state === "capturing"
              ? { state: "deferred", error_code: "CAPTURE_INTERRUPTED" }
              : {}),
            updated_at: Math.max(Date.now(), entry.updated_at),
          });
        }
      }
      if (record.attempt_id) await this.cleanupAttempt(record);
      const { error_code: _error, ...rest } = this.withoutAttempt(record);
      const next: LocalSyncCaptureAttempt = {
        ...rest,
        state: "capturing",
        attempt_id: randomUUID(),
        attempt_generation: owner.session_generation,
        attempt_pid: process.pid,
        attempt_incarnation: this.incarnation,
        updated_at: Math.max(Date.now(), record.updated_at),
      };
      await this.write(this.recordRoot(next), next);
      try {
        await this.createAttempt(next);
      } catch (error) {
        // No bytes have been acquired yet. Release our live lease on ordinary
        // staging failures rather than leaving the current process BUSY.
        const deferred: LocalSyncCaptureRecord = {
          ...next,
          state: "deferred",
          error_code: "CAPTURE_PREPARE_FAILED",
          updated_at: Math.max(Date.now(), next.updated_at),
        };
        await this.write(this.recordRoot(next), deferred);
        await this.cleanupAttempt(deferred);
        await this.write(this.recordRoot(next), this.withoutAttempt(deferred));
        throw error;
      }
      return next;
    });
  }
  private async finish(
    owner: LocalLibraryOwner,
    id: string,
    attemptId: string,
    state: "deferred" | "rejected" | "completed",
    code?: string,
  ): Promise<LocalSyncCaptureRecord> {
    owner = { ...owner };
    if (
      !validOwner(owner) ||
      !UUID.test(id) ||
      !UUID.test(attemptId) ||
      (code !== undefined && !CODE.test(code))
    )
      throw new Error("CAPTURE_ACCOUNT_INVALID");
    return this.locked(async () => {
      const record = await this.read(
        this.recordRoot({ owner, request_id: id }),
      );
      if (record.owner.uid !== owner.uid || record.request_id !== id)
        throw new Error("CAPTURE_ACCOUNT_INVALID");
      if (record.state === "completed" && state === "completed") return record;
      this.attemptOwner(record, owner, attemptId);
      const { error_code: _error, ...rest } = record;
      let next: LocalSyncCaptureRecord = {
        ...rest,
        state,
        ...(code ? { error_code: code } : {}),
        updated_at: Math.max(Date.now(), record.updated_at),
      };
      await this.write(this.recordRoot(next), next);
      await this.cleanupAttempt(next);
      next = this.withoutAttempt(next);
      await this.write(this.recordRoot(next), next);
      return next;
    });
  }
  failAttempt(
    owner: LocalLibraryOwner,
    id: string,
    code: string,
    attemptId: string,
    permanent = false,
  ): Promise<LocalSyncCaptureRecord> {
    return this.finish(
      owner,
      id,
      attemptId,
      permanent ? "rejected" : "deferred",
      code,
    );
  }
  completeAttempt(
    owner: LocalLibraryOwner,
    id: string,
    attemptId: string,
  ): Promise<LocalSyncCaptureRecord> {
    return this.finish(owner, id, attemptId, "completed");
  }
  async recover(): Promise<void> {
    return this.locked(async () => {
      const accounts = await readdir(this.root);
      if (accounts.length > 256) throw new Error("CAPTURE_FULL");
      for (const uid of accounts) {
        if (!HASH.test(uid)) continue;
        const account = join(this.root, uid);
        await assertCacheDirectory(this.root, account);
        const tickets = await readdir(account);
        if (tickets.length > MAX_UNFINISHED + MAX_RECEIPTS + 32)
          throw new Error("CAPTURE_FULL");
        for (const name of tickets) {
          if (!name.startsWith(".ticket-") || !UUID.test(name.slice(8)))
            continue;
          const path = join(account, name);
          await assertCacheDirectory(this.root, path);
          const files = await readdir(path);
          if (!files.length) {
            await rm(path, { recursive: true });
            await syncDirectory(account);
            continue;
          }
          if (
            files.some(
              (file) =>
                file !== "record.json" &&
                !/^\.record-[a-f0-9-]{36}\.tmp$/.test(file),
            )
          )
            throw new Error("CAPTURE_UNSAFE");
          if (!files.includes("record.json")) {
            if (files.length !== 1) throw new Error("CAPTURE_RECORD_INVALID");
            const temporary = join(path, files[0]!);
            let value: unknown;
            try {
              const decoded = await privateJson(temporary);
              value = decoded.value;
              await decoded.file.close();
            } catch (error) {
              // Only an interrupted JSON write is disposable here. A complete
              // but invalid identity is preserved for an explicit safe error.
              if (
                !(error instanceof Error) ||
                error.message !== "CAPTURE_RECORD_INVALID"
              )
                throw error;
              const bytes = await cacheFileBytes(this.root, temporary);
              if (bytes === null || bytes > MAX_RECORD_BYTES)
                throw new Error("CAPTURE_UNSAFE");
              await rm(path, { recursive: true });
              await syncDirectory(account);
              continue;
            }
            const record = this.validate(value);
            if (
              record.request_id !== name.slice(8) ||
              this.uidKey(record.owner.uid) !== uid
            )
              throw new Error("CAPTURE_RECORD_INVALID");
            await rename(temporary, join(path, "record.json"));
            await syncDirectory(path);
          }
          const record = await this.read(path);
          if (
            record.request_id !== name.slice(8) ||
            this.uidKey(record.owner.uid) !== uid
          )
            throw new Error("CAPTURE_RECORD_INVALID");
          await rename(path, this.recordRoot(record));
          await syncDirectory(account);
        }
      }
      const records = await this.all();
      for (const record of records) {
        const path = this.recordRoot(record);
        for (const name of await readdir(path)) {
          if (!/^\.record-[a-f0-9-]{36}\.tmp$/.test(name)) continue;
          const bytes = await cacheFileBytes(this.root, join(path, name));
          if (bytes === null || bytes > MAX_RECORD_BYTES)
            throw new Error("CAPTURE_UNSAFE");
          await unlink(join(path, name));
        }
        if (
          !record.attempt_id ||
          (record.state === "capturing" && live(record.attempt_pid!))
        )
          continue;
        await this.cleanupAttempt(record);
        await this.write(path, {
          ...this.withoutAttempt(record),
          ...(record.state === "capturing"
            ? { state: "deferred", error_code: "CAPTURE_INTERRUPTED" }
            : {}),
          updated_at: Math.max(Date.now(), record.updated_at),
        });
      }
      await this.compact(await this.all());
    });
  }
}

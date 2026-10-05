import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { privateDirectory } from "./app-setup.js";
export { OFFLINE_VOCALS_BUDGET_BYTES } from "../shared/storage-policy.js";
import {
  isVideoId,
  MVP_MAX_DURATION_SECONDS,
  type LocalAudioArtifact,
  type LocalAudioSource,
} from "../shared/protocol.js";

/** Temporary originals have a separate, deliberately smaller bounded queue. */
export const PENDING_ORIGINALS_BUDGET_BYTES = 256 * 1024 ** 2;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_RECORDS = 256;
const WRITER_WAIT_MS = 2_000;
const WRITER_BACKOFF_MS = 25;
const PROFILE = "kim-vocal-2-full-timeline-v1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const TYPES: Readonly<Record<string, string>> = Object.freeze({
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  webm: "audio/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  aac: "audio/aac",
});

export interface LocalLibraryOwner {
  uid: string;
  session_generation: string;
}
export interface LocalSyncStage {
  owner: LocalLibraryOwner;
  request_id: string;
  cache_key: string;
  original: LocalAudioArtifact;
  vocals: LocalAudioArtifact;
  source?: LocalAudioSource;
  title?: string;
}
export interface LocalSyncReceipt {
  sync_id: string;
  job_id: string;
  committed: true;
}
export interface LocalSyncRecord extends LocalSyncStage {
  version: 1;
  profile: typeof PROFILE;
  state: "pending" | "uploading" | "failed" | "committed";
  created_at: number;
  updated_at: number;
  attempt_generation?: string;
  attempt_id?: string;
  attempt_pid?: number;
  attempt_incarnation?: string;
  error_code?: string;
  receipt?: LocalSyncReceipt;
}
export interface LocalSyncOutboxLimits {
  pending_original_bytes?: number;
  minimum_free_bytes?: number;
  max_records?: number;
}
const RECOVERY_FILENAME = "local-sync-recovery.json";
interface LocalPairRecovery {
  version: 1;
  owner: LocalLibraryOwner;
  request_id: string;
  cache_key: string;
  original: Omit<LocalAudioArtifact, "path">;
  vocals: Omit<LocalAudioArtifact, "path">;
  source?: LocalAudioSource;
  title?: string;
}

function owner(value: unknown): value is LocalLibraryOwner {
  if (!value || typeof value !== "object") return false;
  const entry = value as LocalLibraryOwner;
  return (
    Object.keys(entry).every((key) =>
      ["uid", "session_generation"].includes(key),
    ) &&
    typeof entry.uid === "string" &&
    entry.uid.length > 0 &&
    entry.uid.length <= 128 &&
    !/\p{Cc}/u.test(entry.uid) &&
    typeof entry.session_generation === "string" &&
    UUID.test(entry.session_generation)
  );
}
function artifact(value: unknown): value is LocalAudioArtifact {
  if (!value || typeof value !== "object") return false;
  const entry = value as LocalAudioArtifact;
  return (
    Object.keys(entry).every((key) =>
      [
        "path",
        "extension",
        "duration_seconds",
        "bytes",
        "sha256",
        "content_type",
      ].includes(key),
    ) &&
    typeof entry.path === "string" &&
    isAbsolute(entry.path) &&
    typeof entry.extension === "string" &&
    TYPES[entry.extension] === entry.content_type &&
    Number.isSafeInteger(entry.bytes) &&
    entry.bytes > 0 &&
    entry.bytes <= PENDING_ORIGINALS_BUDGET_BYTES &&
    Number.isFinite(entry.duration_seconds) &&
    entry.duration_seconds > 0 &&
    entry.duration_seconds <= MVP_MAX_DURATION_SECONDS &&
    typeof entry.sha256 === "string" &&
    HASH.test(entry.sha256)
  );
}
function source(value: unknown): value is LocalAudioSource {
  if (!value || typeof value !== "object") return false;
  const entry = value as LocalAudioSource;
  return (
    Object.keys(entry).every((key) =>
      [
        "kind",
        "video_id",
        "format_id",
        "audio_track_id",
        "audio_is_default",
        "language",
      ].includes(key),
    ) &&
    entry.kind === "youtube" &&
    isVideoId(entry.video_id) &&
    typeof entry.format_id === "string" &&
    /^[A-Za-z0-9_.-]{1,80}$/.test(entry.format_id) &&
    (entry.audio_track_id === null ||
      (typeof entry.audio_track_id === "string" &&
        /^[A-Za-z0-9_.-]{1,128}$/.test(entry.audio_track_id))) &&
    (entry.audio_is_default === null ||
      typeof entry.audio_is_default === "boolean") &&
    (entry.language === null ||
      (typeof entry.language === "string" &&
        /^[A-Za-z0-9_-]{1,64}$/.test(entry.language)))
  );
}
function receipt(value: unknown): value is LocalSyncReceipt {
  if (!value || typeof value !== "object") return false;
  const entry = value as LocalSyncReceipt;
  return (
    Object.keys(entry).every((key) =>
      ["sync_id", "job_id", "committed"].includes(key),
    ) &&
    typeof entry.sync_id === "string" &&
    (UUID.test(entry.sync_id) || /^[0-9a-f]{24}$/.test(entry.sync_id)) &&
    typeof entry.job_id === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(entry.job_id) &&
    entry.committed === true
  );
}
function within(root: string, path: string): boolean {
  const difference = relative(root, path);
  return (
    difference !== "" && !difference.startsWith("..") && !isAbsolute(difference)
  );
}
async function privateFile(
  path: string,
  maxBytes: number,
  maxLinks = 1,
): Promise<FileHandle> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    const named = await lstat(path);
    if (
      !info.isFile() ||
      info.nlink > maxLinks ||
      info.nlink < 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      info.size > maxBytes ||
      named.isSymbolicLink() ||
      info.ino !== named.ino ||
      info.dev !== named.dev
    )
      throw new Error("OUTBOX_UNSAFE");
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
async function durableDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function recoveryStage(
  cacheRoot: string,
  workRoot: string,
  value: unknown,
): LocalSyncStage {
  if (!value || typeof value !== "object")
    throw new Error("OUTBOX_RECOVERY_INVALID");
  const record = value as LocalPairRecovery;
  const original = record.original && {
    ...record.original,
    path: join(workRoot, `source.${record.original.extension}`),
  };
  const vocals = record.vocals && {
    ...record.vocals,
    path: join(cacheRoot, "vocals", record.cache_key, "vocals.mp3"),
  };
  if (
    !Object.keys(record).every((key) =>
      [
        "version",
        "owner",
        "request_id",
        "cache_key",
        "original",
        "vocals",
        "source",
        "title",
      ].includes(key),
    ) ||
    record.version !== 1 ||
    !owner(record.owner) ||
    !UUID.test(record.request_id) ||
    basename(workRoot) !== record.request_id ||
    !HASH.test(record.cache_key) ||
    !artifact(original) ||
    !artifact(vocals) ||
    "path" in record.original ||
    "path" in record.vocals ||
    vocals.extension !== "mp3" ||
    Math.abs(original.duration_seconds - vocals.duration_seconds) > 0.25 ||
    (record.source !== undefined && !source(record.source)) ||
    (record.title !== undefined &&
      (typeof record.title !== "string" ||
        record.title.length > 300 ||
        /\p{Cc}/u.test(record.title)))
  )
    throw new Error("OUTBOX_RECOVERY_INVALID");
  return { ...record, original, vocals };
}

/** A token-free native recovery ticket lives with the exact acquired source. */
export async function preserveLocalPairRecovery(
  cacheRoot: string,
  input: LocalSyncStage,
): Promise<void> {
  const workRoot = join(cacheRoot, "jobs", input.request_id);
  const { path: originalPath, ...original } = input.original;
  const { path: vocalPath, ...vocals } = input.vocals;
  const recovery: LocalPairRecovery = {
    version: 1,
    owner: { ...input.owner },
    request_id: input.request_id,
    cache_key: input.cache_key,
    original,
    vocals,
    ...(input.source ? { source: { ...input.source } } : {}),
    ...(input.title ? { title: input.title } : {}),
  };
  const checked = recoveryStage(cacheRoot, workRoot, recovery);
  if (
    checked.original.path !== originalPath ||
    checked.vocals.path !== vocalPath
  )
    throw new Error("OUTBOX_RECOVERY_INVALID");
  for (const path of [cacheRoot, join(cacheRoot, "jobs"), workRoot]) {
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077
    )
      throw new Error("OUTBOX_UNSAFE");
  }
  const handle = await privateFile(originalPath, original.bytes);
  try {
    if ((await handle.stat()).size !== original.bytes)
      throw new Error("OUTBOX_ARTIFACT_INVALID");
  } finally {
    await handle.close();
  }
  const bytes = Buffer.from(JSON.stringify(recovery));
  if (bytes.length > MAX_RECORD_BYTES)
    throw new Error("OUTBOX_RECOVERY_INVALID");
  const temporary = join(workRoot, `.local-sync-${randomUUID()}.tmp`);
  const output = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await output.writeFile(bytes);
    await output.sync();
  } finally {
    await output.close();
  }
  await rename(temporary, join(workRoot, RECOVERY_FILENAME));
  await durableDirectory(workRoot);
}

/** Retain only source plus recovery metadata, never the inference scratch tree. */
export async function retainLocalPairRecoverySource(
  cacheRoot: string,
  input: LocalSyncStage,
): Promise<void> {
  const workRoot = join(cacheRoot, "jobs", input.request_id);
  if (
    !UUID.test(input.request_id) ||
    input.original.path !==
      join(workRoot, `source.${input.original.extension}`) ||
    !artifact(input.original)
  )
    throw new Error("OUTBOX_RECOVERY_INVALID");
  const info = await lstat(workRoot);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077
  )
    throw new Error("OUTBOX_UNSAFE");
  for (const name of await readdir(workRoot)) {
    if (
      name === basename(input.original.path) ||
      name === RECOVERY_FILENAME ||
      (name.startsWith(".local-sync-") &&
        name.endsWith(".tmp") &&
        UUID.test(name.slice(12, -4)))
    )
      continue;
    await rm(join(workRoot, name), { recursive: true, force: true });
  }
  // Removing disposable WAV/output files can free space after a first ENOSPC.
  // Retry the captured ticket before leaving the only original for recovery.
  await preserveLocalPairRecovery(cacheRoot, input);
  await durableDirectory(workRoot);
}

/** Account-bound private media staging. Network tokens and grants belong to callers only. */
export class LocalSyncOutbox {
  private serial: Promise<unknown> = Promise.resolve();
  private readonly originalBudget: number;
  private readonly diskReserve: number;
  private readonly recordLimit: number;
  private readonly incarnation = randomUUID();
  constructor(
    private readonly root: string,
    private readonly cacheRoot: string,
    limits: LocalSyncOutboxLimits = {},
  ) {
    if (!isAbsolute(root) || !isAbsolute(cacheRoot))
      throw new Error("OUTBOX_UNSAFE");
    this.originalBudget =
      limits.pending_original_bytes ?? PENDING_ORIGINALS_BUDGET_BYTES;
    this.diskReserve = limits.minimum_free_bytes ?? 3 * 1024 ** 3;
    this.recordLimit = limits.max_records ?? MAX_RECORDS;
    if (
      ![this.originalBudget, this.diskReserve, this.recordLimit].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ) ||
      this.originalBudget > PENDING_ORIGINALS_BUDGET_BYTES ||
      this.recordLimit < 1 ||
      this.recordLimit > MAX_RECORDS
    )
      throw new Error("OUTBOX_LIMIT_INVALID");
  }
  private key(uid: string): string {
    return createHash("sha256").update(uid).digest("hex");
  }
  private recordRoot(
    value: Pick<LocalSyncStage, "owner" | "request_id">,
  ): string {
    return join(this.root, this.key(value.owner.uid), value.request_id);
  }
  private async directory(path: string, create = false): Promise<void> {
    if (create) await privateDirectory(path);
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077
    )
      throw new Error("OUTBOX_UNSAFE");
    if (
      path !== this.root &&
      !within(await realpath(this.root), await realpath(path))
    )
      throw new Error("OUTBOX_UNSAFE");
  }
  private async locked<T>(action: () => Promise<T>): Promise<T> {
    const task = this.serial.then(async () => {
      await this.directory(this.root, true);
      const lockPath = join(this.root, ".writer.lock");
      const deadline = performance.now() + WRITER_WAIT_MS;
      const waitForWriter = async () => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error("OUTBOX_BUSY");
        await delay(Math.min(WRITER_BACKOFF_MS, remaining));
        if (performance.now() >= deadline) throw new Error("OUTBOX_BUSY");
      };
      const publishLock = async () => {
        const temporary = join(this.root, `.writer-${randomUUID()}.tmp`);
        const handle = await open(
          temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        try {
          // An exclusively linked lock always has a complete PID, including a crash during publication.
          await handle.writeFile(String(process.pid));
          await handle.sync();
          await link(temporary, lockPath);
          return handle;
        } catch (error) {
          await handle.close();
          throw error;
        } finally {
          await unlink(temporary);
        }
      };
      const readWriter = async () => {
        let existing: FileHandle;
        try {
          existing = await open(
            lockPath,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          if ((error as NodeJS.ErrnoException).code === "ELOOP")
            throw new Error("OUTBOX_UNSAFE");
          throw error;
        }
        try {
          const identity = await existing.stat();
          const current = await lstat(lockPath);
          if (current.isSymbolicLink()) throw new Error("OUTBOX_UNSAFE");
          // A normal owner may have released or replaced this name after open.
          if (current.ino !== identity.ino || current.dev !== identity.dev)
            return null;
          if (
            !identity.isFile() ||
            identity.nlink < 1 ||
            identity.nlink > 2 ||
            identity.uid !== process.getuid?.() ||
            identity.mode & 0o077 ||
            identity.size > 128
          )
            throw new Error("OUTBOX_UNSAFE");
          const pid = Number(await existing.readFile("utf8"));
          if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647)
            throw new Error("OUTBOX_BUSY");
          return { pid, identity };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        } finally {
          await existing.close();
        }
      };
      let lock: FileHandle;
      for (;;) {
        try {
          lock = await publishLock();
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const writer = await readWriter();
        if (writer) {
          let alive = true;
          try {
            process.kill(writer.pid, 0);
          } catch (error) {
            alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
          }
          if (!alive) {
            try {
              const current = await lstat(lockPath);
              if (
                current.ino === writer.identity.ino &&
                current.dev === writer.identity.dev &&
                !current.isSymbolicLink()
              )
                await unlink(lockPath);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
          }
        }
        // Wait only for local state ownership; no acquisition or upload is retried.
        await waitForWriter();
      }
      try {
        return await action();
      } finally {
        await this.releaseLock(lock, lockPath);
      }
    });
    this.serial = task.catch(() => {});
    return task;
  }
  private async releaseLock(lock: FileHandle, path: string): Promise<void> {
    const identity = await lock.stat();
    await lock.close();
    const current = await lstat(path);
    if (current.ino !== identity.ino || current.dev !== identity.dev)
      throw new Error("OUTBOX_UNSAFE");
    await unlink(path);
  }
  private validate(value: unknown, path: string): LocalSyncRecord {
    if (!value || typeof value !== "object")
      throw new Error("OUTBOX_RECORD_INVALID");
    const record = value as LocalSyncRecord;
    if (
      !Object.keys(record).every((key) =>
        [
          "owner",
          "request_id",
          "cache_key",
          "original",
          "vocals",
          "source",
          "title",
          "version",
          "profile",
          "state",
          "created_at",
          "updated_at",
          "attempt_generation",
          "attempt_id",
          "attempt_pid",
          "attempt_incarnation",
          "error_code",
          "receipt",
        ].includes(key),
      ) ||
      record.version !== 1 ||
      record.profile !== PROFILE ||
      !owner(record.owner) ||
      !UUID.test(record.request_id) ||
      !HASH.test(record.cache_key) ||
      !artifact(record.original) ||
      !artifact(record.vocals) ||
      record.vocals.extension !== "mp3" ||
      Math.abs(
        record.original.duration_seconds - record.vocals.duration_seconds,
      ) > 0.25 ||
      record.original.path !==
        join(path, `original.${record.original.extension}`) ||
      record.vocals.path !==
        join(this.cacheRoot, "vocals", record.cache_key, "vocals.mp3") ||
      !["pending", "uploading", "failed", "committed"].includes(record.state) ||
      !Number.isSafeInteger(record.created_at) ||
      !Number.isSafeInteger(record.updated_at) ||
      record.created_at < 0 ||
      record.updated_at < record.created_at ||
      (record.title !== undefined &&
        (typeof record.title !== "string" ||
          record.title.length > 300 ||
          /\p{Cc}/u.test(record.title))) ||
      (record.source !== undefined && !source(record.source)) ||
      (record.attempt_generation !== undefined &&
        (typeof record.attempt_generation !== "string" ||
          !UUID.test(record.attempt_generation))) ||
      (record.attempt_id !== undefined &&
        (typeof record.attempt_id !== "string" ||
          !UUID.test(record.attempt_id))) ||
      (record.attempt_pid !== undefined &&
        (!Number.isSafeInteger(record.attempt_pid) ||
          record.attempt_pid <= 0)) ||
      (record.attempt_incarnation !== undefined &&
        (typeof record.attempt_incarnation !== "string" ||
          !UUID.test(record.attempt_incarnation))) ||
      (record.error_code !== undefined &&
        !/^[A-Z][A-Z_0-9]{2,64}$/.test(record.error_code)) ||
      (record.state === "uploading" &&
        (record.attempt_generation === undefined ||
          record.attempt_id === undefined ||
          record.attempt_pid === undefined ||
          record.attempt_incarnation === undefined)) ||
      (record.state === "committed"
        ? !receipt(record.receipt)
        : record.receipt !== undefined)
    )
      throw new Error("OUTBOX_RECORD_INVALID");
    return record;
  }
  private async read(path: string): Promise<LocalSyncRecord> {
    await this.directory(path);
    const handle = await privateFile(
      join(path, "record.json"),
      MAX_RECORD_BYTES,
    );
    try {
      return this.validate(JSON.parse(await handle.readFile("utf8")), path);
    } finally {
      await handle.close();
    }
  }
  private async write(path: string, record: LocalSyncRecord): Promise<void> {
    this.validate(record, path);
    const bytes = Buffer.from(JSON.stringify(record));
    if (bytes.length > MAX_RECORD_BYTES)
      throw new Error("OUTBOX_RECORD_INVALID");
    const temporary = join(path, `.record-${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, join(path, "record.json"));
      await durableDirectory(path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private async verifyArtifact(
    item: LocalAudioArtifact,
    expectedRoot: string,
  ): Promise<void> {
    if (
      !artifact(item) ||
      !within(await realpath(expectedRoot), await realpath(item.path))
    )
      throw new Error("OUTBOX_UNSAFE");
    const handle = await privateFile(item.path, item.bytes);
    try {
      const before = await handle.stat();
      const hash = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false }))
        hash.update(chunk);
      const after = await handle.stat();
      if (
        before.size !== item.bytes ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        hash.digest("hex") !== item.sha256
      )
        throw new Error("OUTBOX_ARTIFACT_INVALID");
    } finally {
      await handle.close();
    }
  }
  private async copyOriginal(
    item: LocalAudioArtifact,
    target: string,
  ): Promise<void> {
    await this.verifyArtifact(item, this.cacheRoot);
    const input = await privateFile(item.path, item.bytes);
    let output: FileHandle;
    try {
      output = await open(
        target,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
    } catch (error) {
      await input.close();
      throw error;
    }
    try {
      const hash = createHash("sha256");
      let copied = 0;
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        copied += chunk.length;
        if (copied > item.bytes) throw new Error("OUTBOX_ARTIFACT_INVALID");
        hash.update(chunk);
        let written = 0;
        while (written < chunk.length) {
          const progress = (
            await output.write(chunk, written, chunk.length - written)
          ).bytesWritten;
          if (progress <= 0) throw new Error("OUTBOX_WRITE_FAILED");
          written += progress;
        }
      }
      if (copied !== item.bytes || hash.digest("hex") !== item.sha256)
        throw new Error("OUTBOX_ARTIFACT_INVALID");
      await output.sync();
    } finally {
      await input.close();
      await output.close();
    }
  }
  private async all(): Promise<LocalSyncRecord[]> {
    const records: LocalSyncRecord[] = [];
    for (const uidKey of await readdir(this.root)) {
      if (!HASH.test(uidKey)) continue;
      const account = join(this.root, uidKey);
      await this.directory(account);
      for (const requestId of await readdir(account)) {
        if (requestId.startsWith(".pending-") && UUID.test(requestId.slice(9)))
          throw new Error("OUTBOX_RECOVERY_REQUIRED");
        if (!UUID.test(requestId)) continue;
        if (records.length >= MAX_RECORDS)
          throw new Error("OUTBOX_RECORD_LIMIT");
        const record = await this.read(join(account, requestId));
        if (
          this.key(record.owner.uid) !== uidKey ||
          record.request_id !== requestId
        )
          throw new Error("OUTBOX_RECORD_INVALID");
        records.push(record);
      }
    }
    return records;
  }
  private async recoveries(
    promoteTemporary = false,
  ): Promise<LocalSyncStage[]> {
    const jobs = join(this.cacheRoot, "jobs");
    const checkedDirectory = async (path: string) => {
      const info = await lstat(path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077
      )
        throw new Error("OUTBOX_UNSAFE");
    };
    try {
      await checkedDirectory(this.cacheRoot);
      await checkedDirectory(jobs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: LocalSyncStage[] = [];
    for (const id of await readdir(jobs)) {
      if (!UUID.test(id)) continue;
      const work = join(jobs, id);
      await checkedDirectory(work);
      const readRecovery = async (path: string) => {
        const file = await privateFile(path, MAX_RECORD_BYTES);
        try {
          return recoveryStage(
            this.cacheRoot,
            work,
            JSON.parse(await file.readFile("utf8")),
          );
        } finally {
          await file.close();
        }
      };
      let entry: LocalSyncStage | undefined;
      try {
        entry = await readRecovery(join(work, RECOVERY_FILENAME));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const temporary = (await readdir(work)).filter(
          (name) =>
            name.startsWith(".local-sync-") &&
            name.endsWith(".tmp") &&
            UUID.test(name.slice(12, -4)),
        );
        if (!temporary.length) continue;
        if (!promoteTemporary || temporary.length !== 1)
          throw new Error("OUTBOX_RECOVERY_REQUIRED");
        entry = await readRecovery(join(work, temporary[0]!));
        await rename(join(work, temporary[0]!), join(work, RECOVERY_FILENAME));
        await durableDirectory(work);
      }
      if (entries.length >= MAX_RECORDS) throw new Error("OUTBOX_RECORD_LIMIT");
      entries.push(entry);
    }
    return entries;
  }
  private async admission(
    bytes: number,
    records: LocalSyncRecord[],
    replacing?: LocalSyncStage,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      bytes > this.originalBudget
    )
      throw new Error("OUTBOX_FULL");
    const pending = records.filter((record) => record.state !== "committed");
    const recoveries = (await this.recoveries()).filter((entry) => {
      const existing = records.find(
        (record) =>
          record.owner.uid === entry.owner.uid &&
          record.request_id === entry.request_id,
      );
      if (
        existing &&
        (existing.cache_key !== entry.cache_key ||
          existing.original.sha256 !== entry.original.sha256 ||
          existing.vocals.sha256 !== entry.vocals.sha256)
      )
        throw new Error("OUTBOX_REQUEST_CONFLICT");
      return (
        !existing &&
        !(
          replacing &&
          replacing.owner.uid === entry.owner.uid &&
          replacing.request_id === entry.request_id
        )
      );
    });
    if (
      records.length + recoveries.length >= this.recordLimit ||
      pending.reduce((total, record) => total + record.original.bytes, 0) +
        recoveries.reduce((total, entry) => total + entry.original.bytes, 0) +
        bytes >
        this.originalBudget
    )
      throw new Error("OUTBOX_FULL");
    const disk = await statfs(this.root);
    if (Number(disk.bavail) * Number(disk.bsize) < this.diskReserve + bytes)
      throw new Error("DISK_SPACE_LOW");
  }
  private async pruneReceipts(
    records: LocalSyncRecord[],
  ): Promise<LocalSyncRecord[]> {
    const retained = [...records];
    for (const record of [...records]
      .filter((entry) => entry.state === "committed")
      .sort((a, b) => a.updated_at - b.updated_at)) {
      if (retained.length < this.recordLimit) break;
      const path = this.recordRoot(record);
      await this.removeOriginal(record);
      // Receipts are a bounded recovery journal; canonical account history lives on the server.
      if ((await readdir(path)).some((name) => name !== "record.json"))
        continue;
      const handle = await privateFile(
        join(path, "record.json"),
        MAX_RECORD_BYTES,
      );
      await handle.close();
      await rm(path, { recursive: true });
      await durableDirectory(dirname(path));
      retained.splice(retained.indexOf(record), 1);
    }
    return retained;
  }
  /** Check before acquisition. Caller keeps its one-processing-owner admission fence. */
  async assertAdmission(
    maxOriginalBytes = PENDING_ORIGINALS_BUDGET_BYTES,
  ): Promise<void> {
    return this.locked(async () =>
      this.admission(
        maxOriginalBytes,
        await this.pruneReceipts(await this.all()),
      ),
    );
  }
  async stage(input: LocalSyncStage): Promise<LocalSyncRecord> {
    input = {
      ...input,
      owner: { ...input.owner },
      original: { ...input.original },
      vocals: { ...input.vocals },
      ...(input.source ? { source: { ...input.source } } : {}),
    };
    if (
      !owner(input.owner) ||
      !UUID.test(input.request_id) ||
      !HASH.test(input.cache_key) ||
      !artifact(input.original) ||
      !artifact(input.vocals)
    )
      throw new Error("OUTBOX_RECORD_INVALID");
    return this.locked(() => this.stageLocked(input));
  }
  private async stageLocked(input: LocalSyncStage): Promise<LocalSyncRecord> {
    const final = this.recordRoot(input);
    let records = await this.all();
    const existing = records.find(
      (record) =>
        record.owner.uid === input.owner.uid &&
        record.request_id === input.request_id,
    );
    if (existing) {
      if (
        existing.original.sha256 !== input.original.sha256 ||
        existing.vocals.sha256 !== input.vocals.sha256 ||
        existing.cache_key !== input.cache_key
      )
        throw new Error("OUTBOX_REQUEST_CONFLICT");
      return existing;
    }
    records = await this.pruneReceipts(records);
    await this.admission(input.original.bytes, records, input);
    await this.verifyArtifact(input.vocals, this.cacheRoot);
    await this.directory(dirname(final), true);
    const temporary = join(dirname(final), `.pending-${input.request_id}`);
    const record: LocalSyncRecord = {
      ...input,
      original: {
        ...input.original,
        path: join(final, `original.${input.original.extension}`),
      },
      version: 1,
      profile: PROFILE,
      state: "pending",
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    this.validate(record, final);
    await mkdir(temporary, { mode: 0o700 });
    try {
      await this.copyOriginal(
        input.original,
        join(temporary, `original.${input.original.extension}`),
      );
      // Paths already name the final destination; recovery can promote this completed staging record.
      const handle = await open(
        join(temporary, "record.json"),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await durableDirectory(temporary);
      await rename(temporary, final);
      await durableDirectory(dirname(final));
      return record;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  async list(account: LocalLibraryOwner): Promise<LocalSyncRecord[]> {
    account = { ...account };
    if (!owner(account)) throw new Error("OUTBOX_ACCOUNT_INVALID");
    return this.locked(async () =>
      (await this.all()).filter((record) => record.owner.uid === account.uid),
    );
  }
  /** Bounded recovery receipts only; the desktop catalog owns complete Library metadata. */
  async associations(account: LocalLibraryOwner): Promise<LocalSyncRecord[]> {
    return (await this.list(account)).filter(
      (record) => record.state === "committed",
    );
  }
  async pinnedCacheKeys(): Promise<Set<string>> {
    return this.locked(async () => {
      const records = await this.all();
      return new Set([
        ...records
          .filter((record) => record.state !== "committed")
          .map((record) => record.cache_key),
        ...(await this.recoveries())
          .filter(
            (entry) =>
              !records.some(
                (record) =>
                  record.owner.uid === entry.owner.uid &&
                  record.request_id === entry.request_id &&
                  record.state === "committed",
              ),
          )
          .map((entry) => entry.cache_key),
      ]);
    });
  }
  async beginAttempt(
    account: LocalLibraryOwner,
    requestId: string,
  ): Promise<LocalSyncRecord> {
    account = { ...account };
    return this.modify(account, requestId, async (record) => {
      if (record.state === "committed") return record;
      if (
        record.state === "uploading" &&
        this.processAlive(record.attempt_pid!)
      )
        throw new Error("OUTBOX_BUSY");
      await this.verifyArtifact(record.original, this.root);
      await this.verifyArtifact(record.vocals, this.cacheRoot);
      const { error_code: _error, ...next } = record;
      return {
        ...next,
        state: "uploading",
        attempt_generation: account.session_generation,
        attempt_id: randomUUID(),
        attempt_pid: process.pid,
        attempt_incarnation: this.incarnation,
        updated_at: Math.max(Date.now(), record.updated_at),
      };
    });
  }
  async failAttempt(
    account: LocalLibraryOwner,
    requestId: string,
    code: string,
    attemptId: string,
  ): Promise<LocalSyncRecord> {
    account = { ...account };
    if (!/^[A-Z][A-Z_0-9]{2,64}$/.test(code))
      throw new Error("OUTBOX_ERROR_INVALID");
    return this.modify(account, requestId, async (record) => {
      this.attemptOwner(record, account, attemptId);
      const {
        attempt_id: _id,
        attempt_generation: _generation,
        attempt_pid: _pid,
        attempt_incarnation: _incarnation,
        ...rest
      } = record;
      return {
        ...rest,
        state: "failed",
        error_code: code,
        updated_at: Math.max(Date.now(), record.updated_at),
      };
    });
  }
  async commit(
    account: LocalLibraryOwner,
    requestId: string,
    confirmed: LocalSyncReceipt,
    attemptId: string,
  ): Promise<LocalSyncRecord> {
    confirmed = { ...confirmed };
    account = { ...account };
    if (!receipt(confirmed)) throw new Error("OUTBOX_RECEIPT_INVALID");
    return this.modify(account, requestId, async (record) => {
      if (record.state === "committed") {
        if (JSON.stringify(record.receipt) !== JSON.stringify(confirmed))
          throw new Error("OUTBOX_RECEIPT_CONFLICT");
        return record;
      }
      this.attemptOwner(record, account, attemptId);
      const {
        error_code: _error,
        attempt_generation: _attempt,
        attempt_id: _id,
        attempt_pid: _pid,
        attempt_incarnation: _incarnation,
        ...rest
      } = record;
      return {
        ...rest,
        state: "committed",
        receipt: confirmed,
        updated_at: Math.max(Date.now(), record.updated_at),
      };
    });
  }
  private attemptOwner(
    record: LocalSyncRecord,
    account: LocalLibraryOwner,
    attemptId: string,
  ): void {
    if (
      record.state !== "uploading" ||
      record.attempt_generation !== account.session_generation ||
      record.attempt_id !== attemptId ||
      record.attempt_pid !== process.pid ||
      record.attempt_incarnation !== this.incarnation
    )
      throw new Error("OUTBOX_STALE_ATTEMPT");
  }
  private processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      return true;
    }
  }
  private async modify(
    account: LocalLibraryOwner,
    requestId: string,
    change: (record: LocalSyncRecord) => Promise<LocalSyncRecord>,
  ): Promise<LocalSyncRecord> {
    account = { ...account };
    if (!owner(account) || !UUID.test(requestId))
      throw new Error("OUTBOX_ACCOUNT_INVALID");
    return this.locked(async () => {
      const path = this.recordRoot({ owner: account, request_id: requestId });
      const record = await this.read(path);
      if (record.owner.uid !== account.uid || record.request_id !== requestId)
        throw new Error("OUTBOX_ACCOUNT_INVALID");
      const next = await change(record);
      await this.write(path, next);
      // Persist confirmed publication before touching the only retained original.
      if (next.state === "committed") await this.removeOriginal(next);
      return next;
    });
  }
  private async removeOriginal(record: LocalSyncRecord): Promise<void> {
    try {
      const original = await privateFile(
        record.original.path,
        record.original.bytes,
      );
      await original.close();
      await unlink(record.original.path);
      await durableDirectory(dirname(record.original.path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  /** Startup recovery is explicit and fenced by the same cross-process writer lock. */
  async recover(): Promise<void> {
    return this.locked(async () => {
      for (const uidKey of await readdir(this.root)) {
        if (!HASH.test(uidKey)) continue;
        const account = join(this.root, uidKey);
        await this.directory(account);
        for (const name of await readdir(account)) {
          if (!name.startsWith(".pending-") || !UUID.test(name.slice(9)))
            continue;
          const temporary = join(account, name);
          await this.directory(temporary);
          const final = join(account, name.slice(9));
          let record: LocalSyncRecord | undefined;
          try {
            const handle = await privateFile(
              join(temporary, "record.json"),
              MAX_RECORD_BYTES,
            );
            try {
              record = this.validate(
                JSON.parse(await handle.readFile("utf8")),
                final,
              );
            } finally {
              await handle.close();
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          const allowed = new Set([
            "record.json",
            ...(record
              ? [`original.${record.original.extension}`]
              : Object.keys(TYPES).map((ext) => `original.${ext}`)),
          ]);
          if ((await readdir(temporary)).some((file) => !allowed.has(file)))
            throw new Error("OUTBOX_UNSAFE");
          if (record) {
            if (
              record.owner.uid.length === 0 ||
              this.key(record.owner.uid) !== uidKey ||
              record.request_id !== name.slice(9)
            )
              throw new Error("OUTBOX_RECORD_INVALID");
            await this.verifyArtifact(
              {
                ...record.original,
                path: join(temporary, `original.${record.original.extension}`),
              },
              this.root,
            );
            await this.verifyArtifact(record.vocals, this.cacheRoot);
            await rename(temporary, final);
          } else await rm(temporary, { recursive: true });
          await durableDirectory(account);
        }
      }
      for (const record of await this.all()) {
        const path = this.recordRoot(record);
        for (const name of await readdir(path)) {
          if (
            !name.startsWith(".record-") ||
            !name.endsWith(".tmp") ||
            !UUID.test(name.slice(8, -4))
          )
            continue;
          const temporary = join(path, name);
          const handle = await privateFile(temporary, MAX_RECORD_BYTES);
          await handle.close();
          await unlink(temporary);
        }
        if (record.state === "committed") await this.removeOriginal(record);
        else if (
          record.state === "uploading" &&
          !this.processAlive(record.attempt_pid!)
        ) {
          const {
            attempt_generation: _attempt,
            attempt_id: _id,
            attempt_pid: _pid,
            attempt_incarnation: _incarnation,
            ...rest
          } = record;
          await this.write(this.recordRoot(record), {
            ...rest,
            state: "pending",
            updated_at: Math.max(Date.now(), record.updated_at),
          });
        }
      }
      for (const input of await this.recoveries(true)) {
        try {
          await this.stageLocked(input);
        } catch (error) {
          if (
            error instanceof Error &&
            ["OUTBOX_FULL", "DISK_SPACE_LOW"].includes(error.message)
          )
            continue;
          throw error;
        }
        const work = join(this.cacheRoot, "jobs", input.request_id);
        await rm(work, { recursive: true });
        await durableDirectory(dirname(work));
      }
    });
  }
}

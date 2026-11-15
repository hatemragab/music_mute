import { constants } from "node:fs";
import { lstat, open, readdir, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { ensureLogFile } from "./backend-logs.mjs";

export function retentionPolicy(env = process.env) {
  const integer = (name, fallback, max) => {
    if (env[name] == null) return fallback;
    const value = Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error(`Invalid ${name}.`);
    return value;
  };
  return {
    maxBytes: integer("LOCAL_LOG_MAX_BYTES", 50 * 1024 * 1024, 1024 ** 3),
    maxArchives: integer("LOCAL_LOG_MAX_ARCHIVES", 7, 100),
    maxAgeMs: integer("LOCAL_LOG_MAX_AGE_DAYS", 7, 365) * 86400000,
    rotateAfterMs: 86400000,
  };
}

export function archiveName(file, now = new Date()) {
  return `${basename(file, ".jsonl")}.${now.toISOString().replace(/[-:.]/g, "")}-${randomBytes(4).toString("hex")}.jsonl`;
}

async function privateArchives(file) {
  const directory = join(dirname(file), "archives");
  // Validate ancestors before mkdir, and reject linked directories/files.
  await ensureLogFile(join(directory, ".retention"));
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Unsafe archive directory.");
  return directory;
}

/** Only call when this file's writer has flushed and closed its descriptor. */
export async function archiveCapture(file, now = new Date()) {
  const directory = await privateArchives(file);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new Error("Unsafe capture file.");
  if (!info.size) return null;
  const archive = join(directory, archiveName(file, now));
  await rename(file, archive);
  // Recreate the active path, never truncate or copy a file being written.
  await ensureLogFile(file);
  return archive;
}

export async function inputArchiveBudgetAvailable(file, policy) {
  const directory = await privateArchives(file);
  const prefix = `${basename(file, ".jsonl")}.`;
  let count = 0;
  for (const name of await readdir(directory)) {
    if (
      !name.startsWith(prefix) ||
      !/^\d{8}T\d{9}Z-[a-f0-9]{8}\.jsonl$/.test(name.slice(prefix.length))
    )
      continue;
    const info = await lstat(join(directory, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error("Unsafe archived input.");
    count++;
  }
  // One extra rollover lets the collector enforce the configured retention
  // count after acknowledgement. Outages preserve old inputs and reject new
  // captures once this finite backlog budget is full.
  return count <= policy.maxArchives;
}

/** Purge only our strict archive names; active inputs and other artifacts stay intact. */
export async function pruneArchives(
  file,
  policy,
  now = Date.now(),
  graceMs = 60000,
) {
  const directory = await privateArchives(file);
  const prefix = `${basename(file, ".jsonl")}.`;
  const entries = [];
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!/^\d{8}T\d{9}Z-[a-f0-9]{8}\.jsonl$/.test(suffix)) continue;
    const info = await lstat(join(directory, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error("Unsafe archived capture.");
    const stamp = suffix.slice(0, 18);
    const archivedAt = Date.parse(
      `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, 18)}Z`,
    );
    entries.push({ name, info, archivedAt });
  }
  entries.sort((a, b) => b.name.localeCompare(a.name));
  let removed = 0;
  for (const [index, entry] of entries.entries()) {
    const age = now - entry.archivedAt;
    if (age < graceMs || (index < policy.maxArchives && age <= policy.maxAgeMs))
      continue;
    const path = join(directory, entry.name);
    const current = await lstat(path);
    if (
      current.ino !== entry.info.ino ||
      current.dev !== entry.info.dev ||
      current.nlink !== 1
    )
      throw new Error("Archive identity changed.");
    await unlink(path);
    removed++;
  }
  return removed;
}

/** A single owner's serialized writer. Vector follows active and renamed inputs. */
export class RotatingJsonlWriter {
  constructor(file, policy = retentionPolicy()) {
    this.file = file;
    this.policy = policy;
    this.openedAt = Date.now();
  }
  async open() {
    await ensureLogFile(this.file);
    this.handle = await open(
      this.file,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
    );
    const info = await this.handle.stat();
    if (!info.isFile() || info.nlink !== 1) {
      await this.handle.close();
      throw new Error("Unsafe capture file.");
    }
    this.bytes = info.size;
    this.openedAt = info.size ? info.mtimeMs : Date.now();
    return this;
  }
  async write(text) {
    if (!this.handle) await this.open();
    if (this.recovering) {
      try {
        // A rejected append can have written a prefix. Separate it from later
        // JSONL rather than silently concatenating unrelated valid records.
        await this.handle.writeFile("\n");
        this.bytes++;
        this.recovering = false;
      } catch (error) {
        await this.close().catch(() => {});
        throw error;
      }
    }
    const size = Buffer.byteLength(text);
    if (
      this.bytes &&
      (this.bytes + size > this.policy.maxBytes ||
        Date.now() - this.openedAt >= this.policy.rotateAfterMs)
    ) {
      if (!(await inputArchiveBudgetAvailable(this.file, this.policy)))
        throw new Error("Input log backlog limit reached.");
      await this.close();
      await archiveCapture(this.file);
      await this.open();
    }
    const before = await this.handle.stat();
    try {
      await this.handle.writeFile(text);
      this.bytes += size;
    } catch (error) {
      const after = await this.handle.stat().catch(() => undefined);
      const known =
        after && before.ino === after.ino && before.dev === after.dev;
      const bytesWritten = known ? Math.max(0, after.size - before.size) : null;
      // Expose only controlled outcome metadata, never paths/payload/error text.
      // Callers can distinguish safe zero-byte retry from possible duplicates.
      const failure = new Error("Private log append failed.");
      if (typeof error?.code === "string" && /^[A-Z_]{1,32}$/.test(error.code))
        failure.code = error.code;
      failure.logWriteOutcome =
        bytesWritten === 0 ? "not_written" : "uncertain";
      failure.logBytesWritten = bytesWritten;
      this.recovering = true;
      await this.close().catch(() => {});
      throw failure;
    }
  }
  async close() {
    const handle = this.handle;
    this.handle = undefined;
    await handle?.close();
  }
}

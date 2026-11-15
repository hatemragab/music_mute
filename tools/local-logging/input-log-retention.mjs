import { constants } from "node:fs";
import { lstat, open, opendir, unlink } from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

const maximumFirstLineBytes = 1024 * 1024;
const maximumCheckpointBytes = 8 * 1024 * 1024;
const maximumArchiveEntries = 4096;
const crcMask = (1n << 64n) - 1n;
const crcPolynomial = 0x42f0e1eba9ea3693n;
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = BigInt(index) << 56n;
  for (let bit = 0; bit < 8; bit++)
    value =
      ((value << 1n) ^ (value & (1n << 63n) ? crcPolynomial : 0n)) & crcMask;
  return value;
});

export class InputLogRetentionError extends Error {
  constructor() {
    super("Input log retention could not safely verify local file identities.");
    this.name = "InputLogRetentionError";
    this.code = "UNSAFE_INPUT_LOG_FILES";
  }
}

class InputLogSnapshotChangedError extends InputLogRetentionError {}

/** Vector 0.59.0 uses CRC_64_ECMA_182: zero initial state and no final XOR.
 * https://github.com/vectordotdev/vector/blob/v0.59.0/lib/file-source-common/src/fingerprinter.rs
 */
export function crc64Ecma182(bytes) {
  let value = 0n;
  for (const byte of bytes)
    value =
      ((value << 8n) & crcMask) ^
      crcTable[Number((value >> 56n) ^ BigInt(byte)) & 255];
  return value.toString();
}

async function safeParents(path) {
  const parent = dirname(path);
  let current = parse(parent).root;
  const identities = [];
  for (const part of relative(current, parent).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new InputLogRetentionError();
    identities.push({ path: current, dev: info.dev, ino: info.ino });
  }
  return identities;
}

async function unchangedParents(identities) {
  for (const identity of identities) {
    const current = await lstat(identity.path);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    )
      throw new InputLogRetentionError();
  }
}

function regular(info, allowUnlinked = false) {
  return (
    info.isFile() &&
    !info.isSymbolicLink() &&
    (info.nlink === 1 || (allowUnlinked && info.nlink === 0)) &&
    (typeof process.getuid !== "function" || info.uid === process.getuid()) &&
    (info.mode & 0o022) === 0 &&
    Number.isSafeInteger(info.size) &&
    info.size >= 0
  );
}

function replacedOpenFile(before, actual, current) {
  return (
    regular(actual, true) &&
    actual.nlink === 0 &&
    regular(current) &&
    before.dev === actual.dev &&
    before.ino === actual.ino &&
    (current.dev !== actual.dev || current.ino !== actual.ino)
  );
}

function sameFile(a, b, stableSize = true) {
  return (
    regular(a) &&
    regular(b) &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    (!stableSize ||
      (a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs))
  );
}

async function safeFile(path) {
  let handle;
  try {
    const parents = await safeParents(path);
    const before = await lstat(path);
    if (!regular(before)) throw new InputLogRetentionError();
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const actual = await handle.stat();
    await unchangedParents(parents);
    const current = await lstat(path);
    if (replacedOpenFile(before, actual, current))
      throw new InputLogSnapshotChangedError();
    if (!regular(actual) || !regular(current))
      throw new InputLogRetentionError();
    if (!sameFile(before, actual, false) || !sameFile(actual, current, false))
      throw new InputLogSnapshotChangedError();
    return { handle, info: actual, parents, path };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error.code === "ENOENT") return null;
    if (error instanceof InputLogSnapshotChangedError) throw error;
    throw new InputLogRetentionError();
  }
}

async function stable(file) {
  await unchangedParents(file.parents);
  const actual = await file.handle.stat();
  const current = await lstat(file.path);
  if (replacedOpenFile(file.info, actual, current)) return false;
  if (!regular(actual) || !regular(current)) throw new InputLogRetentionError();
  return sameFile(file.info, actual) && sameFile(file.info, current);
}

async function readBounded(file, length) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await file.handle.read(
      bytes,
      offset,
      length - offset,
      offset,
    );
    if (!result.bytesRead) return null;
    offset += result.bytesRead;
  }
  return bytes;
}

async function firstLineFingerprint(file) {
  const bytes = await readBounded(
    file,
    Math.min(file.info.size, maximumFirstLineBytes),
  );
  if (!bytes?.length) return null;
  const newline = bytes.indexOf(10);
  // Vector cannot fingerprint a short unterminated line. At its max-line limit
  // it deliberately fingerprints the prefix, including an LF when present.
  if (newline < 0 && bytes.length < maximumFirstLineBytes) return null;
  return crc64Ecma182(newline < 0 ? bytes : bytes.subarray(0, newline + 1));
}

/** JSON.parse must never round Vector's unsigned 64-bit numeric fingerprints. */
export function parseVectorCheckpoints(text) {
  const protectedIntegers = text.replace(
    /("(?:first_lines_checksum|first_line_checksum)"\s*:\s*)(\d+)(?=\s*[,}])/g,
    '$1"$2"',
  );
  const value = JSON.parse(protectedIntegers);
  if (
    value?.version !== "1" ||
    !Array.isArray(value.checkpoints) ||
    value.checkpoints.length > 65536
  )
    throw new Error("Unsupported checkpoint data.");
  const positions = new Map();
  for (const checkpoint of value.checkpoints) {
    const checksum =
      checkpoint?.fingerprint?.first_lines_checksum ??
      checkpoint?.fingerprint?.first_line_checksum;
    if (
      typeof checksum !== "string" ||
      !/^\d{1,20}$/.test(checksum) ||
      BigInt(checksum) > crcMask ||
      !Number.isSafeInteger(checkpoint.position) ||
      checkpoint.position < 0
    )
      continue;
    const normalized = BigInt(checksum).toString();
    // Duplicated identities cannot grant more deletion authority than their
    // least advanced position, even if a malformed file repeats an entry.
    positions.set(
      normalized,
      Math.min(positions.get(normalized) ?? Infinity, checkpoint.position),
    );
  }
  return positions;
}

async function checkpointSnapshot(path) {
  // Vector atomically replaces this file after flushing checkpoints.new.json.
  // A changed safe regular file grants no deletion authority for this cycle.
  let file;
  try {
    file = await safeFile(path);
  } catch (error) {
    if (error instanceof InputLogSnapshotChangedError) return null;
    throw error;
  }
  if (!file) return null;
  try {
    if (file.info.size > maximumCheckpointBytes) return null;
    const contents = await readBounded(file, file.info.size);
    if (!contents) return null;
    try {
      if (!(await stable(file))) return null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    try {
      return parseVectorCheckpoints(contents.toString("utf8"));
    } catch {
      return null;
    }
  } finally {
    await file.handle.close();
  }
}

function archiveDate(name, stem) {
  if (!name.startsWith(`${stem}.`)) return null;
  const suffix = name.slice(stem.length + 1);
  if (!/^\d{8}T\d{9}Z-[a-f0-9]{8}\.jsonl$/.test(suffix)) return null;
  const stamp = suffix.slice(0, 18);
  const date = new Date(
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, 18)}Z`,
  );
  return Number.isFinite(date.getTime()) &&
    date.toISOString().replace(/[-:.]/g, "") === `${stamp}Z`
    ? date.getTime()
    : null;
}

/**
 * Expiry/count policy only grants deletion after a stable archive's exact first
 * line fingerprint has an acknowledged Vector checkpoint at or beyond its EOF.
 * The caller must enable sink acknowledgements and use this source's checkpoint
 * file. Unknown/unread/ambiguous archives are retained even above the disk target.
 * No directories/checkpoints are created, repaired, or modified.
 */
export async function pruneConsumedInputArchives(
  file,
  checkpointFile,
  policy,
  now = Date.now(),
) {
  if (
    !Number.isSafeInteger(policy?.maxArchives) ||
    policy.maxArchives < 1 ||
    !Number.isSafeInteger(policy?.maxAgeMs) ||
    policy.maxAgeMs < 1 ||
    !Number.isFinite(now)
  )
    throw new Error("Invalid input log retention policy.");
  file = resolve(file);
  checkpointFile = resolve(checkpointFile);
  const directory = join(dirname(file), "archives");
  const result = {
    removedArchives: 0,
    removedBytes: 0,
    retainedArchives: 0,
    unconsumedArchives: 0,
    ambiguousArchives: 0,
    unsafeArchives: 0,
    inspectedArchives: 0,
    checkpointAvailable: false,
    truncated: false,
    warnings: [],
  };
  const positions = await checkpointSnapshot(checkpointFile);
  result.checkpointAvailable = positions !== null;
  if (!positions)
    result.warnings.push(
      "Vector checkpoints are unavailable; input archives are preserved.",
    );
  let identities;
  let directoryIdentity;
  let entries;
  try {
    identities = await safeParents(join(directory, ".probe"));
    directoryIdentity = await lstat(directory);
    entries = await opendir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return result;
    throw new InputLogRetentionError();
  }
  const candidates = [];
  const stem = basename(file, ".jsonl");
  let inspectedEntries = 0;
  for await (const entry of entries) {
    if (++inspectedEntries > maximumArchiveEntries) {
      result.truncated = true;
      break;
    }
    const archivedAt = archiveDate(entry.name, stem);
    if (archivedAt === null) continue;
    result.inspectedArchives++;
    let candidate;
    try {
      candidate = await safeFile(join(directory, entry.name));
    } catch {
      // Never follow or unlink an unsafe leaf, and keep the remaining inventory
      // useful for an operator while preserving the unsafe artifact.
      result.unsafeArchives++;
      continue;
    }
    if (!candidate) continue; // another pruning pass already removed it
    try {
      const fingerprint = await firstLineFingerprint(candidate);
      const unchanged = await stable(candidate);
      candidates.push({
        name: entry.name,
        archivedAt,
        info: candidate.info,
        fingerprint: unchanged ? fingerprint : null,
      });
    } finally {
      await candidate.handle.close();
    }
  }
  await unchangedParents(identities);
  const currentDirectory = await lstat(directory);
  if (
    !currentDirectory.isDirectory() ||
    currentDirectory.isSymbolicLink() ||
    currentDirectory.ino !== directoryIdentity.ino ||
    currentDirectory.dev !== directoryIdentity.dev
  )
    throw new InputLogRetentionError();
  // Repeated first lines share a Vector identity. Preserve ambiguous candidates
  // instead of mistaking a different file's EOF checkpoint for this archive.
  const fingerprintCounts = new Map();
  for (const candidate of candidates)
    if (candidate.fingerprint !== null)
      fingerprintCounts.set(
        candidate.fingerprint,
        (fingerprintCounts.get(candidate.fingerprint) ?? 0) + 1,
      );
  const active = await safeFile(file);
  if (active) {
    try {
      const fingerprint = await firstLineFingerprint(active);
      if (fingerprint !== null)
        fingerprintCounts.set(
          fingerprint,
          (fingerprintCounts.get(fingerprint) ?? 0) + 1,
        );
    } finally {
      await active.handle.close();
    }
  }
  candidates.sort((a, b) => b.name.localeCompare(a.name));
  for (const [index, candidate] of candidates.entries()) {
    const ambiguous =
      candidate.fingerprint !== null &&
      fingerprintCounts.get(candidate.fingerprint) > 1;
    const consumed =
      !ambiguous &&
      candidate.fingerprint !== null &&
      positions?.get(candidate.fingerprint) >= candidate.info.size;
    if (!consumed) {
      result.retainedArchives++;
      if (ambiguous) result.ambiguousArchives++;
      else result.unconsumedArchives++;
      continue;
    }
    if (
      index < policy.maxArchives &&
      now - candidate.archivedAt <= policy.maxAgeMs
    ) {
      result.retainedArchives++;
      continue;
    }
    // An incomplete bounded inventory cannot establish archive count rank. Age
    // expiration remains sound, but keep candidates that only exceed the count.
    if (result.truncated && now - candidate.archivedAt <= policy.maxAgeMs) {
      result.retainedArchives++;
      continue;
    }
    await unchangedParents(identities);
    const path = join(directory, candidate.name);
    const beforeUnlink = await safeFile(path);
    if (!beforeUnlink) continue;
    try {
      if (
        !sameFile(candidate.info, beforeUnlink.info) ||
        !(await stable(beforeUnlink))
      )
        throw new InputLogRetentionError();
      await unchangedParents(identities);
      await unlink(path);
      result.removedArchives++;
      result.removedBytes += candidate.info.size;
    } finally {
      await beforeUnlink.handle.close();
    }
  }
  if (result.unconsumedArchives || result.ambiguousArchives)
    result.warnings.push(
      "Unread or ambiguous input archives exceed deletion authority and remain on disk until consumption can be proved.",
    );
  if (result.unsafeArchives)
    result.warnings.push("Unsafe input archives were excluded and preserved.");
  if (result.truncated)
    result.warnings.push(
      "Input archive discovery reached its bounded entry limit; count-based pruning was deferred.",
    );
  return result;
}

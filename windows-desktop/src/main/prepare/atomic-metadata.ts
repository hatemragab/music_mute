import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { win32 } from "node:path";
import {
  sameConsumerProcess,
  type PrivateReadable,
  type ConsumerProcessIdentity,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  assertConsumerRelativePath,
  processIdentityFromWire,
  processIdentityToWire,
} from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import type { HostContext } from "../host-context.js";
import {
  RUNTIME_BACKUP_INVENTORY,
  RUNTIME_BACKUP_INVENTORY_MAX,
} from "./runtime-repair-policy.js";
type Birth = { device: string; fileId: string; bornAt: string };
interface Header {
  version: 1;
  target: string;
  bytes: number;
  sha256: string;
  owner: ConsumerProcessIdentity;
  birth: Birth;
}
const MAX_BYTES = 2 * 1024 ** 2,
  MAX_HEADER = 4096,
  MAX_PENDING = 64;
let tail: Promise<void> = Promise.resolve(),
  pending = 0;
function maximumBytes(target: string): number {
  return target === RUNTIME_BACKUP_INVENTORY
    ? RUNTIME_BACKUP_INVENTORY_MAX
    : MAX_BYTES;
}
function birth(stat: BigIntStats): Birth {
  if (!stat.isFile() || stat.nlink !== 1n || stat.ino === 0n)
    throw new Error("METADATA_RECOVERY_PENDING");
  return {
    device: String(stat.dev),
    fileId: String(stat.ino),
    bornAt: String(stat.birthtimeNs),
  };
}
function parseBirth(value: unknown): Birth {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("METADATA_RECOVERY_PENDING");
  const b = value as Birth;
  if (
    Object.keys(b).sort().join() !== "bornAt,device,fileId" ||
    [b.device, b.fileId, b.bornAt].some(
      (v) => typeof v !== "string" || !/^\d{1,30}$/u.test(v),
    ) ||
    b.fileId === "0"
  )
    throw new Error("METADATA_RECOVERY_PENDING");
  return b;
}
function sameBirth(a: Birth, b: Birth): boolean {
  return (
    a.device === b.device && a.fileId === b.fileId && a.bornAt === b.bornAt
  );
}
function paths(target: string) {
  assertConsumerRelativePath(target);
  if (/\.atomic\.(lock|tmp)$/u.test(target))
    throw new Error("INTEGRITY_INVALID");
  const lock = `${target}.atomic.lock`,
    temporary = `${target}.atomic.tmp`;
  assertConsumerRelativePath(lock);
  assertConsumerRelativePath(temporary);
  return { lock, temporary };
}
async function exists(host: HostContext, relative: string): Promise<boolean> {
  try {
    await lstat(win32.join(host.personalRoot, relative));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function exact(
  host: HostContext,
  relative: string,
  expected: Birth,
): Promise<void> {
  await host.native.validatePath("personal", relative, "file");
  if (
    !sameBirth(
      birth(
        await lstat(win32.join(host.personalRoot, relative), { bigint: true }),
      ),
      expected,
    )
  )
    throw new Error("METADATA_RECOVERY_PENDING");
}
async function removeExact(
  host: HostContext,
  relative: string,
  expected: Birth,
): Promise<void> {
  if (await exists(host, relative)) {
    await exact(host, relative, expected);
    await unlink(win32.join(host.personalRoot, relative));
  }
}
async function readExactly(
  file: Pick<PrivateReadable, "read">,
  length: number,
): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const value = await file.read(bytes, offset, length - offset, offset);
    if (!value.bytesRead) throw new Error("METADATA_RECOVERY_PENDING");
    offset += value.bytesRead;
  }
  return bytes;
}
async function readLock(
  host: HostContext,
  relative: string,
): Promise<{ header: Header; temporaryBirth?: Birth }> {
  let file: PrivateReadable | null = null;
  try {
    // The recovery record is read from one retained native generation. A path
    // validation followed by Node open cannot fence a redirected ancestor.
    file = await host.native.openPrivateFile(relative, "read", MAX_HEADER);
    if (!file) throw new Error("METADATA_RECOVERY_PENDING");
    const before = await file.info();
    if (
      !Number.isSafeInteger(before.bytes) ||
      before.bytes < 0 ||
      before.bytes > MAX_HEADER
    )
      throw new Error("METADATA_RECOVERY_PENDING");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await readExactly(file, before.bytes),
      ),
      lines = text.split("\n");
    const header = JSON.parse(lines[0] ?? "") as Header;
    if (
      !header ||
      Object.keys(header).sort().join() !==
        "birth,bytes,owner,sha256,target,version" ||
      header.version !== 1 ||
      !Number.isSafeInteger(header.bytes) ||
      header.bytes < 0 ||
      header.bytes > maximumBytes(header.target) ||
      !/^[a-f0-9]{64}$/u.test(header.sha256)
    )
      throw new Error("METADATA_RECOVERY_PENDING");
    header.birth = parseBirth(header.birth);
    paths(header.target);
    header.owner = processIdentityFromWire(processIdentityToWire(header.owner));
    if (
      header.owner.sid !== host.identity.sid ||
      !sameBirth(before, header.birth)
    )
      throw new Error("METADATA_RECOVERY_PENDING");
    const after = await file.info();
    if (
      !sameBirth(before, after) ||
      before.bytes !== after.bytes ||
      before.writtenAt !== after.writtenAt ||
      before.changedAt !== after.changedAt
    )
      throw new Error("METADATA_RECOVERY_PENDING");
    let temporaryBirth: Birth | undefined;
    if (lines.length === 3 && lines[2] === "") {
      try {
        const value = JSON.parse(lines[1]!);
        if (Object.keys(value).join() !== "temporaryBirth") throw new Error();
        temporaryBirth = parseBirth(value.temporaryBirth);
      } catch {}
    }
    return { header, ...(temporaryBirth ? { temporaryBirth } : {}) };
  } catch {
    throw new Error("METADATA_RECOVERY_PENDING");
  } finally {
    if (file) await file.close();
  }
}
async function recover(host: HostContext, target: string): Promise<void> {
  const { lock, temporary } = paths(target);
  if (!(await exists(host, lock))) {
    if (await exists(host, temporary))
      throw new Error("METADATA_RECOVERY_PENDING");
    return;
  }
  const record = await readLock(host, lock);
  if (record.header.target !== target || !host.native.processIdentity)
    throw new Error("METADATA_RECOVERY_PENDING");
  let current: ConsumerProcessIdentity | null;
  try {
    current = await host.native.processIdentity(record.header.owner.pid);
  } catch {
    throw new Error("METADATA_RECOVERY_PENDING");
  }
  if (current && sameConsumerProcess(current, record.header.owner))
    throw new Error("METADATA_RECOVERY_PENDING");
  if (await exists(host, temporary)) {
    if (!record.temporaryBirth) throw new Error("METADATA_RECOVERY_PENDING");
    await removeExact(host, temporary, record.temporaryBirth);
  }
  await removeExact(host, lock, record.header.birth);
}
async function writeOperation(
  host: HostContext,
  target: string,
  bytes: Buffer,
): Promise<void> {
  const { lock, temporary } = paths(target);
  if (!host.native.processIdentity) throw new Error("STORAGE_OWNER_INVALID");
  const owner = await host.native.processIdentity(process.pid);
  if (
    !owner ||
    owner.pid !== process.pid ||
    owner.sid !== host.identity.sid ||
    owner.sessionId !== host.identity.sessionId
  )
    throw new Error("STORAGE_OWNER_INVALID");
  const lease = await host.native.acquireMutex("metadata");
  if (!lease) throw new Error("METADATA_BUSY");
  let lockFile: FileHandle | undefined,
    tempFile: FileHandle | undefined,
    lockBirth: Birth | undefined,
    tempBirth: Birth | undefined;
  let failure: unknown,
    failed = false,
    tempClosed = true,
    lockClosed = false;
  const cleanupKnown = async () => {
    if (lockFile && lockBirth && tempClosed) {
      if (await exists(host, temporary)) {
        if (!tempBirth) throw new Error("METADATA_RECOVERY_PENDING");
        await removeExact(host, temporary, tempBirth);
      }
      await lockFile.close();
      lockClosed = true;
      await removeExact(host, lock, lockBirth);
    }
  };
  try {
    // Lock order: existing caller cache/Prepare lease -> metadata -> direct file/Native checks only.
    await recover(host, target);
    const parent = win32.dirname(target);
    if (parent !== ".") await host.directory(parent);
    await host.native.validatePath("personal", lock, "absent");
    lockFile = await open(win32.join(host.personalRoot, lock), "wx", 0o600);
    lockBirth = birth(await lockFile.stat({ bigint: true }));
    const header: Header = {
      version: 1,
      target,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      owner,
      birth: lockBirth,
    };
    await lockFile.writeFile(`${JSON.stringify(header)}\n`);
    await lockFile.sync();
    await host.native.validatePath("personal", temporary, "absent");
    tempFile = await open(
      win32.join(host.personalRoot, temporary),
      "wx+",
      0o600,
    );
    tempClosed = false;
    tempBirth = birth(await tempFile.stat({ bigint: true }));
    await lockFile.writeFile(
      `${JSON.stringify({ temporaryBirth: tempBirth })}\n`,
    );
    await lockFile.sync();
    await tempFile.writeFile(bytes);
    await tempFile.sync();
    if (
      (await tempFile.stat({ bigint: true })).size !== BigInt(bytes.length) ||
      createHash("sha256")
        .update(await readExactly(tempFile, bytes.length))
        .digest("hex") !== header.sha256
    )
      throw new Error("INTEGRITY_INVALID");
    await tempFile.close();
    tempClosed = true;
    await exact(host, temporary, tempBirth);
    if (await exists(host, target))
      await host.native.validatePath("personal", target, "file");
    else await host.native.validatePath("personal", target, "absent");
    await rename(
      win32.join(host.personalRoot, temporary),
      win32.join(host.personalRoot, target),
    );
    await host.native.validatePath("personal", target, "file");
  } catch (error) {
    failure = error;
    failed = true;
  } finally {
    if (tempFile && !tempClosed) {
      try {
        await tempFile.close();
        tempClosed = true;
      } catch (error) {
        failure ??= error;
        failed = true;
      }
    }
    try {
      await cleanupKnown();
    } catch (error) {
      failure ??= error;
      failed = true;
    }
    if (lockFile && !lockClosed) {
      try {
        await lockFile.close();
      } catch (error) {
        failure ??= error;
        failed = true;
      }
    }
    try {
      await host.native.releaseMutex(lease);
    } catch (error) {
      failure ??= error;
      failed = true;
    }
  }
  if (failed) throw failure;
}
/** One bounded lock/temporary per target; actual Node birth fences recovery after helper loss. */
export function writeOwnedMetadataAtomic(
  host: HostContext,
  target: string,
  bytes: Buffer,
): Promise<void> {
  if (bytes.length > maximumBytes(target))
    return Promise.reject(new Error("INTEGRITY_INVALID"));
  if (pending >= MAX_PENDING) return Promise.reject(new Error("METADATA_BUSY"));
  paths(target);
  pending++;
  const payload = Buffer.from(bytes);
  const work = tail
    .then(() => writeOperation(host, target, payload))
    .finally(() => {
      pending--;
    });
  tail = work.catch(() => {});
  return work;
}

import { createHash } from "node:crypto";
import { win32 } from "node:path";
import {
  assertConsumerRelativePath,
  PRIVATE_FILE_MAX_BYTES,
  type ConsumerCacheFileIdentity,
  type PrivateReadable,
  type PrivateWritable,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../host-context.js";
import { PrepareFailure } from "./controller.js";
import { writeOwnedMetadataAtomic } from "./atomic-metadata.js";

export interface PrivateFileFingerprint {
  device: string;
  fileId: string;
  bytes: number;
  writtenAt: string;
  changedAt: string;
}
function fingerprint(info: ConsumerCacheFileIdentity): PrivateFileFingerprint {
  return {
    device: info.device,
    fileId: info.fileId,
    bytes: info.bytes,
    writtenAt: info.writtenAt,
    changedAt: info.changedAt,
  };
}
async function openRead(
  host: HostContext,
  relative: string,
): Promise<PrivateReadable> {
  assertConsumerRelativePath(relative);
  const file = await host.native.openPrivateFile(
    relative,
    "read",
    PRIVATE_FILE_MAX_BYTES,
  );
  if (!file)
    throw Object.assign(new Error("PRIVATE_FILE_MISSING"), { code: "ENOENT" });
  return file;
}
function unchanged(
  before: ConsumerCacheFileIdentity,
  after: ConsumerCacheFileIdentity,
): void {
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new PrepareFailure("INTEGRITY_INVALID");
}
export async function readPrivateBytes(
  host: HostContext,
  relative: string,
  maximum: number,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 0 ||
    maximum > PRIVATE_FILE_MAX_BYTES
  )
    throw new PrepareFailure("INTEGRITY_INVALID");
  const file = await openRead(host, relative);
  try {
    const before = await file.info();
    if (before.bytes > maximum) throw new PrepareFailure("INTEGRITY_INVALID");
    const bytes = Buffer.alloc(before.bytes);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) throw new PrepareFailure("INTEGRITY_INVALID");
      offset += bytesRead;
    }
    unchanged(before, await file.info());
    return bytes;
  } finally {
    await file.close();
  }
}
export async function privateFingerprint(
  host: HostContext,
  relative: string,
): Promise<PrivateFileFingerprint> {
  const file = await openRead(host, relative);
  try {
    return fingerprint(await file.info());
  } finally {
    await file.close();
  }
}
export async function verifyPrivateFile(
  host: HostContext,
  relative: string,
  expectedBytes: number,
  signal: AbortSignal,
): Promise<{ sha256: string; fingerprint: PrivateFileFingerprint }> {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes > PRIVATE_FILE_MAX_BYTES
  )
    throw new PrepareFailure("INTEGRITY_INVALID");
  signal.throwIfAborted();
  const file = await openRead(host, relative);
  try {
    const before = await file.info();
    if (before.bytes !== expectedBytes)
      throw new PrepareFailure("INTEGRITY_INVALID");
    const hash = createHash("sha256");
    for await (const bytes of file.chunks({ signal })) hash.update(bytes);
    signal.throwIfAborted();
    const after = await file.info();
    unchanged(before, after);
    return { sha256: hash.digest("hex"), fingerprint: fingerprint(after) };
  } finally {
    await file.close();
  }
}
export async function hashPrivateFile(
  host: HostContext,
  relative: string,
  expectedBytes: number,
  signal: AbortSignal,
): Promise<string> {
  return (await verifyPrivateFile(host, relative, expectedBytes, signal))
    .sha256;
}
export async function newPrivateFile(
  host: HostContext,
  relative: string,
  maximumBytes = PRIVATE_FILE_MAX_BYTES,
): Promise<PrivateWritable> {
  assertConsumerRelativePath(relative);
  const parent = win32.dirname(relative);
  if (parent !== ".") await host.directory(parent);
  return host.native.openPrivateFile(relative, "create-new", maximumBytes);
}
/** Metadata replacement retains its existing journal; its mutation migration is separate. */
export async function writePrivateAtomic(
  host: HostContext,
  relative: string,
  bytes: Buffer,
): Promise<void> {
  await writeOwnedMetadataAtomic(host, relative, bytes);
}

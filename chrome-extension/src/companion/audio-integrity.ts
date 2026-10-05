import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

// Short-lived, process-private evidence. Never trust a receipt from disk or IPC.
// Metadata and the expected digest are checked on every use, even on a hit.
const receipts = new Map<
  string,
  { identity: string; digest: string; expires: number }
>();
const RECEIPT_TTL_MS = 60_000;
const MAX_RECEIPTS = 128;

function identity(info: Stats): string {
  return [
    info.dev,
    info.ino,
    info.size,
    info.mtimeMs,
    info.ctimeMs,
    info.uid,
    info.mode,
    info.nlink,
  ].join(":");
}

async function checkedIdentity(
  file: FileHandle,
  path: string,
  bytes: number,
): Promise<string> {
  const info = await file.stat(),
    named = await lstat(path);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077 ||
    info.size !== bytes ||
    named.isSymbolicLink() ||
    identity(info) !== identity(named)
  )
    throw new Error("CACHE_UNSAFE");
  return identity(info);
}

function remember(path: string, fingerprint: string, digest: string): void {
  receipts.delete(path);
  if (receipts.size >= MAX_RECEIPTS)
    receipts.delete(receipts.keys().next().value!);
  receipts.set(path, {
    identity: fingerprint,
    digest,
    expires: Date.now() + RECEIPT_TTL_MS,
  });
}

/** One checksum per unchanged owned artifact during an admission, not per layer. */
export async function verifyPrivateAudio(
  path: string,
  bytes: number,
  digest: string,
  current: () => Promise<void> = async () => {},
): Promise<boolean> {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    !/^[a-f0-9]{64}$/.test(digest)
  )
    return false;
  await current();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await file.stat()).size !== bytes) return false;
    const before = await checkedIdentity(file, path, bytes);
    const receipt = receipts.get(path);
    if (
      receipt?.identity === before &&
      receipt.digest === digest &&
      receipt.expires > Date.now()
    ) {
      await current();
      return before === (await checkedIdentity(file, path, bytes));
    }
    receipts.delete(path);
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      await current();
      hash.update(chunk);
    }
    await current();
    if (
      before !== (await checkedIdentity(file, path, bytes)) ||
      hash.digest("hex") !== digest
    )
      return false;
    remember(path, before, digest);
    return true;
  } finally {
    await file.close();
  }
}

/** Capture evidence only from the exact descriptor just hashed during a transfer. */
export async function rememberTransferredAudio(
  file: FileHandle,
  path: string,
  bytes: number,
  digest: string,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("CACHE_UNSAFE");
  remember(path, await checkedIdentity(file, path, bytes), digest);
}

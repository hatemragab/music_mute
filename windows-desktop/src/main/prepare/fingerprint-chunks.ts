import { createHash } from "node:crypto";
import type { ReadinessFile } from "./readiness-cache.js";
export const FINGERPRINT_CHUNK_BYTES = 2 * 1024 ** 2;
export const FINGERPRINT_TOTAL_FILES = 100_003;
export const FINGERPRINT_TOTAL_BYTES = 64 * 1024 ** 2;
export const FINGERPRINT_INDEX_BYTES = 64 * 1024;
const CHUNKS = 32;
export interface FingerprintChunk {
  path: string;
  sha256: string;
  bytes: number;
  files: number;
}
interface Port {
  readCapsule(path: string, maximum: number): Promise<Buffer>;
  writeCapsule(path: string, bytes: Buffer): Promise<void>;
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function invalid(): never {
  throw new Error("READINESS_INVALID");
}
function root(base: string, slot: 0 | 1) {
  return `${base}\\slot${slot}`;
}
export function fingerprintIndexPath(
  base: string,
  previous: string | undefined,
): string {
  return `${root(base, previous === `${root(base, 0)}\\index.json` ? 1 : 0)}\\index.json`;
}
/** Two fixed slots, at most32x2MiB each. Old marker remains authoritative until
 * every chunk and the bounded hash index have been written successfully. */
export async function writeFingerprintChunks(
  port: Port,
  indexPath: string,
  files: ReadinessFile[],
  signal: AbortSignal,
): Promise<FingerprintChunk[]> {
  if (
    !files.length ||
    files.length > FINGERPRINT_TOTAL_FILES ||
    !/\\slot[01]\\index\.json$/u.test(indexPath)
  )
    return invalid();
  const directory = indexPath.slice(0, -"\\index.json".length),
    chunks: FingerprintChunk[] = [];
  let part: string[] = [],
    bytes = 2,
    total = 0;
  const flush = async () => {
    if (!part.length) return;
    if (chunks.length >= CHUNKS) return invalid();
    const content = Buffer.from(`[${part.join(",")}]`);
    total += content.length;
    if (total > FINGERPRINT_TOTAL_BYTES) return invalid();
    const path = `${directory}\\chunk-${String(chunks.length).padStart(3, "0")}.json`;
    signal.throwIfAborted();
    await port.writeCapsule(path, content);
    signal.throwIfAborted();
    chunks.push({
      path,
      sha256: sha(content),
      bytes: content.length,
      files: part.length,
    });
    part = [];
    bytes = 2;
  };
  for (const file of files) {
    const item = JSON.stringify(file),
      size = Buffer.byteLength(item);
    if (size + 2 > FINGERPRINT_CHUNK_BYTES) return invalid();
    if (
      bytes + size + (part.length ? 1 : 0) > FINGERPRINT_CHUNK_BYTES ||
      part.length >= 8192
    )
      await flush();
    bytes += size + (part.length ? 1 : 0);
    part.push(item);
  }
  await flush();
  return chunks;
}
export async function readFingerprintChunks(
  port: Port,
  indexPath: string,
  chunks: unknown,
  totalFiles: unknown,
  signal: AbortSignal,
): Promise<ReadinessFile[]> {
  if (
    !/\\slot[01]\\index\.json$/u.test(indexPath) ||
    !Array.isArray(chunks) ||
    !chunks.length ||
    chunks.length > CHUNKS ||
    !Number.isSafeInteger(totalFiles) ||
    (totalFiles as number) < 1 ||
    (totalFiles as number) > FINGERPRINT_TOTAL_FILES
  )
    return invalid();
  const directory = indexPath.slice(0, -"\\index.json".length),
    files: ReadinessFile[] = [];
  let total = 0;
  for (let index = 0; index < chunks.length; index++) {
    const item = chunks[index] as FingerprintChunk;
    if (
      !item ||
      Object.keys(item).sort().join() !== "bytes,files,path,sha256" ||
      item.path !==
        `${directory}\\chunk-${String(index).padStart(3, "0")}.json` ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.sha256) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 2 ||
      item.bytes > FINGERPRINT_CHUNK_BYTES ||
      !Number.isSafeInteger(item.files) ||
      item.files < 1 ||
      item.files > 8192
    )
      return invalid();
    total += item.bytes;
    if (total > FINGERPRINT_TOTAL_BYTES) return invalid();
    signal.throwIfAborted();
    const bytes = await port.readCapsule(item.path, FINGERPRINT_CHUNK_BYTES);
    signal.throwIfAborted();
    if (bytes.length !== item.bytes || sha(bytes) !== item.sha256)
      return invalid();
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      return invalid();
    }
    if (
      !Array.isArray(decoded) ||
      decoded.length !== item.files ||
      files.length + decoded.length > FINGERPRINT_TOTAL_FILES
    )
      return invalid();
    files.push(...decoded);
  }
  if (files.length !== totalFiles) return invalid();
  return files;
}

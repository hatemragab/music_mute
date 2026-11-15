import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";
import * as yauzl from "yauzl";
import {
  hashStoreFile,
  safeStoreRelativePath,
  type StoreInventoryEntry,
} from "./inventory.js";

const EMPTY_SHA256 = createHash("sha256").digest("hex");
function invalid(): never {
  throw new Error("STORE_ARCHIVE_INVALID");
}
/** MSIX Encoding::EncodeFileName escapes this inventory's safe ASCII paths.
 * Derive raw ZIP part names from trusted pins; never decode archive names. */
function sdkPartName(path: string): string {
  return path
    .split("/")
    .map((part) =>
      part.replace(
        /[^A-Za-z0-9._~-]/gu,
        (character) =>
          "%" +
          character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
      ),
    )
    .join("/");
}
/** Keep the authority handle owned here; yauzl.fromFd closes its descriptor. */
class HeldArchiveReader extends yauzl.RandomAccessReader {
  constructor(private readonly file: FileHandle) {
    super();
  }
  _readStreamForRange(start: number, end: number): Readable {
    const file = this.file;
    return Readable.from(
      (async function* () {
        let cursor = start;
        while (cursor < end) {
          const buffer = Buffer.alloc(Math.min(65536, end - cursor));
          const { bytesRead } = await file.read(
            buffer,
            0,
            buffer.length,
            cursor,
          );
          if (!bytesRead) invalid();
          cursor += bytesRead;
          yield buffer.subarray(0, bytesRead);
        }
      })(),
      { objectMode: false },
    );
  }
  close(callback: (error: Error | null) => void): void {
    callback(null);
  }
}
/** Read back the actual unsigned SDK output; no extraction or execution. */
export async function auditStoreUploadArchive(
  path: string,
  expected: readonly StoreInventoryEntry[],
) {
  if (!Array.isArray(expected) || !expected.length || expected.length > 65542)
    invalid();
  const wanted = new Map<string, StoreInventoryEntry>();
  const aliases = new Set<string>();
  let total = 0;
  for (const candidate of expected) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      (Object.getPrototypeOf(candidate) !== Object.prototype &&
        Object.getPrototypeOf(candidate) !== null) ||
      Reflect.ownKeys(candidate).some((key) => typeof key !== "string") ||
      Reflect.ownKeys(candidate).sort().join() !== "bytes,path,sha256"
    )
      invalid();
    const descriptors = Object.getOwnPropertyDescriptors(candidate),
      values: Record<string, unknown> = Object.create(null);
    for (const key of ["path", "bytes", "sha256"] as const) {
      const d = descriptors[key];
      if (!d?.enumerable || !("value" in d)) invalid();
      values[key] = d.value;
    }
    const row = values as unknown as StoreInventoryEntry;
    safeStoreRelativePath(row.path);
    if (
      aliases.has(row.path.toLowerCase()) ||
      /^(?:AppxBlockMap\.xml|\[Content_Types\]\.xml|AppxSignature\.p7x)$/iu.test(
        row.path,
      ) ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 0 ||
      row.bytes > 4 * 1024 ** 3 ||
      !/^[a-f0-9]{64}$/u.test(row.sha256) ||
      (row.bytes === 0 && row.sha256 !== EMPTY_SHA256)
    )
      invalid();
    total += row.bytes;
    if (total > 32 * 1024 ** 3) invalid();
    aliases.add(row.path.toLowerCase());
    wanted.set(
      sdkPartName(row.path),
      Object.freeze({ path: row.path, bytes: row.bytes, sha256: row.sha256 }),
    );
  }
  const before = await hashStoreFile(path),
    named = await lstat(path, { bigint: true });
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let zip: yauzl.ZipFile | undefined;
  try {
    const opened = await file.stat({ bigint: true });
    const same = (s: typeof opened) =>
      s.isFile() &&
      !s.isSymbolicLink() &&
      s.nlink === 1n &&
      s.dev === opened.dev &&
      s.ino === opened.ino &&
      s.size === opened.size &&
      s.mtimeNs === opened.mtimeNs &&
      s.ctimeNs === opened.ctimeNs &&
      s.birthtimeNs === opened.birthtimeNs;
    if (!same(named) || Number(opened.size) !== before.bytes) invalid();
    zip = await new Promise<yauzl.ZipFile>((accept, reject) =>
      yauzl.fromRandomAccessReader(
        new HeldArchiveReader(file),
        Number(opened.size),
        {
          lazyEntries: true,
          autoClose: false,
          validateEntrySizes: true,
          strictFileNames: true,
        },
        (error, value) =>
          error || !value
            ? reject(error ?? new Error("STORE_ARCHIVE_INVALID"))
            : accept(value),
      ),
    );
    const seen = new Set<string>();
    let generated = 0;
    await new Promise<void>((accept, reject) => {
      const archive = zip!;
      const fail = () => {
        archive.close();
        reject(new Error("STORE_ARCHIVE_INVALID"));
      };
      archive.on("error", fail);
      archive.on("end", () =>
        wanted.size === 0 && generated === 2 ? accept() : fail(),
      );
      archive.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          const name = entry.fileName;
          const isGenerated =
            name === "AppxBlockMap.xml" || name === "[Content_Types].xml";
          if (
            name.endsWith("/") ||
            seen.has(name.toLowerCase()) ||
            seen.size >= 65544 ||
            (entry.generalPurposeBitFlag & ~0x080e) !== 0 ||
            ![0, 8].includes(entry.compressionMethod) ||
            (entry.externalFileAttributes & 0x10) !== 0 ||
            ![0, 0x8000].includes(
              (entry.externalFileAttributes >>> 16) & 0xf000,
            )
          )
            invalid();
          const local = await archive.readLocalFileHeaderPromise(entry);
          if (
            !local.fileName.equals(entry.fileNameRaw) ||
            !entry.fileNameRaw.equals(Buffer.from(name, "ascii")) ||
            local.generalPurposeBitFlag !== entry.generalPurposeBitFlag ||
            local.compressionMethod !== entry.compressionMethod ||
            ((entry.generalPurposeBitFlag & 8) === 0 &&
              (local.crc32 !== entry.crc32 ||
                local.compressedSize !== entry.compressedSize ||
                local.uncompressedSize !== entry.uncompressedSize))
          )
            invalid();
          if (!isGenerated) safeStoreRelativePath(name);
          seen.add(name.toLowerCase());
          const pin = wanted.get(name);
          if (
            (!pin && !isGenerated) ||
            (pin && entry.uncompressedSize !== pin.bytes) ||
            (isGenerated &&
              (entry.uncompressedSize < 1 ||
                entry.uncompressedSize > 16 * 1024 ** 2))
          )
            invalid();
          const stream = await new Promise<import("node:stream").Readable>(
            (yes, no) =>
              archive.openReadStream(entry, (error, value) =>
                error || !value
                  ? no(error ?? new Error("STORE_ARCHIVE_INVALID"))
                  : yes(value),
              ),
          );
          const digest = createHash("sha256");
          let bytes = 0,
            crc = 0;
          for await (const value of stream) {
            const chunk = Buffer.from(value as Uint8Array);
            bytes += chunk.length;
            if (bytes > (pin?.bytes ?? 16 * 1024 ** 2)) {
              stream.destroy();
              invalid();
            }
            digest.update(chunk);
            crc = crc32(chunk, crc);
          }
          if (
            bytes !== entry.uncompressedSize ||
            crc !== entry.crc32 ||
            (pin && digest.digest("hex") !== pin.sha256)
          )
            invalid();
          if (pin) wanted.delete(name);
          else generated++;
          archive.readEntry();
        })().catch(fail);
      });
      archive.readEntry();
    });
    if (
      !same(await file.stat({ bigint: true })) ||
      !same(await lstat(path, { bigint: true }))
    )
      invalid();
    const after = await hashStoreFile(path);
    if (after.bytes !== before.bytes || after.sha256 !== before.sha256)
      invalid();
    return Object.freeze({
      bytes: before.bytes,
      sha256: before.sha256,
      inventoryFilesVerified: expected.length,
      generatedMetadataVerified: generated,
      signed: false,
      installable: false,
      releaseReady: false,
    });
  } catch {
    return invalid();
  } finally {
    zip?.close();
    await file.close();
  }
}

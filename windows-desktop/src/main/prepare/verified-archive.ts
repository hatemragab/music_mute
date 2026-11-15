import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, normalize } from "node:path";
import { Readable } from "node:stream";
import {
  fromRandomAccessReader,
  RandomAccessReader,
  type Entry,
  type ZipFile,
} from "yauzl";
import { assertConsumerRelativePath } from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import type { PrivateReadable } from "../../../../worker/src/platform/windows/consumer-private-file.js";

const MAX_ARCHIVE_BYTES = 4 * 1024 ** 3;
export const MAX_UNPACKED_BYTES = 16 * 1024 ** 3;
const MAX_FILE_BYTES = 2 * 1024 ** 3;
const MAX_ENTRIES = 100_000;
/** ZIP reads need only positional bytes; this reader never owns its caller's lifetime. */
class HandleReader extends RandomAccessReader {
  constructor(private readonly handle: Pick<PrivateReadable, "read">) {
    super();
  }
  _readStreamForRange(start: number, end: number): Readable {
    const handle = this.handle;
    return Readable.from(
      (async function* () {
        let position = start;
        while (position < end) {
          const buffer = Buffer.allocUnsafe(
            Math.min(64 * 1024, end - position),
          );
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            position,
          );
          if (bytesRead < 1) throw new Error("ARCHIVE_TRUNCATED");
          position += bytesRead;
          yield buffer.subarray(0, bytesRead);
        }
      })(),
    );
  }
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (error: Error | null) => void,
  ): void {
    void this.handle.read(buffer, offset, length, position).then(
      (result) => {
        if (result.bytesRead !== length)
          callback(new Error("ARCHIVE_TRUNCATED"));
        else callback(null);
      },
      () => callback(new Error("ARCHIVE_READ_FAILED")),
    );
  }
  close(callback: (error: Error | null) => void): void {
    callback(null);
  }
}
export interface ArchiveDestination {
  /** A fresh, empty staging directory validated by the native private-root adapter. */
  root: string;
  directory(relativePath: string): Promise<string>;
  validateFile(relativePath: string, kind: "absent" | "file"): Promise<void>;
}
export interface VerifiedArchiveOptions {
  path: string;
  expectedBytes: number;
  expectedSha256: string;
  destination: ArchiveDestination;
  signal: AbortSignal;
  onProgress?: (writtenBytes: number, totalBytes: number) => void;
}
/** Signed archive planning reads no user state and allocates no extracted files. */
export async function planVerifiedArchive(
  path: string,
  expectedBytes: number,
  expectedSha256: string,
  signal: AbortSignal,
): Promise<number> {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    expectedBytes > MAX_ARCHIVE_BYTES ||
    !/^[a-f0-9]{64}$/.test(expectedSha256)
  )
    throw new Error("ARCHIVE_METADATA_INVALID");
  const named = await lstat(path, { bigint: true });
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1n ||
    named.size !== BigInt(expectedBytes)
  )
    throw new Error("ARCHIVE_INTEGRITY_INVALID");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let archive: ZipFile | undefined;
  try {
    const before = await handle.stat({ bigint: true });
    if (
      before.ino !== named.ino ||
      before.dev !== named.dev ||
      before.size !== named.size ||
      !before.isFile()
    )
      throw new Error("ARCHIVE_INTEGRITY_INVALID");
    const hash = createHash("sha256");
    for await (const bytes of handle.createReadStream({
      autoClose: false,
      signal,
    }))
      hash.update(bytes);
    if (hash.digest("hex") !== expectedSha256)
      throw new Error("ARCHIVE_INTEGRITY_INVALID");
    archive = await new Promise<ZipFile>((resolve, reject) =>
      fromRandomAccessReader(
        new HandleReader(handle),
        expectedBytes,
        {
          lazyEntries: true,
          autoClose: false,
          validateEntrySizes: true,
          strictFileNames: true,
        },
        (error, value) =>
          error ? reject(new Error("ARCHIVE_INVALID")) : resolve(value),
      ),
    );
    if (archive.entryCount < 1 || archive.entryCount > MAX_ENTRIES)
      throw new Error("ARCHIVE_SIZE_UNSUPPORTED");
    let total = 0;
    for await (const entry of archive.eachEntry()) {
      interrupted(signal);
      entryPath(entry);
      total += entry.uncompressedSize;
      if (!Number.isSafeInteger(total) || total > MAX_UNPACKED_BYTES)
        throw new Error("ARCHIVE_SIZE_UNSUPPORTED");
    }
    const after = await handle.stat({ bigint: true });
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new Error("ARCHIVE_INTEGRITY_INVALID");
    return total;
  } finally {
    archive?.close();
    await handle.close();
  }
}
function interrupted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("PREPARE_CANCELLED");
}
function entryPath(entry: Entry): { path: string; directory: boolean } {
  const directory = entry.fileName.endsWith("/");
  const name = entry.fileName.startsWith("./")
    ? entry.fileName.slice(2)
    : entry.fileName;
  const path = directory ? name.replace(/\/$/, "") : name;
  try {
    if (Buffer.byteLength(path, "utf8") > 1024 || path.includes("\\"))
      throw new Error("ARCHIVE_PATH_UNSAFE");
    assertConsumerRelativePath(
      path.replaceAll("/", "\\"),
      directory && path === "",
    );
  } catch {
    throw new Error("ARCHIVE_PATH_UNSAFE");
  }
  const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (
    (unixType !== 0 && unixType !== (directory ? 0o040000 : 0o100000)) ||
    (entry.externalFileAttributes & 0x400) !== 0 ||
    entry.isEncrypted() ||
    !entry.canDecodeFileData() ||
    (directory && entry.uncompressedSize !== 0) ||
    !Number.isSafeInteger(entry.uncompressedSize) ||
    entry.uncompressedSize < 0 ||
    entry.uncompressedSize > MAX_FILE_BYTES
  )
    throw new Error("ARCHIVE_ENTRY_UNSAFE");
  return { path, directory };
}
export async function extractVerifiedArchive(
  options: VerifiedArchiveOptions,
): Promise<{ files: number; bytes: number }> {
  if (
    !Number.isSafeInteger(options.expectedBytes) ||
    options.expectedBytes < 1 ||
    options.expectedBytes > MAX_ARCHIVE_BYTES ||
    !/^[a-f0-9]{64}$/.test(options.expectedSha256)
  )
    throw new Error("ARCHIVE_METADATA_INVALID");
  interrupted(options.signal);
  const named = await lstat(options.path, { bigint: true });
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1n ||
    named.size !== BigInt(options.expectedBytes)
  )
    throw new Error("ARCHIVE_INTEGRITY_INVALID");
  const archive = await open(
    options.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let zip: ZipFile | undefined;
  try {
    const opened = await archive.stat({ bigint: true });
    if (
      opened.ino !== named.ino ||
      opened.dev !== named.dev ||
      opened.size !== named.size ||
      !opened.isFile()
    )
      throw new Error("ARCHIVE_INTEGRITY_INVALID");
    const hash = createHash("sha256");
    for await (const bytes of archive.createReadStream({
      autoClose: false,
      start: 0,
      end: options.expectedBytes - 1,
      signal: options.signal,
    }))
      hash.update(bytes);
    const afterHash = await archive.stat({ bigint: true });
    if (
      hash.digest("hex") !== options.expectedSha256 ||
      afterHash.size !== opened.size ||
      afterHash.mtimeNs !== opened.mtimeNs ||
      afterHash.ctimeNs !== opened.ctimeNs
    )
      throw new Error("ARCHIVE_INTEGRITY_INVALID");
    zip = await new Promise<ZipFile>((resolve, reject) =>
      fromRandomAccessReader(
        new HandleReader(archive),
        options.expectedBytes,
        {
          lazyEntries: true,
          autoClose: false,
          validateEntrySizes: true,
          strictFileNames: true,
        },
        (error, value) =>
          error ? reject(new Error("ARCHIVE_INVALID")) : resolve(value),
      ),
    );
    const entries: { entry: Entry; path: string; directory: boolean }[] = [];
    if (zip.entryCount < 1 || zip.entryCount > MAX_ENTRIES)
      throw new Error("ARCHIVE_SIZE_UNSUPPORTED");
    const aliases = new Map<string, boolean>();
    let totalBytes = 0;
    // Preflight every central-directory entry before creating any output.
    for await (const entry of zip.eachEntry()) {
      interrupted(options.signal);
      const value = entryPath(entry);
      if (value.path === "" && value.directory) continue;
      const key = value.path.normalize("NFC").toLowerCase();
      if (aliases.has(key) || entries.length >= MAX_ENTRIES)
        throw new Error("ARCHIVE_PATH_UNSAFE");
      aliases.set(key, value.directory);
      totalBytes += entry.uncompressedSize;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_UNPACKED_BYTES)
        throw new Error("ARCHIVE_SIZE_UNSUPPORTED");
      entries.push({ entry, ...value });
    }
    if (
      !aliases.has("release-manifest.json") ||
      aliases.get("release-manifest.json") !== false
    )
      throw new Error("ARCHIVE_MANIFEST_MISSING");
    for (const { path } of entries) {
      const pieces = path.split("/");
      for (let index = 1; index < pieces.length; index++)
        if (
          aliases.get(
            pieces.slice(0, index).join("/").normalize("NFC").toLowerCase(),
          ) === false
        )
          throw new Error("ARCHIVE_PATH_UNSAFE");
    }
    const root = await options.destination.directory("");
    if (
      normalize(root) !== normalize(options.destination.root) ||
      (await readdir(root)).length !== 0
    )
      throw new Error("ARCHIVE_DESTINATION_UNSAFE");
    let written = 0;
    let files = 0;
    for (const { entry, path, directory } of entries) {
      interrupted(options.signal);
      if (directory) {
        const output = await options.destination.directory(path);
        if (normalize(output) !== normalize(join(root, ...path.split("/"))))
          throw new Error("ARCHIVE_DESTINATION_UNSAFE");
        continue;
      }
      const parent = path.split("/").slice(0, -1).join("/");
      const outputParent = await options.destination.directory(parent);
      if (
        normalize(outputParent) !== normalize(join(root, ...parent.split("/")))
      )
        throw new Error("ARCHIVE_DESTINATION_UNSAFE");
      await options.destination.validateFile(path, "absent");
      const output = await open(
        join(root, ...path.split("/")),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        const stream = await zip.openReadStreamPromise(entry);
        let fileBytes = 0;
        try {
          for await (const bytes of stream) {
            interrupted(options.signal);
            const chunk = Buffer.isBuffer(bytes)
              ? bytes
              : Buffer.from(bytes as Uint8Array);
            fileBytes += chunk.length;
            if (fileBytes > entry.uncompressedSize)
              throw new Error("ARCHIVE_SIZE_UNSUPPORTED");
            // FileHandle.write can return a short write; never discard the suffix.
            let offset = 0;
            while (offset < chunk.length) {
              const result = await output.write(
                chunk,
                offset,
                chunk.length - offset,
              );
              if (result.bytesWritten < 1)
                throw new Error("ARCHIVE_WRITE_FAILED");
              offset += result.bytesWritten;
            }
            written += chunk.length;
            options.onProgress?.(written, totalBytes);
          }
        } finally {
          stream.destroy();
        }
        if (fileBytes !== entry.uncompressedSize)
          throw new Error("ARCHIVE_INTEGRITY_INVALID");
        await output.sync();
      } finally {
        await output.close();
      }
      await options.destination.validateFile(path, "file");
      files++;
    }
    const afterExtraction = await archive.stat({ bigint: true });
    if (
      afterExtraction.size !== opened.size ||
      afterExtraction.mtimeNs !== opened.mtimeNs ||
      afterExtraction.ctimeNs !== opened.ctimeNs
    )
      throw new Error("ARCHIVE_INTEGRITY_INVALID");
    interrupted(options.signal);
    return { files, bytes: written };
  } finally {
    zip?.close();
    await archive.close();
  }
}

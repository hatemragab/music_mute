import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { AdvancedExportEntry } from "./fleet/advanced/benchmark-exports.js";
import { CRC32_INITIAL, finishCrc32, updateCrc32 } from "./crc32.js";
/** Bounded stored ZIP (PKWARE APPNOTE 6.3.10). No complete audio buffer is built. */
export async function writeBenchmarkDestination(
  kind: "audio" | "report",
  output: FileHandle,
  entries: readonly AdvancedExportEntry[],
  signal: AbortSignal,
  current: () => void,
): Promise<void> {
  const audio = kind === "audio",
    names = new Set<string>();
  let total = 0;
  if (entries.length < 1 || entries.length > (audio ? 26 : 1))
    throw new Error("EXPORT_UNAVAILABLE");
  for (const entry of entries) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(entry.filename) ||
      entry.filename.includes("..") ||
      names.has(entry.filename.toLowerCase()) ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1 ||
      entry.bytes > (audio ? 256 * 1024 ** 2 : 2 * 1024 ** 2) ||
      (!audio && !entry.filename.endsWith(".json"))
    )
      throw new Error("EXPORT_UNAVAILABLE");
    names.add(entry.filename.toLowerCase());
    total += entry.bytes;
  }
  if (total > (audio ? 1024 ** 3 : 2 * 1024 ** 2))
    throw new Error("EXPORT_UNAVAILABLE");
  if ((await output.stat()).size !== 0) throw new Error("EXPORT_UNAVAILABLE");
  let position = 0;
  const write = async (bytes: Buffer) => {
    for (let offset = 0; offset < bytes.length;) {
      signal.throwIfAborted();
      current();
      const result = await output.write(
        bytes,
        offset,
        bytes.length - offset,
        position,
      );
      if (result.bytesWritten < 1) throw new Error("EXPORT_UNAVAILABLE");
      position += result.bytesWritten;
      offset += result.bytesWritten;
    }
  };
  const directory: Buffer[] = [];
  const buffer = Buffer.alloc(Math.min(total, 1024 ** 2));
  for (const entry of entries) {
    const before = await entry.file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size !== BigInt(entry.bytes)
    )
      throw new Error("EXPORT_UNAVAILABLE");
    const start = position,
      name = Buffer.from(entry.filename),
      hash = createHash("sha256");
    let crc = CRC32_INITIAL;
    if (audio) {
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x808, 6);
      local.writeUInt16LE(0x21, 12);
      local.writeUInt16LE(name.length, 26);
      await write(local);
      await write(name);
    }
    for (let offset = 0; offset < entry.bytes;) {
      signal.throwIfAborted();
      current();
      const { bytesRead } = await entry.file.read(
        buffer,
        0,
        Math.min(buffer.length, entry.bytes - offset),
        offset,
      );
      if (bytesRead < 1) throw new Error("EXPORT_UNAVAILABLE");
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes);
      crc = updateCrc32(crc, bytes);
      await write(bytes);
      offset += bytesRead;
    }
    const after = await entry.file.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      hash.digest("hex") !== entry.sha256
    )
      throw new Error("EXPORT_UNAVAILABLE");
    if (audio) {
      const checksum = finishCrc32(crc),
        descriptor = Buffer.alloc(16),
        central = Buffer.alloc(46);
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(entry.bytes, 8);
      descriptor.writeUInt32LE(entry.bytes, 12);
      await write(descriptor);
      central.writeUInt32LE(0x02014b50);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x808, 8);
      central.writeUInt16LE(0x21, 14);
      central.writeUInt32LE(checksum, 16);
      central.writeUInt32LE(entry.bytes, 20);
      central.writeUInt32LE(entry.bytes, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(start, 42);
      directory.push(central, name);
    }
  }
  if (audio) {
    const start = position;
    for (const row of directory) await write(row);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(position - start, 12);
    end.writeUInt32LE(start, 16);
    await write(end);
  }
  signal.throwIfAborted();
  current();
}

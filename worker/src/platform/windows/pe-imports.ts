import { lstat, open, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";

export interface WindowsPeImport {
  name: string;
  kind: "import" | "delay";
}
const MAX_OFFSET = 1024 * 1024,
  MAX_IMPORTS = 2048;
function invalid(): never {
  throw new TypeError(
    "Windows runtime has an invalid or unsupported PE import table",
  );
}
async function read(
  handle: FileHandle,
  offset: number,
  bytes: number,
  size: number,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    offset + bytes > size
  )
    return invalid();
  const result = Buffer.alloc(bytes);
  let done = 0;
  while (done < bytes) {
    const { bytesRead } = await handle.read(
      result,
      done,
      bytes - done,
      offset + done,
    );
    if (!bytesRead) return invalid();
    done += bytesRead;
  }
  return result;
}
/** Only bounded PE32+ ordinary/delay library names are read. A real DLL-format
 * .node addon may also declare the exact Node-API host import node.exe. That is
 * an import-table fact; the payload auditor must bind its actual Node/Deno host.
 * This does not execute
 * a binary, validate symbol exports, or prove dynamically computed LoadLibrary. */
export async function readWindowsX64Imports(
  path: string,
): Promise<WindowsPeImport[]> {
  const pathBefore = await lstat(path);
  if (
    !pathBefore.isFile() ||
    pathBefore.isSymbolicLink() ||
    pathBefore.nlink !== 1
  )
    return invalid();
  const handle = await open(path, "r");
  try {
    const before = await handle.stat(),
      size = before.size;
    if (!before.isFile() || before.nlink !== 1 || size < 64 || size > 2 ** 31)
      return invalid();
    const dos = await read(handle, 0, 64, size),
      offset = dos.readUInt32LE(0x3c);
    if (
      pathBefore.dev !== before.dev ||
      pathBefore.ino !== before.ino ||
      dos.toString("ascii", 0, 2) !== "MZ" ||
      offset < 64 ||
      offset > MAX_OFFSET
    )
      return invalid();
    const coff = await read(handle, offset, 24, size),
      sections = coff.readUInt16LE(6),
      optionalSize = coff.readUInt16LE(20);
    if (
      coff.toString("binary", 0, 4) !== "PE\0\0" ||
      coff.readUInt16LE(4) !== 0x8664 ||
      sections < 1 ||
      sections > 96 ||
      optionalSize < 112 ||
      optionalSize > 4096
    )
      return invalid();
    const nodeAddon =
      basename(path).toLowerCase().endsWith(".node") &&
      (coff.readUInt16LE(22) & 0x2000) !== 0;
    const optional = await read(handle, offset + 24, optionalSize, size),
      directories = optional.readUInt32LE(108),
      headers = optional.readUInt32LE(60),
      image = optional.readUInt32LE(56);
    if (
      optional.readUInt16LE(0) !== 0x20b ||
      directories > 16 ||
      112 + directories * 8 > optionalSize ||
      headers < offset + 24 + optionalSize + sections * 40 ||
      headers > size ||
      image < headers
    )
      return invalid();
    const table = await read(
        handle,
        offset + 24 + optionalSize,
        sections * 40,
        size,
      ),
      mappings: {
        rva: number;
        bytes: number;
        offset: number;
        virtualBytes: number;
      }[] = [];
    for (let i = 0; i < sections; i++) {
      const at = i * 40,
        virtualBytes = table.readUInt32LE(at + 8),
        rva = table.readUInt32LE(at + 12),
        bytes = table.readUInt32LE(at + 16),
        start = table.readUInt32LE(at + 20);
      if (
        rva < headers ||
        rva + Math.max(bytes, virtualBytes) > image ||
        (bytes && (start < headers || start + bytes > size))
      )
        return invalid();
      for (const row of mappings)
        if (
          rva < row.rva + Math.max(row.bytes, row.virtualBytes) &&
          row.rva < rva + Math.max(bytes, virtualBytes)
        )
          return invalid();
      mappings.push({ rva, bytes, offset: start, virtualBytes });
    }
    const mapped = (rva: number, bytes: number): number => {
      if (rva < 1 || rva + bytes > image) return invalid();
      if (rva + bytes <= headers) return rva;
      const rows = mappings.filter(
        (row) => rva >= row.rva && rva + bytes <= row.rva + row.bytes,
      );
      if (rows.length !== 1) return invalid();
      return rows[0]!.offset + rva - rows[0]!.rva;
    };
    const name = async (rva: number): Promise<string> => {
      const start = mapped(rva, 1),
        row = mappings.find(
          (entry) => rva >= entry.rva && rva < entry.rva + entry.bytes,
        ),
        available = rva < headers ? headers - rva : row!.rva + row!.bytes - rva,
        bytes = await read(handle, start, Math.min(181, available), size),
        end = bytes.indexOf(0);
      if (
        end < 1 ||
        bytes.subarray(0, end).some((value) => value < 0x21 || value > 0x7e)
      )
        return invalid();
      const result = bytes.toString("ascii", 0, end).toLowerCase();
      if (
        (!/^[a-z0-9][a-z0-9._+-]{0,175}\.(?:dll|drv)$/u.test(result) &&
          !(nodeAddon && result === "node.exe")) ||
        result.includes("..")
      )
        return invalid();
      return result;
    };
    const imports: WindowsPeImport[] = [],
      seen = new Set<string>();
    let descriptorCount = 0;
    for (const [directory, kind, stride, nameOffset] of [
      [1, "import", 20, 12],
      [13, "delay", 32, 4],
    ] as const) {
      if (directory >= directories) continue;
      const at = 112 + directory * 8,
        rva = optional.readUInt32LE(at),
        bytes = optional.readUInt32LE(at + 4);
      if (rva === 0 && bytes === 0) continue;
      if (!rva || bytes < stride) return invalid();
      // Some toolchains advertise the whole .idata payload, including thunks
      // and names. Validate its complete mapped range, but read only the bounded
      // descriptor prefix (including the required null terminator).
      const data = await read(
        handle,
        mapped(rva, bytes),
        Math.min(bytes, (MAX_IMPORTS + 1) * stride),
        size,
      );
      let terminated = false;
      for (let entry = 0; entry + stride <= data.length; entry += stride) {
        const descriptor = data.subarray(entry, entry + stride);
        if (descriptor.every((byte) => byte === 0)) {
          terminated = true;
          break;
        }
        if (++descriptorCount > MAX_IMPORTS) return invalid();
        // Pinned current PE64 toolchains use RVA-based delay descriptors only.
        if (kind === "delay" && descriptor.readUInt32LE(0) !== 1)
          return invalid();
        const dll = await name(descriptor.readUInt32LE(nameOffset)),
          key = `${kind}:${dll}`;
        // Linkers may split one library's imports across multiple descriptors.
        // Count every descriptor, but project each dependency only once.
        if (!seen.has(key)) {
          seen.add(key);
          imports.push({ name: dll, kind });
        }
      }
      if (!terminated) return invalid();
    }
    const after = await handle.stat(),
      pathAfter = await lstat(path);
    if (
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino ||
      pathAfter.isSymbolicLink() ||
      pathAfter.nlink !== 1 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      return invalid();
    return imports;
  } finally {
    await handle.close();
  }
}

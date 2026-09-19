import { open } from "node:fs/promises";

const DOS_HEADER_BYTES = 64;
const PE_HEADER_BYTES = 26;
const MAX_PE_OFFSET = 1024 * 1024;
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const PE32_PLUS_MAGIC = 0x20b;

export async function auditWindowsX64Binary(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    const dos = Buffer.alloc(DOS_HEADER_BYTES);
    const dosRead = await handle.read(dos, 0, dos.length, 0);
    if (
      dosRead.bytesRead !== dos.length ||
      dos.toString("ascii", 0, 2) !== "MZ"
    )
      throw new TypeError("Windows runtime binary has an invalid DOS header");
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset < DOS_HEADER_BYTES || peOffset > MAX_PE_OFFSET)
      throw new TypeError("Windows runtime binary has an invalid PE offset");
    const pe = Buffer.alloc(PE_HEADER_BYTES);
    const peRead = await handle.read(pe, 0, pe.length, peOffset);
    if (
      peRead.bytesRead !== pe.length ||
      pe.toString("binary", 0, 4) !== "PE\0\0"
    )
      throw new TypeError("Windows runtime binary has an invalid PE header");
    if (pe.readUInt16LE(4) !== IMAGE_FILE_MACHINE_AMD64)
      throw new TypeError("Windows runtime binary is not x86_64");
    if (pe.readUInt16LE(24) !== PE32_PLUS_MAGIC)
      throw new TypeError("Windows runtime binary is not PE32+");
  } finally {
    await handle.close();
  }
}

import type { WindowsPeImport } from "../../src/platform/windows/pe-imports.js";
/** Structural bytes only, never a runnable Windows executable or release input. */
export function fixturePe64(imports: readonly WindowsPeImport[] = []): Buffer {
  const bytes = Buffer.alloc(4096),
    pe = 128,
    optional = pe + 24,
    section = optional + 240;
  bytes.write("MZ");
  bytes.writeUInt32LE(pe, 0x3c);
  bytes.write("PE\0\0", pe, "binary");
  bytes.writeUInt16LE(0x8664, pe + 4);
  bytes.writeUInt16LE(1, pe + 6);
  bytes.writeUInt16LE(240, pe + 20);
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt32LE(8192, optional + 56);
  bytes.writeUInt32LE(512, optional + 60);
  bytes.writeUInt32LE(16, optional + 108);
  bytes.write(".idata", section);
  bytes.writeUInt32LE(3584, section + 8);
  bytes.writeUInt32LE(4096, section + 12);
  bytes.writeUInt32LE(3584, section + 16);
  bytes.writeUInt32LE(512, section + 20);
  let names = 1536;
  for (const [kind, directory, offset, stride, nameField] of [
    ["import", 1, 512, 20, 12],
    ["delay", 13, 1024, 32, 4],
  ] as const) {
    const selected = imports.filter((row) => row.kind === kind);
    if (!selected.length) continue;
    bytes.writeUInt32LE(offset - 512 + 4096, optional + 112 + directory * 8);
    bytes.writeUInt32LE(
      (selected.length + 1) * stride,
      optional + 116 + directory * 8,
    );
    for (let i = 0; i < selected.length; i++) {
      const at = offset + i * stride;
      if (kind === "delay") bytes.writeUInt32LE(1, at);
      bytes.writeUInt32LE(names - 512 + 4096, at + nameField);
      bytes.write(selected[i]!.name, names, "ascii");
      names += selected[i]!.name.length + 1;
    }
  }
  return bytes;
}

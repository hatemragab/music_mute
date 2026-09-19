import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditWindowsX64Binary } from "../src/platform/windows/pe-audit.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Windows PE audit", () => {
  it("accepts an x86_64 PE32+ binary", async () => {
    const path = await fixture(0x8664, 0x20b);
    await expect(auditWindowsX64Binary(path)).resolves.toBeUndefined();
  });

  it("rejects a non-x86_64 binary", async () => {
    const path = await fixture(0xaa64, 0x20b);
    await expect(auditWindowsX64Binary(path)).rejects.toThrow("not x86_64");
  });
});

async function fixture(machine: number, magic: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-pe-"));
  roots.push(root);
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64, "binary");
  bytes.writeUInt16LE(machine, 68);
  bytes.writeUInt16LE(2, 70);
  bytes.writeUInt16LE(0xf0, 84);
  bytes.writeUInt16LE(magic, 88);
  const path = join(root, "fixture.exe");
  await writeFile(path, bytes);
  return path;
}

import { createHash } from "node:crypto";
import {
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import yauzl from "yauzl";
import { writeBenchmarkDestination } from "../src/main/benchmark-export.js";
import { crc32 } from "../src/main/crc32.js";
import type { AdvancedExportEntry } from "../src/main/fleet/advanced/benchmark-exports.js";
const roots: string[] = [],
  handles: FileHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((file) => file.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(bytes: Buffer) {
  const root = await mkdtemp(join(tmpdir(), "musicmute-benchmark-export-"));
  roots.push(root);
  await writeFile(join(root, "source"), bytes);
  const file = await open(join(root, "source"), "r"),
    output = await open(join(root, "output"), "wx");
  handles.push(file, output);
  const entry: AdvancedExportEntry = {
    file,
    filename: "run-01-vocals.mp3",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return { root, file, output, entry };
}
async function decode(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error);
        return;
      }
      const rows = new Map<string, Buffer>();
      zip.on("error", reject);
      zip.on("end", () => resolve(rows));
      zip.on("entry", (entry) =>
        zip.openReadStream(entry, (failure, stream) => {
          if (failure || !stream) {
            reject(failure);
            return;
          }
          const data: Buffer[] = [];
          stream.on("data", (chunk) => data.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            const content = Buffer.concat(data);
            expect(crc32(content)).toBe(entry.crc32);
            rows.set(entry.fileName, content);
            zip.readEntry();
          });
        }),
      );
      zip.readEntry();
    });
  });
}
it("streams saved benchmark audio larger than the report buffer limit into an interoperable CRC-checked ZIP", async () => {
  const bytes = Buffer.alloc(9 * 1024 ** 2 + 17, 0x39),
    f = await fixture(bytes);
  await writeBenchmarkDestination(
    "audio",
    f.output,
    [f.entry],
    new AbortController().signal,
    () => {},
  );
  const rows = await decode(await readFile(join(f.root, "output")));
  expect(rows.get(f.entry.filename)?.equals(bytes)).toBe(true);
  expect((await readFile(join(f.root, "source"))).equals(bytes)).toBe(true);
  expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
});
it("keeps reports as a bounded plain JSON document and rejects altered borrowed audio before committing", async () => {
  const bytes = Buffer.from('{"provider":"directml"}'),
    f = await fixture(bytes);
  await writeBenchmarkDestination(
    "report",
    f.output,
    [{ ...f.entry, filename: "benchmark.json" }],
    new AbortController().signal,
    () => {},
  );
  expect(await readFile(join(f.root, "output"))).toEqual(bytes);
  const changed = await fixture(Buffer.from("changed source"));
  await expect(
    writeBenchmarkDestination(
      "audio",
      changed.output,
      [{ ...changed.entry, sha256: "a".repeat(64) }],
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow("EXPORT_UNAVAILABLE");
});
it("rejects duplicate/traversing names, count and aggregate limits before writing destination bytes", async () => {
  const f = await fixture(Buffer.from("fixture")),
    signal = new AbortController().signal;
  for (const entries of [
    [{ ...f.entry, filename: "../escape.mp3" }],
    [f.entry, { ...f.entry }],
    Array.from({ length: 27 }, (_, index) => ({
      ...f.entry,
      filename: `${index}.mp3`,
    })),
    Array.from({ length: 5 }, (_, index) => ({
      ...f.entry,
      filename: `${index}.mp3`,
      bytes: 256 * 1024 ** 2,
    })),
  ])
    await expect(
      writeBenchmarkDestination("audio", f.output, entries, signal, () => {}),
    ).rejects.toThrow("EXPORT_UNAVAILABLE");
  expect((await f.output.stat()).size).toBe(0);
});

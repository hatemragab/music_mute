import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  extractVerifiedArchive,
  planVerifiedArchive,
  type ArchiveDestination,
} from "../src/main/prepare/verified-archive.js";
interface FixtureEntry {
  name: string;
  body?: string;
  attributes?: number;
  flags?: number;
}
/** Tiny stored ZIP fixtures; no external zip/toolchain or installed runtime is invoked. */
function fixtureZip(entries: FixtureEntry[]): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      body = Buffer.from(entry.body ?? "");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.flags ?? 0, 6);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(name.length, 26);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50);
    index.writeUInt16LE(0x0314, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt16LE(entry.flags ?? 0, 8);
    index.writeUInt32LE(body.length, 20);
    index.writeUInt32LE(body.length, 24);
    index.writeUInt16LE(name.length, 28);
    index.writeUInt32LE(entry.attributes ?? 0, 38);
    index.writeUInt32LE(offset, 42);
    local.push(header, name, body);
    central.push(index, name);
    offset += header.length + name.length + body.length;
  }
  const indexes = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(indexes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, indexes, end]);
}
async function withArchive(
  entries: FixtureEntry[],
  run: (options: {
    path: string;
    expectedBytes: number;
    expectedSha256: string;
    destination: ArchiveDestination;
    signal: AbortSignal;
  }) => Promise<void>,
) {
  const parent = await mkdtemp(join(tmpdir(), "musicmute-archive-"));
  const path = join(parent, "input.zip"),
    root = join(parent, "staging");
  const bytes = fixtureZip(entries);
  await writeFile(path, bytes);
  await mkdir(root);
  const destination: ArchiveDestination = {
    root,
    directory: async (relative) => {
      const output = join(root, ...relative.split("/"));
      await mkdir(output, { recursive: true });
      return output;
    },
    validateFile: async (relative, kind) => {
      const file = join(root, ...relative.split("/"));
      if (kind === "absent") {
        await expect(lstat(file)).rejects.toThrow();
      } else {
        const stat = await lstat(file);
        expect(stat.isFile() && !stat.isSymbolicLink()).toBe(true);
      }
    },
  };
  try {
    await run({
      path,
      expectedBytes: bytes.length,
      expectedSha256: createHash("sha256").update(bytes).digest("hex"),
      destination,
      signal: new AbortController().signal,
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}
const manifest = { name: "release-manifest.json", body: '{"fixture":true}' };
it("plans disk usage from the same signed archive without creating extracted files", async () => {
  await withArchive(
    [manifest, { name: "runtime/node/node.exe", body: "fixture-PE" }],
    async (options) => {
      expect(
        await planVerifiedArchive(
          options.path,
          options.expectedBytes,
          options.expectedSha256,
          options.signal,
        ),
      ).toBe(26);
      expect(await readdir(options.destination.root)).toEqual([]);
      await expect(
        planVerifiedArchive(
          options.path,
          options.expectedBytes,
          "0".repeat(64),
          options.signal,
        ),
      ).rejects.toThrow("ARCHIVE_INTEGRITY_INVALID");
    },
  );
});
it("extracts a hash-verified ZIP with tar-style ./ names into validated fresh staging", async () => {
  await withArchive(
    [
      { name: "./" },
      { ...manifest, name: "./release-manifest.json" },
      { name: "./runtime/node/node.exe", body: "fixture-PE" },
    ],
    async (options) => {
      const progress: number[] = [];
      const result = await extractVerifiedArchive({
        ...options,
        onProgress: (written) => progress.push(written),
      });
      expect(result.files).toBe(2);
      expect(result.bytes).toBe(26);
      expect(progress.at(-1)).toBe(26);
      expect(
        await readFile(
          join(options.destination.root, "runtime/node/node.exe"),
          "utf8",
        ),
      ).toBe("fixture-PE");
    },
  );
});
it.each(
  [
    [{ name: "../escape.txt", body: "unsafe" }],
    [{ name: "runtime/AUX.txt", body: "unsafe" }],
    [{ name: "runtime/file:stream", body: "unsafe" }],
    [
      { name: "runtime/file", body: "x" },
      { name: "runtime/File", body: "y" },
    ],
    [
      { name: "runtime/file", body: "x" },
      { name: "runtime/file/child", body: "y" },
    ],
    [{ name: "runtime/link", attributes: 0o120777 * 65536, body: "target" }],
    [{ name: "runtime/reparse", attributes: 0x400, body: "target" }],
    [{ name: "runtime/encrypted", flags: 1, body: "hidden" }],
  ].map((entries) => ({ entries })),
)(
  "preflights unsafe Windows archive entries before writing %j",
  async ({ entries }) => {
    await withArchive([manifest, ...entries], async (options) => {
      await expect(extractVerifiedArchive(options)).rejects.toThrow();
      expect(await readdir(options.destination.root)).toEqual([]);
    });
  },
);
it("rejects wrong digests, missing manifests and occupied destinations", async () => {
  await withArchive([manifest], async (options) => {
    await expect(
      extractVerifiedArchive({ ...options, expectedSha256: "0".repeat(64) }),
    ).rejects.toThrow("ARCHIVE_INTEGRITY_INVALID");
    await writeFile(join(options.destination.root, "preserve"), "existing");
    await expect(extractVerifiedArchive(options)).rejects.toThrow(
      "ARCHIVE_DESTINATION_UNSAFE",
    );
    expect(
      await readFile(join(options.destination.root, "preserve"), "utf8"),
    ).toBe("existing");
  });
  await withArchive(
    [{ name: "runtime/file", body: "fixture" }],
    async (options) => {
      await expect(extractVerifiedArchive(options)).rejects.toThrow(
        "ARCHIVE_MANIFEST_MISSING",
      );
    },
  );
});
it("cancels without producing output and rejects a redirected native staging adapter", async () => {
  await withArchive([manifest], async (options) => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      extractVerifiedArchive({ ...options, signal: abort.signal }),
    ).rejects.toThrow("PREPARE_CANCELLED");
    await expect(
      extractVerifiedArchive({
        ...options,
        destination: {
          ...options.destination,
          directory: async () => tmpdir(),
        },
      }),
    ).rejects.toThrow("ARCHIVE_DESTINATION_UNSAFE");
    expect(await readdir(options.destination.root)).toEqual([]);
  });
});

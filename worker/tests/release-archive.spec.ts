import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeReleaseArchiveEntries,
  createInstallationReleaseArchive,
  prepareInstallationRelease,
} from "../src/enrollment/release-archive.js";
import {
  verifyMacRelease,
  writeMacReleaseManifest,
} from "../src/platform/macos/release-manifest.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("installation release archive", () => {
  it("accepts one direct immutable release tree", () => {
    expect(() =>
      assertSafeReleaseArchiveEntries(
        [
          "./",
          "./app/",
          "./app/dist/src/cli/main.js",
          "./runtime/node/bin/node",
          "./release-manifest.json",
        ].join("\n"),
      ),
    ).not.toThrow();
  });

  it.each([
    ["parent traversal", "../escape\nrelease-manifest.json"],
    ["nested traversal", "runtime/../escape\nrelease-manifest.json"],
    ["absolute path", "/tmp/escape\nrelease-manifest.json"],
    ["Windows drive path", "C:\\escape\nrelease-manifest.json"],
    ["backslash path", "runtime\\escape\nrelease-manifest.json"],
    ["duplicate path", "app/file\napp/file\nrelease-manifest.json"],
    ["missing manifest", "app/file"],
  ])("rejects %s", (_name, listing) => {
    expect(() => assertSafeReleaseArchiveEntries(listing)).toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "creates a catalog-ready archive and materializes the exact release",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "musicmute-release-archive-"));
      roots.push(root);
      const releaseRoot = join(root, "release");
      await macRelease(releaseRoot, "0.1.2");
      const archiveRoot = join(root, "archives");
      const preparedRoot = join(root, "prepared");
      await mkdir(archiveRoot, { mode: 0o700 });
      await mkdir(preparedRoot, { mode: 0o700 });
      await chmod(archiveRoot, 0o700);
      await chmod(preparedRoot, 0o700);
      const archivePath = join(archiveRoot, "musicmute-worker.tar.gz");

      const created = await createInstallationReleaseArchive({
        releaseRoot,
        outputPath: archivePath,
        platform: "darwin-arm64",
      });
      const bytes = await readFile(archivePath);
      expect(created).toMatchObject({
        path: archivePath,
        releaseVersion: "0.1.2",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        contentType: "application/gzip",
      });

      const prepared = await prepareInstallationRelease({
        archivePath,
        outputRoot: preparedRoot,
        platform: "darwin-arm64",
        releaseVersion: "0.1.2",
      });
      expect(prepared.reused).toBe(false);
      await expect(verifyMacRelease(prepared.path)).resolves.toMatchObject({
        releaseVersion: "0.1.2",
      });
      await expect(
        createInstallationReleaseArchive({
          releaseRoot,
          outputPath: archivePath,
          platform: "darwin-arm64",
        }),
      ).rejects.toThrow("already exists");
    },
  );
});

async function macRelease(root: string, version: string): Promise<void> {
  const files: Array<[string, string, number]> = [
    ["app/dist/src/cli/main.js", "#!/usr/bin/env node\n", 0o755],
    ["app/engine/musicmute_engine/__init__.py", "VALUE = 1\n", 0o644],
    ["app/package.json", '{"private":true}\n', 0o644],
    ["runtime/node/bin/node", "#!/bin/sh\nexit 0\n", 0o755],
    ["runtime/python/bin/python3", "#!/bin/sh\nexit 0\n", 0o755],
    ["runtime/bin/ffmpeg", "#!/bin/sh\nexit 0\n", 0o755],
    ["runtime/bin/ffprobe", "#!/bin/sh\nexit 0\n", 0o755],
    ["runtime/media-source-manifest.json", '{"schemaVersion":1}\n', 0o644],
    ["runtime/licenses/ffmpeg/COPYING.LGPLv2.1", "ffmpeg\n", 0o644],
    ["runtime/licenses/lame/COPYING", "lame\n", 0o644],
  ];
  for (const [path, contents, mode] of files) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, { mode });
    await chmod(absolute, mode);
  }
  await writeMacReleaseManifest(root, version);
}

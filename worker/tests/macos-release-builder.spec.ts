import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMacRelease } from "../src/platform/macos/release-builder.js";
import { verifyMacRelease } from "../src/platform/macos/release-manifest.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("macOS release builder", () => {
  it("assembles only the compiled app and private runtime inputs", async () => {
    const root = await temporaryRoot();
    const workerRoot = join(root, "worker");
    const nodeRoot = join(root, "node");
    const pythonRoot = join(root, "python");
    const mediaRoot = join(root, "media");
    const outputRoot = join(root, "release");
    await compiledCli(join(workerRoot, "dist", "src", "cli", "main.js"));
    await mkdir(join(workerRoot, "engine"), { recursive: true });
    await writeFile(join(workerRoot, "engine", "module.py"), "VALUE = 1\n");
    await writeFile(join(workerRoot, "engine", "ignored.pyc"), "ignored\n");
    await writeFile(join(workerRoot, "package.json"), '{"private":true}\n');
    await executable(join(nodeRoot, "bin", "node"));
    await executable(join(pythonRoot, "bin", "python3.13"));
    await symlink("python3.13", join(pythonRoot, "bin", "python3"));
    await mediaRuntime(mediaRoot);

    const built = await buildMacRelease({
      workerRoot,
      outputRoot,
      releaseVersion: "0.1.0-builder.1",
      nodeRoot,
      pythonRoot,
      mediaRoot,
      host: { platform: "darwin", arch: "arm64" },
      binaryAudit: async () => {},
    });

    expect(await verifyMacRelease(outputRoot)).toEqual(built);
    expect(
      (await lstat(join(outputRoot, "app", "dist", "src", "cli", "main.js")))
        .mode & 0o777,
    ).toBe(0o755);
    expect(built.entries.map((entry) => entry.path)).not.toContain(
      "app/engine/ignored.pyc",
    );
    expect(built.entries.map((entry) => entry.path)).toContain(
      "runtime/media-source-manifest.json",
    );
    expect(built.entries.map((entry) => entry.path)).toContain(
      "runtime/licenses/lame/COPYING",
    );
    await expect(lstat(join(outputRoot, "state"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to produce a Mac package on a non-ARM64 host", async () => {
    const root = await temporaryRoot();
    await expect(
      buildMacRelease({
        workerRoot: join(root, "worker"),
        outputRoot: join(root, "release"),
        releaseVersion: "0.1.0-builder.2",
        nodeRoot: join(root, "node"),
        pythonRoot: join(root, "python"),
        mediaRoot: join(root, "media"),
        host: { platform: "linux", arch: "x64" },
      }),
    ).rejects.toThrow("native Darwin ARM64 host");
  });
});

async function executable(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(path, 0o755);
}

async function compiledCli(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/usr/bin/env node\n", { mode: 0o644 });
  await chmod(path, 0o644);
}

async function mediaRuntime(root: string): Promise<void> {
  await executable(join(root, "bin", "ffmpeg"));
  await executable(join(root, "bin", "ffprobe"));
  await mkdir(join(root, "licenses", "ffmpeg"), { recursive: true });
  await mkdir(join(root, "licenses", "lame"), { recursive: true });
  await writeFile(
    join(root, "licenses", "ffmpeg", "COPYING.LGPLv2.1"),
    "FFmpeg license\n",
  );
  await writeFile(join(root, "licenses", "lame", "COPYING"), "LAME license\n");
  await writeFile(join(root, "SOURCE-MANIFEST.json"), '{"schemaVersion":1}\n');
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-macos-builder-"));
  roots.push(root);
  return root;
}

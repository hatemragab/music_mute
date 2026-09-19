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
    const outputRoot = join(root, "release");
    await executable(join(workerRoot, "dist", "src", "cli", "main.js"));
    await mkdir(join(workerRoot, "engine"), { recursive: true });
    await writeFile(join(workerRoot, "engine", "module.py"), "VALUE = 1\n");
    await writeFile(join(workerRoot, "engine", "ignored.pyc"), "ignored\n");
    await writeFile(join(workerRoot, "package.json"), '{"private":true}\n');
    await executable(join(nodeRoot, "bin", "node"));
    await executable(join(pythonRoot, "bin", "python3.13"));
    await symlink("python3.13", join(pythonRoot, "bin", "python3"));
    const ffmpeg = join(root, "ffmpeg");
    const ffprobe = join(root, "ffprobe");
    await executable(ffmpeg);
    await executable(ffprobe);

    const built = await buildMacRelease({
      workerRoot,
      outputRoot,
      releaseVersion: "0.1.0-builder.1",
      nodeRoot,
      pythonRoot,
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      host: { platform: "darwin", arch: "arm64" },
      binaryAudit: async () => {},
    });

    expect(await verifyMacRelease(outputRoot)).toEqual(built);
    expect(built.entries.map((entry) => entry.path)).not.toContain(
      "app/engine/ignored.pyc",
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
        ffmpegPath: join(root, "ffmpeg"),
        ffprobePath: join(root, "ffprobe"),
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

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-macos-builder-"));
  roots.push(root);
  return root;
}

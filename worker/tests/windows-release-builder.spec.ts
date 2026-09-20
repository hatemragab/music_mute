import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWindowsRelease } from "../src/platform/windows/release-builder.js";
import { verifyWindowsRelease } from "../src/platform/windows/release-manifest.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Windows release builder", () => {
  it("builds a complete private release and audits every runtime executable", async () => {
    const fixture = await inputs();
    const audited: string[] = [];
    const manifest = await buildWindowsRelease({
      ...fixture,
      releaseVersion: "0.1.0-win.1",
      host: { platform: "win32", arch: "x64" },
      binaryAudit: async (path) => {
        audited.push(path);
      },
    });
    expect(audited).toHaveLength(5);
    expect(await verifyWindowsRelease(fixture.outputRoot)).toEqual(manifest);
    await expect(
      readFile(
        join(
          fixture.outputRoot,
          "runtime",
          "service",
          "MusicMuteWorkerService.exe",
        ),
        "utf8",
      ),
    ).resolves.toBe("winsw\n");
  });

  it("rejects a non-Windows build host before creating output", async () => {
    const fixture = await inputs();
    await expect(
      buildWindowsRelease({
        ...fixture,
        releaseVersion: "0.1.0-win.1",
        host: { platform: "darwin", arch: "arm64" },
      }),
    ).rejects.toThrow("native Windows x86_64 host");
  });
});

async function inputs() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-win-builder-"));
  roots.push(root);
  const workerRoot = join(root, "worker");
  const outputRoot = join(root, "release");
  const nodeRoot = join(root, "node");
  const pythonRoot = join(root, "python");
  const mediaRoot = join(root, "media");
  const serviceRoot = join(root, "service");
  const files: Array<[string, string]> = [
    [join(workerRoot, "dist", "src", "cli", "main.js"), "cli\n"],
    [join(workerRoot, "engine", "musicmute_engine", "__init__.py"), "engine\n"],
    [join(workerRoot, "package.json"), "{}\n"],
    [
      join(workerRoot, "scripts", "manage-windows-service.ps1"),
      "Write-Output 'installer'\n",
    ],
    [join(nodeRoot, "node.exe"), "node\n"],
    [join(pythonRoot, "python.exe"), "python\n"],
    [join(mediaRoot, "bin", "ffmpeg.exe"), "ffmpeg\n"],
    [join(mediaRoot, "bin", "ffprobe.exe"), "ffprobe\n"],
    [join(mediaRoot, "SOURCE-MANIFEST.json"), "{}\n"],
    [
      join(mediaRoot, "licenses", "ffmpeg", "COPYING.LGPLv2.1"),
      "ffmpeg license\n",
    ],
    [join(mediaRoot, "licenses", "lame", "COPYING"), "lame license\n"],
    [join(serviceRoot, "WinSW.exe"), "winsw\n"],
    [join(serviceRoot, "SOURCE-MANIFEST.json"), "{}\n"],
    [join(serviceRoot, "LICENSE.txt"), "winsw license\n"],
  ];
  for (const [path, contents] of files) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  return {
    workerRoot,
    outputRoot,
    nodeRoot,
    pythonRoot,
    mediaRoot,
    serviceRoot,
  };
}

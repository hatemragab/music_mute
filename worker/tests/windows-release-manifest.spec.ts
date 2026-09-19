import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  verifyWindowsRelease,
  writeWindowsReleaseManifest,
} from "../src/platform/windows/release-manifest.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Windows release manifest", () => {
  it("round-trips an immutable release and detects drift", async () => {
    const root = await releaseFixture();
    const manifest = await writeWindowsReleaseManifest(root, "0.1.0-win.1");
    await expect(verifyWindowsRelease(root)).resolves.toEqual(manifest);
    await writeFile(join(root, "runtime", "node", "node.exe"), "changed");
    await expect(verifyWindowsRelease(root)).rejects.toThrow("does not match");
  });

  it("rejects links anywhere in the release", async () => {
    const root = await releaseFixture();
    await symlink("node.exe", join(root, "runtime", "node", "node-link.exe"));
    await expect(
      writeWindowsReleaseManifest(root, "0.1.0-win.1"),
    ).rejects.toThrow("contains a link");
  });
});

async function releaseFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-win-release-"));
  roots.push(root);
  const files = [
    "app/dist/src/cli/main.js",
    "app/engine/musicmute_engine/__init__.py",
    "installer/manage-windows-service.ps1",
    "runtime/node/node.exe",
    "runtime/python/python.exe",
    "runtime/bin/ffmpeg.exe",
    "runtime/bin/ffprobe.exe",
    "runtime/service/MusicMuteWorkerService.exe",
    "runtime/service/LICENSE.txt",
    "runtime/service/source-manifest.json",
    "runtime/media-source-manifest.json",
    "runtime/licenses/ffmpeg/COPYING.LGPLv2.1",
    "runtime/licenses/lame/COPYING",
  ];
  for (const path of files) {
    const destination = join(root, ...path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, `${path}\n`);
  }
  return root;
}

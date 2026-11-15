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

  it("binds a per-user runtime to its explicit profile without a machine service", async () => {
    const root = await releaseFixture("windows-user");
    const manifest = await writeWindowsReleaseManifest(
      root,
      "0.1.0-user.1",
      "windows-user",
    );
    expect(manifest.installationProfile).toBe("windows-user");
    await expect(verifyWindowsRelease(root, "windows-user")).resolves.toEqual(
      manifest,
    );
    await expect(verifyWindowsRelease(root)).rejects.toThrow(
      "installation profile does not match",
    );
    const legacy = await releaseFixture();
    await writeWindowsReleaseManifest(legacy, "0.1.0-service.1");
    await expect(verifyWindowsRelease(legacy, "windows-user")).rejects.toThrow(
      "installation profile does not match",
    );
  });

  it("rejects mixed service payloads and Windows path aliases in user artifacts", async () => {
    const root = await releaseFixture("windows-user");
    await mkdir(join(root, "runtime", "service"));
    await writeFile(
      join(root, "runtime", "service", "MusicMuteWorkerService.exe"),
      "service",
    );
    await expect(
      writeWindowsReleaseManifest(root, "0.1.0-user.1", "windows-user"),
    ).rejects.toThrow("machine service payload");
    const alias = await releaseFixture("windows-user");
    await writeFile(join(alias, "runtime", "node", "invalid:stream"), "unsafe");
    await expect(
      writeWindowsReleaseManifest(alias, "0.1.0-user.1", "windows-user"),
    ).rejects.toThrow("path is unsafe");
  });
});

async function releaseFixture(profile?: "windows-user"): Promise<string> {
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
  if (profile === "windows-user") {
    for (let index = files.length - 1; index >= 0; index--)
      if (
        files[index]!.startsWith("runtime/service/") ||
        files[index]!.startsWith("installer/")
      )
        files.splice(index, 1);
    files.push(
      "runtime/native/musicmute-native.exe",
      "agent/session-agent.cjs",
      "agent/login-worker.cjs",
      "agent/fleet.cjs",
      "agent/personal.cjs",
      "agent/prepare.cjs",
      "app/engine/musicmute_engine/windows_gpu.py",
      "app/engine/musicmute_engine/provider_adapter.py",
      "app/engine/musicmute_engine/qualification.py",
      "app/engine/musicmute_engine/consumer_personal.py",
    );
  }
  for (const path of files) {
    const destination = join(root, ...path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, `${path}\n`);
  }
  return root;
}

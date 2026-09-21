import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeMacReleaseManifest } from "../src/platform/macos/release-manifest.js";
import {
  installMacUserModel,
  installMacUserRelease,
  rollbackMacUserRelease,
  verifyActiveMacUserRelease,
} from "../src/platform/macos/user-release.js";
import { createMacUserLayout } from "../src/platform/macos/user-paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("macOS user release activation", () => {
  it("installs, reuses, upgrades, and rolls back immutable releases", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const layout = createMacUserLayout(home);
    const first = join(root, "release-1");
    const second = join(root, "release-2");
    await releaseFixture(first, "0.1.0");
    await releaseFixture(second, "0.2.0");

    const installed = await installMacUserRelease(layout, first);
    expect(installed).toMatchObject({ previousRelease: null, reused: false });
    expect(await readlink(layout.currentLink)).toBe("releases/0.1.0");

    await expect(installMacUserRelease(layout, first)).resolves.toMatchObject({
      previousRelease: "releases/0.1.0",
      reused: true,
    });
    const upgraded = await installMacUserRelease(layout, second);
    expect(await readlink(layout.currentLink)).toBe("releases/0.2.0");
    await rollbackMacUserRelease(layout, upgraded.previousRelease);
    expect(await readlink(layout.currentLink)).toBe("releases/0.1.0");
    expect((await readdir(layout.releasesRoot)).sort()).toEqual([
      "0.1.0",
      "0.2.0",
    ]);
    expect(await readdir(join(layout.releasesRoot, "0.1.0"))).toContain(
      "release-manifest.json",
    );
    await expect(verifyActiveMacUserRelease(layout)).resolves.toBeUndefined();
    await writeFile(
      join(layout.releasesRoot, "0.1.0", "app", "engine", "module.py"),
      "VALUE = 'tampered'\n",
    );
    await expect(verifyActiveMacUserRelease(layout)).rejects.toThrow(
      "does not match release contents",
    );
  });

  it("installs and reuses only an exact model artifact", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const layout = createMacUserLayout(home);
    const sourcePath = join(root, "Kim_Vocal_2.onnx");
    const bytes = Buffer.from("approved model bytes");
    await writeFile(sourcePath, bytes, { mode: 0o600 });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const options = {
      layout,
      sourcePath,
      filename: "Kim_Vocal_2.onnx",
      bytes: bytes.length,
      sha256,
    };

    await expect(installMacUserModel(options)).resolves.toMatchObject({
      reused: false,
    });
    await expect(installMacUserModel(options)).resolves.toMatchObject({
      reused: true,
    });
    expect(
      await readFile(join(layout.modelRoot, sha256, options.filename)),
    ).toEqual(bytes);
  });
});

async function releaseFixture(root: string, version: string): Promise<void> {
  for (const path of [
    "app/dist/src/cli/main.js",
    "runtime/node/bin/node",
    "runtime/python/bin/python3.13",
    "runtime/bin/ffmpeg",
    "runtime/bin/ffprobe",
  ]) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(absolute, 0o755);
  }
  await symlink(
    "python3.13",
    join(root, "runtime", "python", "bin", "python3"),
  );
  await mkdir(join(root, "app", "engine"), { recursive: true });
  await writeFile(join(root, "app", "engine", "module.py"), "VALUE = 1\n");
  await writeFile(
    join(root, "app", "package.json"),
    '{"name":"@musicmute/worker","version":"0.1.0"}\n',
  );
  await mkdir(join(root, "runtime", "licenses", "ffmpeg"), { recursive: true });
  await mkdir(join(root, "runtime", "licenses", "lame"), { recursive: true });
  await writeFile(
    join(root, "runtime", "licenses", "ffmpeg", "COPYING.LGPLv2.1"),
    "license\n",
  );
  await writeFile(
    join(root, "runtime", "licenses", "lame", "COPYING"),
    "license\n",
  );
  await writeFile(
    join(root, "runtime", "media-source-manifest.json"),
    '{"schemaVersion":1}\n',
  );
  await writeMacReleaseManifest(root, version);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-user-release-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

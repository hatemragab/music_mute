import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAC_RELEASE_MANIFEST,
  verifyMacRelease,
  writeMacReleaseManifest,
} from "../src/platform/macos/release-manifest.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("macOS release manifest", () => {
  it("writes and verifies a deterministic private runtime manifest", async () => {
    const root = await fixture();
    const created = await writeMacReleaseManifest(root, "0.1.0-test.1");
    const verified = await verifyMacRelease(root);

    expect(verified).toEqual(created);
    expect(verified.entries.map((entry) => entry.path)).toEqual(
      verified.entries.map((entry) => entry.path).sort(),
    );
    expect(verified.entries.some((entry) => entry.kind === "symlink")).toBe(
      true,
    );
    expect(
      JSON.parse(await readFile(join(root, MAC_RELEASE_MANIFEST), "utf8")),
    ).toEqual(created);
  });

  it("rejects content changed after the manifest was generated", async () => {
    const root = await fixture();
    await writeMacReleaseManifest(root, "0.1.0-test.2");
    await writeFile(join(root, "app", "engine", "module.py"), "changed\n");

    await expect(verifyMacRelease(root)).rejects.toThrow(
      "does not match release contents",
    );
  });

  it("rejects symlinks that leave the immutable release", async () => {
    const root = await fixture();
    await symlink("../../../../outside", join(root, "app", "engine", "escape"));

    await expect(writeMacReleaseManifest(root, "0.1.0-test.3")).rejects.toThrow(
      "escapes the release root",
    );
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-macos-release-"));
  roots.push(root);
  const executablePaths = [
    "app/dist/src/cli/main.js",
    "runtime/node/bin/node",
    "runtime/python/bin/python3.13",
    "runtime/bin/ffmpeg",
    "runtime/bin/ffprobe",
  ];
  for (const path of executablePaths) {
    const absolute = join(root, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(absolute, 0o755);
  }
  await symlink(
    "python3.13",
    join(root, "runtime", "python", "bin", "python3"),
  );
  await mkdir(join(root, "app", "engine"), { recursive: true });
  await writeFile(join(root, "app", "engine", "module.py"), "VALUE = 1\n");
  return root;
}

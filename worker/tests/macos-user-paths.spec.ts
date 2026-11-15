import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeExistingAncestors,
  createMacUserDirectories,
  createMacUserLayout,
} from "../src/platform/macos/user-paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("macOS per-user paths", () => {
  it("places all worker state under the user Library roots", () => {
    const layout = createMacUserLayout("/Users/tester");
    expect(layout.installRoot).toBe(
      "/Users/tester/Library/Application Support/MusicMuteWorker",
    );
    expect(layout.lifecyclePath).toBe(
      "/Users/tester/Library/Application Support/MusicMuteWorker/state/lifecycle.json",
    );
    expect(layout.currentLink).toBe(
      "/Users/tester/Library/Application Support/MusicMuteWorker/runtime/current",
    );
    expect(layout.unpairReceiptPath).toBe(
      "/Users/tester/Library/Application Support/MusicMuteWorker/state/unpaired.json",
    );
    expect(layout.plistPath).toBe(
      "/Users/tester/Library/LaunchAgents/com.musicmute.worker.plist",
    );
    expect(layout.cliPath).toContain(
      "/runtime/current/app/dist/src/cli/main.js",
    );
  });

  it("creates private directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-user-paths-"));
    roots.push(root);
    await chmod(root, 0o700);
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const layout = createMacUserLayout(home);

    await createMacUserDirectories(layout);

    for (const path of [
      layout.installRoot,
      layout.configRoot,
      layout.credentialRoot,
      layout.transactionRoot,
      layout.releasesRoot,
      layout.modelRoot,
      layout.workRoot,
      layout.logRoot,
      layout.launchAgentsRoot,
    ]) {
      const info = await lstat(path);
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o077).toBe(0);
    }
  });

  it("accepts the normal non-writable macOS LaunchAgents directory mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-user-launchagents-"));
    roots.push(root);
    await chmod(root, 0o700);
    const home = join(root, "home");
    await mkdir(join(home, "Library", "LaunchAgents"), {
      recursive: true,
      mode: 0o755,
    });
    await chmod(join(home, "Library", "LaunchAgents"), 0o755);
    const layout = createMacUserLayout(home);

    await expect(createMacUserDirectories(layout)).resolves.toBeUndefined();
    expect((await lstat(layout.launchAgentsRoot)).mode & 0o777).toBe(0o755);

    await chmod(layout.launchAgentsRoot, 0o775);
    await expect(createMacUserDirectories(layout)).rejects.toThrow(
      "Writable macOS path ancestor",
    );
  });

  it("rejects symlink and writable ancestors", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-user-unsafe-"));
    roots.push(root);
    await chmod(root, 0o700);
    const home = join(root, "home");
    const elsewhere = join(root, "elsewhere");
    await mkdir(home, { mode: 0o700 });
    await mkdir(elsewhere, { mode: 0o700 });
    await mkdir(join(home, "Library"), { mode: 0o700 });
    await symlink(elsewhere, join(home, "Library", "Application Support"));
    const layout = createMacUserLayout(home);

    await expect(createMacUserDirectories(layout)).rejects.toThrow(
      "Unsafe macOS path ancestor",
    );

    await rm(join(home, "Library", "Application Support"));
    await mkdir(join(home, "Library", "Application Support"), { mode: 0o777 });
    await chmod(join(home, "Library", "Application Support"), 0o777);
    await expect(
      assertSafeExistingAncestors(home, layout.installRoot),
    ).rejects.toThrow("Writable macOS path ancestor");
  });

  it("rejects relative, root, and escaping inputs", async () => {
    expect(() => createMacUserLayout("relative/home")).toThrow(
      "must be absolute",
    );
    expect(() => createMacUserLayout("/")).toThrow("is unsafe");
    await expect(
      assertSafeExistingAncestors("/Users/tester", "/private/tmp/worker"),
    ).rejects.toThrow("outside the trusted root");
  });
});

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupMacLegacyService,
  LEGACY_MAC_SERVICE,
} from "../src/platform/macos/legacy-cleanup.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("macOS legacy service cleanup", () => {
  it("requires administrator identity", async () => {
    const paths = await fixture();
    await expect(cleanupMacLegacyService({ uid: 501, paths })).rejects.toThrow(
      "administrator",
    );
  });

  it("stops only the known service and moves exact paths into a backup", async () => {
    const paths = await fixture();
    const launchctl = vi.fn(async (arguments_: readonly string[]) => ({
      code: arguments_[0] === "print" || arguments_[0] === "bootout" ? 0 : 1,
      stdout: "",
      stderr: "",
    }));
    const result = await cleanupMacLegacyService({
      uid: 0,
      ownerUid: process.getuid!(),
      paths,
      now: new Date("2026-09-21T01:02:03.000Z"),
      launchctl,
    });
    expect(result).toMatchObject({
      status: "backed-up",
      serviceWasLoaded: true,
      movedApplicationRoot: true,
      movedPlist: true,
    });
    expect(launchctl).toHaveBeenNthCalledWith(1, ["print", LEGACY_MAC_SERVICE]);
    expect(launchctl).toHaveBeenNthCalledWith(2, [
      "bootout",
      LEGACY_MAC_SERVICE,
    ]);
    await expect(lstat(paths.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(paths.plist)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(
        join(
          result.backupRoot!,
          "legacy-launch-daemons",
          "com.musicmute.worker.plist",
        ),
        "utf8",
      ),
    ).toBe("legacy plist\n");
    expect(await readFile(join(result.backupRoot!, "state.txt"), "utf8")).toBe(
      "legacy state\n",
    );
  });

  it("refuses unsafe legacy symlinks without invoking launchctl bootout", async () => {
    const paths = await fixture();
    await rm(paths.root, { recursive: true });
    await writeFile(paths.root, "not a directory\n", { mode: 0o600 });
    const launchctl = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    await expect(
      cleanupMacLegacyService({
        uid: 0,
        ownerUid: process.getuid!(),
        paths,
        launchctl,
      }),
    ).rejects.toThrow("directory is unsafe");
    expect(launchctl).toHaveBeenCalledTimes(1);
  });

  it("checks backup collisions before stopping the legacy service", async () => {
    const paths = await fixture();
    const now = new Date("2026-09-21T01:02:03.000Z");
    await mkdir(`${paths.root}.legacy-backup-20260921T010203000Z`, {
      mode: 0o700,
    });
    const launchctl = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    await expect(
      cleanupMacLegacyService({
        uid: 0,
        ownerUid: process.getuid!(),
        paths,
        now,
        launchctl,
      }),
    ).rejects.toThrow("already exists");
    expect(launchctl).toHaveBeenCalledTimes(1);
    expect(await readFile(paths.plist, "utf8")).toBe("legacy plist\n");
  });
});

async function fixture(): Promise<{ plist: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), "musicmute-legacy-"));
  roots.push(parent);
  await chmod(parent, 0o700);
  const root = join(parent, "MusicMuteWorker");
  const plistRoot = join(parent, "LaunchDaemons");
  const plist = join(plistRoot, "com.musicmute.worker.plist");
  await mkdir(root, { mode: 0o700 });
  await mkdir(plistRoot, { mode: 0o700 });
  await writeFile(join(root, "state.txt"), "legacy state\n", { mode: 0o600 });
  await writeFile(plist, "legacy plist\n", { mode: 0o600 });
  return { plist, root };
}

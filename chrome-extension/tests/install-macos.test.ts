import type { Stats } from "node:fs";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);

type ParentInfo = Pick<
  Stats,
  "uid" | "gid" | "mode" | "dev" | "ino" | "isDirectory" | "isSymbolicLink"
>;
interface InstallerGuards {
  parseApplicationsDirectory(args: readonly string[], userHome: string): string;
  assertSafeApplicationsDirectory(
    info: ParentInfo,
    applications: string,
    userId: number,
  ): void;
  assertSafeBackupDirectory(
    info: ParentInfo,
    userId: number,
    parentDevice: number,
    expected?: ParentInfo,
  ): void;
  ensurePrivateBackupDirectory(
    applications: string,
    userId: number,
    parentDevice: number,
  ): Promise<{ path: string; info: Stats }>;
}
// Import the real guards without running package reads, copies or installation.
const installerUrl = new URL("../scripts/install-macos.mjs", import.meta.url)
  .href;
const {
  parseApplicationsDirectory,
  assertSafeApplicationsDirectory,
  assertSafeBackupDirectory,
  ensurePrivateBackupDirectory,
} = (await import(installerUrl)) as InstallerGuards;
const userHome = "/fixture/home";
const userDirectory = join(userHome, "Applications");
const userId = 501;
function parent({
  uid = userId,
  gid = 20,
  mode = 0o755,
  dev = 1,
  ino = 2,
  directory = true,
  symlink = false,
}: {
  uid?: number;
  gid?: number;
  mode?: number;
  dev?: number;
  ino?: number;
  directory?: boolean;
  symlink?: boolean;
} = {}): ParentInfo {
  return {
    uid,
    gid,
    mode,
    dev,
    ino,
    isDirectory: () => directory,
    isSymbolicLink: () => symlink,
  };
}

describe("explicit macOS Applications installation", () => {
  it("preserves the per-user default", () => {
    expect(parseApplicationsDirectory([], userHome)).toBe(userDirectory);
  });
  it("requires the explicit flag when a home path would resolve to the system target", () => {
    expect(() => parseApplicationsDirectory([], "/")).toThrow(
      "INVALID_INSTALL_OPTIONS",
    );
  });
  it("allows only the explicit standard system target", () => {
    expect(
      parseApplicationsDirectory(
        ["--applications-dir", "/Applications"],
        userHome,
      ),
    ).toBe("/Applications");
  });
  it.each([
    ["--applications-dir"],
    ["--applications-dir", ""],
    ["--applications-dir", "/Applications/"],
    ["--applications-dir", "/Applications/../Applications"],
    ["--applications-dir", "Applications"],
    ["--applications-dir", "/arbitrary"],
    ["--applications-dir", userDirectory],
    ["--applications-dir=/Applications"],
    [
      "--applications-dir",
      "/Applications",
      "--applications-dir",
      "/Applications",
    ],
    ["--applications-dir", "/Applications", "extra"],
    ["--target", "/Applications"],
    ["/Applications"],
    ["--help"],
  ])(
    "rejects malformed, arbitrary, duplicate or unknown arguments %j",
    (...args: string[]) => {
      expect(() => parseApplicationsDirectory(args, userHome)).toThrow(
        "INVALID_INSTALL_OPTIONS",
      );
    },
  );

  it.each([0o700, 0o755])(
    "keeps an owned per-user parent with mode %o",
    (mode) => {
      expect(() =>
        assertSafeApplicationsDirectory(
          parent({ mode }),
          userDirectory,
          userId,
        ),
      ).not.toThrow();
    },
  );
  it.each([
    { uid: 0 },
    { uid: userId + 1 },
    { mode: 0o775, gid: 80 },
    { mode: 0o757 },
    { directory: false },
    { symlink: true },
  ])("keeps the per-user ownership/permission/type fence %j", (options) => {
    expect(() =>
      assertSafeApplicationsDirectory(parent(options), userDirectory, userId),
    ).toThrow("UNSAFE_APPLICATIONS_DIRECTORY");
  });

  it.each([
    { uid: 0, gid: 0, mode: 0o755 },
    { uid: 0, gid: 20, mode: 0o755 },
    { uid: 0, gid: 80, mode: 0o755 },
    { uid: 0, gid: 80, mode: 0o775 },
  ])(
    "allows a real root-owned system parent and admin-only group write %j",
    (options) => {
      expect(() =>
        assertSafeApplicationsDirectory(
          parent(options),
          "/Applications",
          userId,
        ),
      ).not.toThrow();
    },
  );
  it.each([
    { uid: userId, gid: 80, mode: 0o755 },
    { uid: userId + 1, gid: 80, mode: 0o755 },
    { uid: 0, gid: 80, mode: 0o777 },
    { uid: 0, gid: 80, mode: 0o757 },
    { uid: 0, gid: 20, mode: 0o775 },
    { uid: 0, gid: 0, mode: 0o775 },
    { uid: 0, gid: 80, directory: false },
    { uid: 0, gid: 80, symlink: true },
  ])(
    "refuses unsafe system ownership, world/non-admin writes or path types %j",
    (options) => {
      expect(() =>
        assertSafeApplicationsDirectory(
          parent(options),
          "/Applications",
          userId,
        ),
      ).toThrow("UNSAFE_APPLICATIONS_DIRECTORY");
    },
  );
});

const fixtureRoots: string[] = [];
afterEach(async () => {
  for (const path of fixtureRoots.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const applications = await mkdtemp(
    join(tmpdir(), "musicmute-installer-backup-"),
  );
  fixtureRoots.push(applications);
  const info = await lstat(applications);
  return { applications, userId: info.uid, parentDevice: info.dev };
}

describe("private noindex rollback storage", () => {
  it.each([0o700, 0o755])(
    "accepts only an owned nonwritable directory on the parent filesystem (%o)",
    (mode) => {
      expect(() =>
        assertSafeBackupDirectory(parent({ mode }), userId, 1),
      ).not.toThrow();
    },
  );
  it.each([
    { uid: 0 },
    { uid: userId + 1 },
    { mode: 0o775, gid: 80 },
    { mode: 0o757 },
    { mode: 0o777 },
    { directory: false },
    { symlink: true },
    { dev: 2 },
  ])(
    "refuses foreign, linked, writable or different-filesystem backup folders %j",
    (options) => {
      expect(() =>
        assertSafeBackupDirectory(parent(options), userId, 1),
      ).toThrow("UNSAFE_BACKUP_DIRECTORY");
    },
  );
  it("fences a directory identity change before promotion or rollback", () => {
    const original = parent({ mode: 0o700 });
    expect(() =>
      assertSafeBackupDirectory(original, userId, 1, original),
    ).not.toThrow();
    expect(() =>
      assertSafeBackupDirectory(
        parent({ mode: 0o700, ino: 3 }),
        userId,
        1,
        original,
      ),
    ).toThrow("INSTALL_BACKUP_PATH_CHANGED");
  });
  it("creates the hidden noindex child exclusively at mode 0700 and preserves existing bytes", async () => {
    const context = await fixture();
    const created = await ensurePrivateBackupDirectory(
      context.applications,
      context.userId,
      context.parentDevice,
    );
    expect(created.path).toBe(
      join(context.applications, ".musicmute-backups.noindex"),
    );
    expect(created.info.mode & 0o777).toBe(0o700);
    expect(created.info.dev).toBe(context.parentDevice);
    const sentinel = join(created.path, "owned-fixture-bytes");
    await writeFile(sentinel, "preserved fixture", { flag: "wx", mode: 0o600 });
    const reused = await ensurePrivateBackupDirectory(
      context.applications,
      context.userId,
      context.parentDevice,
    );
    expect(reused.info.ino).toBe(created.info.ino);
    expect(await readFile(sentinel, "utf8")).toBe("preserved fixture");
  });
  it("never creates a missing Applications ancestor", async () => {
    const context = await fixture();
    const absent = join(context.applications, "missing-parent");
    await expect(
      ensurePrivateBackupDirectory(
        absent,
        context.userId,
        context.parentDevice,
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(absent)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses an existing ordinary file without replacing its bytes", async () => {
    const context = await fixture();
    const path = join(context.applications, ".musicmute-backups.noindex");
    await writeFile(path, "foreign-shaped fixture", {
      flag: "wx",
      mode: 0o600,
    });
    await expect(
      ensurePrivateBackupDirectory(
        context.applications,
        context.userId,
        context.parentDevice,
      ),
    ).rejects.toThrow("UNSAFE_BACKUP_DIRECTORY");
    expect(await readFile(path, "utf8")).toBe("foreign-shaped fixture");
  });
  it("refuses an existing symlink without modifying its target", async () => {
    const context = await fixture();
    const target = join(context.applications, "external-fixture");
    await mkdir(target, { mode: 0o700 });
    const sentinel = join(target, "sentinel");
    await writeFile(sentinel, "unchanged target", { flag: "wx", mode: 0o600 });
    const path = join(context.applications, ".musicmute-backups.noindex");
    await symlink(target, path);
    await expect(
      ensurePrivateBackupDirectory(
        context.applications,
        context.userId,
        context.parentDevice,
      ),
    ).rejects.toThrow("UNSAFE_BACKUP_DIRECTORY");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(sentinel, "utf8")).toBe("unchanged target");
  });
  it("refuses writable existing directories without repairing permissions or removing files", async () => {
    const context = await fixture();
    const path = join(context.applications, ".musicmute-backups.noindex");
    await mkdir(path, { mode: 0o700 });
    const sentinel = join(path, "sentinel");
    await writeFile(sentinel, "retained fixture", { flag: "wx", mode: 0o600 });
    await chmod(path, 0o777);
    await expect(
      ensurePrivateBackupDirectory(
        context.applications,
        context.userId,
        context.parentDevice,
      ),
    ).rejects.toThrow("UNSAFE_BACKUP_DIRECTORY");
    expect((await lstat(path)).mode & 0o777).toBe(0o777);
    expect(await readFile(sentinel, "utf8")).toBe("retained fixture");
  });
  it("allows concurrent exclusive creation only for the same validated owned directory", async () => {
    const context = await fixture();
    const directories = await Promise.all([
      ensurePrivateBackupDirectory(
        context.applications,
        context.userId,
        context.parentDevice,
      ),
      ensurePrivateBackupDirectory(
        context.applications,
        context.userId,
        context.parentDevice,
      ),
    ]);
    expect(directories[0]?.info.ino).toBe(directories[1]?.info.ino);
    expect(directories.every(({ info }) => (info.mode & 0o777) === 0o700)).toBe(
      true,
    );
  });

  it("uses an identity-pinned native exclusive rename without a runtime or Python dependency", async () => {
    const context = await fixture();
    const helper = join(context.applications, "MusicMuteInstallHelper");
    const helperSource = fileURLToPath(
      new URL("../macos/InstallHelper.swift", import.meta.url),
    );
    await exec("/usr/bin/xcrun", [
      "swiftc",
      "-swift-version",
      "6",
      "-warnings-as-errors",
      "-target",
      "arm64-apple-macos14.0",
      "-parse-as-library",
      helperSource,
      "-o",
      helper,
    ]);
    const installerSource = await readFile(
      new URL("../scripts/install-macos.mjs", import.meta.url),
      "utf8",
    );
    expect(installerSource).not.toContain("Resources/runtime");
    expect(installerSource).not.toContain("python3");

    const parent = await lstat(context.applications);
    const invoke = async (
      sourceName: string,
      destinationName: string,
      source: Stats,
      inode = source.ino,
    ) =>
      exec(helper, [
        "exclusive-rename",
        context.applications,
        sourceName,
        context.applications,
        destinationName,
        String(source.dev),
        String(inode),
        String(parent.dev),
        String(parent.ino),
        String(parent.dev),
        String(parent.ino),
      ]);

    const sourceName = "candidate.app";
    const destinationName = "installed.app";
    await mkdir(join(context.applications, sourceName), { mode: 0o700 });
    const source = await lstat(join(context.applications, sourceName));
    await invoke(sourceName, destinationName, source);
    await expect(
      lstat(join(context.applications, sourceName)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(join(context.applications, destinationName))).ino).toBe(
      source.ino,
    );

    const blockedSourceName = "blocked-candidate.app";
    const occupiedName = "occupied.app";
    await mkdir(join(context.applications, blockedSourceName), { mode: 0o700 });
    await mkdir(join(context.applications, occupiedName), { mode: 0o700 });
    const blockedSource = await lstat(
      join(context.applications, blockedSourceName),
    );
    await expect(
      invoke(blockedSourceName, occupiedName, blockedSource),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("INSTALL_EXCLUSIVE_RENAME_FAILED"),
    });
    expect(
      (await lstat(join(context.applications, blockedSourceName))).ino,
    ).toBe(blockedSource.ino);

    await expect(
      invoke(blockedSourceName, "wrong-identity.app", blockedSource, 0),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("INSTALL_PATH_CHANGED"),
    });
  });
});

import { execFile as nodeExecFile } from "node:child_process";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

export const LEGACY_MAC_SERVICE = "system/com.musicmute.worker";
export const LEGACY_MAC_PLIST =
  "/Library/LaunchDaemons/com.musicmute.worker.plist";
export const LEGACY_MAC_ROOT = "/Library/Application Support/MusicMuteWorker";

interface LegacyPaths {
  plist: string;
  root: string;
}

interface LaunchctlResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface LegacyCleanupResult {
  status: "clean" | "backed-up";
  serviceWasLoaded: boolean;
  backupRoot: string | null;
  movedApplicationRoot: boolean;
  movedPlist: boolean;
}

export async function runMacLegacyCleanupCommand(
  arguments_: readonly string[],
): Promise<number> {
  if (arguments_.length !== 1 || arguments_[0] !== "--confirm-backup")
    throw new TypeError(
      "legacy-cleanup requires the exact --confirm-backup acknowledgement",
    );
  const result = await cleanupMacLegacyService();
  console.log(JSON.stringify(result));
  return 0;
}

export async function cleanupMacLegacyService(
  dependencies: {
    uid?: number;
    ownerUid?: number;
    now?: Date;
    paths?: LegacyPaths;
    launchctl?: (arguments_: readonly string[]) => Promise<LaunchctlResult>;
  } = {},
): Promise<LegacyCleanupResult> {
  const uid = dependencies.uid ?? process.getuid?.();
  if (process.platform !== "darwin" && dependencies.paths === undefined)
    throw new TypeError("Legacy cleanup requires macOS");
  if (uid !== 0)
    throw new TypeError(
      "Legacy cleanup requires explicit administrator access",
    );
  const paths = dependencies.paths ?? {
    plist: LEGACY_MAC_PLIST,
    root: LEGACY_MAC_ROOT,
  };
  const ownerUid = dependencies.ownerUid ?? 0;
  const launchctl = dependencies.launchctl ?? executeLaunchctl;
  const serviceState = await launchctl(["print", LEGACY_MAC_SERVICE]);
  if (serviceState.code !== 0 && serviceState.code !== 113)
    throw new Error("Legacy MusicMute service state could not be inspected");
  const serviceWasLoaded = serviceState.code === 0;
  const rootExists = await validateLegacyPath(
    paths.root,
    "directory",
    ownerUid,
  );
  const plistExists = await validateLegacyPath(paths.plist, "file", ownerUid);
  if (!rootExists && !plistExists && !serviceWasLoaded)
    return {
      status: "clean",
      serviceWasLoaded: false,
      backupRoot: null,
      movedApplicationRoot: false,
      movedPlist: false,
    };
  const backupRoot = `${paths.root}.legacy-backup-${timestamp(
    dependencies.now ?? new Date(),
  )}`;
  await assertMissing(backupRoot);
  if (serviceWasLoaded) {
    const stopped = await launchctl(["bootout", LEGACY_MAC_SERVICE]);
    if (stopped.code !== 0)
      throw new Error("Legacy MusicMute service could not be stopped");
  }
  let movedApplicationRoot = false;
  let createdBackupRoot = false;
  try {
    if (rootExists) {
      await rename(paths.root, backupRoot);
      movedApplicationRoot = true;
    } else {
      await mkdir(backupRoot, { mode: 0o700 });
      createdBackupRoot = true;
    }
    let movedPlist = false;
    if (plistExists) {
      const plistBackupRoot = join(backupRoot, "legacy-launch-daemons");
      await mkdir(plistBackupRoot, { mode: 0o700 });
      await rename(
        paths.plist,
        join(plistBackupRoot, "com.musicmute.worker.plist"),
      );
      movedPlist = true;
    }
    return {
      status: "backed-up",
      serviceWasLoaded,
      backupRoot,
      movedApplicationRoot,
      movedPlist,
    };
  } catch (error) {
    if (movedApplicationRoot) {
      await rm(join(backupRoot, "legacy-launch-daemons"), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
      await rename(backupRoot, paths.root).catch(() => undefined);
    } else if (createdBackupRoot)
      await rm(backupRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    if (serviceWasLoaded)
      await launchctl(["bootstrap", "system", paths.plist]).catch(
        () => undefined,
      );
    throw error;
  }
}

async function validateLegacyPath(
  path: string,
  kind: "file" | "directory",
  ownerUid: number,
): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      info.uid !== ownerUid ||
      (info.mode & 0o022) !== 0 ||
      (kind === "file" ? !info.isFile() : !info.isDirectory())
    )
      throw new TypeError(`Legacy MusicMute ${kind} is unsafe`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Legacy MusicMute backup destination already exists");
}

function timestamp(value: Date): string {
  if (!Number.isFinite(value.getTime()))
    throw new TypeError("Backup time is invalid");
  return value.toISOString().replace(/[-:.]/gu, "");
}

async function executeLaunchctl(
  arguments_: readonly string[],
): Promise<LaunchctlResult> {
  try {
    const result = await execFile("/bin/launchctl", [...arguments_], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      timeout: 15_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

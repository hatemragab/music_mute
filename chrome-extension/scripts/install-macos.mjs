import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const MACOS_ADMIN_GID = 80;

/** Only the per-user default or the explicit standard macOS directory is supported. */
export function parseApplicationsDirectory(args, userHome = homedir()) {
  if (args.length === 0) {
    const applications = join(userHome, "Applications");
    if (applications === "/Applications")
      throw new Error("INVALID_INSTALL_OPTIONS");
    return applications;
  }
  if (
    args.length === 2 &&
    args[0] === "--applications-dir" &&
    args[1] === "/Applications"
  )
    return "/Applications";
  throw new Error("INVALID_INSTALL_OPTIONS");
}

export function assertSafeApplicationsDirectory(info, applications, userId) {
  const unsafeParent = !info.isDirectory() || info.isSymbolicLink();
  const unsafePermissions =
    applications === "/Applications"
      ? info.uid !== 0 ||
        Boolean(info.mode & 0o002) ||
        (Boolean(info.mode & 0o020) && info.gid !== MACOS_ADMIN_GID)
      : info.uid !== userId || Boolean(info.mode & 0o022);
  if (unsafeParent || unsafePermissions)
    throw new Error("UNSAFE_APPLICATIONS_DIRECTORY");
}

export function assertSafeBackupDirectory(
  info,
  userId,
  parentDevice,
  expected,
) {
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== userId ||
    info.mode & 0o022 ||
    info.dev !== parentDevice
  )
    throw new Error("UNSAFE_BACKUP_DIRECTORY");
  if (expected && !sameIdentity(info, expected))
    throw new Error("INSTALL_BACKUP_PATH_CHANGED");
}

export async function ensurePrivateBackupDirectory(
  applications,
  userId,
  parentDevice,
) {
  const path = join(applications, ".musicmute-backups.noindex");
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  assertSafeBackupDirectory(info, userId, parentDevice);
  return { path, info };
}

const expectedBundle = "com.hatem.musicmute.local";
const sameIdentity = (left, right) =>
  left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
const helperFailures = new Set([
  "INSTALL_HELPER_INVALID_ARGUMENTS",
  "INSTALL_PARENT_CHANGED",
  "INSTALL_PATH_CHANGED",
  "INSTALL_EXCLUSIVE_RENAME_FAILED",
]);
async function installMacos(args) {
  const applications = parseApplicationsDirectory(args);
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("UNSUPPORTED_PLATFORM");
  const result = JSON.parse(
    await readFile(join(root, "output/macos/latest.json"), "utf8"),
  );
  const source = await realpath(result.app);
  if (relative(join(root, "output/macos"), source).startsWith(".."))
    throw new Error("INVALID_PACKAGE_PATH");
  const installHelper = join(source, "Contents/MacOS/MusicMuteInstallHelper");
  let backups;
  async function moveOwnedApp(from, to, identity) {
    if (backups)
      assertSafeBackupDirectory(
        await lstat(backups.path),
        process.getuid?.(),
        parent.dev,
        backups.info,
      );
    const fromParentPath = dirname(from);
    const toParentPath = dirname(to);
    const fromParent = await lstat(fromParentPath);
    const toParent = await lstat(toParentPath);
    for (const [path, info] of [
      [fromParentPath, fromParent],
      [toParentPath, toParent],
    ]) {
      if (path === applications) {
        assertSafeApplicationsDirectory(info, applications, process.getuid?.());
        if (!sameIdentity(info, parent))
          throw new Error("INSTALL_PARENT_CHANGED");
      } else if (backups && path === backups.path) {
        assertSafeBackupDirectory(
          info,
          process.getuid?.(),
          parent.dev,
          backups.info,
        );
      } else {
        throw new Error("INSTALL_PARENT_CHANGED");
      }
    }
    try {
      await exec(
        installHelper,
        [
          "exclusive-rename",
          fromParentPath,
          basename(from),
          toParentPath,
          basename(to),
          String(identity.dev),
          String(identity.ino),
          String(fromParent.dev),
          String(fromParent.ino),
          String(toParent.dev),
          String(toParent.ino),
        ],
        {
          timeout: 30_000,
          maxBuffer: 16 * 1024,
          env: { HOME: homedir(), PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
        },
      );
    } catch (error) {
      const code = String(error.stderr ?? "").trim();
      throw new Error(
        helperFailures.has(code) ? code : "INSTALL_EXCLUSIVE_RENAME_FAILED",
      );
    }
  }
  async function validateApp(path) {
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.()
    )
      throw new Error("UNSAFE_APP_PATH");
    const { stdout } = await exec("/usr/bin/plutil", [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      join(path, "Contents/Info.plist"),
    ]);
    if (stdout.trim() !== expectedBundle) throw new Error("FOREIGN_APP_EXISTS");
    const audit = JSON.parse(
      await readFile(
        join(path, "Contents/Resources/bundle-audit.json"),
        "utf8",
      ),
    );
    if (
      audit.schema_version !== 1 ||
      audit.architecture !== "arm64" ||
      audit.includes_model_weights !== false ||
      audit.includes_worker_state !== false ||
      audit.runtime_delivery !== "EXTERNAL_PREPARE" ||
      audit.runtime_bootstrap !== "runtime-bootstrap.json"
    )
      throw new Error("APP_AUDIT_INVALID");
    const resources = join(path, "Contents/Resources");
    const bootstrap = await lstat(join(resources, "runtime-bootstrap.json"));
    if (
      !bootstrap.isFile() ||
      bootstrap.isSymbolicLink() ||
      bootstrap.nlink !== 1 ||
      bootstrap.size < 2 ||
      bootstrap.size > 16 * 1024 * 1024 ||
      bootstrap.mode & 0o022
    )
      throw new Error("APP_AUDIT_INVALID");
    try {
      await lstat(join(resources, "runtime"));
      throw new Error("APP_AUDIT_INVALID");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", path], {
      timeout: 120_000,
      maxBuffer: 256 * 1024,
    });
    if (!sameIdentity(info, await lstat(path)))
      throw new Error("INSTALL_PATH_CHANGED");
    return info;
  }
  await validateApp(source);
  const helper = await lstat(installHelper);
  if (
    !helper.isFile() ||
    helper.isSymbolicLink() ||
    helper.nlink !== 1 ||
    !(helper.mode & 0o111)
  )
    throw new Error("APP_AUDIT_INVALID");
  if (applications !== "/Applications")
    await mkdir(applications, { recursive: true });
  const parent = await lstat(applications);
  assertSafeApplicationsDirectory(parent, applications, process.getuid?.());
  const destination = join(applications, "MusicMute Local.app");
  let previous;
  let previousIdentity;
  try {
    previousIdentity = await validateApp(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  backups = await ensurePrivateBackupDirectory(
    applications,
    process.getuid?.(),
    parent.dev,
  );
  if (previousIdentity)
    previous = join(
      backups.path,
      `MusicMute Local.previous-${randomUUID()}.app`,
    );
  const staged = join(applications, `.musicmute-install-${randomUUID()}.app`);
  await exec("/bin/cp", ["-c", "-p", "-R", source, staged], {
    timeout: 180_000,
    maxBuffer: 128 * 1024,
  });
  const candidateIdentity = await validateApp(staged);
  if (previous) await moveOwnedApp(destination, previous, previousIdentity);
  try {
    await moveOwnedApp(staged, destination, candidateIdentity);
    const installedIdentity = await validateApp(destination);
    if (!sameIdentity(candidateIdentity, installedIdentity))
      throw new Error("INSTALL_PATH_CHANGED");
  } catch (error) {
    try {
      let current;
      try {
        current = await lstat(destination);
      } catch (inspectionError) {
        if (inspectionError.code !== "ENOENT") throw inspectionError;
      }
      if (current && sameIdentity(current, candidateIdentity))
        await moveOwnedApp(
          destination,
          join(backups.path, `.musicmute-failed-${randomUUID()}.app`),
          candidateIdentity,
        );
      if (previous) await moveOwnedApp(previous, destination, previousIdentity);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "INSTALL_ROLLBACK_BLOCKED",
      );
    }
    throw error;
  }
  console.log(
    JSON.stringify(
      {
        installed_app: destination,
        previous_app_preserved: previous ?? null,
        notarized: false,
        setup_required: true,
        registration_changed: false,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename)
  await installMacos(process.argv.slice(2));

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, link, lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { WorkerPlatform } from "../../protocol/v1/protocol.js";
import { verifyMacRelease } from "../platform/macos/release-manifest.js";
import { verifyWindowsRelease } from "../platform/windows/release-manifest.js";

const executeFile = promisify(execFile);
const RELEASE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_ARCHIVE_LIST_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_PATH_BYTES = 1024;

export interface InstallationReleaseArchiveOptions {
  archivePath: string;
  outputRoot: string;
  platform: WorkerPlatform;
  releaseVersion: string;
}

export interface PreparedInstallationRelease {
  path: string;
  releaseVersion: string;
  reused: boolean;
}

export interface CreateInstallationReleaseArchiveOptions {
  releaseRoot: string;
  outputPath: string;
  platform: WorkerPlatform;
}

export interface CreatedInstallationReleaseArchive {
  path: string;
  releaseVersion: string;
  bytes: number;
  sha256: string;
  contentType: "application/gzip" | "application/zip";
}

export async function createInstallationReleaseArchive(
  options: CreateInstallationReleaseArchiveOptions,
): Promise<CreatedInstallationReleaseArchive> {
  if (
    !isAbsolute(options.releaseRoot) ||
    !isAbsolute(options.outputPath) ||
    (options.platform === "darwin-arm64"
      ? !options.outputPath.endsWith(".tar.gz")
      : !options.outputPath.endsWith(".zip"))
  )
    throw new TypeError("Release archive output is invalid");
  await assertProtectedDirectory(dirname(options.outputPath));
  if (await pathExists(options.outputPath))
    throw new TypeError("Release archive output already exists");
  const releaseVersion = await verifyReleaseForPlatform(
    options.releaseRoot,
    options.platform,
  );
  const temporary = `${options.outputPath}.${randomUUID()}.tmp`;
  const command = process.platform === "win32" ? "tar.exe" : "tar";
  const arguments_ =
    options.platform === "darwin-arm64"
      ? ["-czf", temporary, "-C", options.releaseRoot, "."]
      : ["-cf", temporary, "--format", "zip", "-C", options.releaseRoot, "."];
  try {
    await executeFile(command, arguments_, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 20 * 60_000,
      windowsHide: true,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    const listed = await executeFile(command, ["-tf", temporary], {
      encoding: "utf8",
      maxBuffer: MAX_ARCHIVE_LIST_BYTES,
      timeout: 10 * 60_000,
      windowsHide: true,
    });
    assertSafeReleaseArchiveEntries(listed.stdout);
    const info = await lstat(temporary);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1)
      throw new TypeError("Release archive output is unsafe");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(temporary)) digest.update(chunk);
    await link(temporary, options.outputPath);
    await rm(temporary);
    if (process.platform !== "win32") await chmod(options.outputPath, 0o600);
    return {
      path: options.outputPath,
      releaseVersion,
      bytes: info.size,
      sha256: digest.digest("hex"),
      contentType:
        options.platform === "darwin-arm64"
          ? "application/gzip"
          : "application/zip",
    };
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function prepareInstallationRelease(
  options: InstallationReleaseArchiveOptions,
): Promise<PreparedInstallationRelease> {
  validateOptions(options);
  await assertRegularArchive(options.archivePath);
  await assertProtectedDirectory(options.outputRoot);
  const destination = join(
    options.outputRoot,
    `release-${options.releaseVersion}`,
  );
  if (await pathExists(destination)) {
    await verifyRelease(destination, options.platform, options.releaseVersion);
    return {
      path: destination,
      releaseVersion: options.releaseVersion,
      reused: true,
    };
  }

  const temporary = join(
    options.outputRoot,
    `.release-${options.releaseVersion}.${randomUUID()}.extracting`,
  );
  await mkdir(temporary, { mode: 0o700 });
  if (process.platform !== "win32") await chmod(temporary, 0o700);
  try {
    const command = process.platform === "win32" ? "tar.exe" : "tar";
    const listed = await executeFile(command, ["-tf", options.archivePath], {
      encoding: "utf8",
      maxBuffer: MAX_ARCHIVE_LIST_BYTES,
      timeout: 10 * 60_000,
      windowsHide: true,
    });
    assertSafeReleaseArchiveEntries(listed.stdout);
    await executeFile(command, ["-xf", options.archivePath, "-C", temporary], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 20 * 60_000,
      windowsHide: true,
    });
    await verifyRelease(temporary, options.platform, options.releaseVersion);
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!(await pathExists(destination))) throw error;
      await verifyRelease(
        destination,
        options.platform,
        options.releaseVersion,
      );
      await rm(temporary, { recursive: true, force: true });
      return {
        path: destination,
        releaseVersion: options.releaseVersion,
        reused: true,
      };
    }
    return {
      path: destination,
      releaseVersion: options.releaseVersion,
      reused: false,
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function assertSafeReleaseArchiveEntries(listing: string): void {
  if (Buffer.byteLength(listing, "utf8") > MAX_ARCHIVE_LIST_BYTES)
    throw new TypeError("Release archive listing is too large");
  const rawEntries = listing.split(/\r?\n/u).filter((entry) => entry !== "");
  if (rawEntries.length < 1 || rawEntries.length > MAX_ARCHIVE_ENTRIES)
    throw new TypeError("Release archive entry count is invalid");
  const entries = new Set<string>();
  for (const rawEntry of rawEntries) {
    const hasUnsafeCharacter = [...rawEntry].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint === undefined ||
        codePoint <= 0x1f ||
        codePoint === 0x7f ||
        character === "\\"
      );
    });
    if (
      Buffer.byteLength(rawEntry, "utf8") > MAX_ARCHIVE_PATH_BYTES ||
      hasUnsafeCharacter ||
      rawEntry.startsWith("/") ||
      /^[A-Za-z]:/u.test(rawEntry)
    )
      throw new TypeError("Release archive contains an unsafe path");
    const normalized = rawEntry.replace(/^\.\//u, "").replace(/\/+$/u, "");
    if (normalized === "" || normalized === ".") continue;
    const components = normalized.split("/");
    if (
      components.some(
        (component) =>
          component === "" || component === "." || component === "..",
      ) ||
      entries.has(normalized)
    )
      throw new TypeError("Release archive contains an unsafe path");
    entries.add(normalized);
  }
  if (!entries.has("release-manifest.json"))
    throw new TypeError("Release archive manifest is missing");
}

async function verifyRelease(
  path: string,
  platform: WorkerPlatform,
  releaseVersion: string,
): Promise<void> {
  const actualVersion = await verifyReleaseForPlatform(path, platform);
  if (actualVersion !== releaseVersion)
    throw new TypeError("Release archive version does not match catalog");
}

async function verifyReleaseForPlatform(
  path: string,
  platform: WorkerPlatform,
): Promise<string> {
  const manifest =
    platform === "darwin-arm64"
      ? await verifyMacRelease(path)
      : await verifyWindowsRelease(path);
  return manifest.releaseVersion;
}

function validateOptions(options: InstallationReleaseArchiveOptions): void {
  if (
    !isAbsolute(options.archivePath) ||
    !isAbsolute(options.outputRoot) ||
    !RELEASE_VERSION.test(options.releaseVersion) ||
    !["darwin-arm64", "windows-amd64"].includes(options.platform)
  )
    throw new TypeError("Release archive options are invalid");
}

async function assertRegularArchive(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1)
    throw new TypeError("Release archive is unsafe");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    throw new TypeError("Release archive permissions are unsafe");
}

async function assertProtectedDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new TypeError("Release output directory is unsafe");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
}

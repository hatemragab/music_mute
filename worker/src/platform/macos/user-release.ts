import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { verifyMacRelease } from "./release-manifest.js";
import type { MacUserLayout } from "./user-paths.js";

export interface MacUserReleaseInstallation {
  releaseVersion: string;
  releaseRoot: string;
  previousRelease: string | null;
  reused: boolean;
}

export interface StagedMacUserRelease {
  releaseVersion: string;
  releaseRoot: string;
  reused: boolean;
}

export async function installMacUserRelease(
  layout: MacUserLayout,
  sourceRoot: string,
): Promise<MacUserReleaseInstallation> {
  const staged = await stageMacUserRelease(layout, sourceRoot);
  const previousRelease = await activateMacUserRelease(
    layout,
    staged.releaseVersion,
  );
  return { ...staged, previousRelease };
}

export async function stageMacUserRelease(
  layout: MacUserLayout,
  sourceRoot: string,
): Promise<StagedMacUserRelease> {
  const manifest = await verifyMacRelease(sourceRoot);
  const destination = join(layout.releasesRoot, manifest.releaseVersion);
  await mkdir(layout.releasesRoot, { recursive: true, mode: 0o700 });
  let reused = false;
  try {
    const existing = await verifyMacRelease(destination);
    if (JSON.stringify(existing) !== JSON.stringify(manifest))
      throw new TypeError("Installed macOS release version is immutable");
    reused = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const temporary = join(
      layout.releasesRoot,
      `.${manifest.releaseVersion}.${randomUUID()}.tmp`,
    );
    try {
      await cp(sourceRoot, temporary, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      await verifyMacRelease(temporary);
      await rename(temporary, destination);
    } catch (copyError) {
      await rm(temporary, { recursive: true, force: true });
      throw copyError;
    }
  }
  return {
    releaseVersion: manifest.releaseVersion,
    releaseRoot: destination,
    reused,
  };
}

export async function activateMacUserRelease(
  layout: MacUserLayout,
  releaseVersion: string,
): Promise<string | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(releaseVersion))
    throw new TypeError("macOS release version is unsafe");
  await verifyMacRelease(join(layout.releasesRoot, releaseVersion));
  const previousRelease = await currentRelease(layout);
  const relativeTarget = join("releases", releaseVersion);
  if (previousRelease === relativeTarget) return previousRelease;
  const temporaryLink = `${layout.currentLink}.${randomUUID()}.tmp`;
  await symlink(relativeTarget, temporaryLink);
  try {
    await rename(temporaryLink, layout.currentLink);
  } catch (error) {
    await rm(temporaryLink, { force: true });
    throw error;
  }
  return previousRelease;
}

export async function installMacUserModel(options: {
  layout: MacUserLayout;
  sourcePath: string;
  filename: string;
  bytes: number;
  sha256: string;
}): Promise<{ path: string; reused: boolean }> {
  const destination = macUserModelPath(
    options.layout,
    options.sha256,
    options.filename,
  );
  await assertArtifact(options.sourcePath, options.bytes, options.sha256);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await assertArtifact(destination, options.bytes, options.sha256);
    return { path: destination, reused: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await copyFile(options.sourcePath, temporary, 0);
    await chmod(temporary, 0o600);
    await assertArtifact(temporary, options.bytes, options.sha256);
    await rename(temporary, destination);
    return { path: destination, reused: false };
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function macUserModelPath(
  layout: MacUserLayout,
  sha256: string,
  filename: string,
): string {
  if (basename(filename) !== filename || !/^[a-f0-9]{64}$/u.test(sha256))
    throw new TypeError("Model identity is unsafe");
  return join(layout.modelRoot, sha256, filename);
}

export async function rollbackMacUserRelease(
  layout: MacUserLayout,
  previousRelease: string | null,
): Promise<void> {
  if (previousRelease === null) {
    await rm(layout.currentLink, { force: true });
    return;
  }
  if (!/^releases\/[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/u.test(previousRelease))
    throw new TypeError("Previous macOS release link is unsafe");
  const temporaryLink = `${layout.currentLink}.${randomUUID()}.rollback`;
  await symlink(previousRelease, temporaryLink);
  await rename(temporaryLink, layout.currentLink);
}

export async function verifyActiveMacUserRelease(
  layout: MacUserLayout,
): Promise<void> {
  const target = await currentRelease(layout);
  if (target === null) throw new TypeError("Current macOS release is missing");
  const releaseRoot = resolve(dirname(layout.currentLink), target);
  if (!releaseRoot.startsWith(`${layout.releasesRoot}/`))
    throw new TypeError("Current macOS release target is unsafe");
  await verifyMacRelease(releaseRoot);
}

async function currentRelease(layout: MacUserLayout): Promise<string | null> {
  try {
    const info = await lstat(layout.currentLink);
    if (!info.isSymbolicLink())
      throw new TypeError("Current macOS release link is unsafe");
    const target = await readlink(layout.currentLink);
    if (!/^releases\/[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/u.test(target))
      throw new TypeError("Current macOS release target is unsafe");
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function assertArtifact(
  path: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== expectedBytes ||
    !/^[a-f0-9]{64}$/u.test(expectedSha256)
  )
    throw new TypeError("Model artifact is unsafe");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== expectedSha256)
    throw new TypeError("Model artifact digest does not match");
}

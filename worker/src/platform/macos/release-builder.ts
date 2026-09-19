import { randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readlink,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  type MacReleaseManifest,
  writeMacReleaseManifest,
} from "./release-manifest.js";
import { auditMacRuntimeBinary } from "./macho-audit.js";

export interface MacReleaseBuildOptions {
  workerRoot: string;
  outputRoot: string;
  releaseVersion: string;
  nodeRoot: string;
  pythonRoot: string;
  mediaRoot: string;
  host?: { platform: NodeJS.Platform; arch: string };
  binaryAudit?: (path: string) => Promise<void>;
}

export async function buildMacRelease(
  options: MacReleaseBuildOptions,
): Promise<MacReleaseManifest> {
  const host = options.host ?? process;
  if (host.platform !== "darwin" || host.arch !== "arm64")
    throw new TypeError("Mac releases require a native Darwin ARM64 host");
  const workerRoot = safeAbsolute(options.workerRoot, "worker root");
  const outputRoot = safeAbsolute(options.outputRoot, "output root");
  const nodeRoot = safeAbsolute(options.nodeRoot, "Node root");
  const pythonRoot = safeAbsolute(options.pythonRoot, "Python root");
  const mediaRoot = safeAbsolute(options.mediaRoot, "media root");
  const ffmpeg = join(mediaRoot, "bin", "ffmpeg");
  const ffprobe = join(mediaRoot, "bin", "ffprobe");
  await assertDirectory(workerRoot, "worker root");
  await assertDirectory(join(workerRoot, "dist"), "compiled worker");
  await assertDirectory(join(workerRoot, "engine"), "worker engine");
  await assertDirectory(nodeRoot, "Node root");
  await assertDirectory(pythonRoot, "Python root");
  await assertDirectory(mediaRoot, "media root");
  await assertDirectory(join(mediaRoot, "licenses"), "media licenses");
  await assertRegularFile(
    join(mediaRoot, "SOURCE-MANIFEST.json"),
    "media source manifest",
  );
  await assertRegularFile(
    join(mediaRoot, "licenses", "ffmpeg", "COPYING.LGPLv2.1"),
    "FFmpeg license",
  );
  await assertRegularFile(
    join(mediaRoot, "licenses", "lame", "COPYING"),
    "LAME license",
  );
  await assertExecutable(
    join(nodeRoot, "bin", "node"),
    "private Node",
    nodeRoot,
  );
  await assertExecutable(
    join(pythonRoot, "bin", "python3"),
    "private Python",
    pythonRoot,
  );
  await assertExecutable(ffmpeg, "ffmpeg");
  await assertExecutable(ffprobe, "ffprobe");
  const audit = options.binaryAudit ?? auditMacRuntimeBinary;
  await audit(join(nodeRoot, "bin", "node"));
  await audit(join(pythonRoot, "bin", "python3"));
  await audit(ffmpeg);
  await audit(ffprobe);

  await assertMissing(outputRoot);
  const temporary = join(
    dirname(outputRoot),
    `.${basename(outputRoot)}.${randomUUID()}.building`,
  );
  await mkdir(temporary, { recursive: false, mode: 0o755 });
  try {
    await copyTree(join(workerRoot, "dist"), join(temporary, "app", "dist"));
    await chmod(join(temporary, "app", "dist", "src", "cli", "main.js"), 0o755);
    await copyTree(
      join(workerRoot, "engine"),
      join(temporary, "app", "engine"),
    );
    await copyFile(
      join(workerRoot, "package.json"),
      join(temporary, "app", "package.json"),
    );
    await copyTree(nodeRoot, join(temporary, "runtime", "node"));
    await copyTree(pythonRoot, join(temporary, "runtime", "python"));
    await copyFile(ffmpeg, join(temporary, "runtime", "bin", "ffmpeg"));
    await copyFile(ffprobe, join(temporary, "runtime", "bin", "ffprobe"));
    await copyTree(
      join(mediaRoot, "licenses"),
      join(temporary, "runtime", "licenses"),
    );
    await copyFile(
      join(mediaRoot, "SOURCE-MANIFEST.json"),
      join(temporary, "runtime", "media-source-manifest.json"),
    );
    const manifest = await writeMacReleaseManifest(
      temporary,
      options.releaseVersion,
    );
    await rename(temporary, outputRoot);
    return manifest;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function copyTree(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    filter: (path) => {
      const name = basename(path);
      return (
        name !== "__pycache__" && name !== ".DS_Store" && !name.endsWith(".pyc")
      );
    },
  });
}

async function copyFile(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await cp(source, destination, {
    dereference: false,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new TypeError(`${label} is unsafe`);
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1)
    throw new TypeError(`${label} is unsafe`);
}

async function assertExecutable(
  path: string,
  label: string,
  allowedRoot?: string,
): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    const target = await readlink(path);
    const destination = resolve(dirname(path), target);
    if (
      allowedRoot === undefined ||
      isAbsolute(target) ||
      (destination !== allowedRoot &&
        !destination.startsWith(`${allowedRoot}${sep}`))
    )
      throw new TypeError(`Mac ${label} is unsafe`);
    const destinationInfo = await stat(destination);
    if (!destinationInfo.isFile() || (destinationInfo.mode & 0o111) === 0)
      throw new TypeError(`Mac ${label} is unsafe`);
    return;
  }
  if (!info.isFile() || (info.mode & 0o111) === 0)
    throw new TypeError(`Mac ${label} is unsafe`);
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new TypeError("Mac release output must not already exist");
}

function safeAbsolute(value: string, label: string): string {
  if (!isAbsolute(value)) throw new TypeError(`${label} must be absolute`);
  return resolve(value);
}

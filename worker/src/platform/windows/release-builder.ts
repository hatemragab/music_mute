import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { auditWindowsX64Binary } from "./pe-audit.js";
import {
  type WindowsReleaseManifest,
  writeWindowsReleaseManifest,
} from "./release-manifest.js";

export interface WindowsReleaseBuildOptions {
  workerRoot: string;
  outputRoot: string;
  releaseVersion: string;
  nodeRoot: string;
  pythonRoot: string;
  mediaRoot: string;
  serviceRoot: string;
  host?: { platform: NodeJS.Platform; arch: string };
  binaryAudit?: (path: string) => Promise<void>;
}

export async function buildWindowsRelease(
  options: WindowsReleaseBuildOptions,
): Promise<WindowsReleaseManifest> {
  const host = options.host ?? process;
  if (host.platform !== "win32" || host.arch !== "x64")
    throw new TypeError(
      "Windows releases require a native Windows x86_64 host",
    );
  const workerRoot = safeAbsolute(options.workerRoot, "worker root");
  const outputRoot = safeAbsolute(options.outputRoot, "output root");
  const nodeRoot = safeAbsolute(options.nodeRoot, "Node root");
  const pythonRoot = safeAbsolute(options.pythonRoot, "Python root");
  const mediaRoot = safeAbsolute(options.mediaRoot, "media root");
  const serviceRoot = safeAbsolute(options.serviceRoot, "service root");
  await assertDirectory(join(workerRoot, "dist"), "compiled worker");
  await assertDirectory(join(workerRoot, "engine"), "worker engine");
  await assertRegularFile(
    join(workerRoot, "scripts", "manage-windows-service.ps1"),
    "Windows service manager",
  );
  for (const [path, label] of [
    [nodeRoot, "Node root"],
    [pythonRoot, "Python root"],
    [mediaRoot, "media root"],
    [serviceRoot, "service root"],
  ] as const)
    await assertDirectory(path, label);
  const binaries = [
    join(nodeRoot, "node.exe"),
    join(pythonRoot, "python.exe"),
    join(mediaRoot, "bin", "ffmpeg.exe"),
    join(mediaRoot, "bin", "ffprobe.exe"),
    join(serviceRoot, "WinSW.exe"),
  ];
  for (const path of binaries) await assertRegularFile(path, "runtime binary");
  const provenance = [
    join(mediaRoot, "SOURCE-MANIFEST.json"),
    join(mediaRoot, "licenses", "ffmpeg", "COPYING.LGPLv2.1"),
    join(mediaRoot, "licenses", "lame", "COPYING"),
    join(serviceRoot, "SOURCE-MANIFEST.json"),
    join(serviceRoot, "LICENSE.txt"),
  ];
  for (const path of provenance)
    await assertRegularFile(path, "provenance file");
  const audit = options.binaryAudit ?? auditWindowsX64Binary;
  for (const path of binaries) await audit(path);

  await assertMissing(outputRoot);
  const temporary = join(
    dirname(outputRoot),
    `.${basename(outputRoot)}.${randomUUID()}.building`,
  );
  await mkdir(temporary, { recursive: false });
  try {
    await copyTree(join(workerRoot, "dist"), join(temporary, "app", "dist"));
    await copyTree(
      join(workerRoot, "engine"),
      join(temporary, "app", "engine"),
    );
    await copyFile(
      join(workerRoot, "package.json"),
      join(temporary, "app", "package.json"),
    );
    await copyFile(
      join(workerRoot, "scripts", "manage-windows-service.ps1"),
      join(temporary, "installer", "manage-windows-service.ps1"),
    );
    await copyTree(nodeRoot, join(temporary, "runtime", "node"));
    await copyTree(pythonRoot, join(temporary, "runtime", "python"));
    await copyFile(
      binaries[2]!,
      join(temporary, "runtime", "bin", "ffmpeg.exe"),
    );
    await copyFile(
      binaries[3]!,
      join(temporary, "runtime", "bin", "ffprobe.exe"),
    );
    await copyTree(
      join(mediaRoot, "licenses"),
      join(temporary, "runtime", "licenses"),
    );
    await copyFile(
      join(mediaRoot, "SOURCE-MANIFEST.json"),
      join(temporary, "runtime", "media-source-manifest.json"),
    );
    await copyFile(
      join(serviceRoot, "WinSW.exe"),
      join(temporary, "runtime", "service", "MusicMuteWorkerService.exe"),
    );
    await copyFile(
      join(serviceRoot, "LICENSE.txt"),
      join(temporary, "runtime", "service", "LICENSE.txt"),
    );
    await copyFile(
      join(serviceRoot, "SOURCE-MANIFEST.json"),
      join(temporary, "runtime", "service", "source-manifest.json"),
    );
    const manifest = await writeWindowsReleaseManifest(
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
  await mkdir(dirname(destination), { recursive: true });
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

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new TypeError("Windows release output must not already exist");
}

function safeAbsolute(value: string, label: string): string {
  if (!isAbsolute(value)) throw new TypeError(`${label} must be absolute`);
  return resolve(value);
}

import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  writeDiagnosticContents,
  MAX_BUNDLE_BYTES,
  type DiagnosticBundleResult,
} from "../shared/diagnostic-bundle.js";
import type { MacUserHealth } from "./user-health.js";
import type { MacUserLayout } from "./user-paths.js";

const execFileAsync = promisify(execFile);
export type MacDiagnosticBundleResult = DiagnosticBundleResult;

export async function createMacDiagnosticBundle(options: {
  layout: MacUserLayout;
  status: unknown;
  health: MacUserHealth;
  outputPath?: string;
  jobId?: string;
  since?: number;
  execute?: (
    file: string,
    arguments_: readonly string[],
  ) => Promise<{ stdout: string; stderr: string }>;
}): Promise<MacDiagnosticBundleResult> {
  if (options.jobId !== undefined && !/^[0-9a-f]{24}$/iu.test(options.jobId))
    throw new TypeError("Diagnostic job ID must be 24 hex characters");
  const outputPath = safeOutputPath(
    options.layout,
    options.outputPath ?? defaultOutputPath(options.layout),
  );
  await assertMissing(outputPath);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const staging = join(
    options.layout.temporaryRoot,
    `diagnostics-${randomUUID()}`,
  );
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const contentRoot = join(staging, "contents");
  const archivePath = join(staging, "bundle.zip");
  await mkdir(contentRoot, { mode: 0o700 });
  try {
    const { files, createdAt } = await writeDiagnosticContents(
      contentRoot,
      options,
    );
    const execute = options.execute ?? executeDitto;
    await execute("/usr/bin/ditto", [
      "-c",
      "-k",
      "--norsrc",
      "--keepParent",
      contentRoot,
      archivePath,
    ]);
    const output = await lstat(archivePath);
    if (!output.isFile() || output.isSymbolicLink() || output.size < 1)
      throw new TypeError("Diagnostic bundle output is unsafe");
    if (output.size > MAX_BUNDLE_BYTES)
      throw new TypeError("Diagnostic bundle exceeds the export size limit");
    await chmod(archivePath, 0o600);
    await copyFile(archivePath, outputPath, constants.COPYFILE_EXCL);
    return { schemaVersion: 1, path: outputPath, files, createdAt };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function defaultOutputPath(layout: MacUserLayout): string {
  return join(
    layout.homeRoot,
    "Downloads",
    `musicmute-worker-diagnostics-${new Date().toISOString().replaceAll(":", "-")}.zip`,
  );
}

function safeOutputPath(layout: MacUserLayout, value: string): string {
  if (!isAbsolute(value) || !value.endsWith(".zip"))
    throw new TypeError(
      "Diagnostic bundle output must be an absolute .zip path",
    );
  const output = resolve(value);
  const home = resolve(layout.homeRoot);
  if (!output.startsWith(`${home}${sep}`) || basename(output).length > 180)
    throw new TypeError(
      "Diagnostic bundle output must be inside the current home directory",
    );
  return output;
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new TypeError("Diagnostic bundle output already exists");
}

async function executeDitto(
  file: string,
  arguments_: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(file, [...arguments_], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    timeout: 60_000,
    maxBuffer: 64 * 1024,
  });
}

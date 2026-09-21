import { execFile as nodeExecFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execFilePromise = promisify(nodeExecFile);

export const REQUIRED_NODE_VERSION = "24.18.0";
export const REQUIRED_FFMPEG_VERSION = "8.0.3";

export type ComponentDecision = "reuse" | "install-private";

export interface InstalledComponentProbe {
  decision: ComponentDecision;
  requestedVersion: string;
  installedVersion?: string;
  executablePath?: string;
  reason: "compatible" | "missing" | "untrusted" | "older" | "incompatible";
}

export interface RuntimePreflightResult {
  node: InstalledComponentProbe;
  ffmpeg: InstalledComponentProbe;
  ffprobe: InstalledComponentProbe;
}

export type VersionCommand = (
  executable: string,
  arguments_: readonly string[],
) => Promise<string>;

export async function inspectInstalledMacRuntime(options: {
  nodeCandidates: readonly string[];
  ffmpegCandidates: readonly string[];
  ffprobeCandidates: readonly string[];
  execute?: VersionCommand;
  uid?: number;
}): Promise<RuntimePreflightResult> {
  const execute = options.execute ?? executeVersion;
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || uid <= 0)
    throw new TypeError("macOS runtime preflight requires a non-root user");
  const result: RuntimePreflightResult = {
    node: await probe(
      options.nodeCandidates,
      REQUIRED_NODE_VERSION,
      ["--version"],
      parseNodeVersion,
      execute,
      uid,
    ),
    ffmpeg: await probe(
      options.ffmpegCandidates,
      REQUIRED_FFMPEG_VERSION,
      ["-version"],
      parseFfmpegVersion,
      execute,
      uid,
    ),
    ffprobe: await probe(
      options.ffprobeCandidates,
      REQUIRED_FFMPEG_VERSION,
      ["-version"],
      parseFfmpegVersion,
      execute,
      uid,
    ),
  };
  if (
    result.ffmpeg.decision === "reuse" &&
    result.ffprobe.decision === "reuse" &&
    result.ffmpeg.installedVersion !== result.ffprobe.installedVersion
  ) {
    result.ffmpeg = incompatiblePair(result.ffmpeg);
    result.ffprobe = incompatiblePair(result.ffprobe);
  } else if (result.ffmpeg.decision !== result.ffprobe.decision) {
    if (result.ffmpeg.decision === "reuse")
      result.ffmpeg = incompatiblePair(result.ffmpeg);
    if (result.ffprobe.decision === "reuse")
      result.ffprobe = incompatiblePair(result.ffprobe);
  }
  return result;
}

function incompatiblePair(
  component: InstalledComponentProbe,
): InstalledComponentProbe {
  return {
    ...component,
    decision: "install-private",
    reason: "incompatible",
  };
}

async function probe(
  candidates: readonly string[],
  requestedVersion: string,
  arguments_: readonly string[],
  parseVersion: (output: string) => string | null,
  execute: VersionCommand,
  uid: number,
): Promise<InstalledComponentProbe> {
  let bestFailure: InstalledComponentProbe | undefined;
  for (const candidate of candidates) {
    if (!(await candidateExists(candidate))) continue;
    const trustedPath = await trustedExecutable(candidate, uid);
    if (trustedPath === null) {
      bestFailure ??= {
        decision: "install-private",
        requestedVersion,
        reason: "untrusted",
      };
      continue;
    }
    let output: string;
    try {
      output = await execute(trustedPath, arguments_);
    } catch {
      bestFailure ??= {
        decision: "install-private",
        requestedVersion,
        executablePath: trustedPath,
        reason: "incompatible",
      };
      continue;
    }
    const installedVersion = parseVersion(output);
    if (installedVersion === null) {
      bestFailure ??= {
        decision: "install-private",
        requestedVersion,
        executablePath: trustedPath,
        reason: "incompatible",
      };
      continue;
    }
    const comparison = compareVersions(installedVersion, requestedVersion);
    if (comparison < 0 || major(installedVersion) !== major(requestedVersion)) {
      bestFailure = {
        decision: "install-private",
        requestedVersion,
        installedVersion,
        executablePath: trustedPath,
        reason: comparison < 0 ? "older" : "incompatible",
      };
      continue;
    }
    return {
      decision: "reuse",
      requestedVersion,
      installedVersion,
      executablePath: trustedPath,
      reason: "compatible",
    };
  }
  return (
    bestFailure ?? {
      decision: "install-private",
      requestedVersion,
      reason: "missing",
    }
  );
}

async function candidateExists(candidate: string): Promise<boolean> {
  if (!isAbsolute(candidate)) return true;
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function trustedExecutable(
  candidate: string,
  uid: number,
): Promise<string | null> {
  if (!isAbsolute(candidate)) return null;
  try {
    const resolved = await realpath(candidate);
    const info = await lstat(resolved);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o111) === 0 ||
      (info.mode & 0o022) !== 0 ||
      (info.uid !== 0 && info.uid !== uid)
    )
      return null;
    return resolved;
  } catch {
    return null;
  }
}

export function parseNodeVersion(output: string): string | null {
  return /^v(\d+\.\d+\.\d+)\s*$/u.exec(output.trim())?.[1] ?? null;
}

export function parseFfmpegVersion(output: string): string | null {
  return (
    /^ff(?:mpeg|probe) version (\d+\.\d+(?:\.\d+)?)(?:\s|$)/u.exec(
      output.trim(),
    )?.[1] ?? null
  );
}

function compareVersions(left: string, right: string): number {
  const leftParts = normalizedParts(left);
  const rightParts = normalizedParts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function major(version: string): number {
  return normalizedParts(version)[0]!;
}

function normalizedParts(version: string): [number, number, number] {
  const parts = version.split(".").map(Number);
  if (
    parts.length < 2 ||
    parts.length > 3 ||
    parts.some((part) => !Number.isSafeInteger(part) || part < 0)
  )
    throw new TypeError("Runtime version is invalid");
  return [parts[0]!, parts[1]!, parts[2] ?? 0];
}

async function executeVersion(
  executable: string,
  arguments_: readonly string[],
): Promise<string> {
  const result = await execFilePromise(executable, [...arguments_], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    timeout: 10_000,
  });
  return `${result.stdout}\n${result.stderr}`.trim();
}

import { execFile as nodeExecFile } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { loadRuntimeConfig } from "../../runtime/runtime-config.js";
import type { LaunchAgentStatus } from "./launch-agent.js";
import type { MacUserLayout } from "./user-paths.js";
import { verifyActiveMacUserRelease } from "./user-release.js";

const execFile = promisify(nodeExecFile);
const DOCTOR_OUTPUT_LIMIT = 64 * 1024;

export interface MacUserHealthCheck {
  name: string;
  ok: boolean;
  path: string;
}

export interface MacUserHealth {
  schemaVersion: 1;
  healthy: boolean;
  checks: MacUserHealthCheck[];
}

interface LaunchAgentStatusReader {
  status(): Promise<LaunchAgentStatus>;
}

export async function inspectMacUserHealth(
  layout: MacUserLayout,
  launchAgent: LaunchAgentStatusReader,
  dependencies: {
    runtimeDoctor?: (layout: MacUserLayout) => Promise<void>;
    releaseVerifier?: (layout: MacUserLayout) => Promise<void>;
    requireRunning?: boolean;
  } = {},
): Promise<MacUserHealth> {
  const checks = await Promise.all([
    checkFile("runtime-config", layout.configPath, false),
    checkFile("credential", layout.credentialPath, false),
    checkFile("lifecycle", layout.lifecyclePath, false),
    checkFile("runtime-status", layout.runtimeStatusPath, false),
    checkFile("launch-agent", layout.plistPath, false),
    checkFile("node", layout.nodePath, true),
    checkFile("python", layout.pythonPath, true, true),
    checkFile("ffmpeg", layout.ffmpegPath, true),
    checkFile("ffprobe", layout.ffprobePath, true),
  ]);
  checks.push(
    await checkOperation(
      "release-manifest",
      layout.currentLink,
      async () =>
        await (dependencies.releaseVerifier ?? verifyActiveMacUserRelease)(
          layout,
        ),
    ),
  );
  checks.push(
    await checkOperation("config-contract", layout.configPath, async () => {
      await loadRuntimeConfig(layout.configPath, {
        platform: "darwin",
        arch: "arm64",
      });
    }),
  );
  const service = await launchAgent.status();
  checks.push({
    name: "launchctl",
    ok:
      dependencies.requireRunning === false ||
      (service.loaded && service.running),
    path: "/bin/launchctl",
  });
  checks.push(
    await checkOperation(
      "runtime-doctor",
      layout.pythonPath,
      async () =>
        await (dependencies.runtimeDoctor ?? runMacUserRuntimeDoctor)(layout),
    ),
  );
  return {
    schemaVersion: 1,
    healthy: checks.every((item) => item.ok),
    checks,
  };
}

async function checkFile(
  name: string,
  path: string,
  executable: boolean,
  allowSymlink = false,
): Promise<MacUserHealthCheck> {
  try {
    const info = await lstat(path);
    const target =
      info.isSymbolicLink() && allowSymlink ? await stat(path) : info;
    return {
      name,
      ok:
        target.isFile() &&
        (!info.isSymbolicLink() || allowSymlink) &&
        (!executable || (target.mode & 0o111) !== 0) &&
        (target.mode & 0o022) === 0,
      path,
    };
  } catch {
    return { name, ok: false, path };
  }
}

async function checkOperation(
  name: string,
  path: string,
  operation: () => Promise<void>,
): Promise<MacUserHealthCheck> {
  try {
    await operation();
    return { name, ok: true, path };
  } catch {
    return { name, ok: false, path };
  }
}

async function runMacUserRuntimeDoctor(layout: MacUserLayout): Promise<void> {
  const result = await execFile(
    layout.pythonPath,
    [
      "-m",
      "musicmute_engine.service_doctor",
      "--model-cache",
      layout.modelRoot,
      "--ffmpeg",
      layout.ffmpegPath,
      "--ffprobe",
      layout.ffprobePath,
    ],
    {
      cwd: layout.installRoot,
      encoding: "utf8",
      env: macUserPythonEnvironment(layout),
      timeout: 45_000,
      maxBuffer: DOCTOR_OUTPUT_LIMIT,
    },
  );
  const value = JSON.parse(result.stdout) as unknown;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).status !== "ok" ||
    (value as Record<string, unknown>).platform !== "darwin" ||
    (value as Record<string, unknown>).architecture !== "arm64"
  )
    throw new TypeError("macOS user runtime doctor returned invalid output");
}

export function macUserPythonEnvironment(
  layout: MacUserLayout,
): NodeJS.ProcessEnv {
  return {
    HOME: layout.homeRoot,
    LANG: "en_US.UTF-8",
    PATH: `${dirname(layout.ffmpegPath)}:${dirname(layout.nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    MPLCONFIGDIR: join(layout.cacheRoot, "matplotlib"),
    NUMBA_CACHE_DIR: join(layout.cacheRoot, "numba"),
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONPATH: layout.engineRoot,
    PYTHONUNBUFFERED: "1",
    XDG_CACHE_HOME: layout.cacheRoot,
  };
}

import { execFile as nodeExecFile } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { loadLocalRuntimeStatus } from "../../runtime/local-runtime-status.js";
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
  status?: "passed" | "failed" | "warning" | "unsupported" | "not-run";
  code?: string;
  evidence?: string;
  nextAction?: string;
}

export interface MacUserHealth {
  schemaVersion: 1;
  healthy: boolean;
  checks: MacUserHealthCheck[];
  depth?: "quick" | "full";
}

class HealthCheckFailure extends Error {
  constructor(
    readonly code: string,
    readonly evidence: string,
  ) {
    super(evidence);
  }
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
    depth?: "quick" | "full";
  } = {},
): Promise<MacUserHealth> {
  const depth = dependencies.depth ?? "full";
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
    depth === "quick"
      ? notRun(
          "release-manifest",
          layout.currentLink,
          "Run doctor --full to verify release integrity",
        )
      : await checkOperation(
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
  const serviceOk =
    dependencies.requireRunning === false ||
    (service.loaded && service.running);
  checks.push({
    name: "launchctl",
    ok: serviceOk,
    path: "/bin/launchctl",
    status: serviceOk ? "passed" : "failed",
    code: serviceOk ? "OK" : "SERVICE_NOT_RUNNING",
    evidence: service.loaded
      ? service.running
        ? "loaded-running"
        : "loaded-stopped"
      : "not-loaded",
    nextAction: serviceOk ? "None" : "Check mw status --local and service logs",
  });
  if (depth === "quick") {
    checks.push(
      await checkOperation(
        "runtime-snapshot",
        layout.runtimeStatusPath,
        async () => {
          await loadLocalRuntimeStatus(layout.runtimeStatusPath);
        },
      ),
    );
    checks.push(
      notRun(
        "runtime-doctor",
        layout.pythonPath,
        "Run doctor --full for Python, provider, model, and FFmpeg integrity",
      ),
    );
  } else {
    checks.push(
      await checkOperation(
        "runtime-doctor",
        layout.pythonPath,
        async () =>
          await (dependencies.runtimeDoctor ?? runMacUserRuntimeDoctor)(layout),
      ),
    );
  }
  return {
    schemaVersion: 1,
    depth,
    healthy: checks.every(
      (item) =>
        item.ok || item.status === "not-run" || item.status === "warning",
    ),
    checks,
  };
}

function notRun(
  name: string,
  path: string,
  nextAction: string,
): MacUserHealthCheck {
  return {
    name,
    path,
    ok: false,
    status: "not-run",
    code: "NOT_RUN",
    evidence: "Not checked in quick mode",
    nextAction,
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
    const ok =
      target.isFile() &&
      (!info.isSymbolicLink() || allowSymlink) &&
      (!executable || (target.mode & 0o111) !== 0) &&
      (target.mode & 0o022) === 0;
    return {
      name,
      ok,
      path,
      status: ok ? "passed" : "failed",
      code: ok ? "OK" : "UNSAFE_FILE",
      evidence: ok
        ? "Private file present"
        : "File type, symlink, executable bit, or permissions invalid",
      nextAction: ok
        ? "None"
        : `Inspect the installed ${name} file and permissions`,
    };
  } catch {
    return {
      name,
      ok: false,
      path,
      status: "failed",
      code: "FILE_MISSING",
      evidence: "Required file is unavailable",
      nextAction: `Inspect the installed ${name} file`,
    };
  }
}

async function checkOperation(
  name: string,
  path: string,
  operation: () => Promise<void>,
): Promise<MacUserHealthCheck> {
  try {
    await operation();
    return {
      name,
      ok: true,
      path,
      status: "passed",
      code: "OK",
      evidence: "Check completed",
      nextAction: "None",
    };
  } catch (error) {
    return {
      name,
      ok: false,
      path,
      status: "failed",
      code:
        error instanceof HealthCheckFailure
          ? error.code
          : `${name.toUpperCase().replaceAll("-", "_")}_FAILED`,
      evidence:
        error instanceof HealthCheckFailure
          ? error.evidence
          : "Check failed; run doctor --full and inspect recent errors",
      nextAction:
        name === "runtime-doctor"
          ? "Check model cache and provider integrity with doctor --full"
          : `Inspect ${name} and rerun doctor --full`,
    };
  }
}

async function runMacUserRuntimeDoctor(layout: MacUserLayout): Promise<void> {
  let result: Awaited<ReturnType<typeof execFile>>;
  try {
    result = await execFile(
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
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string") {
      try {
        const value = JSON.parse(stderr.trim()) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const record = value as Record<string, unknown>;
          if (
            typeof record.code === "string" &&
            /^[A-Z0-9_]{1,64}$/u.test(record.code) &&
            typeof record.reason === "string" &&
            /^[A-Za-z0-9 .-]{1,120}$/u.test(record.reason)
          )
            throw new HealthCheckFailure(record.code, record.reason);
        }
      } catch (parsed) {
        if (parsed instanceof HealthCheckFailure) throw parsed;
      }
    }
    throw new HealthCheckFailure(
      "RUNTIME_DOCTOR_PROCESS_FAILED",
      "Runtime doctor process exited or timed out",
    );
  }
  const value = JSON.parse(result.stdout.toString()) as unknown;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).status !== "ok" ||
    (value as Record<string, unknown>).platform !== "darwin" ||
    (value as Record<string, unknown>).architecture !== "arm64"
  )
    throw new HealthCheckFailure(
      "RUNTIME_DOCTOR_OUTPUT_INVALID",
      "Runtime doctor returned an invalid result",
    );
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

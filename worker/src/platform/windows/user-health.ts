import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { loadRuntimeConfig } from "../../runtime/runtime-config.js";
import { loadLocalLifecycle } from "../../runtime/local-lifecycle.js";
import { loadLocalRuntimeStatus } from "../../runtime/local-runtime-status.js";
import {
  checkOperation,
  HealthCheckFailure,
  notRun,
  type UserHealth,
} from "../shared/user-health.js";
import type { WindowsServiceActions } from "./native-service.js";
import { assertWindowsPrivateDataFile } from "./private-data.js";
import { verifyWindowsRelease } from "./release-manifest.js";
import {
  createWindowsReleaseLayout,
  type WindowsReleaseLayout,
  type WindowsServiceLayout,
} from "./service-definition.js";
import { readWindowsActiveVersion } from "./active-release.js";
import { windowsOperationPending } from "./user-maintenance.js";

export interface WindowsHealthDependencies {
  depth?: "quick" | "full";
  privateFile?: typeof assertWindowsPrivateDataFile;
  activeVersion?: typeof readWindowsActiveVersion;
  releaseVerifier?: (release: WindowsReleaseLayout) => Promise<void>;
  configValidator?: (path: string) => Promise<void>;
  runtimeDoctor?: (
    layout: WindowsServiceLayout,
    release: WindowsReleaseLayout,
  ) => Promise<void>;
}

/** Read-only inspection. Never starts the service or runs inference. */
export async function inspectWindowsUserHealth(
  layout: WindowsServiceLayout,
  service: WindowsServiceActions,
  dependencies: WindowsHealthDependencies = {},
): Promise<UserHealth> {
  const depth = dependencies.depth ?? "quick";
  const checks = [
    await checkOperation("installation-permissions", layout.installRoot, () =>
      service.assertPrivateInstallation(),
    ),
  ];
  const result = (): UserHealth => ({
    schemaVersion: 1,
    depth,
    healthy: checks.every(
      (check) =>
        check.ok || check.status === "not-run" || check.status === "warning",
    ),
    checks,
  });
  if (!checks[0]!.ok) {
    checks.push(
      notRun(
        "installation-content",
        layout.installRoot,
        "Restore private installation permissions before inspecting content",
      ),
    );
    return result();
  }
  const privateFile = dependencies.privateFile ?? assertWindowsPrivateDataFile;
  for (const [name, path] of [
    ["runtime-config", layout.configPath],
    ["credential", layout.credentialPath],
    ["active-release", layout.activeReleasePath],
    ["lifecycle", layout.lifecyclePath],
    ["runtime-status", layout.runtimeStatusPath],
    ["service-config", layout.serviceConfigPath],
  ] as const) {
    checks.push(await checkOperation(name, path, () => privateFile(path)));
  }
  let release: WindowsReleaseLayout | undefined;
  if (checks.find((check) => check.name === "active-release")?.ok) {
    checks.push(
      await checkOperation(
        "active-release-version",
        layout.activeReleasePath,
        async () => {
          release = createWindowsReleaseLayout(
            layout,
            await (dependencies.activeVersion ?? readWindowsActiveVersion)(
              layout,
            ),
          );
        },
      ),
    );
  }
  checks.push(
    await checkOperation("config-contract", layout.configPath, async () => {
      if (
        !checks.find((check) => check.name === "runtime-config")?.ok ||
        !checks.find((check) => check.name === "credential")?.ok
      )
        throw new Error("Unsafe configuration");
      if (dependencies.configValidator)
        await dependencies.configValidator(layout.configPath);
      else
        await loadRuntimeConfig(layout.configPath, {
          platform: "win32",
          arch: "x64",
        });
    }),
  );
  checks.push(
    await checkOperation(
      "service-control",
      layout.serviceExecutablePath,
      async () => {
        const native = await service.inspect();
        if (native.state !== "running")
          throw new HealthCheckFailure(
            native.state === "absent"
              ? "SERVICE_NOT_INSTALLED"
              : "SERVICE_NOT_RUNNING",
            `Service ${native.state}`,
          );
        if (!checks.find((check) => check.name === "runtime-status")?.ok)
          throw new Error("Unsafe status");
        const snapshot = await loadLocalRuntimeStatus(layout.runtimeStatusPath);
        const age = Date.now() - Date.parse(snapshot.updatedAt);
        if (
          native.runtimeProcessId !== snapshot.processId ||
          native.runtimeStartedAt === null ||
          Date.parse(snapshot.updatedAt) <
            Date.parse(native.runtimeStartedAt) ||
          age > 180_000 ||
          age < -30_000
        )
          throw new HealthCheckFailure(
            "RUNTIME_STATUS_STALE",
            "Runtime heartbeat does not identify the current service process",
          );
        if (snapshot.childState !== "ready")
          throw new HealthCheckFailure(
            "RUNTIME_NOT_READY",
            "Processing children are not ready",
          );
      },
    ),
  );
  checks.push(
    await checkOperation(
      "lifecycle-contract",
      layout.lifecyclePath,
      async () => {
        if (!checks.find((check) => check.name === "lifecycle")?.ok)
          throw new Error("Unsafe lifecycle");
        await loadLocalLifecycle(layout.lifecyclePath);
      },
    ),
  );
  checks.push(
    await checkOperation(
      "maintenance-recovery",
      layout.serviceRoot,
      async () => {
        if (await windowsOperationPending(layout))
          throw new HealthCheckFailure(
            "MAINTENANCE_RECOVERY_REQUIRED",
            "Run mw recover before operating this installation",
          );
      },
    ),
  );
  if (depth === "quick" || !release) {
    const nextAction = release
      ? "Run doctor --full to verify installed runtime integrity"
      : "Repair the active release marker before checking the runtime";
    checks.push(
      notRun("release-manifest", layout.releasesRoot, nextAction),
      notRun("runtime-doctor", layout.releasesRoot, nextAction),
    );
  } else {
    const active = release;
    const integrity = await checkOperation(
      "release-manifest",
      active.releaseRoot,
      async () => {
        if (dependencies.releaseVerifier)
          await dependencies.releaseVerifier(active);
        else {
          const manifest = await verifyWindowsRelease(active.releaseRoot);
          if (manifest.releaseVersion !== win32.basename(active.releaseRoot))
            throw new Error("Release identity mismatch");
        }
      },
    );
    checks.push(integrity);
    checks.push(
      integrity.ok
        ? await checkOperation("runtime-doctor", active.pythonPath, () =>
            (dependencies.runtimeDoctor ?? runWindowsRuntimeDoctor)(
              layout,
              active,
            ),
          )
        : notRun(
            "runtime-doctor",
            active.pythonPath,
            "Repair release integrity before executing installed tools",
          ),
    );
  }
  return result();
}

async function runWindowsRuntimeDoctor(
  layout: WindowsServiceLayout,
  release: WindowsReleaseLayout,
): Promise<void> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[A-Za-z]:\\[^\r\n\0]+$/u.test(systemRoot))
    throw new Error("Windows system directory is unavailable");
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(
      release.pythonPath,
      [
        "-B",
        "-E",
        "-s",
        "-m",
        "musicmute_engine.service_doctor",
        "--provider",
        "directml",
        "--model-cache",
        layout.modelCacheRoot,
        "--ffmpeg",
        release.ffmpegPath,
        "--ffprobe",
        release.ffprobePath,
      ],
      {
        cwd: release.engineRoot,
        windowsHide: true,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 64 * 1024,
        env: {
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
          PATH: `${win32.dirname(release.ffmpegPath)};${win32.join(systemRoot, "System32")};${systemRoot}`,
          HOME: layout.stateRoot,
          TEMP: layout.temporaryRoot,
          TMP: layout.temporaryRoot,
          MPLCONFIGDIR: win32.join(layout.runtimeCacheRoot, "matplotlib"),
          NUMBA_CACHE_DIR: win32.join(layout.runtimeCacheRoot, "numba"),
          XDG_CACHE_HOME: layout.runtimeCacheRoot,
        },
      },
    ));
  } catch {
    // Child stderr and exception messages may contain local paths or environment data.
    throw new HealthCheckFailure(
      "RUNTIME_DOCTOR_PROCESS_FAILED",
      "Installed runtime doctor failed or timed out; inspect model and media integrity",
    );
  }
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new HealthCheckFailure(
      "RUNTIME_DOCTOR_OUTPUT_INVALID",
      "Runtime doctor returned an invalid result",
    );
  }
  if (
    !value ||
    value.status !== "ok" ||
    value.platform !== "win32" ||
    value.architecture !== "x64" ||
    value.provider !== "DmlExecutionProvider"
  )
    throw new HealthCheckFailure(
      "RUNTIME_DOCTOR_OUTPUT_INVALID",
      "Runtime doctor returned an invalid result",
    );
}

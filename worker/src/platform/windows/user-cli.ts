import {
  checkWindowsUserUpdate,
  updateWindowsUserWorker,
} from "./user-updater.js";
import { reactivateWindowsInstallation } from "./user-installation.js";
import { unpairWindowsWorker, uninstallWindowsWorker } from "./user-removal.js";
import { createWindowsDiagnosticBundle } from "./diagnostic-bundle.js";
import { parseSince } from "../shared/operational-logs.js";
import { inspectWindowsUserHealth } from "./user-health.js";
import { formatHealth } from "../shared/user-health.js";
import { configureWorkerCapacity } from "../shared/worker-capacity.js";
import { watchStatus, waitForReady } from "../shared/status-watch.js";
import { join } from "node:path";
import { lstat, readFile } from "node:fs/promises";
import {
  loadLocalLifecycle,
  setLocalLifecycleIntent,
} from "../../runtime/local-lifecycle.js";
import {
  loadLocalRuntimeStatus,
  type LocalRuntimeStatus,
} from "../../runtime/local-runtime-status.js";
import { withNativeLock } from "../../runtime/native-lock.js";
import { resetRestartBudget } from "../../runtime/restart-budget.js";
import { waitForLocalDrain } from "../shared/local-drain.js";
import {
  isOperatorCommand,
  runOperatorCommand,
} from "../shared/operator-cli.js";
import {
  createWindowsServiceLayout,
  type WindowsServiceLayout,
} from "./service-definition.js";
import {
  WindowsServiceController,
  type WindowsServiceActions,
  type WindowsServiceStatus,
} from "./native-service.js";
import { runWindowsCommand } from "./cli.js";
import {
  recoverWindowsOperation,
  windowsOperationPending,
} from "./user-maintenance.js";
import {
  benchmarkWindowsFile,
  type WindowsFileBenchmarkRequest,
} from "./user-benchmark.js";
import {
  extractBooleanFlag,
  parseValueFlags,
} from "../shared/cli-arguments.js";
import { formatDetailedResult } from "../shared/cli-format.js";
import {
  WORKER_RECIPE_IDS,
  type WorkerRecipeId,
} from "../../../protocol/v1/protocol.js";

export const WINDOWS_USER_USAGE = `Usage:
  mw --version [--json]
  mw install --backend-url <origin> --enrollment-file <path> --output <path> --label <name>
  mw install [--json]
  mw status [--local] [--watch] [--json]
  mw update --check [--json]
  mw update [--force] [--json]
  mw unpair [--force] [--json]
  mw uninstall [--purge] [--json]
  mw doctor [--full] [--json]
  mw diagnostics [--output <new-archive.zip>] [--job <job-id>] [--since <1s-30d>] [--json]
  mw start [--wait-ready] [--json]
  mw stop [--force] [--json]
  mw restart [--force] [--json]
  mw pause [--json]
  mw drain [--json]
  mw resume [--json]
  mw recover [--release-version <installed-version>] [--leave-stopped] [--json]
  mw logs [--lines <1-1000>] [--events | --errors] [--follow]
          [--attempt-id <id>] [--since <1s-30d>] [--level <info|warning|error>] [--json]
  mw logs --clear [--json]
  mw job <job-id> [--json]
  mw errors [--since <1s-30d>] [--limit <1-100>] [--json]
  mw explain <code> [--since <1s-30d>] [--json]
  mw perf [--last <1-200>] [--since <1s-30d>] [--recipe <id>] [--json]
  mw capacity --workers <1|2> [--json]
  mw benchmark --workers 2 --input <absolute-audio-path>
          [--warmup-runs <1-2>] [--measured-runs <3-10>] [--output <new-report.json>]
          [--release-version <installed-version>] [--json]
  mw benchmark-file --input <absolute-audio-path> [--recipe <id>]
          [--warmup-runs <0-2>] [--measured-runs <3-10>] [--output <new-report.json>]
          [--release-version <installed-version>] [--json]

Windows service commands require an elevated administrator shell.`;

export interface WindowsUserContext {
  host?: { platform: NodeJS.Platform; arch: string };
  layout?: WindowsServiceLayout;
  service?: WindowsServiceActions;
  stdout?: (value: string) => void;
  lock?: <T>(path: string, operation: () => Promise<T>) => Promise<T>;
  wait?: (milliseconds: number) => Promise<void>;
  drainTimeoutMs?: number;
  readinessTimeoutMs?: number;
  monotonicNow?: () => number;
  benchmarkFile?: (request: WindowsFileBenchmarkRequest) => Promise<unknown>;
  recover?: typeof recoverWindowsOperation;
  health?: typeof inspectWindowsUserHealth;
  checkUpdate?: typeof checkWindowsUserUpdate;
  update?: typeof updateWindowsUserWorker;
  reactivate?: typeof reactivateWindowsInstallation;
  unpair?: typeof unpairWindowsWorker;
  uninstall?: typeof uninstallWindowsWorker;
  diagnostics?: typeof createWindowsDiagnosticBundle;
}

export async function runWindowsUserCommand(
  command: string,
  arguments_: readonly string[],
  context: WindowsUserContext = {},
): Promise<number> {
  const host = context.host ?? process;
  if (host.platform !== "win32" || host.arch !== "x64")
    throw new TypeError("Windows worker requires Windows x64");
  const layout = context.layout ?? createWindowsServiceLayout();
  const service = context.service ?? new WindowsServiceController(layout);
  if (command === "install") {
    const json = extractBooleanFlag(arguments_, "--json");
    if (json.remaining.length === 0) {
      const result = await (
        context.reactivate ?? reactivateWindowsInstallation
      )({ layout, service });
      (context.stdout ?? console.log)(
        formatDetailedResult(
          "MusicMute Worker Installation",
          result,
          json.present,
        ),
      );
    } else {
      await runWindowsCommand(["bootstrap", ...arguments_]);
    }
    return 0;
  }
  if (command === "update") {
    const jsonFlag = extractBooleanFlag(arguments_, "--json");
    const checkFlag = extractBooleanFlag(jsonFlag.remaining, "--check");
    const forceFlag = extractBooleanFlag(checkFlag.remaining, "--force");
    if (
      forceFlag.remaining.length !== 0 ||
      (checkFlag.present && forceFlag.present)
    )
      throw new TypeError(
        "Use update [--force] or update --check, with optional --json",
      );
    if (!checkFlag.present) {
      const result = await (context.update ?? updateWindowsUserWorker)({
        layout,
        service,
        force: forceFlag.present,
      });
      (context.stdout ?? console.log)(
        formatDetailedResult(
          "MusicMute Worker Update",
          { action: "update", ...result },
          jsonFlag.present,
        ),
      );
      return 0;
    }
    const checked = await (context.checkUpdate ?? checkWindowsUserUpdate)({
      layout,
      service,
    });
    (context.stdout ?? console.log)(
      formatDetailedResult(
        "MusicMute Worker Update",
        {
          action: "update-check",
          status: "ok",
          currentVersion: checked.currentVersion,
          availableVersion: checked.availableVersion,
          sequence: checked.sequence,
          updateAvailable: checked.updateAvailable,
        },
        jsonFlag.present,
      ),
    );
    return 0;
  }
  if (command === "unpair" || command === "uninstall") {
    const jsonFlag = extractBooleanFlag(arguments_, "--json");
    const actionFlag = extractBooleanFlag(
      jsonFlag.remaining,
      command === "unpair" ? "--force" : "--purge",
    );
    if (actionFlag.remaining.length !== 0)
      throw new TypeError(`${command} arguments are invalid`);
    const options = {
      layout,
      service,
      ...(context.lock ? { lock: context.lock } : {}),
      ...(context.wait ? { wait: context.wait } : {}),
      ...(context.drainTimeoutMs === undefined
        ? {}
        : { drainTimeoutMs: context.drainTimeoutMs }),
    };
    const result =
      command === "unpair"
        ? await (context.unpair ?? unpairWindowsWorker)({
            ...options,
            force: actionFlag.present,
          })
        : await (context.uninstall ?? uninstallWindowsWorker)({
            ...options,
            purge: actionFlag.present,
          });
    (context.stdout ?? console.log)(
      formatDetailedResult(
        "MusicMute Worker Removal",
        result,
        jsonFlag.present,
      ),
    );
    return 0;
  }
  if (command === "diagnostics") {
    const jsonFlag = extractBooleanFlag(arguments_, "--json");
    const flags = parseValueFlags(
      jsonFlag.remaining,
      new Set(["output", "job", "since"]),
    );
    const jobId = flags.get("job");
    if (jobId !== undefined && !/^[0-9a-f]{24}$/iu.test(jobId))
      throw new TypeError("Diagnostic job ID must be 24 hex characters");
    const since = flags.has("since")
      ? parseSince(flags.get("since")!)
      : undefined;
    await service.assertPrivateInstallation();
    const result = await (context.lock ?? withNativeLock)(
      layout.commandLockPath,
      async () => {
        const health = await (context.health ?? inspectWindowsUserHealth)(
          layout,
          service,
          { depth: "full" },
        );
        const status = await readWindowsStatus(layout, service).catch(() => ({
          healthy: false,
          status: "unavailable",
          readiness: {
            phase: "unavailable",
            modelReady: false,
            blockers: ["LOCAL_STATUS_UNAVAILABLE"],
          },
        }));
        return await (context.diagnostics ?? createWindowsDiagnosticBundle)({
          layout,
          status,
          health,
          ...(flags.has("output") ? { outputPath: flags.get("output")! } : {}),
          ...(jobId === undefined ? {} : { jobId }),
          ...(since === undefined ? {} : { since }),
        });
      },
    );
    (context.stdout ?? console.log)(
      formatDetailedResult(
        "MusicMute Worker Diagnostics",
        result,
        jsonFlag.present,
      ),
    );
    return 0;
  }
  if (command === "doctor") {
    const jsonFlag = extractBooleanFlag(arguments_, "--json");
    const fullFlag = extractBooleanFlag(jsonFlag.remaining, "--full");
    if (fullFlag.remaining.length !== 0)
      throw new TypeError("doctor accepts only --full and --json");
    const result = await (context.health ?? inspectWindowsUserHealth)(
      layout,
      service,
      { depth: fullFlag.present ? "full" : "quick" },
    );
    (context.stdout ?? console.log)(formatHealth(result, jsonFlag.present));
    return result.healthy ? 0 : 1;
  }
  if (command === "recover") {
    const jsonFlag = extractBooleanFlag(arguments_, "--json");
    const stoppedFlag = extractBooleanFlag(
      jsonFlag.remaining,
      "--leave-stopped",
    );
    const flags = parseValueFlags(
      stoppedFlag.remaining,
      new Set(["release-version"]),
    );
    const result = await (context.recover ?? recoverWindowsOperation)({
      layout,
      service,
      ...(stoppedFlag.present ? { leaveStopped: true } : {}),
      ...(flags.has("release-version")
        ? { releaseVersion: flags.get("release-version")! }
        : {}),
    });
    (context.stdout ?? console.log)(
      formatDetailedResult(
        "MusicMute Windows Recovery",
        result,
        jsonFlag.present,
      ),
    );
    return 0;
  }
  if (command === "capacity") {
    const jsonFlag = extractBooleanFlag(arguments_, "--json");
    const flags = parseValueFlags(jsonFlag.remaining, new Set(["workers"]));
    const workers = flags.get("workers");
    if (workers !== "1" && workers !== "2")
      throw new TypeError("capacity requires --workers 1 or 2");
    await service.assertPrivateInstallation();
    const result = await (context.lock ?? withNativeLock)(
      layout.commandLockPath,
      () =>
        configureWorkerCapacity({
          configPath: layout.configPath,
          receiptPath: join(layout.stateRoot, "capacity-validation.json"),
          workers: Number(workers) as 1 | 2,
          requireStopped: async () => {
            if (await windowsOperationPending(layout))
              throw new Error(
                "Windows maintenance recovery is required; run mw recover",
              );
            if ((await service.inspect()).state !== "stopped")
              throw new Error(
                "Drain and stop the installed worker before changing capacity",
              );
          },
        }),
    );
    (context.stdout ?? console.log)(
      formatDetailedResult(
        "MusicMute Worker Capacity",
        result,
        jsonFlag.present,
      ),
    );
    return 0;
  }
  if (command === "benchmark-file" || command === "benchmark") {
    const capacityMode = command === "benchmark";
    const jsonFlag = extractBooleanFlag(arguments_, "--json");
    const flags = parseValueFlags(
      jsonFlag.remaining,
      new Set([
        "input",
        capacityMode ? "workers" : "recipe",
        "warmup-runs",
        "measured-runs",
        "output",
        "release-version",
      ]),
    );
    const inputPath = flags.get("input");
    if (inputPath === undefined)
      throw new TypeError(`${command} requires --input`);
    if (capacityMode && flags.get("workers") !== "2")
      throw new TypeError("Windows capacity benchmark requires --workers 2");
    const recipeId = flags.get("recipe") ?? WORKER_RECIPE_IDS[0];
    if (!WORKER_RECIPE_IDS.includes(recipeId as WorkerRecipeId))
      throw new TypeError("Benchmark recipe is invalid");
    await service.assertPrivateInstallation();
    const request: WindowsFileBenchmarkRequest = {
      inputPath,
      ...(capacityMode
        ? { workers: 2 as const }
        : { recipeId: recipeId as WorkerRecipeId }),
      warmupRuns: Number(flags.get("warmup-runs") ?? "1"),
      measuredRuns: Number(flags.get("measured-runs") ?? "3"),
      ...(flags.has("output")
        ? { outputReportPath: flags.get("output")! }
        : {}),
      ...(flags.has("release-version")
        ? { releaseVersion: flags.get("release-version")! }
        : {}),
    };
    if (
      !Number.isSafeInteger(request.warmupRuns) ||
      request.warmupRuns < (capacityMode ? 1 : 0) ||
      request.warmupRuns > 2 ||
      !Number.isSafeInteger(request.measuredRuns) ||
      request.measuredRuns < 3 ||
      request.measuredRuns > 10
    )
      throw new TypeError(
        "Benchmark warm-up runs must be 0-2 and measured runs 3-10",
      );
    const result = await (
      context.benchmarkFile ??
      ((value) => benchmarkWindowsFile({ ...value, layout, service }))
    )(request);
    (context.stdout ?? console.log)(
      formatDetailedResult(
        capacityMode
          ? "MusicMute Two-worker Capacity Benchmark"
          : "MusicMute Worker File Benchmark",
        result,
        jsonFlag.present,
      ),
    );
    return typeof result === "object" &&
      result !== null &&
      "status" in result &&
      result.status === "FAIL"
      ? 2
      : 0;
  }
  if (isOperatorCommand(command)) {
    await service.assertPrivateInstallation();
    const run = () => runOperatorCommand(command, arguments_, layout, context);
    return command === "logs" && arguments_.includes("--clear")
      ? await (context.lock ?? withNativeLock)(layout.commandLockPath, run)
      : await run();
  }
  const allowed: Record<string, string[]> = {
    status: ["--local", "--watch", "--json"],
    start: ["--wait-ready", "--json"],
    stop: ["--force", "--json"],
    restart: ["--force", "--json"],
    pause: ["--json"],
    drain: ["--json"],
    resume: ["--json"],
  };
  if (
    allowed[command] === undefined ||
    new Set(arguments_).size !== arguments_.length ||
    arguments_.some((flag) => !allowed[command]!.includes(flag))
  )
    throw new TypeError("Unsupported Windows command or flags");
  const stdout = context.stdout ?? console.log;
  const report = (value: Record<string, unknown>) =>
    stdout(
      arguments_.includes("--json")
        ? JSON.stringify(value)
        : formatResult(value),
    );
  if (command === "status") {
    const read = () => readWindowsStatus(layout, service);
    if (arguments_.includes("--watch")) {
      const json = arguments_.includes("--json");
      await watchStatus(
        read,
        (value) => (json ? JSON.stringify(value) : formatResult(value)),
        stdout,
        json,
        context.wait,
      );
      return 0;
    }
    const status = await read();
    report(status);
    return status.healthy ? 0 : 1;
  }
  await service.assertPrivateInstallation();
  return await (context.lock ?? withNativeLock)(
    layout.commandLockPath,
    async () => {
      if (await windowsOperationPending(layout))
        throw new Error(
          "Windows maintenance recovery is required; run mw recover (supply --release-version if no active release exists)",
        );
      await requireConfig(layout.configPath);
      const native = await service.inspect();
      if (native.state === "absent")
        throw new Error("Windows worker service is not installed");
      if (native.state === "pending")
        throw new Error(
          "Windows service transition is in progress; retry after it finishes",
        );
      if (command === "start") {
        if (native.state !== "running") await service.start();
        const readiness = arguments_.includes("--wait-ready")
          ? (
              await waitForReady(
                () => readWindowsStatus(layout, service),
                context.wait,
                (status) =>
                  stdout(
                    arguments_.includes("--json")
                      ? JSON.stringify({
                          type: "readiness-update",
                          phase: status.readiness.phase,
                          blockers: status.readiness.blockers,
                        })
                      : `Waiting: ${status.readiness.phase}`,
                  ),
                context.readinessTimeoutMs,
                context.monotonicNow,
              )
            ).readiness
          : undefined;
        report({
          status: "ok",
          action: command,
          outcome:
            native.state === "running" ? "already-running" : "service-started",
          ...(readiness === undefined ? {} : { readiness }),
        });
        return 0;
      }
      const previous = await loadLocalLifecycle(layout.lifecyclePath);
      const intent =
        command === "pause"
          ? "paused"
          : command === "resume"
            ? "active"
            : "draining";
      const changed =
        previous.intent === intent
          ? previous
          : await setLocalLifecycleIntent(layout.lifecyclePath, intent);
      if (command === "pause" || command === "resume") {
        report({
          status: "ok",
          action: command,
          revision: changed.revision,
          outcome: changed === previous ? "already-set" : "intent-updated",
        });
        return 0;
      }
      try {
        const drainingNative = await service.inspect();
        if (drainingNative.state === "pending")
          throw new Error("Windows service transition is in progress");
        if (drainingNative.state === "running") {
          const snapshot = await loadLocalRuntimeStatus(
            layout.runtimeStatusPath,
          ).catch(() => null);
          if (
            !arguments_.includes("--force") &&
            (!snapshot || !currentRuntimeSnapshot(drainingNative, snapshot))
          )
            throw new Error(
              "Current Windows runtime status is unavailable; use --force only to interrupt the worker",
            );
          await waitForLocalDrain({
            runtimeStatusPath: layout.runtimeStatusPath,
            expectedRevision: changed.revision,
            force: arguments_.includes("--force"),
            ...(context.wait === undefined ? {} : { wait: context.wait }),
            ...(context.drainTimeoutMs === undefined
              ? {}
              : { timeoutMs: context.drainTimeoutMs }),
          });
        }
        if (command !== "drain") {
          await service.stop();
          if ((await service.inspect()).state !== "stopped")
            throw new Error("Windows service did not stop");
          if (command === "restart")
            await resetRestartBudget(
              join(layout.stateRoot, "restart-budget.json"),
            );
        }
      } finally {
        if (command !== "drain")
          await setLocalLifecycleIntent(layout.lifecyclePath, previous.intent);
      }
      if (command === "restart") await service.start();
      report({ status: "ok", action: command });
      return 0;
    },
  );
}

export async function readWindowsStatus(
  layout: WindowsServiceLayout,
  service: WindowsServiceActions,
) {
  const native = await service.inspect();
  if (native.state === "absent") {
    return {
      action: "status",
      status: "not-installed",
      healthy: false,
      maintenancePending: false,
      lifecycle: null,
      runtime: null,
      staleRuntimeStatus: false,
      readiness: {
        phase: "stopped",
        modelReady: false,
        blockers: ["not-installed"],
      },
    };
  }
  await service.assertPrivateInstallation();
  const lifecycle = await loadLocalLifecycle(layout.lifecyclePath);
  const snapshot = await loadLocalRuntimeStatus(layout.runtimeStatusPath).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    },
  );
  const sameProcess =
    snapshot !== null && currentRuntimeSnapshot(native, snapshot);
  const age =
    snapshot === null ? null : Date.now() - Date.parse(snapshot.updatedAt);
  const heartbeatStale = age !== null && (age > 180_000 || age < -30_000);
  const runtime = sameProcess && !heartbeatStale ? snapshot : null;
  const maintenancePending = await windowsOperationPending(layout);
  const healthy =
    native.state === "running" &&
    runtime?.childState === "ready" &&
    !maintenancePending;
  const blockers: string[] = [];
  if (native.state !== "running") blockers.push(`service-${native.state}`);
  if (maintenancePending) blockers.push("maintenance-recovery-required");
  if (snapshot === null) blockers.push("runtime-status-missing");
  else if (!sameProcess) blockers.push("runtime-process-mismatch");
  else if (heartbeatStale) blockers.push("runtime-heartbeat-stale");
  if (runtime && runtime.childState !== "ready")
    blockers.push(`child-${runtime.childState ?? "unknown"}`);
  const phase =
    native.state !== "running"
      ? "stopped"
      : maintenancePending
        ? "maintenance"
        : runtime === null
          ? "starting"
          : (runtime.childState ?? "starting");
  return {
    action: "status",
    status: native.state,
    healthy,
    maintenancePending,
    lifecycle,
    runtime,
    staleRuntimeStatus: snapshot !== null && runtime === null,
    readiness: { phase, modelReady: healthy, blockers },
  };
}

export function currentRuntimeSnapshot(
  service: WindowsServiceStatus,
  status: LocalRuntimeStatus,
): boolean {
  return (
    service.state === "running" &&
    service.runtimeProcessId !== null &&
    service.runtimeStartedAt !== null &&
    status.processId === service.runtimeProcessId &&
    Date.parse(status.updatedAt) >= Date.parse(service.runtimeStartedAt)
  );
}

async function requireConfig(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > 64 * 1024
  )
    throw new Error("Windows runtime config is unsafe");
  // Check the document without displaying its credential path or other data.
  const config = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  if (config.schemaVersion !== 1)
    throw new Error("Windows runtime config is invalid");
}

function formatResult(value: Record<string, unknown>): string {
  return Object.entries(value)
    .map(
      ([key, item]) =>
        `${key}: ${typeof item === "object" ? JSON.stringify(item) : String(item)}`,
    )
    .join("\n");
}

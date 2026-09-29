import { awaitUnpair } from "../shared/unpair.js";
import { formatHealth } from "../shared/user-health.js";
import { watchStatus, waitForReady } from "../shared/status-watch.js";
export { waitForReady } from "../shared/status-watch.js";
import { configureWorkerCapacity } from "../shared/worker-capacity.js";
import { dirname, join } from "node:path";
import { resetRestartBudget } from "../../runtime/restart-budget.js";
import { lstat, readFile, readlink, rm } from "node:fs/promises";
import { homedir } from "node:os";
import {
  initializeLocalLifecycle,
  loadLocalLifecycle,
  setLocalLifecycleIntent,
  type LocalLifecycleIntent,
} from "../../runtime/local-lifecycle.js";
import {
  MacLaunchAgentController,
  writeLaunchAgentPlist,
  type LaunchAgentStatus,
} from "./launch-agent.js";
import {
  createMacUserDirectories,
  createMacUserLayout,
  type MacUserLayout,
} from "./user-paths.js";
import {
  ControlPlaneError,
  WorkerControlPlaneClient,
  type WorkerMachineStatus,
} from "../../runtime/control-plane-client.js";
import { readMaintenanceConnection } from "../../runtime/runtime-config.js";
import { readHiddenTerminalLine } from "./secret-prompt.js";
import { WorkerEnrollmentError } from "../../enrollment/enrollment-client.js";
import {
  installMacUserWorker,
  readPendingMacUserEnrollmentCredential,
  recoverMacUserWorker,
  resumeMacUserInstallation,
  resetPendingMacUserEnrollment,
  type MacUserInstallationResult,
  type MacUserRecoveryResult,
} from "./user-installer.js";
import {
  checkMacUserUpdate,
  recoverInterruptedMacUpdate,
  updateMacUserWorker,
  type MacUserUpdateCheck,
} from "./user-updater.js";
import {
  benchmarkMacUserFile,
  benchmarkMacUserWorker,
} from "./user-benchmark.js";
import { waitForLocalDrain } from "../shared/local-drain.js";
import {
  loadLocalRuntimeStatus,
  writeLocalRuntimeStatus,
} from "../../runtime/local-runtime-status.js";
import { inspectMacUserHealth, type MacUserHealth } from "./user-health.js";
import { withMacUserCommandLock } from "./command-lock.js";
import {
  loadConfirmedUnpairReceipt,
  writeConfirmedUnpairReceipt,
} from "../shared/unpair-receipt.js";
import {
  inspectOperationalLogUsage,
  maintainWorkerLogs,
  parseSince,
} from "../shared/operational-logs.js";
import {
  isOperatorCommand,
  runOperatorCommand,
  type LogArguments,
} from "../shared/operator-cli.js";
import {
  exactArguments,
  extractBooleanFlag,
  parseValueFlags,
} from "../shared/cli-arguments.js";
import {
  formatActionResult,
  formatDetailedResult,
  appendDetails,
  formatJson,
  humanizeLabel,
} from "../shared/cli-format.js";
import {
  createMacDiagnosticBundle,
  type MacDiagnosticBundleResult,
} from "./diagnostic-bundle.js";
import {
  DEFAULT_MAC_RECIPE_ID,
  MAC_RECIPE_IDS,
  type MacRecipeId,
} from "./runtime-recipes.js";

interface MacUserHost {
  platform: NodeJS.Platform;
  arch: string;
  uid: number;
  home: string;
}

export const MAC_USER_USAGE = `Usage:
  mw --version [--json]
  mw install --label <name> [--group-id <id>] [--new-code] [--json]
  mw install [--json]  # recover a preserved paired installation
  mw status [--local] [--watch] [--json]
  mw start [--wait-ready] [--json]
  mw stop [--force] [--json]
  mw restart [--force] [--json]
  mw pause [--json]
  mw drain [--json]
  mw resume [--json]
  mw update [--check | --force] [--json]
  mw unpair [--force] [--json]
  mw uninstall [--purge] [--json]
  mw logs [--lines <1-1000>] [--events | --errors] [--follow]
                        [--attempt-id <id>] [--since <1s-30d>]
                        [--level <info|warning|error>] [--json]
  mw logs --clear [--json]
  mw job <job-id> [--json]
  mw errors [--since <1s-30d>] [--limit <1-100>] [--json]
  mw explain <code> [--since <1s-30d>] [--json]
  mw perf [--last <1-100>] [--since <1s-30d>] [--recipe <id>] [--json]
  mw diagnostics [--job <job-id>] [--since <1s-30d>]
                               [--output </absolute/path.zip>] [--json]
  mw doctor [--full] [--json]
  mw capacity --workers <1|2> [--json]
  mw benchmark [--workers <1|2>] [--json]
  mw benchmark-file --input </absolute/song> [--recipe <kim-vocals-v2|kim-vocals-v2-trim>]
                                  [--warmup-runs <0-2>] [--runs <3-10>] [--group-size <1|2|4>]
                                  [--candidate-engine </absolute/worker/engine>]
                                  [--report </absolute/report.json>] [--save-audio-dir </absolute/dir>]
                                  [--baseline-report </absolute/report.json>] [--json]`;

interface LaunchAgentActions {
  bootstrap(plistPath: string): Promise<void>;
  bootout(): Promise<void>;
  kickstart(): Promise<void>;
  status(): Promise<LaunchAgentStatus>;
}

export interface MacUserCommandContext {
  host?: { platform: NodeJS.Platform; arch: string; uid: number; home: string };
  layout?: MacUserLayout;
  launchAgent?: LaunchAgentActions;
  stdout?: (value: string) => void;
  unpair?: (force: boolean) => Promise<{ confirmed: true; machineId: string }>;
  wait?: (milliseconds: number) => Promise<void>;
  unpairTimeoutMs?: number;
  drainTimeoutMs?: number;
  readEnrollmentCode?: () => Promise<string>;
  install?: (input: {
    enrollmentCredential: string;
    label: string;
    groupId?: string;
  }) => Promise<MacUserInstallationResult>;
  recover?: () => Promise<MacUserRecoveryResult>;
  checkUpdate?: () => Promise<MacUserUpdateCheck>;
  update?: (force: boolean) => Promise<{
    status: "current" | "updated";
    releaseVersion: string;
    sequence: number;
  }>;
  benchmark?: (workers: 1 | 2) => Promise<unknown>;
  benchmarkFile?: (input: {
    inputPath: string;
    recipeId: MacRecipeId;
    warmupRuns: number;
    measuredRuns: number;
    groupSize: 1 | 2 | 4;
    candidateEngineRoot?: string;
    outputReportPath?: string;
    saveAudioDir?: string;
    baselineReportPath?: string;
    onProgress: (event: Record<string, unknown>) => void;
  }) => Promise<unknown>;
  health?: (depth?: "quick" | "full") => Promise<MacUserHealth>;
  remoteStatus?: () => Promise<WorkerMachineStatus>;
  preflight?: () => Promise<boolean>;
  diagnostics?: (
    outputPath?: string,
    jobId?: string,
    since?: number,
  ) => Promise<MacDiagnosticBundleResult>;
  followLogs?: (flags: LogArguments) => Promise<void>;
}

export async function runMacUserCommand(
  command: string,
  arguments_: readonly string[],
  context: MacUserCommandContext = {},
): Promise<number> {
  const host = context.host ?? {
    platform: process.platform,
    arch: process.arch,
    uid: process.getuid?.() ?? 0,
    home: homedir(),
  };
  assertSupportedHost(host);
  const layout = context.layout ?? createMacUserLayout(host.home);
  if (!mutatesLocalState(command, arguments_))
    return await runUnlocked(command, arguments_, context, host, layout);
  if (command === "install") await createMacUserDirectories(layout);
  else if (command === "unpair" || command === "uninstall")
    await requireManagedInstallation(layout);
  else await requireInstalled(layout);
  return await withMacUserCommandLock(
    layout.commandLockPath,
    async () => runUnlocked(command, arguments_, context, host, layout),
    command,
  );
}

async function runUnlocked(
  command: string,
  arguments_: readonly string[],
  context: MacUserCommandContext,
  host: MacUserHost,
  layout: MacUserLayout,
): Promise<number> {
  const launchAgent =
    context.launchAgent ?? new MacLaunchAgentController(host.uid);
  const stdout = context.stdout ?? console.log;

  if (isOperatorCommand(command))
    return await runOperatorCommand(command, arguments_, layout, context);

  switch (command) {
    case "install": {
      const newCodeFlag = extractBooleanFlag(arguments_, "--new-code");
      const jsonFlag = extractBooleanFlag(newCodeFlag.remaining, "--json");
      const flags = parseValueFlags(
        jsonFlag.remaining,
        new Set(["label", "group-id"]),
      );
      const resumed = await resumeMacUserInstallation({
        layout,
        uid: host.uid,
        launchAgent,
      });
      if (resumed !== null) {
        stdout(
          formatActionResult(
            { status: "ok", action: "recover", ...resumed },
            jsonFlag.present,
          ),
        );
        return 0;
      }
      if (await isRegularFile(layout.configPath)) {
        if (await pathExists(layout.currentLink))
          throw new Error(
            "MusicMute worker is already installed; use status, doctor, or update",
          );
        const result = await (
          context.recover ??
          (() =>
            recoverMacUserWorker({
              layout,
              uid: host.uid,
              launchAgent,
            }))
        )();
        stdout(
          formatActionResult(
            { status: "ok", action: "recover", ...result },
            jsonFlag.present,
          ),
        );
        return 0;
      }
      if (
        (await isRegularFile(layout.installationStatePath)) ||
        (await loadConfirmedUnpairReceipt(layout.unpairReceiptPath)) !== null
      )
        throw new Error(
          "Preserved unpaired MusicMute state requires uninstall --purge before fresh enrollment",
        );
      const label = flags.get("label");
      if (label === undefined) throw new TypeError("install requires --label");
      if (newCodeFlag.present) await resetPendingMacUserEnrollment(layout);
      const pendingCredential =
        await readPendingMacUserEnrollmentCredential(layout);
      const enrollmentCredential =
        pendingCredential ??
        (await (
          context.readEnrollmentCode ??
          (() => readHiddenTerminalLine("MusicMute one-use enrollment code: "))
        )());
      const install =
        context.install ??
        (async (input) =>
          await installMacUserWorker({
            layout,
            uid: host.uid,
            enrollmentCredential: input.enrollmentCredential,
            label: input.label,
            ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
            launchAgent,
          }));
      let result: MacUserInstallationResult;
      try {
        result = await install({
          enrollmentCredential,
          label,
          ...(flags.get("group-id") === undefined
            ? {}
            : { groupId: flags.get("group-id")! }),
        });
      } catch (error) {
        if (
          error instanceof WorkerEnrollmentError &&
          error.code === "WORKER_CONFLICT"
        )
          throw new Error(
            "Enrollment code conflicts with an earlier exchange. Create a new one-use code and retry install with --new-code.",
            { cause: error },
          );
        throw error;
      }
      stdout(
        formatActionResult(
          { status: "ok", action: "install", ...result },
          jsonFlag.present,
        ),
      );
      return 0;
    }
    case "status": {
      exactArguments(arguments_, new Set(["--local", "--watch", "--json"]));
      const localOnly = arguments_.includes("--local");
      const json = arguments_.includes("--json");
      const reader = () =>
        readStatus(layout, launchAgent, context.remoteStatus, { localOnly });
      if (arguments_.includes("--watch")) {
        await watchStatus(
          reader,
          (status) => formatStatus(status, json),
          stdout,
          json,
          context.wait,
        );
        return 0;
      }
      const status = await reader();
      stdout(formatStatus(status, json));
      return status.healthy ? 0 : 1;
    }
    case "start": {
      exactArguments(arguments_, new Set(["--wait-ready", "--json"]));
      await recoverInterruptedMacUpdate(layout, launchAgent);
      const result = await start(layout, launchAgent, context.preflight);
      let readiness: Awaited<ReturnType<typeof readStatus>> | null = null;
      if (arguments_.includes("--wait-ready")) {
        await waitForReady(
          () => readStatus(layout, launchAgent, undefined, { localOnly: true }),
          context.wait,
          (status) =>
            stdout(
              arguments_.includes("--json")
                ? JSON.stringify({
                    type: "readiness-update",
                    phase: status.readiness.phase,
                    blockers: status.readiness.blockers,
                  })
                : `Waiting: ${humanizeLabel(status.readiness.phase)}`,
            ),
        );
        readiness = await readStatus(layout, launchAgent, context.remoteStatus);
      }
      stdout(
        formatActionResult(
          {
            status: "ok",
            action: "start",
            outcome: result,
            ...(readiness === null ? {} : { readiness: readiness.readiness }),
          },
          arguments_.includes("--json"),
        ),
      );
      return 0;
    }
    case "stop": {
      exactArguments(arguments_, new Set(["--force", "--json"]));
      await gracefulStop(layout, launchAgent, arguments_.includes("--force"), {
        ...(context.wait === undefined ? {} : { wait: context.wait }),
        ...(context.drainTimeoutMs === undefined
          ? {}
          : { timeoutMs: context.drainTimeoutMs }),
      });
      stdout(
        formatActionResult(
          { status: "ok", action: "stop" },
          arguments_.includes("--json"),
        ),
      );
      return 0;
    }
    case "restart": {
      exactArguments(arguments_, new Set(["--force", "--json"]));
      await recoverInterruptedMacUpdate(layout, launchAgent);
      await gracefulStop(layout, launchAgent, arguments_.includes("--force"), {
        ...(context.wait === undefined ? {} : { wait: context.wait }),
        ...(context.drainTimeoutMs === undefined
          ? {}
          : { timeoutMs: context.drainTimeoutMs }),
      });
      await resetRestartBudget(
        join(dirname(layout.configPath), "restart-budget.json"),
      );
      await start(layout, launchAgent, context.preflight);
      stdout(
        formatActionResult(
          { status: "ok", action: "restart" },
          arguments_.includes("--json"),
        ),
      );
      return 0;
    }
    case "pause": {
      exactArguments(arguments_, new Set(["--json"]));
      return await transition(
        layout,
        launchAgent,
        "paused",
        stdout,
        arguments_.includes("--json"),
      );
    }
    case "drain": {
      exactArguments(arguments_, new Set(["--json"]));
      await requireInstalled(layout);
      const state = await setLocalLifecycleIntent(
        layout.lifecyclePath,
        "draining",
      );
      const service = await launchAgent.status();
      const drained = service.loaded
        ? await waitForLocalDrain({
            runtimeStatusPath: layout.runtimeStatusPath,
            expectedRevision: state.revision,
            force: false,
            ...(context.wait === undefined ? {} : { wait: context.wait }),
            ...(context.drainTimeoutMs === undefined
              ? {}
              : { timeoutMs: context.drainTimeoutMs }),
          })
        : { forced: false, activeAttempts: 0 };
      stdout(
        formatActionResult(
          {
            status: "ok",
            action: "draining",
            revision: state.revision,
            ...drained,
          },
          arguments_.includes("--json"),
        ),
      );
      return 0;
    }
    case "resume": {
      exactArguments(arguments_, new Set(["--json"]));
      await recoverInterruptedMacUpdate(layout, launchAgent);
      return await transition(
        layout,
        launchAgent,
        "active",
        stdout,
        arguments_.includes("--json"),
      );
    }
    case "update": {
      exactArguments(arguments_, new Set(["--check", "--force", "--json"]));
      if (arguments_.includes("--check") && arguments_.includes("--force"))
        throw new TypeError("update accepts either --check or --force");
      await requireInstalled(layout);
      if (arguments_.includes("--check")) {
        const checked = await (
          context.checkUpdate ?? (() => checkMacUserUpdate(layout))
        )();
        stdout(
          formatActionResult(
            {
              status: "ok",
              action: "update-check",
              currentVersion: checked.currentVersion,
              availableVersion: checked.availableVersion,
              sequence: checked.sequence,
              updateAvailable: checked.updateAvailable,
            },
            arguments_.includes("--json"),
          ),
        );
        return 0;
      }
      const result = await (
        context.update ??
        ((force: boolean) =>
          updateMacUserWorker({
            layout,
            uid: host.uid,
            force,
            launchAgent,
          }))
      )(arguments_.includes("--force"));
      stdout(
        formatActionResult(
          { action: "update", ...result },
          arguments_.includes("--json"),
        ),
      );
      return 0;
    }
    case "unpair": {
      exactArguments(arguments_, new Set(["--force", "--json"]));
      const replay = await loadConfirmedUnpairReceipt(layout.unpairReceiptPath);
      if (replay !== null) {
        if ((await launchAgent.status()).loaded) await launchAgent.bootout();
        await rm(layout.credentialPath, { force: true });
        await rm(layout.configPath, { force: true });
        stdout(
          formatActionResult(
            {
              status: "ok",
              action: "unpair",
              machineId: replay.machineId,
              confirmed: true,
              replayed: true,
            },
            arguments_.includes("--json"),
          ),
        );
        return 0;
      }
      await requireInstalled(layout);
      const force = arguments_.includes("--force");
      await setLocalLifecycleIntent(layout.lifecyclePath, "draining");
      if (force && (await launchAgent.status()).loaded)
        await launchAgent.bootout();
      const operation =
        context.unpair ??
        (async (forced: boolean) => {
          const config = await readMaintenanceConnection(layout.configPath);
          return await new WorkerControlPlaneClient({
            baseUrl: config.backendBaseUrl,
            credential: config.credential,
            allowInsecureLoopback: config.allowInsecureLoopback,
          }).unpair(forced);
        });
      const confirmation = await awaitUnpair(operation, force, {
        ...(context.wait === undefined ? {} : { wait: context.wait }),
        ...(context.unpairTimeoutMs === undefined
          ? {}
          : { timeoutMs: context.unpairTimeoutMs }),
      });
      if (!confirmation.confirmed)
        throw new Error("Backend did not confirm worker unpair");
      if ((await launchAgent.status()).loaded) await launchAgent.bootout();
      await writeConfirmedUnpairReceipt(
        layout.unpairReceiptPath,
        confirmation.machineId,
      );
      await rm(layout.credentialPath, { force: true });
      await rm(layout.configPath, { force: true });
      stdout(
        formatActionResult(
          {
            status: "ok",
            action: "unpair",
            machineId: confirmation.machineId,
            confirmed: true,
          },
          arguments_.includes("--json"),
        ),
      );
      return 0;
    }
    case "uninstall": {
      exactArguments(arguments_, new Set(["--purge", "--json"]));
      const purge = arguments_.includes("--purge");
      if (purge) {
        const receipt = await loadConfirmedUnpairReceipt(
          layout.unpairReceiptPath,
        );
        if (
          receipt === null ||
          (await isRegularFile(layout.credentialPath)) ||
          (await isRegularFile(layout.configPath))
        )
          throw new Error("Purge requires a backend-confirmed unpair first");
      }
      await gracefulStop(layout, launchAgent, false, {
        ...(context.wait === undefined ? {} : { wait: context.wait }),
        ...(context.drainTimeoutMs === undefined
          ? {}
          : { timeoutMs: context.drainTimeoutMs }),
      });
      await rm(layout.plistPath, { force: true });
      if (purge) await rm(layout.installRoot, { recursive: true, force: true });
      else await rm(layout.currentLink, { force: true });
      stdout(
        formatActionResult(
          {
            status: "ok",
            action: purge ? "purge" : "uninstall",
            preservedData: !purge,
          },
          arguments_.includes("--json"),
        ),
      );
      return 0;
    }
    case "diagnostics": {
      const jsonFlag = extractBooleanFlag(arguments_, "--json");
      const values = parseValueFlags(
        jsonFlag.remaining,
        new Set(["output", "job", "since"]),
      );
      const outputPath = values.get("output");
      const jobId = values.get("job");
      const since =
        values.get("since") === undefined
          ? undefined
          : parseSince(values.get("since")!);
      if (jobId !== undefined && !/^[0-9a-f]{24}$/iu.test(jobId))
        throw new TypeError("Diagnostic job ID must be 24 hex characters");
      const health = await (
        context.health ??
        ((depth = "full") =>
          inspectMacUserHealth(layout, launchAgent, { depth }))
      )("full");
      const status = await readStatus(
        layout,
        launchAgent,
        context.remoteStatus,
      );
      const diagnostics =
        context.diagnostics ??
        ((output?: string, selectedJobId?: string, selectedSince?: number) =>
          createMacDiagnosticBundle({
            layout,
            status,
            health,
            ...(output === undefined ? {} : { outputPath: output }),
            ...(selectedJobId === undefined ? {} : { jobId: selectedJobId }),
            ...(selectedSince === undefined ? {} : { since: selectedSince }),
          }));
      const result =
        jobId === undefined && since === undefined
          ? await diagnostics(outputPath)
          : await diagnostics(outputPath, jobId, since);
      stdout(
        jsonFlag.present
          ? formatJson(result)
          : `MusicMute Worker Diagnostics\n\nBundle: ${result.path}\nFiles: ${result.files.length}\nPrivacy: sanitized; credentials and configuration values excluded`,
      );
      return 0;
    }
    case "doctor": {
      exactArguments(arguments_, new Set(["--json", "--full"]));
      const depth = arguments_.includes("--full") ? "full" : "quick";
      const result = await (
        context.health ??
        ((selected = "quick") =>
          inspectMacUserHealth(layout, launchAgent, { depth: selected }))
      )(depth);
      stdout(formatHealth(result, arguments_.includes("--json")));
      return result.healthy ? 0 : 1;
    }
    case "capacity": {
      const jsonFlag = extractBooleanFlag(arguments_, "--json");
      const flags = parseValueFlags(jsonFlag.remaining, new Set(["workers"]));
      const workers = flags.get("workers");
      if (workers !== "1" && workers !== "2")
        throw new TypeError("capacity requires --workers 1 or 2");
      const result = await configureWorkerCapacity({
        configPath: layout.configPath,
        receiptPath: layout.capacityValidationPath,
        workers: Number(workers) as 1 | 2,
        requireStopped: async () => {
          const service = await launchAgent.status();
          if (service.loaded || service.running)
            throw new Error(
              "Drain and stop the worker before changing capacity",
            );
        },
      });
      stdout(formatActionResult(result, jsonFlag.present));
      return 0;
    }
    case "benchmark": {
      const jsonFlag = extractBooleanFlag(arguments_, "--json");
      const flags = parseValueFlags(jsonFlag.remaining, new Set(["workers"]));
      const workersValue = flags.get("workers") ?? "1";
      if (workersValue !== "1" && workersValue !== "2")
        throw new TypeError("Benchmark workers must be 1 or 2");
      const workers = Number(workersValue) as 1 | 2;
      await requireInstalled(layout);
      const result = await (
        context.benchmark ??
        ((selectedWorkers) =>
          benchmarkMacUserWorker({
            layout,
            uid: host.uid,
            launchAgent,
            workers: selectedWorkers,
          }))
      )(workers);
      stdout(
        formatDetailedResult(
          "MusicMute Worker Benchmark",
          result,
          jsonFlag.present,
        ),
      );
      return 0;
    }
    case "benchmark-file": {
      const jsonFlag = extractBooleanFlag(arguments_, "--json");
      const flags = parseValueFlags(
        jsonFlag.remaining,
        new Set([
          "input",
          "recipe",
          "warmup-runs",
          "runs",
          "group-size",
          "candidate-engine",
          "report",
          "save-audio-dir",
          "baseline-report",
        ]),
      );
      const inputPath = flags.get("input");
      if (inputPath === undefined)
        throw new TypeError("benchmark-file requires --input");
      const recipe = flags.get("recipe") ?? DEFAULT_MAC_RECIPE_ID;
      if (!MAC_RECIPE_IDS.includes(recipe as MacRecipeId))
        throw new TypeError(
          `benchmark-file recipe must be one of: ${MAC_RECIPE_IDS.join(", ")}`,
        );
      const warmupRuns = Number(flags.get("warmup-runs") ?? "1");
      const measuredRuns = Number(flags.get("runs") ?? "3");
      const groupSize = Number(flags.get("group-size") ?? "1");
      if (!Number.isSafeInteger(warmupRuns) || warmupRuns < 0 || warmupRuns > 2)
        throw new TypeError("benchmark-file warm-up runs must be 0-2");
      if (
        !Number.isSafeInteger(measuredRuns) ||
        measuredRuns < 3 ||
        measuredRuns > 10
      )
        throw new TypeError("benchmark-file measured runs must be 3-10");
      if (![1, 2, 4].includes(groupSize))
        throw new TypeError("benchmark-file window group must be 1, 2, or 4");
      await requireInstalled(layout);
      const result = await (
        context.benchmarkFile ??
        ((input) =>
          benchmarkMacUserFile({
            layout,
            uid: host.uid,
            launchAgent,
            ...input,
          }))
      )({
        inputPath,
        recipeId: recipe as MacRecipeId,
        warmupRuns,
        measuredRuns,
        groupSize: groupSize as 1 | 2 | 4,
        ...(flags.get("candidate-engine") === undefined
          ? {}
          : { candidateEngineRoot: flags.get("candidate-engine")! }),
        ...(flags.get("report") === undefined
          ? {}
          : { outputReportPath: flags.get("report")! }),
        ...(flags.get("save-audio-dir") === undefined
          ? {}
          : { saveAudioDir: flags.get("save-audio-dir")! }),
        ...(flags.get("baseline-report") === undefined
          ? {}
          : { baselineReportPath: flags.get("baseline-report")! }),
        onProgress: (event) =>
          stdout(
            jsonFlag.present
              ? formatJson({ type: "benchmark-progress", ...event })
              : `Benchmark: ${String(event.type ?? "progress")}${event.index ? ` run ${event.index}` : ""}${event.stage ? ` (${event.stage})` : ""}`,
          ),
      });
      stdout(
        formatDetailedResult(
          "MusicMute Worker File Benchmark",
          result,
          jsonFlag.present,
        ),
      );
      return 0;
    }
    default:
      throw new TypeError(`Unknown macOS user command: ${command}`);
  }
}

function mutatesLocalState(
  command: string,
  arguments_: readonly string[],
): boolean {
  if (command === "update" && arguments_.includes("--check")) return false;
  if (command === "logs" && arguments_.includes("--clear")) return true;
  return new Set([
    "install",
    "start",
    "stop",
    "restart",
    "pause",
    "drain",
    "resume",
    "update",
    "unpair",
    "uninstall",
    "benchmark",
    "benchmark-file",
    "capacity",
    "diagnostics",
  ]).has(command);
}

async function start(
  layout: MacUserLayout,
  launchAgent: LaunchAgentActions,
  preflight?: () => Promise<boolean>,
): Promise<"already-running" | "service-started"> {
  await requireInstalled(layout);
  const current = await launchAgent.status();
  if (current.running) return "already-running";
  await maintainWorkerLogs(layout);
  const healthy = await (
    preflight ??
    (async () =>
      (
        await inspectMacUserHealth(layout, launchAgent, {
          requireRunning: false,
        })
      ).healthy)
  )();
  if (!healthy) throw new Error("MusicMute worker failed start preflight");
  if (current.loaded) await launchAgent.kickstart();
  else await launchAgent.bootstrap(layout.plistPath);
  return "service-started";
}

async function transition(
  layout: MacUserLayout,
  launchAgent: LaunchAgentActions,
  intent: LocalLifecycleIntent,
  stdout: (value: string) => void,
  json: boolean,
): Promise<number> {
  await requireInstalled(layout);
  const previous = await loadLocalLifecycle(layout.lifecyclePath);
  const state =
    previous.intent === intent
      ? previous
      : await setLocalLifecycleIntent(layout.lifecyclePath, intent);
  const service = await launchAgent.status();
  stdout(
    formatActionResult(
      {
        status: "ok",
        action: intent,
        outcome: previous.intent === intent ? "already-set" : "intent-updated",
        revision: state.revision,
        serviceRunning: service.running,
      },
      json,
    ),
  );
  return 0;
}

export async function initializeMacUserServiceFiles(
  layout: MacUserLayout,
): Promise<void> {
  await createMacUserDirectories(layout);
  try {
    await loadLocalLifecycle(layout.lifecyclePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await initializeLocalLifecycle(layout.lifecyclePath);
  }
  await writeLocalRuntimeStatus(layout.runtimeStatusPath, []);
  await writeLaunchAgentPlist(layout);
}

async function gracefulStop(
  layout: MacUserLayout,
  launchAgent: LaunchAgentActions,
  force: boolean,
  options: {
    wait?: (milliseconds: number) => Promise<void>;
    timeoutMs?: number;
  },
): Promise<void> {
  await requireManagedInstallation(layout);
  const previous = await loadLocalLifecycle(layout.lifecyclePath);
  const draining = await setLocalLifecycleIntent(
    layout.lifecyclePath,
    "draining",
  );
  const service = await launchAgent.status();
  try {
    if (service.loaded) {
      if (service.running)
        await waitForLocalDrain({
          runtimeStatusPath: layout.runtimeStatusPath,
          expectedRevision: draining.revision,
          force,
          ...(options.wait === undefined ? {} : { wait: options.wait }),
          ...(options.timeoutMs === undefined
            ? {}
            : { timeoutMs: options.timeoutMs }),
        });
      await launchAgent.bootout();
    }
  } finally {
    await setLocalLifecycleIntent(layout.lifecyclePath, previous.intent);
  }
}

async function readStatus(
  layout: MacUserLayout,
  launchAgent: LaunchAgentActions,
  remoteStatus?: () => Promise<WorkerMachineStatus>,
  options: { localOnly?: boolean; now?: number } = {},
) {
  const now = options.now ?? Date.now();
  const installed = await isRegularFile(layout.configPath);
  const activeReleaseVersion = installed
    ? await readActiveReleaseVersion(layout)
    : null;
  const lifecycle = installed
    ? await loadLocalLifecycle(layout.lifecyclePath).catch(() => null)
    : null;
  const service = await launchAgent.status();
  const runtime = installed
    ? await loadLocalRuntimeStatus(layout.runtimeStatusPath).catch(() => null)
    : null;
  const update = installed
    ? await readOptionalBoundedJson(layout.updateStatePath)
    : null;
  const remote =
    installed && !options.localOnly
      ? await readRemoteStatus(layout, remoteStatus)
      : {
          available: false as const,
          state: null,
          checkedAt: null,
          errorCode: null,
        };
  const logs = installed
    ? await inspectOperationalLogUsage(layout).catch(() => null)
    : null;
  const heartbeatAgeMs = runtime
    ? Math.max(0, now - Date.parse(runtime.updatedAt))
    : null;
  const heartbeatStale = heartbeatAgeMs === null || heartbeatAgeMs > 180_000;
  const wrongProcess =
    service.running &&
    service.pid !== undefined &&
    runtime?.processId !== undefined &&
    service.pid !== runtime.processId;
  const identityUnverified =
    runtime !== null &&
    (runtime.sessionId === undefined ||
      runtime.incarnation === undefined ||
      (service.pid !== undefined && runtime.processId === undefined));
  const capacitySlots = runtime?.slots?.length ?? null;
  const capacityFull =
    capacitySlots !== null &&
    capacitySlots > 0 &&
    runtime!.activeAttemptIds.length >= capacitySlots;
  const diagnosticBlocked =
    runtime?.diagnostics?.blockedReason !== null &&
    runtime?.diagnostics?.blockedReason !== undefined
      ? runtime.diagnostics.blockedReason
      : logs?.diagnosticSpoolBlocked
        ? "diagnostic-marker-present"
        : null;
  const modelReady =
    installed &&
    service.running &&
    runtime !== null &&
    !heartbeatStale &&
    !wrongProcess &&
    !identityUnverified &&
    runtime.childState === "ready";
  const localReady =
    modelReady &&
    lifecycle?.intent === "active" &&
    !capacityFull &&
    diagnosticBlocked === null;
  const blockers: string[] = [];
  if (!installed) blockers.push("not-installed");
  if (!service.running) blockers.push("service-stopped");
  if (runtime === null) blockers.push("runtime-status-missing");
  else if (heartbeatStale) blockers.push("runtime-heartbeat-stale");
  if (wrongProcess) blockers.push("runtime-process-mismatch");
  if (identityUnverified) blockers.push("runtime-identity-unverified");
  if (lifecycle?.intent === "paused") blockers.push("local-paused");
  if (lifecycle?.intent === "draining") blockers.push("local-draining");
  if (runtime?.childState === "loading") blockers.push("model-loading");
  if (runtime?.childState === "warming") blockers.push("model-warming");
  if (runtime?.childState === "unavailable") blockers.push("child-unavailable");
  if (runtime !== null && runtime.childState === undefined)
    blockers.push("child-state-unknown");
  if (diagnosticBlocked !== null)
    blockers.push(`diagnostics-${diagnosticBlocked}`);
  if (capacityFull) blockers.push("capacity-full");
  if (!options.localOnly) {
    if (!remote.available) blockers.push("backend-unavailable");
    else {
      if (remote.state.status !== "active")
        blockers.push(`backend-${remote.state.status}`);
      if (!remote.state.claimsAllowed) blockers.push("backend-claims-disabled");
    }
  }
  const phase =
    !installed || !service.running
      ? "stopped"
      : lifecycle?.intent === "paused"
        ? "paused"
        : lifecycle?.intent === "draining"
          ? "draining"
          : heartbeatStale || wrongProcess
            ? "failed"
            : identityUnverified
              ? "starting"
              : runtime?.childState === "loading"
                ? "loading"
                : runtime?.childState === "warming"
                  ? "warming"
                  : runtime?.childState === "unavailable"
                    ? "recovering"
                    : (runtime?.activeAttemptIds.length ?? 0) > 0
                      ? "processing"
                      : runtime?.childState === "ready"
                        ? "ready"
                        : "starting";
  const claimEligible =
    options.localOnly || !remote.available
      ? null
      : localReady &&
        remote.state.status === "active" &&
        remote.state.claimsAllowed;
  return {
    schemaVersion: 2,
    installed,
    activeReleaseVersion,
    lifecycle: lifecycle?.intent ?? "unknown",
    service,
    runtime: {
      activeAttempts: runtime?.activeAttemptIds.length ?? null,
      currentAttempts: (runtime?.currentAttempts ?? []).map((attempt) => ({
        ...attempt,
        stageElapsedMs: attempt.stageStartedAt
          ? Math.max(0, now - Date.parse(attempt.stageStartedAt))
          : null,
        lastProgressAgeMs: attempt.lastProgressAt
          ? Math.max(0, now - Date.parse(attempt.lastProgressAt))
          : null,
      })),
      childState: runtime?.childState ?? "unknown",
      sessionId: runtime?.sessionId ?? null,
      incarnation: runtime?.incarnation ?? null,
      processId: runtime?.processId ?? null,
      slots: runtime?.slots ?? [],
      cachedPolicy: runtime?.cachedPolicy ?? null,
      cachedPolicyAgeMs: runtime?.cachedPolicy
        ? Math.max(0, now - Date.parse(runtime.cachedPolicy.observedAt))
        : null,
      diagnostics: runtime?.diagnostics ?? null,
      lastSuccessfulJob: runtime?.lastSuccessfulJob ?? null,
      lastFailedJob: runtime?.lastFailedJob ?? null,
      updatedAt: runtime?.updatedAt ?? null,
    },
    logs,
    telemetry: { gpuMemoryBytes: null, note: "not-sampled" },
    update,
    remote,
    readiness: {
      phase,
      modelReady,
      localReady,
      claimEligible,
      blockers,
      heartbeatAgeMs,
      progressStale: (runtime?.currentAttempts ?? []).some(
        (attempt) =>
          attempt.lastProgressAt !== undefined &&
          now - Date.parse(attempt.lastProgressAt) > 300_000,
      ),
    },
    effectiveClaimsAllowed: claimEligible === true,
    healthy:
      installed &&
      lifecycle !== null &&
      runtime !== null &&
      service.loaded &&
      service.running &&
      modelReady &&
      diagnosticBlocked === null &&
      (options.localOnly || remote.available),
  };
}

async function readActiveReleaseVersion(
  layout: MacUserLayout,
): Promise<string | null> {
  try {
    const info = await lstat(layout.currentLink);
    if (!info.isSymbolicLink()) return null;
    const target = await readlink(layout.currentLink);
    const match = /^releases\/([A-Za-z0-9][A-Za-z0-9._+-]{0,63})$/u.exec(
      target,
    );
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function readRemoteStatus(
  layout: MacUserLayout,
  remoteStatus?: () => Promise<WorkerMachineStatus>,
): Promise<
  | {
      available: true;
      state: WorkerMachineStatus;
      checkedAt: string;
      errorCode: null;
    }
  | {
      available: false;
      state: null;
      checkedAt: string;
      errorCode: string;
    }
> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const request = (
      remoteStatus ??
      (async () => {
        const config = await readMaintenanceConnection(layout.configPath);
        return await new WorkerControlPlaneClient({
          baseUrl: config.backendBaseUrl,
          credential: config.credential,
          allowInsecureLoopback: config.allowInsecureLoopback,
        }).machineStatus(controller.signal);
      })
    )();
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Backend status timed out"));
      }, 15_000);
    });
    const state = await Promise.race([request, timeout]);
    return {
      available: true,
      state,
      checkedAt: new Date().toISOString(),
      errorCode: null,
    };
  } catch (error) {
    return {
      available: false,
      state: null,
      checkedAt: new Date().toISOString(),
      errorCode:
        error instanceof ControlPlaneError ? error.code : "BACKEND_UNAVAILABLE",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readOptionalBoundedJson(path: string): Promise<unknown | null> {
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size < 2 ||
      info.size > 64 * 1024 ||
      (info.mode & 0o077) !== 0
    )
      return null;
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function requireInstalled(layout: MacUserLayout): Promise<void> {
  if (!(await isRegularFile(layout.configPath)))
    throw new Error("MusicMute worker is not installed for this user");
}

async function requireManagedInstallation(
  layout: MacUserLayout,
): Promise<void> {
  if (
    !(await isRegularFile(layout.configPath)) &&
    !(await isRegularFile(layout.installationStatePath)) &&
    (await loadConfirmedUnpairReceipt(layout.unpairReceiptPath)) === null
  )
    throw new Error("MusicMute worker is not installed for this user");
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertSupportedHost(host: {
  platform: NodeJS.Platform;
  arch: string;
  uid: number;
}): void {
  if (host.platform !== "darwin" || host.arch !== "arm64")
    throw new TypeError("macOS user commands require Apple Silicon macOS");
  if (!Number.isSafeInteger(host.uid) || host.uid <= 0)
    throw new TypeError("macOS user commands must not run as root");
}

function formatStatus(
  status: Awaited<ReturnType<typeof readStatus>>,
  json: boolean,
): string {
  if (json) return formatJson(status);
  const service = status.service.running
    ? `Running${status.service.pid === undefined ? "" : ` (PID ${status.service.pid})`}`
    : status.service.loaded
      ? "Loaded, but not running"
      : "Stopped";
  const lines = [
    "MusicMute Worker Status",
    "",
    `Overall: ${status.healthy ? "Healthy" : "Needs attention"}`,
    `Installation: ${status.installed ? "Installed" : "Not installed"}`,
    `Active release: ${status.activeReleaseVersion ?? "Not available"}`,
    `Local state: ${humanizeLabel(status.lifecycle)}`,
    `Service: ${service}`,
    `Phase: ${humanizeLabel(status.readiness.phase)}`,
    `Active jobs: ${status.runtime.activeAttempts ?? "Unknown"}`,
    `Processing child: ${humanizeLabel(status.runtime.childState)}`,
    "GPU memory: Unknown (not sampled)",
    `Model ready: ${status.readiness.modelReady ? "Yes" : "No"}`,
    `Locally ready for a claim: ${status.readiness.localReady ? "Yes" : "No"}`,
    `Eligible to claim: ${status.readiness.claimEligible === null ? "Unknown" : status.readiness.claimEligible ? "Yes" : "No"}`,
    `Dashboard: ${status.remote.checkedAt === null ? "Not checked" : status.remote.available ? "Connected" : "Unavailable"}`,
  ];
  if (status.readiness.blockers.length > 0)
    lines.push(`Blockers: ${status.readiness.blockers.join(", ")}`);
  if (status.service.detail !== undefined)
    lines.push(`Service detail: ${status.service.detail}`);
  if (status.remote.available) {
    lines.push(
      `Machine state: ${humanizeLabel(status.remote.state.status)}`,
      `Machine ID: ${status.remote.state.machineId}`,
      `Group: ${status.remote.state.groupId ?? "Not assigned"}`,
      `Policy revision: ${status.remote.state.policyRevision}`,
      `Last contact: ${status.remote.state.lastSeenAt ?? "Not available"}`,
    );
  }
  if (status.runtime.updatedAt !== null)
    lines.push(
      `Runtime heartbeat: ${status.runtime.updatedAt} (${formatAge(status.readiness.heartbeatAgeMs)} ago)`,
    );
  if (status.runtime.cachedPolicy !== null)
    lines.push(
      `Cached policy: ${humanizeLabel(status.runtime.cachedPolicy.machineStatus)} (${formatAge(status.runtime.cachedPolicyAgeMs)} old; not a live connection)`,
    );
  if (status.runtime.slots.length > 0)
    lines.push(
      `GPU slots: ${status.runtime.slots.map((slot) => `${slot.provider}:${slot.gpuId}`).join(", ")}`,
    );
  for (const attempt of status.runtime.currentAttempts)
    lines.push(
      `Current job: ${attempt.jobId} (attempt ${attempt.attemptId}, worker ${attempt.workerId})`,
      `  Stage: ${attempt.stage ?? "Unknown"} (${formatAge(attempt.stageElapsedMs)} elapsed; last progress ${formatAge(attempt.lastProgressAgeMs)} ago)`,
      ...(attempt.work === undefined
        ? []
        : [
            `  Observed work: ${attempt.work.completed}/${attempt.work.total} ${attempt.work.unit}`,
          ]),
    );
  if (status.readiness.progressStale)
    lines.push("Warning: processing progress has not changed for five minutes");
  if (status.runtime.lastSuccessfulJob !== null)
    lines.push(
      `Last successful job: ${status.runtime.lastSuccessfulJob.jobId} at ${status.runtime.lastSuccessfulJob.at}`,
    );
  if (status.runtime.lastFailedJob !== null)
    lines.push(
      `Last failed job: ${status.runtime.lastFailedJob.jobId} (${status.runtime.lastFailedJob.code}) at ${status.runtime.lastFailedJob.at}`,
    );
  if (status.logs !== null)
    lines.push(
      `Log storage: ${formatBytes(status.logs.bytes)} in ${status.logs.files} files`,
      `Diagnostic spool: ${status.logs.diagnosticSpoolBlocked ? "Blocked" : "Ready"}`,
    );
  if (status.update !== null) {
    lines.push("", "Update:");
    appendDetails(lines, status.update, 2);
  }
  return lines.join("\n");
}

function formatAge(milliseconds: number | null): string {
  if (milliseconds === null) return "unknown";
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${Math.floor(milliseconds / 1_000)} s`;
  return `${Math.floor(milliseconds / 60_000)} min`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

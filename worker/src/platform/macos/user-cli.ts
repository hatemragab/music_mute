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
import { loadRuntimeConfig } from "../../runtime/runtime-config.js";
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
import { waitForLocalDrain } from "./local-drain.js";
import {
  loadLocalRuntimeStatus,
  writeLocalRuntimeStatus,
} from "../../runtime/local-runtime-status.js";
import { inspectMacUserHealth, type MacUserHealth } from "./user-health.js";
import {
  explainError,
  investigateErrors,
  investigateJob,
} from "./investigation.js";
import { queryPerformanceReport } from "./performance-report.js";
import { withMacUserCommandLock } from "./command-lock.js";
import {
  loadConfirmedUnpairReceipt,
  writeConfirmedUnpairReceipt,
} from "./unpair-receipt.js";
import {
  formatOperationalEvent,
  createOperationalLogCursor,
  clearMacUserLogs,
  inspectOperationalLogUsage,
  maintainMacUserLogs,
  parseSince,
  readOperationalEvents,
  readNewOperationalEvents,
  readNewTextLog,
  readTextLogTail,
  type OperationalLogLevel,
} from "./operational-logs.js";
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
        await watchStatus(reader, stdout, json, context.wait);
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
          const config = await loadRuntimeConfig(layout.configPath);
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
    case "logs": {
      const flags = parseLogArguments(arguments_);
      if (flags.clear) {
        const result = await clearMacUserLogs(layout);
        stdout(
          formatActionResult(
            { status: "ok", action: "logs-cleared", ...result },
            flags.json,
          ),
        );
        return 0;
      }
      await maintainMacUserLogs(layout);
      if (flags.follow) {
        await (
          context.followLogs ?? ((value) => followLogs(layout, value, stdout))
        )(flags);
        return 0;
      }
      stdout(await renderLogs(layout, flags));
      return 0;
    }
    case "job": {
      const [jobId, ...flags] = arguments_;
      if (jobId === undefined) throw new TypeError("job requires a job ID");
      exactArguments(flags, new Set(["--json"]));
      const result = await investigateJob(layout, jobId);
      stdout(
        formatDetailedResult(
          "MusicMute Worker Job",
          result,
          flags.includes("--json"),
        ),
      );
      return result.foundLocally ? 0 : 2;
    }
    case "errors": {
      const jsonFlag = extractBooleanFlag(arguments_, "--json");
      const flags = parseValueFlags(
        jsonFlag.remaining,
        new Set(["since", "limit"]),
      );
      const since = parseSince(flags.get("since") ?? "7d");
      const limit = Number(flags.get("limit") ?? "100");
      const result = await investigateErrors(layout, since, limit);
      stdout(
        formatDetailedResult(
          "MusicMute Worker Errors",
          result,
          jsonFlag.present,
        ),
      );
      return 0;
    }
    case "explain": {
      const [code, ...rest] = arguments_;
      if (code === undefined)
        throw new TypeError("explain requires an error code");
      const jsonFlag = extractBooleanFlag(rest, "--json");
      const flags = parseValueFlags(jsonFlag.remaining, new Set(["since"]));
      const result = await explainError(
        layout,
        code,
        parseSince(flags.get("since") ?? "7d"),
      );
      stdout(
        formatDetailedResult(
          "MusicMute Worker Error Explanation",
          result,
          jsonFlag.present,
        ),
      );
      return 0;
    }
    case "perf": {
      const jsonFlag = extractBooleanFlag(arguments_, "--json");
      const flags = parseValueFlags(
        jsonFlag.remaining,
        new Set(["last", "since", "recipe"]),
      );
      const last = Number(flags.get("last") ?? "20");
      const since = flags.get("since");
      const recipeId = flags.get("recipe");
      const result = await queryPerformanceReport(layout, {
        last,
        ...(since === undefined ? {} : { since: parseSince(since) }),
        ...(recipeId === undefined ? {} : { recipeId }),
      });
      stdout(
        formatDetailedResult(
          "MusicMute Worker Performance",
          result,
          jsonFlag.present,
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

async function watchStatus(
  read: () => Promise<Awaited<ReturnType<typeof readStatus>>>,
  stdout: (value: string) => void,
  json: boolean,
  wait?: (milliseconds: number) => Promise<void>,
): Promise<void> {
  let stopped = false;
  let previous = "";
  let wakeStop: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    stopped = true;
    wakeStop?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopped) {
      const status = await read();
      const rendered = formatStatus(status, json);
      if (json || rendered !== previous) stdout(rendered);
      previous = rendered;
      if (stopped) break;
      const pause = wait
        ? wait(2_000)
        : new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 2_000);
          });
      await Promise.race([
        pause,
        new Promise<void>((resolve) => {
          wakeStop = resolve;
        }),
      ]);
      if (timer) clearTimeout(timer);
      timer = undefined;
      wakeStop = undefined;
    }
  } finally {
    if (timer) clearTimeout(timer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

export async function waitForReady(
  read: () => Promise<Awaited<ReturnType<typeof readStatus>>>,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  onPhase?: (status: Awaited<ReturnType<typeof readStatus>>) => void,
  timeoutMs = 360_000,
  now: () => number = Date.now,
): Promise<Awaited<ReturnType<typeof readStatus>>> {
  const deadline = now() + timeoutMs;
  let previousPhase = "";
  while (true) {
    const status = await read();
    if (status.readiness.phase !== previousPhase) {
      onPhase?.(status);
      previousPhase = status.readiness.phase;
    }
    if (status.readiness.modelReady) return status;
    if (now() >= deadline)
      throw new Error(
        `Worker did not become model-ready within ${timeoutMs / 1_000} seconds: ${status.readiness.blockers.join(", ")}`,
      );
    await wait(Math.min(2_000, deadline - now()));
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
    "diagnostics",
  ]).has(command);
}

async function awaitUnpair(
  operation: (
    force: boolean,
  ) => Promise<{ confirmed: true; machineId: string }>,
  force: boolean,
  options: {
    wait?: (milliseconds: number) => Promise<void>;
    timeoutMs?: number;
  },
): Promise<{ confirmed: true; machineId: string }> {
  const wait =
    options.wait ??
    (async (milliseconds: number) =>
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const started = Date.now();
  while (true) {
    try {
      return await operation(force);
    } catch (error) {
      if (
        force ||
        !(error instanceof ControlPlaneError) ||
        error.code !== "WORKER_CONFLICT" ||
        Date.now() - started >= timeoutMs
      )
        throw error;
      await wait(Math.min(5_000, timeoutMs - (Date.now() - started)));
    }
  }
}

async function start(
  layout: MacUserLayout,
  launchAgent: LaunchAgentActions,
  preflight?: () => Promise<boolean>,
): Promise<"already-running" | "service-started"> {
  await requireInstalled(layout);
  const current = await launchAgent.status();
  if (current.running) return "already-running";
  await maintainMacUserLogs(layout);
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
  await setLocalLifecycleIntent(layout.lifecyclePath, "draining");
  const service = await launchAgent.status();
  try {
    if (service.loaded) {
      if (service.running)
        await waitForLocalDrain({
          runtimeStatusPath: layout.runtimeStatusPath,
          force,
          ...(options.wait === undefined ? {} : { wait: options.wait }),
          ...(options.timeoutMs === undefined
            ? {}
            : { timeoutMs: options.timeoutMs }),
        });
      await launchAgent.bootout();
      await waitForLaunchAgentUnload(launchAgent, options.wait);
    }
  } finally {
    await setLocalLifecycleIntent(layout.lifecyclePath, previous.intent);
  }
}

async function waitForLaunchAgentUnload(
  launchAgent: LaunchAgentActions,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!(await launchAgent.status()).loaded) return;
    await wait(100);
  }
  throw new Error("MusicMute worker service did not unload");
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
        const config = await loadRuntimeConfig(layout.configPath);
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
      }, 2_500);
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

interface LogArguments {
  lines: number;
  json: boolean;
  events: boolean;
  errors: boolean;
  follow: boolean;
  clear: boolean;
  attemptId?: string;
  since?: number;
  level?: OperationalLogLevel;
}

function parseLogArguments(arguments_: readonly string[]): LogArguments {
  let lines = 100;
  let json = false;
  let events = false;
  let errors = false;
  let follow = false;
  let clear = false;
  let attemptId: string | undefined;
  let since: number | undefined;
  let level: OperationalLogLevel | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const current = arguments_[index];
    if (current === "--json") json = true;
    else if (current === "--events") events = true;
    else if (current === "--errors") errors = true;
    else if (current === "--follow") follow = true;
    else if (current === "--clear") clear = true;
    else if (current === "--lines") {
      const value = Number(arguments_[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 1000)
        throw new TypeError("Log line count must be between 1 and 1000");
      lines = value;
      index += 1;
    } else if (current === "--attempt-id") {
      const value = arguments_[index + 1];
      if (!value || !/^[0-9a-f-]{36}$/iu.test(value))
        throw new TypeError("--attempt-id must be a UUID");
      attemptId = value;
      index += 1;
    } else if (current === "--since") {
      const value = arguments_[index + 1];
      if (!value) throw new TypeError("--since requires a duration");
      since = parseSince(value);
      index += 1;
    } else if (current === "--level") {
      const value = arguments_[index + 1];
      if (!value || !["info", "warning", "error"].includes(value))
        throw new TypeError("--level must be info, warning, or error");
      level = value as OperationalLogLevel;
      index += 1;
    } else throw new TypeError(`Unknown logs argument: ${current}`);
  }
  if (events && errors)
    throw new TypeError("logs accepts either --events or --errors");
  if (
    clear &&
    (events ||
      errors ||
      follow ||
      attemptId !== undefined ||
      since !== undefined ||
      level !== undefined ||
      arguments_.includes("--lines"))
  )
    throw new TypeError("logs --clear cannot be combined with viewing options");
  if (
    (attemptId !== undefined || since !== undefined || level !== undefined) &&
    !events &&
    !errors
  )
    throw new TypeError("Log filters require --events or --errors");
  return {
    lines,
    json,
    events,
    errors,
    follow,
    clear,
    ...(attemptId === undefined ? {} : { attemptId }),
    ...(since === undefined ? {} : { since }),
    ...(level === undefined ? {} : { level }),
  };
}

async function renderLogs(
  layout: MacUserLayout,
  flags: LogArguments,
): Promise<string> {
  if (flags.events || flags.errors) {
    const events = await readOperationalEvents(layout, {
      lines: flags.lines,
      errorsOnly: flags.errors,
      ...(flags.attemptId === undefined ? {} : { attemptId: flags.attemptId }),
      ...(flags.since === undefined ? {} : { since: flags.since }),
      ...(flags.level === undefined ? {} : { level: flags.level }),
    });
    const hasStructuredFilter =
      flags.attemptId !== undefined ||
      flags.since !== undefined ||
      flags.level !== undefined;
    const stderr =
      flags.errors && !hasStructuredFilter
        ? await readTextLogTail(layout.stderrPath, flags.lines)
        : "";
    if (flags.json)
      return formatJson({ events, ...(stderr ? { stderr } : {}) });
    const title = flags.errors ? "Worker errors" : "Worker events";
    return [
      `== ${title} ==`,
      ...events.map(formatOperationalEvent),
      ...(stderr ? ["", "== worker stderr ==", stderr] : []),
    ].join("\n");
  }
  const logs = {
    stdout: await readTextLogTail(layout.stdoutPath, flags.lines),
    stderr: await readTextLogTail(layout.stderrPath, flags.lines),
  };
  return flags.json
    ? formatJson(logs)
    : `== worker stdout ==\n${logs.stdout}\n== worker stderr ==\n${logs.stderr}`;
}

async function followLogs(
  layout: MacUserLayout,
  flags: LogArguments,
  stdout: (value: string) => void,
): Promise<void> {
  const eventCursor = createOperationalLogCursor();
  const stdoutCursor = createOperationalLogCursor();
  const stderrCursor = createOperationalLogCursor();
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopped) {
      if (flags.events || flags.errors) {
        const events = await readNewOperationalEvents(
          layout,
          {
            lines: flags.lines,
            errorsOnly: flags.errors,
            ...(flags.attemptId === undefined
              ? {}
              : { attemptId: flags.attemptId }),
            ...(flags.since === undefined ? {} : { since: flags.since }),
            ...(flags.level === undefined ? {} : { level: flags.level }),
          },
          eventCursor,
        );
        for (const event of events)
          stdout(
            flags.json ? JSON.stringify(event) : formatOperationalEvent(event),
          );
        if (
          flags.errors &&
          flags.attemptId === undefined &&
          flags.since === undefined &&
          flags.level === undefined
        ) {
          const stderr = await readNewTextLog(layout.stderrPath, stderrCursor);
          if (stderr)
            stdout(
              flags.json
                ? JSON.stringify({ stream: "stderr", text: stderr })
                : `== worker stderr ==\n${stderr}`,
            );
        }
      } else {
        const normal = await readNewTextLog(layout.stdoutPath, stdoutCursor);
        const errors = await readNewTextLog(layout.stderrPath, stderrCursor);
        if (normal)
          stdout(
            flags.json
              ? JSON.stringify({ stream: "stdout", text: normal })
              : `== worker stdout ==\n${normal}`,
          );
        if (errors)
          stdout(
            flags.json
              ? JSON.stringify({ stream: "stderr", text: errors })
              : `== worker stderr ==\n${errors}`,
          );
      }
      await maintainMacUserLogs(layout);
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function extractBooleanFlag(
  arguments_: readonly string[],
  flag: string,
): { present: boolean; remaining: string[] } {
  const count = arguments_.filter((argument) => argument === flag).length;
  if (count > 1) throw new TypeError(`Command flag ${flag} is duplicated`);
  return {
    present: count === 1,
    remaining: arguments_.filter((argument) => argument !== flag),
  };
}

function parseValueFlags(
  arguments_: readonly string[],
  allowed: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  if (arguments_.length % 2 !== 0)
    throw new TypeError("Command flag is missing a value");
  const result = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index]!;
    const value = arguments_[index + 1]!;
    if (!flag.startsWith("--") || !allowed.has(flag.slice(2)))
      throw new TypeError(`Unknown command flag: ${flag}`);
    if (value.length < 1 || value.startsWith("--"))
      throw new TypeError(`Command flag ${flag} has an invalid value`);
    if (result.has(flag.slice(2)))
      throw new TypeError(`Command flag ${flag} is duplicated`);
    result.set(flag.slice(2), value);
  }
  return result;
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

function exactArguments(
  arguments_: readonly string[],
  allowed: ReadonlySet<string>,
): void {
  if (new Set(arguments_).size !== arguments_.length)
    throw new TypeError("Command arguments contain duplicates");
  if (arguments_.some((argument) => !allowed.has(argument)))
    throw new TypeError("Command contains an unknown argument");
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

function formatHealth(health: MacUserHealth, json: boolean): string {
  if (json) return formatJson(health);
  const passed = health.checks.filter((check) => check.ok).length;
  const failed = health.checks.filter(
    (check) =>
      !check.ok && check.status !== "not-run" && check.status !== "warning",
  ).length;
  const skipped = health.checks.filter(
    (check) => check.status === "not-run",
  ).length;
  const lines = [
    "MusicMute Worker Doctor",
    "",
    `Overall: ${health.healthy ? "Healthy" : "Problems found"}`,
    `Checks: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} not run` : ""}`,
    "",
  ];
  for (const check of health.checks) {
    lines.push(
      `[${check.status === "not-run" ? "NOT RUN" : check.ok ? "PASS" : "FAIL"}] ${humanizeLabel(check.name)}`,
      `       ${check.path}`,
    );
    if (check.code) lines.push(`       ${check.code}: ${check.evidence ?? ""}`);
    if (!check.ok && check.nextAction)
      lines.push(`       Next: ${check.nextAction}`);
  }
  return lines.join("\n");
}

function formatActionResult(
  value: Record<string, unknown>,
  json: boolean,
): string {
  if (json) return formatJson(value);
  const action =
    typeof value.action === "string" ? humanizeLabel(value.action) : "Command";
  const result =
    value.status === "ok"
      ? "Success"
      : typeof value.status === "string"
        ? humanizeLabel(value.status)
        : "Success";
  const lines = [`MusicMute Worker ${action}`, "", `Result: ${result}`];
  appendDetails(
    lines,
    {
      ...value,
      ...(typeof value.outcome === "string"
        ? { outcome: humanizeLabel(value.outcome) }
        : {}),
    },
    0,
    new Set(["action", "schemaVersion", "status"]),
  );
  return lines.join("\n");
}

function formatDetailedResult(
  title: string,
  value: unknown,
  json: boolean,
): string {
  if (json) return formatJson(value);
  const lines = [title, ""];
  appendDetails(lines, value);
  return lines.join("\n");
}

function appendDetails(
  lines: string[],
  value: unknown,
  indent = 0,
  omittedKeys: ReadonlySet<string> = new Set(),
): void {
  const padding = " ".repeat(indent);
  if (!isRecord(value)) {
    lines.push(`${padding}${formatScalar(value)}`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (omittedKeys.has(key)) continue;
    const label = humanizeLabel(key);
    if (isRecord(child)) {
      lines.push(`${padding}${label}:`);
      appendDetails(lines, child, indent + 2);
    } else if (Array.isArray(child)) {
      lines.push(`${padding}${label}:`);
      if (child.length === 0) lines.push(`${padding}  None`);
      else {
        for (const item of child) {
          if (isRecord(item)) {
            lines.push(`${padding}  -`);
            appendDetails(lines, item, indent + 4);
          } else lines.push(`${padding}  - ${formatScalar(item)}`);
        }
      }
    } else lines.push(`${padding}${label}: ${formatScalar(child)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "Not available";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  return formatJson(value);
}

function formatJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new TypeError("Command result is not serializable");
  return encoded;
}

function humanizeLabel(value: string): string {
  const acronyms: Readonly<Record<string, string>> = {
    api: "API",
    cpu: "CPU",
    ffmpeg: "FFmpeg",
    ffprobe: "FFprobe",
    gpu: "GPU",
    id: "ID",
    pid: "PID",
    sha256: "SHA-256",
    url: "URL",
  };
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[\s_-]+/u)
    .filter(Boolean)
    .map((word) =>
      acronyms[word.toLowerCase()] === undefined
        ? `${word.charAt(0).toUpperCase()}${word.slice(1)}`
        : acronyms[word.toLowerCase()]!,
    )
    .join(" ");
}

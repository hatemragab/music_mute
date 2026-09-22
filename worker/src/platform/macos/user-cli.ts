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
import {
  installMacUserWorker,
  readPendingMacUserEnrollmentCredential,
  recoverMacUserWorker,
  type MacUserInstallationResult,
  type MacUserRecoveryResult,
} from "./user-installer.js";
import {
  checkMacUserUpdate,
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
import { withMacUserCommandLock } from "./command-lock.js";
import {
  loadConfirmedUnpairReceipt,
  writeConfirmedUnpairReceipt,
} from "./unpair-receipt.js";
import {
  formatOperationalEvent,
  clearMacUserLogs,
  inspectOperationalLogUsage,
  maintainMacUserLogs,
  parseSince,
  readOperationalEvents,
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
  musicmute-worker install --label <name> [--group-id <id>] [--json]
  musicmute-worker install [--json]  # recover a preserved paired installation
  musicmute-worker status [--json]
  musicmute-worker start [--json]
  musicmute-worker stop [--force] [--json]
  musicmute-worker restart [--force] [--json]
  musicmute-worker pause [--json]
  musicmute-worker drain [--json]
  musicmute-worker resume [--json]
  musicmute-worker update [--check | --force] [--json]
  musicmute-worker unpair [--force] [--json]
  musicmute-worker uninstall [--purge] [--json]
  musicmute-worker logs [--lines <1-1000>] [--events | --errors] [--follow]
                        [--attempt-id <id>] [--since <1s-30d>]
                        [--level <info|warning|error>] [--json]
  musicmute-worker logs --clear [--force] [--json]
  musicmute-worker diagnostics [--output </absolute/path.zip>] [--json]
  musicmute-worker doctor [--json]
  musicmute-worker benchmark [--workers <1|2>] [--json]
  musicmute-worker benchmark-file --input </absolute/song> [--recipe <kim-vocals-v2|kim-vocals-v2-trim>] [--iterations <1|2>] [--json]`;

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
    iterations: 1 | 2;
  }) => Promise<unknown>;
  health?: () => Promise<MacUserHealth>;
  remoteStatus?: () => Promise<WorkerMachineStatus>;
  preflight?: () => Promise<boolean>;
  diagnostics?: (outputPath?: string) => Promise<MacDiagnosticBundleResult>;
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
  return await withMacUserCommandLock(layout.commandLockPath, async () =>
    runUnlocked(command, arguments_, context, host, layout),
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
      const jsonFlag = extractBooleanFlag(arguments_, "--json");
      const flags = parseValueFlags(
        jsonFlag.remaining,
        new Set(["label", "group-id"]),
      );
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
      const result = await install({
        enrollmentCredential,
        label,
        ...(flags.get("group-id") === undefined
          ? {}
          : { groupId: flags.get("group-id")! }),
      });
      stdout(
        formatActionResult(
          { status: "ok", action: "install", ...result },
          jsonFlag.present,
        ),
      );
      return 0;
    }
    case "status": {
      exactArguments(arguments_, new Set(["--json"]));
      const status = await readStatus(
        layout,
        launchAgent,
        context.remoteStatus,
      );
      stdout(formatStatus(status, arguments_.includes("--json")));
      return status.healthy ? 0 : 1;
    }
    case "start": {
      exactArguments(arguments_, new Set(["--json"]));
      await start(layout, launchAgent, context.preflight);
      stdout(
        formatActionResult(
          { status: "ok", action: "start" },
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
      await gracefulStop(layout, launchAgent, arguments_.includes("--force"), {
        ...(context.wait === undefined ? {} : { wait: context.wait }),
        ...(context.drainTimeoutMs === undefined
          ? {}
          : { timeoutMs: context.drainTimeoutMs }),
      });
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
        const service = await launchAgent.status();
        if (service.loaded)
          await gracefulStop(layout, launchAgent, flags.force, {
            ...(context.wait === undefined ? {} : { wait: context.wait }),
            ...(context.drainTimeoutMs === undefined
              ? {}
              : { timeoutMs: context.drainTimeoutMs }),
          });
        const result = await clearMacUserLogs(layout);
        if (service.loaded) await start(layout, launchAgent, context.preflight);
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
    case "diagnostics": {
      const jsonFlag = extractBooleanFlag(arguments_, "--json");
      const values = parseValueFlags(jsonFlag.remaining, new Set(["output"]));
      const outputPath = values.get("output");
      const health = await (
        context.health ?? (() => inspectMacUserHealth(layout, launchAgent))
      )();
      const status = await readStatus(
        layout,
        launchAgent,
        context.remoteStatus,
      );
      const result = await (
        context.diagnostics ??
        ((output?: string) =>
          createMacDiagnosticBundle({
            layout,
            status,
            health,
            ...(output === undefined ? {} : { outputPath: output }),
          }))
      )(outputPath);
      stdout(
        jsonFlag.present
          ? formatJson(result)
          : `MusicMute Worker Diagnostics\n\nBundle: ${result.path}\nFiles: ${result.files.length}\nPrivacy: sanitized; credentials and configuration values excluded`,
      );
      return 0;
    }
    case "doctor": {
      exactArguments(arguments_, new Set(["--json"]));
      const result = await (
        context.health ?? (() => inspectMacUserHealth(layout, launchAgent))
      )();
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
        new Set(["input", "recipe", "iterations"]),
      );
      const inputPath = flags.get("input");
      if (inputPath === undefined)
        throw new TypeError("benchmark-file requires --input");
      const recipe = flags.get("recipe") ?? DEFAULT_MAC_RECIPE_ID;
      if (!MAC_RECIPE_IDS.includes(recipe as MacRecipeId))
        throw new TypeError(
          `benchmark-file recipe must be one of: ${MAC_RECIPE_IDS.join(", ")}`,
        );
      const iterationValue = flags.get("iterations") ?? "1";
      if (iterationValue !== "1" && iterationValue !== "2")
        throw new TypeError("benchmark-file iterations must be 1 or 2");
      const iterations = Number(iterationValue) as 1 | 2;
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
        iterations,
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
): Promise<void> {
  await requireInstalled(layout);
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
  const current = await launchAgent.status();
  if (current.loaded) await launchAgent.kickstart();
  else await launchAgent.bootstrap(layout.plistPath);
}

async function transition(
  layout: MacUserLayout,
  launchAgent: LaunchAgentActions,
  intent: LocalLifecycleIntent,
  stdout: (value: string) => void,
  json: boolean,
): Promise<number> {
  await requireInstalled(layout);
  const state = await setLocalLifecycleIntent(layout.lifecyclePath, intent);
  if (intent === "active" && (await launchAgent.status()).loaded)
    await launchAgent.kickstart();
  stdout(
    formatActionResult(
      { status: "ok", action: intent, revision: state.revision },
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
) {
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
  const remote = installed
    ? await readRemoteStatus(layout, remoteStatus)
    : { available: false as const, state: null };
  const logs = installed
    ? await inspectOperationalLogUsage(layout).catch(() => null)
    : null;
  const effectiveClaimsAllowed =
    installed &&
    lifecycle?.intent === "active" &&
    service.loaded &&
    service.running &&
    remote.available &&
    remote.state.claimsAllowed;
  return {
    schemaVersion: 1,
    installed,
    activeReleaseVersion,
    lifecycle: lifecycle?.intent ?? "unknown",
    service,
    runtime: {
      activeAttempts: runtime?.activeAttemptIds.length ?? null,
      currentAttempts: runtime?.currentAttempts ?? [],
      childState: runtime?.childState ?? "unknown",
      lastSuccessfulJob: runtime?.lastSuccessfulJob ?? null,
      lastFailedJob: runtime?.lastFailedJob ?? null,
      updatedAt: runtime?.updatedAt ?? null,
    },
    logs,
    update,
    remote,
    effectiveClaimsAllowed,
    healthy:
      installed &&
      lifecycle !== null &&
      runtime !== null &&
      service.loaded &&
      (service.running || lifecycle.intent !== "active") &&
      remote.available,
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
  | { available: true; state: WorkerMachineStatus }
  | { available: false; state: null }
> {
  try {
    const state = await (
      remoteStatus ??
      (async () => {
        const config = await loadRuntimeConfig(layout.configPath);
        return await new WorkerControlPlaneClient({
          baseUrl: config.backendBaseUrl,
          credential: config.credential,
          allowInsecureLoopback: config.allowInsecureLoopback,
        }).machineStatus();
      })
    )();
    return { available: true, state };
  } catch {
    return { available: false, state: null };
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
  force: boolean;
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
  let force = false;
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
    else if (current === "--force") force = true;
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
  if (follow && json) throw new TypeError("logs --follow cannot use --json");
  if (force && !clear) throw new TypeError("logs --force requires --clear");
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
    force,
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
  let previous = "";
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopped) {
      const rendered = await renderLogs(layout, flags);
      if (rendered !== previous) {
        stdout(
          previous && rendered.startsWith(previous)
            ? rendered.slice(previous.length)
            : rendered,
        );
        previous = rendered;
      }
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
    `Active jobs: ${status.runtime.activeAttempts ?? "Unknown"}`,
    `Processing child: ${humanizeLabel(status.runtime.childState)}`,
    `Accepting jobs: ${status.effectiveClaimsAllowed ? "Yes" : "No"}`,
    `Dashboard: ${status.remote.available ? "Connected" : "Unavailable"}`,
  ];
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
    lines.push(`Runtime heartbeat: ${status.runtime.updatedAt}`);
  for (const attempt of status.runtime.currentAttempts)
    lines.push(
      `Current job: ${attempt.jobId} (attempt ${attempt.attemptId}, worker ${attempt.workerId})`,
    );
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatHealth(health: MacUserHealth, json: boolean): string {
  if (json) return formatJson(health);
  const passed = health.checks.filter((check) => check.ok).length;
  const failed = health.checks.length - passed;
  const lines = [
    "MusicMute Worker Doctor",
    "",
    `Overall: ${health.healthy ? "Healthy" : "Problems found"}`,
    `Checks: ${passed} passed, ${failed} failed`,
    "",
  ];
  for (const check of health.checks) {
    lines.push(
      `[${check.ok ? "PASS" : "FAIL"}] ${humanizeLabel(check.name)}`,
      `       ${check.path}`,
    );
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
    value,
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

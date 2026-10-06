import { createHash } from "node:crypto";
import { lstat, readFile, readlink, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  runEnrollmentCommand,
  runInstallationPreparationCommand,
} from "../../enrollment/cli.js";
import {
  loadLocalLifecycle,
  setLocalLifecycleIntent,
  type LocalLifecycleIntent,
} from "../../runtime/local-lifecycle.js";
import { waitForLocalDrain } from "../shared/local-drain.js";
import { retainSlotIdentities } from "../shared/slot-identities.js";
import { loadRuntimeConfig } from "../../runtime/runtime-config.js";
import {
  MacLaunchAgentController,
  writeLaunchAgentPlist,
} from "./launch-agent.js";
import { MacCommandBusyError, withMacUserCommandLock } from "./command-lock.js";
import {
  withMacAppPreparationFence,
  recoverMacAppPreparationFence,
} from "./app-control-maintenance.js";
import { createMacUserLayout, type MacUserLayout } from "./user-paths.js";
import type { MacUserCommandContext } from "./user-cli.js";
import {
  installMacUserWorker,
  qualifyMacUserRelease,
  recoverMacUserWorker,
  resumeMacUserInstallation,
} from "./user-installer.js";
import {
  acceptMacAppKnownGood,
  checkMacUserUpdate,
  loadUpdateState,
  recoverInterruptedMacUpdate,
  restoreMacAppUpdateState,
  validateMacAppUpdateState,
  updateMacUserWorker,
} from "./user-updater.js";
import {
  readMacQualifiedRollback,
  validateMacQualifiedRollback,
  writeMacQualifiedRollback,
  type QualifiedRollbackReference,
} from "./app-installation-state.js";
import { inspectMacUserHealth } from "./user-health.js";
import {
  activateMacUserRelease,
  rollbackMacUserRelease,
} from "./user-release.js";
import {
  privateWrite,
  readBoundedJson,
  resolveMacAppExecutionLayout,
  stageMacAppService,
  verifyManagedMacRelease,
  macAppServiceCandidateIdentity,
} from "./app-installation-binding.js";
import { AppControlError } from "./app-control-protocol.js";
import type { inspectInstalledMacRuntime } from "./install-preflight.js";

type Service = Pick<
  MacLaunchAgentController,
  "status" | "bootstrap" | "bootout" | "kickstart"
>;
type UpdateSource = "app" | "catalog";
interface AppActivationJournal {
  schemaVersion: 1;
  previousVersion: string;
  candidateVersion: string;
  previousConfig: Record<string, unknown>;
  previousInstallation: Record<string, unknown>;
  previousUpdate?: Record<string, unknown>;
  previousRollback?: QualifiedRollbackReference | null;
  intent: LocalLifecycleIntent;
  serviceWasRunning: boolean;
  phase: "staged" | "qualifying" | "activating";
}
export interface AppInstallationDependencies {
  layout?: MacUserLayout;
  uid?: number;
  launchAgent?: Service;
  stage?: typeof stageMacAppService;
  qualify?: typeof qualifyMacUserRelease;
  healthy?: (layout: MacUserLayout) => Promise<boolean>;
  prepare?: typeof runInstallationPreparationCommand;
  enroll?: typeof runEnrollmentCommand;
  wait?: (milliseconds: number) => Promise<void>;
  beforeQualification?: () => Promise<void>;
  inspectRuntime?: typeof inspectInstalledMacRuntime;
}

/** No installation occurs until a typed, confirmed operator command invokes a hook. */
export function createMacAppCommandContext(
  resources: string,
  supportRoot: string,
  dependencies: AppInstallationDependencies = {},
): MacUserCommandContext {
  if (
    !isAbsolute(resources) ||
    resolve(resources) !== resources ||
    !isAbsolute(supportRoot) ||
    resolve(supportRoot) !== supportRoot
  )
    throw new AppControlError("APP_RUNTIME_INCOMPATIBLE");
  const layout = dependencies.layout ?? createMacUserLayout(homedir());
  if (
    supportRoot !==
    join(layout.homeRoot, "Library", "Application Support", "MusicMuteLocal")
  )
    throw new AppControlError("APP_RUNTIME_INCOMPATIBLE");
  const uid = dependencies.uid ?? process.getuid?.() ?? 0;
  const service = dependencies.launchAgent ?? new MacLaunchAgentController(uid);
  const stage = () =>
    (dependencies.stage ?? stageMacAppService)(layout, resources, supportRoot);
  const quiet = { stdout: (_value: string) => undefined };
  const retireEngine =
    dependencies.beforeQualification ??
    (async () => {
      let helper: Record<string, unknown>;
      try {
        helper = (await import(
          pathToFileURL(join(resources, "companion", "worker-preflight.js"))
            .href
        )) as Record<string, unknown>;
      } catch {
        throw new AppControlError("APP_RUNTIME_INCOMPATIBLE");
      }
      if (typeof helper.retireAppEngineForWorker !== "function")
        throw new AppControlError("APP_RUNTIME_INCOMPATIBLE");
      try {
        await (
          helper.retireAppEngineForWorker as (
            resources: string,
            support: string,
          ) => Promise<void>
        )(resources, supportRoot);
      } catch {
        throw new AppControlError("WORKER_PERSONAL_BUSY");
      }
    });
  const operations = { ...dependencies, beforeQualification: retireEngine };
  return {
    layout,
    appControl: true,
    launchAgent: service,
    beforeRuntimeRemoval: retireEngine,
    beforeWorkerLoad: retireEngine,
    preflight: async () => {
      return (
        await inspectMacUserHealth(
          await resolveMacAppExecutionLayout(layout),
          service,
          { requireRunning: false },
        )
      ).healthy;
    },
    resumeInstallation: () =>
      withMacAppPreparationFence(layout, "recover", () =>
        resumeMacUserInstallation({
          layout,
          uid,
          launchAgent: service,
          beforeStart: retireEngine,
        }),
      ),
    ...(dependencies.wait ? { wait: dependencies.wait } : {}),
    install: async (input) =>
      withMacAppPreparationFence(layout, "install", async () => {
        const staged = await stage();
        const installed = await installMacUserWorker({
          layout,
          uid,
          launchAgent: service,
          ...input,
          prepare: (args, reuse) =>
            (dependencies.prepare ?? runInstallationPreparationCommand)(
              args,
              { ...reuse, appReleaseRoot: staged.releaseRoot },
              quiet,
            ),
          enroll: (args) =>
            (dependencies.enroll ?? runEnrollmentCommand)(args, quiet),
          beforeQualification: retireEngine,
          ...(dependencies.qualify ? { qualify: dependencies.qualify } : {}),
          ...(dependencies.inspectRuntime
            ? { inspectRuntime: dependencies.inspectRuntime }
            : {}),
        });
        await acceptMacAppKnownGood(layout, staged.releaseVersion);
        await writeMacQualifiedRollback(layout, {
          schemaVersion: 1,
          knownGoodVersion: staged.releaseVersion,
          previousVersion: null,
        });
        return installed;
      }),
    recover: () =>
      withMacAppPreparationFence(layout, "recover", async () =>
        recoverMacUserWorker({
          layout: await resolveMacAppExecutionLayout(layout),
          uid,
          launchAgent: service,
          beforeStart: retireEngine,
        }),
      ),
    adopt: () =>
      withMacAppPreparationFence(layout, "adopt", async () =>
        activateAppService(layout, await stage(), service, false, operations),
      ),
    checkUpdate: async (source: UpdateSource = "app") => {
      if (source === "catalog")
        return await checkMacUserUpdate(
          await resolveMacAppExecutionLayout(layout),
        );
      const candidate = await macAppServiceCandidateIdentity(resources);
      const current = await readBoundedJson(layout.installationStatePath);
      return {
        currentVersion: String(current.releaseVersion),
        availableVersion: candidate.releaseVersion,
        sequence: 0,
        updateAvailable: current.releaseVersion !== candidate.releaseVersion,
      };
    },
    update: (force, source: UpdateSource = "app") =>
      withMacAppPreparationFence(layout, "update", async () => {
        if (source === "catalog")
          return await updateMacUserWorker({
            layout: await resolveMacAppExecutionLayout(layout),
            uid,
            launchAgent: service,
            force,
            beforeQualification: retireEngine,
          });
        const result = await activateAppService(
          layout,
          await stage(),
          service,
          force,
          operations,
        );
        return {
          status: result.adopted ? "updated" : "current",
          releaseVersion: result.releaseVersion,
          sequence: 0,
          capacityRequalificationRequired:
            result.capacityRequalificationRequired,
        };
      }),
  };
}

async function activateAppService(
  layout: MacUserLayout,
  candidate: { releaseVersion: string; releaseRoot: string },
  service: Service,
  force: boolean,
  dependencies: AppInstallationDependencies,
) {
  await recoverMacAppActivation(layout, service);
  await recoverInterruptedMacUpdate(
    layout,
    service,
    "Interrupted update recovered",
    false,
    dependencies.beforeQualification,
  );
  const previousConfig = await readBoundedJson(layout.configPath);
  const previousInstallation = await readBoundedJson(
    layout.installationStatePath,
  );
  const previousVersion = String(previousInstallation.releaseVersion);
  if (
    !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(previousVersion) ||
    (await readlink(layout.currentLink)) !== `releases/${previousVersion}`
  )
    throw new AppControlError("APP_WORKER_RECOVERY_REQUIRED");
  await verifyManagedMacRelease(join(layout.releasesRoot, previousVersion));
  const prior = await loadLocalLifecycle(layout.lifecyclePath);
  const before = await service.status();
  if (before.loaded && !before.running)
    throw new AppControlError("APP_WORKER_RECOVERY_REQUIRED");
  if (candidate.releaseVersion === previousVersion)
    return {
      status: "ok",
      action: "adopt",
      releaseVersion: previousVersion,
      adopted: false,
      capacityRequalificationRequired: false,
    };
  const journal: AppActivationJournal = {
    schemaVersion: 1,
    previousVersion,
    candidateVersion: candidate.releaseVersion,
    previousConfig,
    previousInstallation,
    previousUpdate: (await loadUpdateState(
      layout.updateStatePath,
    )) as unknown as Record<string, unknown>,
    previousRollback: await readMacQualifiedRollback(layout),
    intent: prior.intent,
    serviceWasRunning: before.running,
    phase: "staged",
  };
  await writeActivation(layout, journal);
  try {
    const draining = await setLocalLifecycleIntent(
      layout.lifecyclePath,
      "draining",
    );
    if (before.running)
      await waitForLocalDrain({
        runtimeStatusPath: layout.runtimeStatusPath,
        expectedRevision: draining.revision,
        force,
        ...(dependencies.wait ? { wait: dependencies.wait } : {}),
      });
    if (before.loaded) await service.bootout();
    await writeActivation(layout, { ...journal, phase: "qualifying" });
    await dependencies.beforeQualification?.();
    const targetLayout = await resolveMacAppExecutionLayout(
      layout,
      candidate.releaseRoot,
    );
    const fixture = join(layout.stateRoot, "qualification.wav");
    const digest = createHash("sha256")
      .update(await readFile(fixture))
      .digest("hex");
    await (dependencies.qualify ?? qualifyMacUserRelease)(
      targetLayout,
      candidate.releaseRoot,
      fixture,
      digest,
      service,
      false,
    );
    await writeActivation(layout, { ...journal, phase: "activating" });
    await activateMacUserRelease(layout, candidate.releaseVersion);
    const slots = previousConfig.slots as {
      gpuId: string;
      slotIndex: number;
    }[];
    if (!Array.isArray(slots) || slots.length < 1)
      throw new AppControlError("APP_WORKER_RECOVERY_REQUIRED");
    const seen = new Set<string>();
    const selected = slots.filter((slot) => {
      if (seen.has(slot.gpuId)) return false;
      seen.add(slot.gpuId);
      return true;
    });
    const config = {
      ...retainSlotIdentities(previousConfig, selected),
      validatedMaxWorkersPerGpu: 1,
      modelCacheRoot: targetLayout.modelRoot,
      engineRoot: targetLayout.engineRoot,
      pythonPath: targetLayout.pythonPath,
      ffmpegPath: targetLayout.ffmpegPath,
      ffprobePath: targetLayout.ffprobePath,
    };
    await privateWrite(
      layout.configPath,
      Buffer.from(`${JSON.stringify(config)}\n`),
    );
    await loadRuntimeConfig(layout.configPath);
    await writeLaunchAgentPlist(targetLayout);
    await setLocalLifecycleIntent(layout.lifecyclePath, journal.intent);
    if (journal.serviceWasRunning) await service.bootstrap(layout.plistPath);
    const healthy = await (
      dependencies.healthy ??
      (async (selectedLayout) =>
        (
          await inspectMacUserHealth(selectedLayout, service, {
            requireRunning: journal.serviceWasRunning,
          })
        ).healthy)
    )(targetLayout);
    if (!healthy) throw new AppControlError("APP_WORKER_RECOVERY_REQUIRED");
    await privateWrite(
      layout.installationStatePath,
      Buffer.from(
        `${JSON.stringify({ ...previousInstallation, releaseVersion: candidate.releaseVersion, updatedAt: new Date().toISOString(), distribution: "app-external" })}\n`,
      ),
    );
    await acceptMacAppKnownGood(layout, candidate.releaseVersion);
    await writeMacQualifiedRollback(layout, {
      schemaVersion: 1,
      knownGoodVersion: candidate.releaseVersion,
      previousVersion,
    });
    await rm(activationPath(layout));
    return {
      status: "ok",
      action: "adopt",
      releaseVersion: candidate.releaseVersion,
      adopted: true,
      capacityRequalificationRequired:
        previousConfig.validatedMaxWorkersPerGpu === 2,
      legacyCliRequiresUpdate: true,
      supportCliPath: join(layout.installRoot, "bin", "mw"),
    };
  } catch (error) {
    await recoverMacAppActivation(layout, service);
    throw error;
  }
}

/** The existing command lock covers pointer/config/intent changes and restoration. */
export async function recoverMacAppActivation(
  layout: MacUserLayout,
  service: Pick<Service, "status" | "bootstrap" | "bootout">,
  serviceStartup = false,
  beforeStart?: () => Promise<void>,
): Promise<boolean> {
  let raw: Record<string, unknown>;
  try {
    raw = await readBoundedJson(activationPath(layout));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (
    raw.schemaVersion !== 1 ||
    !["staged", "qualifying", "activating"].includes(String(raw.phase)) ||
    !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(String(raw.previousVersion)) ||
    !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(String(raw.candidateVersion)) ||
    !["active", "paused", "draining"].includes(String(raw.intent)) ||
    typeof raw.serviceWasRunning !== "boolean" ||
    !raw.previousConfig ||
    typeof raw.previousConfig !== "object" ||
    Array.isArray(raw.previousConfig) ||
    "credential" in raw.previousConfig ||
    !raw.previousInstallation ||
    typeof raw.previousInstallation !== "object" ||
    Array.isArray(raw.previousInstallation) ||
    Object.keys(raw).some(
      (key) =>
        ![
          "schemaVersion",
          "previousVersion",
          "candidateVersion",
          "previousConfig",
          "previousInstallation",
          "previousUpdate",
          "previousRollback",
          "intent",
          "serviceWasRunning",
          "phase",
        ].includes(key),
    )
  )
    throw new AppControlError("APP_WORKER_RECOVERY_REQUIRED");
  const journal = raw as unknown as AppActivationJournal;
  if (journal.previousUpdate !== undefined)
    validateMacAppUpdateState(journal.previousUpdate);
  if (
    journal.previousRollback !== undefined &&
    journal.previousRollback !== null
  )
    validateMacQualifiedRollback(journal.previousRollback);
  await verifyManagedMacRelease(
    join(layout.releasesRoot, journal.previousVersion),
  );
  const target = await readlink(layout.currentLink);
  if (
    ![journal.previousVersion, journal.candidateVersion]
      .map((version) => `releases/${version}`)
      .includes(target)
  )
    throw new AppControlError("APP_WORKER_RECOVERY_REQUIRED");
  if (
    !serviceStartup &&
    journal.phase !== "staged" &&
    (await service.status()).loaded
  ) {
    // Drain completed before "qualifying" was durable. The preparation fence
    // prevents claims in a candidate supervisor; temporary qualification emits
    // no fleet runtime status and must not be mistaken for accepted fleet work.
    await service.bootout();
  }
  await rollbackMacUserRelease(layout, `releases/${journal.previousVersion}`);
  await privateWrite(
    layout.configPath,
    Buffer.from(`${JSON.stringify(journal.previousConfig)}\n`),
  );
  await privateWrite(
    layout.installationStatePath,
    Buffer.from(`${JSON.stringify(journal.previousInstallation)}\n`),
  );
  if (journal.previousUpdate !== undefined)
    await restoreMacAppUpdateState(layout, journal.previousUpdate);
  if (journal.previousRollback !== undefined)
    await writeMacQualifiedRollback(layout, journal.previousRollback);
  await writeLaunchAgentPlist(await resolveMacAppExecutionLayout(layout));
  await setLocalLifecycleIntent(layout.lifecyclePath, journal.intent);
  if (
    !serviceStartup &&
    journal.serviceWasRunning &&
    !(await service.status()).loaded
  ) {
    await beforeStart?.();
    await service.bootstrap(layout.plistPath);
  }
  await rm(activationPath(layout));
  return journal.serviceWasRunning;
}

export class MacAppStartupRecovered extends Error {
  constructor(readonly restart: boolean) {
    super("App worker activation restored before processing");
  }
}
export async function recoverMacAppActivationAtStartup(
  layout: MacUserLayout,
): Promise<void> {
  const info = await lstat(activationPath(layout)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!info) return;
  try {
    const restart = await withMacUserCommandLock(
      layout.commandLockPath,
      async () => {
        await recoverMacAppPreparationFence(layout);
        return await recoverMacAppActivation(
          layout,
          new MacLaunchAgentController(process.getuid?.() ?? 0),
          true,
        );
      },
      "app-activation-recovery",
    );
    throw new MacAppStartupRecovered(restart);
  } catch (error) {
    if (
      error instanceof MacCommandBusyError &&
      ["adopt", "update", "install", "recover"].includes(error.operation ?? "")
    )
      return;
    throw error;
  }
}
function activationPath(layout: MacUserLayout): string {
  return join(layout.stateRoot, "app-activation.json");
}
async function writeActivation(
  layout: MacUserLayout,
  journal: AppActivationJournal,
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(journal)}\n`);
  if (bytes.length > 64 * 1024)
    throw new TypeError("App worker activation journal is too large");
  await privateWrite(activationPath(layout), bytes);
}

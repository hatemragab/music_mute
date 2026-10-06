import {
  BUILT_IN_UPDATE_TRUST,
  parseUpdateTrust,
} from "../shared/update-trust.js";
import { compareWorkerReleaseVersions } from "../shared/release-version.js";
import { createHash, randomUUID } from "node:crypto";
import { retainSlotIdentities } from "../shared/slot-identities.js";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  rm,
  statfs,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { downloadVerifiedArtifact } from "../../enrollment/artifact-download.js";
import { prepareInstallationRelease } from "../../enrollment/release-archive.js";
import { WorkerControlPlaneClient } from "../../runtime/control-plane-client.js";
import {
  loadLocalLifecycle,
  setLocalLifecycleIntent,
} from "../../runtime/local-lifecycle.js";
import {
  loadRuntimeConfig,
  readMaintenanceConnection,
} from "../../runtime/runtime-config.js";
import { inspectInstalledMacRuntime } from "./install-preflight.js";
import {
  MacLaunchAgentController,
  writeLaunchAgentPlist,
} from "./launch-agent.js";
import { qualifyMacUserRelease } from "./user-installer.js";
import {
  assertSafeExistingAncestors,
  type MacUserLayout,
} from "./user-paths.js";
import {
  activateMacUserRelease,
  rollbackMacUserRelease,
  stageMacUserRelease,
  installMacUserModel,
  macUserModelPath,
} from "./user-release.js";
import {
  verifyUpdateMetadata,
  type UpdateCandidate,
  type UpdateMetadata,
} from "../shared/update-metadata.js";
import { waitForLocalDrain } from "../shared/local-drain.js";
import {
  verifyManagedMacRelease as verifyMacRelease,
  resolveMacAppExecutionLayout,
  APP_MODEL_BYTES,
  APP_MODEL_SHA256,
} from "./app-installation-binding.js";
import { createMacUserLayout } from "./user-paths.js";
import {
  readMacQualifiedRollback,
  validateMacQualifiedRollback,
  writeMacQualifiedRollback,
  type QualifiedRollbackReference,
} from "./app-installation-state.js";
import { inspectMacUserHealth } from "./user-health.js";
import { MacCommandBusyError, withMacUserCommandLock } from "./command-lock.js";

export class MacUpdateStartupRecovered extends Error {
  constructor(readonly restart: boolean) {
    super("Interrupted update restored; exit before starting processing");
  }
}

/** Runs before creating any engine or backend session in the managed service. */
export async function recoverMacUpdateAtStartup(
  layout: MacUserLayout,
  service: Pick<
    MacLaunchAgentController,
    "status"
  > = new MacLaunchAgentController(process.getuid?.() ?? 0),
): Promise<void> {
  const before = await loadUpdateState(layout.updateStatePath);
  if (before.status !== "staged" && before.status !== "activating") return;
  const currentService = await service.status();
  if (!currentService.loaded || currentService.pid !== process.pid)
    throw new TypeError(
      "Update startup recovery requires the managed service process",
    );
  let restart: boolean | undefined;
  try {
    await withMacUserCommandLock(layout.commandLockPath, async () => {
      const state = await loadUpdateState(layout.updateStatePath);
      if (state.status !== "staged" && state.status !== "activating") return;
      restart = state.recovery?.serviceWasLoaded;
      await recoverInterruptedMacUpdate(
        layout,
        new MacLaunchAgentController(process.getuid?.() ?? 0),
        "Interrupted update recovered at service startup",
        true,
      );
    });
  } catch (error) {
    // The updating CLI deliberately boots the candidate while holding this lock
    // and needs it running to complete health acceptance. Do not roll it back.
    if (error instanceof MacCommandBusyError && error.operation === "update")
      return;
    throw error;
  }
  if (restart !== undefined) throw new MacUpdateStartupRecovered(restart);
}

interface UpdateState {
  schemaVersion: 1;
  highestSequence: number;
  status: "none" | "staged" | "activating" | "healthy" | "rolled-back";
  knownGoodVersion?: string;
  candidateVersion?: string;
  quarantinedVersions: string[];
  updatedAt: string;
  failure?: string;
  recovery?: {
    previousVersion: string;
    intent: "active" | "paused" | "draining";
    serviceWasLoaded: boolean;
    runtimeConfig?: Record<string, unknown>;
    qualifiedRollback?: QualifiedRollbackReference | null;
    fleetDrained?: true;
  };
}

export interface MacUserUpdateCheck {
  currentVersion: string;
  availableVersion: string;
  sequence: number;
  updateAvailable: boolean;
  candidate: UpdateCandidate;
  metadata: UpdateMetadata;
  state: UpdateState;
  installationState: Record<string, unknown>;
}

export async function checkMacUserUpdate(
  layout: MacUserLayout,
  dependencies: {
    candidate?: () => Promise<UpdateCandidate>;
    now?: Date;
    download?: boolean;
  } = {},
): Promise<MacUserUpdateCheck> {
  const config = await readMaintenanceConnection(layout.configPath);
  const installation = await readPrivateRecord(layout.installationStatePath);
  const currentVersion = requiredText(
    installation.releaseVersion,
    "Installed release version",
  );
  const state = await loadUpdateState(layout.updateStatePath);
  const trust = await loadMacUpdateTrust(layout.updateTrustPath);
  const candidate = await (
    dependencies.candidate ??
    (() =>
      new WorkerControlPlaneClient({
        baseUrl: config.backendBaseUrl,
        credential: config.credential,
        allowInsecureLoopback: config.allowInsecureLoopback,
      }).updateCandidate("darwin-arm64", dependencies.download === true))
  )();
  const metadata = verifyUpdateMetadata(candidate.signed, {
    platform: "darwin-arm64",
    publicKeys: trust,
    minimumSequence: state.highestSequence,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  if (state.quarantinedVersions.includes(metadata.releaseVersion))
    throw new Error("Update candidate is locally quarantined");
  return {
    currentVersion,
    availableVersion: metadata.releaseVersion,
    sequence: metadata.sequence,
    updateAvailable:
      compareWorkerReleaseVersions(metadata.releaseVersion, currentVersion) > 0,
    candidate,
    metadata,
    state,
    installationState: installation,
  };
}

export async function updateMacUserWorker(options: {
  layout: MacUserLayout;
  uid: number;
  force?: boolean;
  launchAgent?: Pick<
    MacLaunchAgentController,
    "bootstrap" | "bootout" | "status"
  >;
  candidate?: () => Promise<UpdateCandidate>;
  qualify?: typeof qualifyMacUserRelease;
  now?: Date;
  fetch?: typeof fetch;
  confirmStarted?: () => Promise<boolean>;
  health?: () => Promise<boolean>;
  availableDiskBytes?: () => Promise<number>;
  removeTransaction?: (path: string) => Promise<void>;
  beforeQualification?: () => Promise<void>;
}): Promise<{
  status: "current" | "updated";
  releaseVersion: string;
  sequence: number;
  capacityRequalificationRequired?: boolean;
  cleanupWarning?: string;
}> {
  await recoverInterruptedMacUpdate(
    options.layout,
    options.launchAgent ?? new MacLaunchAgentController(options.uid),
    "Interrupted update recovered",
    false,
    options.beforeQualification,
  );
  const checked = await checkMacUserUpdate(options.layout, {
    ...(options.candidate === undefined
      ? {}
      : { candidate: options.candidate }),
    ...(options.now === undefined ? {} : { now: options.now }),
    download: true,
  });
  if (!checked.updateAvailable)
    return {
      status: "current",
      releaseVersion: checked.currentVersion,
      sequence: checked.sequence,
    };
  const launchAgent =
    options.launchAgent ?? new MacLaunchAgentController(options.uid);
  const transactionRoot = join(
    options.layout.transactionRoot,
    "updates",
    String(checked.sequence),
  );
  if (checked.candidate.grant === undefined)
    throw new TypeError("Update download grant is missing");
  await assertSafeExistingAncestors(options.layout.homeRoot, transactionRoot);
  await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
  let result:
    | {
        status: "updated";
        releaseVersion: string;
        sequence: number;
        capacityRequalificationRequired?: boolean;
        cleanupWarning?: string;
      }
    | undefined;
  try {
    await chmod(transactionRoot, 0o700);
    await assertUpdateDiskBudget(
      transactionRoot,
      checked.metadata.release.bytes,
      options.availableDiskBytes,
    );
    const archivePath = join(
      transactionRoot,
      checked.metadata.release.filename,
    );
    await downloadVerifiedArtifact({
      url: checked.candidate.grant.url,
      outputPath: archivePath,
      expectedBytes: checked.metadata.release.bytes,
      expectedSha256: checked.metadata.release.sha256,
      expectedContentType: checked.metadata.release.contentType,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const prepared = await prepareInstallationRelease({
      archivePath,
      outputRoot: transactionRoot,
      platform: "darwin-arm64",
      releaseVersion: checked.metadata.releaseVersion,
    });
    const runtime = await inspectInstalledMacRuntime({
      nodeCandidates: [join(prepared.path, "runtime", "node", "bin", "node")],
      ffmpegCandidates: [join(prepared.path, "runtime", "bin", "ffmpeg")],
      ffprobeCandidates: [join(prepared.path, "runtime", "bin", "ffprobe")],
      uid: options.uid,
    });
    if (
      Object.values(runtime).some((component) => component.decision !== "reuse")
    )
      throw new TypeError("Update candidate contains an incompatible runtime");
    const staged = await stageMacUserRelease(options.layout, prepared.path);
    const previousLifecycle = await loadLocalLifecycle(
      options.layout.lifecyclePath,
    );
    const previousService = await launchAgent.status();
    // A loaded but stopped job is deliberately stopped as far as activation is
    // concerned. Qualification may load a temporary job but must not start it later.
    const serviceWasLoaded = previousService.loaded && previousService.running;
    const previousConfig = await readPrivateRecord(options.layout.configPath);
    const capacityRequalificationRequired =
      previousConfig.validatedMaxWorkersPerGpu === 2;
    const previousTarget = await readlink(options.layout.currentLink);
    if (previousTarget !== `releases/${checked.currentVersion}`)
      throw new Error("Installed release and active pointer disagree");
    await verifyMacRelease(
      join(options.layout.releasesRoot, checked.currentVersion),
    );
    const pending: UpdateState = {
      ...checked.state,
      status: "staged",
      candidateVersion: staged.releaseVersion,
      recovery: {
        previousVersion: checked.currentVersion,
        intent: previousLifecycle.intent,
        serviceWasLoaded,
        runtimeConfig: previousConfig,
        qualifiedRollback: await readMacQualifiedRollback(options.layout),
      },
      updatedAt: new Date().toISOString(),
    };
    // Commit recovery intent before the first lifecycle/service mutation.
    await writeUpdateState(options.layout.updateStatePath, pending);
    try {
      const draining = await setLocalLifecycleIntent(
        options.layout.lifecyclePath,
        "draining",
      );
      if (serviceWasLoaded) {
        await waitForLocalDrain({
          runtimeStatusPath: options.layout.runtimeStatusPath,
          expectedRevision: draining.revision,
          force: options.force === true,
        });
      }
      if (previousService.loaded) await launchAgent.bootout();
      // Qualification is a temporary LaunchAgent with no fleet status stream.
      // Commit positive drain/stop before loading it, so interrupted recovery
      // can retire it without waiting for a nonexistent fleet acknowledgement.
      pending.recovery!.fleetDrained = true;
      await writeUpdateState(options.layout.updateStatePath, pending);
      await options.beforeQualification?.();
      const fixturePath = join(options.layout.stateRoot, "qualification.wav");
      const fixtureSha256 = await sha256(fixturePath);
      const qualify = options.qualify ?? qualifyMacUserRelease;
      await qualify(
        options.layout,
        staged.releaseRoot,
        fixturePath,
        fixtureSha256,
        launchAgent,
        false,
      );
      await writeUpdateState(options.layout.updateStatePath, {
        ...pending,
        status: "activating",
        candidateVersion: staged.releaseVersion,
        updatedAt: new Date().toISOString(),
      });
      await writeMacQualifiedRollback(options.layout, {
        schemaVersion: 1,
        knownGoodVersion: staged.releaseVersion,
        previousVersion: checked.currentVersion,
      });
      await activateMacUserRelease(options.layout, staged.releaseVersion);
      // Approval is release-bound. Keep the old receipt untouched for rollback;
      // it cannot authorize the new release. Retain one existing slot per GPU.
      if (capacityRequalificationRequired) {
        const seen = new Set<string>();
        const slots = (
          previousConfig.slots as { gpuId: string; slotIndex: number }[]
        ).filter((slot) => {
          if (seen.has(slot.gpuId)) return false;
          seen.add(slot.gpuId);
          return true;
        });
        await writePrivateRecord(options.layout.configPath, {
          ...retainSlotIdentities(previousConfig, slots),
          validatedMaxWorkersPerGpu: 1,
        });
      }
      // A signed full-runtime candidate must stop referencing an older shared
      // app base. Preserve identities/policy while selecting its own executables.
      const fullLayout = createMacUserLayout(options.layout.homeRoot);
      const activeLayout = await resolveMacAppExecutionLayout(fullLayout);
      if (options.layout.modelRoot !== activeLayout.modelRoot)
        await installMacUserModel({
          layout: activeLayout,
          sourcePath: macUserModelPath(
            options.layout,
            APP_MODEL_SHA256,
            "Kim_Vocal_2.onnx",
          ),
          filename: "Kim_Vocal_2.onnx",
          bytes: APP_MODEL_BYTES,
          sha256: APP_MODEL_SHA256,
        });
      const activeConfig = await readPrivateRecord(options.layout.configPath);
      await writePrivateRecord(options.layout.configPath, {
        ...activeConfig,
        engineRoot: activeLayout.engineRoot,
        pythonPath: activeLayout.pythonPath,
        ffmpegPath: activeLayout.ffmpegPath,
        ffprobePath: activeLayout.ffprobePath,
        modelCacheRoot: activeLayout.modelRoot,
      });
      // A stopped service must also have a valid configuration before committing.
      await loadRuntimeConfig(options.layout.configPath);
      await writeLaunchAgentPlist(activeLayout);
      await setLocalLifecycleIntent(
        options.layout.lifecyclePath,
        previousLifecycle.intent,
      );
      if (serviceWasLoaded) {
        await launchAgent.bootstrap(options.layout.plistPath);
        const service = await (
          options.confirmStarted ?? (() => waitForLoadedService(launchAgent))
        )();
        if (!service) throw new Error("Updated LaunchAgent failed to start");
        const healthy = await (
          options.health ??
          (async () =>
            (await inspectMacUserHealth(activeLayout, launchAgent)).healthy)
        )();
        if (!healthy) throw new Error("Updated worker failed runtime doctor");
      }
      await writePrivateRecord(options.layout.installationStatePath, {
        ...checked.installationState,
        releaseVersion: staged.releaseVersion,
        updatedAt: new Date().toISOString(),
      });
      await writeUpdateState(options.layout.updateStatePath, {
        schemaVersion: 1,
        highestSequence: checked.sequence,
        status: "healthy",
        knownGoodVersion: staged.releaseVersion,
        candidateVersion: staged.releaseVersion,
        quarantinedVersions: checked.state.quarantinedVersions.filter(
          (version) => version !== staged.releaseVersion,
        ),
        updatedAt: new Date().toISOString(),
      });
      result = {
        status: "updated",
        releaseVersion: staged.releaseVersion,
        sequence: checked.sequence,
        ...(capacityRequalificationRequired
          ? { capacityRequalificationRequired: true }
          : {}),
      };
      return result;
    } catch (error) {
      await recoverInterruptedMacUpdate(
        options.layout,
        launchAgent,
        error instanceof Error ? error.message.slice(0, 240) : "unknown",
        false,
        options.beforeQualification,
      );
      throw error;
    }
  } finally {
    try {
      // A completed transaction is only scratch: recovery restores the verified
      // releases under runtime/releases. Keep all scratch until recovery intent
      // is durably finalized, including a rollback whose restart still failed.
      const state = await loadUpdateState(options.layout.updateStatePath);
      if (
        state.status !== "staged" &&
        state.status !== "activating" &&
        state.recovery === undefined
      ) {
        await assertSafeExistingAncestors(
          options.layout.homeRoot,
          transactionRoot,
        );
        await (
          options.removeTransaction ??
          ((path: string) => rm(path, { recursive: true, force: true }))
        )(transactionRoot);
      }
    } catch {
      // Do not roll back an accepted update or hide its original failure because
      // scratch could not be removed. The cleanup CLI can retry it safely.
      const warning = "Update scratch cleanup deferred; run mw cleanup --apply";
      if (result !== undefined) result.cleanupWarning = warning;
      else process.emitWarning(warning, { code: "WORKER_CLEANUP_DEFERRED" });
    }
  }
}

/** Caller holds the CLI command lock. Recovery is repeatable after interruption. */
export async function recoverInterruptedMacUpdate(
  layout: MacUserLayout,
  launchAgent: Pick<
    MacLaunchAgentController,
    "bootstrap" | "bootout" | "status"
  >,
  failure = "Interrupted update recovered",
  serviceStartup = false,
  beforeStart?: () => Promise<void>,
): Promise<boolean> {
  const state = await loadUpdateState(layout.updateStatePath);
  if (
    state.status !== "staged" &&
    state.status !== "activating" &&
    !(state.status === "rolled-back" && state.recovery !== undefined)
  )
    return false;
  const recovery = state.recovery;
  if (!recovery || !state.candidateVersion)
    throw new Error("Interrupted legacy update requires operator recovery");
  // Never switch to a damaged or missing rollback bundle.
  await verifyMacRelease(join(layout.releasesRoot, recovery.previousVersion));
  const activeTarget = await readlink(layout.currentLink);
  if (
    ![
      `releases/${recovery.previousVersion}`,
      `releases/${state.candidateVersion}`,
    ].includes(activeTarget)
  )
    throw new Error("Update recovery found an unrelated active release");
  const draining = await setLocalLifecycleIntent(
    layout.lifecyclePath,
    "draining",
  );
  if (!serviceStartup && (await launchAgent.status()).loaded) {
    if (!(state.status === "staged" && recovery.fleetDrained === true))
      await waitForLocalDrain({
        runtimeStatusPath: layout.runtimeStatusPath,
        expectedRevision: draining.revision,
        force: false,
      });
    await launchAgent.bootout();
  }
  await rollbackMacUserRelease(layout, `releases/${recovery.previousVersion}`);
  if (recovery.runtimeConfig !== undefined)
    await writePrivateRecord(layout.configPath, recovery.runtimeConfig);
  if (recovery.qualifiedRollback !== undefined)
    await writeMacQualifiedRollback(layout, recovery.qualifiedRollback);
  await writeLaunchAgentPlist(layout);
  const installation = await readPrivateRecord(layout.installationStatePath);
  await writePrivateRecord(layout.installationStatePath, {
    ...installation,
    releaseVersion: recovery.previousVersion,
    updatedAt: new Date().toISOString(),
  });
  await setLocalLifecycleIntent(layout.lifecyclePath, recovery.intent);
  const { recovery: _recovery, ...restored } = state;
  const rolledBack: UpdateState = {
    ...restored,
    status: "rolled-back",
    quarantinedVersions: [
      ...new Set([...state.quarantinedVersions, state.candidateVersion]),
    ],
    updatedAt: new Date().toISOString(),
    failure,
  };
  // Restored older binaries must never see a journal with fields their strict
  // parser does not know. Config is durable now; retain only legacy-compatible
  // restart intent until bootstrap succeeds, so a failed start remains retryable.
  await writeUpdateState(layout.updateStatePath, {
    ...rolledBack,
    recovery: {
      previousVersion: recovery.previousVersion,
      intent: recovery.intent,
      serviceWasLoaded: recovery.serviceWasLoaded,
    },
  });
  if (!serviceStartup && recovery.serviceWasLoaded) {
    await beforeStart?.();
    await launchAgent.bootstrap(layout.plistPath);
    if (!(await waitForLoadedService(launchAgent)))
      throw new Error("Recovered LaunchAgent failed to start");
  }
  await writeUpdateState(layout.updateStatePath, rolledBack);
  return true;
}

async function waitForLoadedService(
  launchAgent: Pick<MacLaunchAgentController, "status">,
): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = await launchAgent.status();
    if (status.loaded && status.running) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export async function loadMacUpdateTrust(
  path: string,
): Promise<Record<string, string>> {
  let record: Record<string, unknown>;
  try {
    record = await readPrivateRecord(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ...BUILT_IN_UPDATE_TRUST };
    throw error;
  }
  return parseUpdateTrust(record);
}

export async function loadUpdateState(path: string): Promise<UpdateState> {
  try {
    const record = await readPrivateRecord(path);
    const allowed = new Set([
      "schemaVersion",
      "highestSequence",
      "status",
      "knownGoodVersion",
      "candidateVersion",
      "quarantinedVersions",
      "updatedAt",
      "failure",
      "recovery",
    ]);
    if (
      Object.keys(record).some((key) => !allowed.has(key)) ||
      record.schemaVersion !== 1 ||
      !Number.isSafeInteger(record.highestSequence) ||
      (record.highestSequence as number) < 0 ||
      !["none", "staged", "activating", "healthy", "rolled-back"].includes(
        String(record.status),
      ) ||
      !Array.isArray(record.quarantinedVersions) ||
      record.quarantinedVersions.length > 100 ||
      record.quarantinedVersions.some(
        (value) =>
          typeof value !== "string" ||
          !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(value),
      ) ||
      new Set(record.quarantinedVersions).size !==
        record.quarantinedVersions.length ||
      typeof record.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(record.updatedAt)) ||
      (record.knownGoodVersion !== undefined &&
        (typeof record.knownGoodVersion !== "string" ||
          !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(
            record.knownGoodVersion,
          ))) ||
      (record.candidateVersion !== undefined &&
        (typeof record.candidateVersion !== "string" ||
          !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(
            record.candidateVersion,
          ))) ||
      (record.failure !== undefined &&
        (typeof record.failure !== "string" || record.failure.length > 240))
    )
      throw new TypeError("Update state is invalid");
    if (record.recovery !== undefined) {
      const recovery = record.recovery as Record<string, unknown>;
      if (
        !recovery ||
        typeof recovery !== "object" ||
        Array.isArray(recovery) ||
        Object.keys(recovery).some(
          (key) =>
            ![
              "previousVersion",
              "intent",
              "serviceWasLoaded",
              "runtimeConfig",
              "qualifiedRollback",
              "fleetDrained",
            ].includes(key),
        ) ||
        typeof recovery.previousVersion !== "string" ||
        !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(recovery.previousVersion) ||
        !["active", "paused", "draining"].includes(String(recovery.intent)) ||
        typeof recovery.serviceWasLoaded !== "boolean" ||
        (recovery.fleetDrained !== undefined &&
          recovery.fleetDrained !== true) ||
        (recovery.runtimeConfig !== undefined &&
          (recovery.runtimeConfig === null ||
            typeof recovery.runtimeConfig !== "object" ||
            Array.isArray(recovery.runtimeConfig) ||
            (recovery.runtimeConfig as Record<string, unknown>)
              .schemaVersion !== 1 ||
            "credential" in recovery.runtimeConfig))
      )
        throw new TypeError("Update recovery state is invalid");
      if (
        recovery.qualifiedRollback !== undefined &&
        recovery.qualifiedRollback !== null
      )
        validateMacQualifiedRollback(recovery.qualifiedRollback);
    }
    return record as unknown as UpdateState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      schemaVersion: 1,
      highestSequence: 0,
      status: "none",
      quarantinedVersions: [],
      updatedAt: new Date(0).toISOString(),
    };
  }
}

async function writeUpdateState(
  path: string,
  state: UpdateState,
): Promise<void> {
  if (Buffer.byteLength(JSON.stringify(state, null, 2), "utf8") + 1 > 64 * 1024)
    throw new TypeError("Update recovery journal is too large");
  await writePrivateRecord(path, state as unknown as Record<string, unknown>);
}

/** App qualification updates local known-good identity without resetting signed catalog sequence. */
export async function acceptMacAppKnownGood(
  layout: MacUserLayout,
  version: string,
): Promise<void> {
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(version))
    throw new TypeError("App worker update identity is invalid");
  const prior = await loadUpdateState(layout.updateStatePath);
  if (
    prior.recovery !== undefined ||
    prior.status === "staged" ||
    prior.status === "activating"
  )
    throw new TypeError("Signed worker update recovery must finish first");
  await writeUpdateState(layout.updateStatePath, {
    ...prior,
    status: "healthy",
    knownGoodVersion: version,
    candidateVersion: version,
    quarantinedVersions: prior.quarantinedVersions.filter(
      (value) => value !== version,
    ),
    updatedAt: new Date().toISOString(),
  });
}

export async function restoreMacAppUpdateState(
  layout: MacUserLayout,
  value: Record<string, unknown>,
): Promise<void> {
  validateMacAppUpdateState(value);
  await writeUpdateState(
    layout.updateStatePath,
    value as unknown as UpdateState,
  );
}

export function validateMacAppUpdateState(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("App worker update snapshot is invalid");
  const record = value as Record<string, unknown>;
  const allowed = [
    "schemaVersion",
    "highestSequence",
    "status",
    "knownGoodVersion",
    "candidateVersion",
    "quarantinedVersions",
    "updatedAt",
    "failure",
  ];
  if (
    record.schemaVersion !== 1 ||
    Object.keys(record).some((key) => !allowed.includes(key)) ||
    !Number.isSafeInteger(record.highestSequence) ||
    (record.highestSequence as number) < 0 ||
    !["none", "healthy", "rolled-back"].includes(String(record.status)) ||
    !Array.isArray(record.quarantinedVersions) ||
    record.quarantinedVersions.length > 100 ||
    record.quarantinedVersions.some(
      (version) => !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(String(version)),
    ) ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt))
  )
    throw new TypeError("App worker update snapshot is invalid");
  for (const field of ["knownGoodVersion", "candidateVersion"])
    if (
      record[field] !== undefined &&
      (typeof record[field] !== "string" ||
        !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(String(record[field])))
    )
      throw new TypeError("App worker update identity is invalid");
  if (
    record.failure !== undefined &&
    (typeof record.failure !== "string" || record.failure.length > 240)
  )
    throw new TypeError("App worker update snapshot is invalid");
}

async function writePrivateRecord(
  path: string,
  state: Record<string, unknown>,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readPrivateRecord(
  path: string,
): Promise<Record<string, unknown>> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > 64 * 1024 ||
    (info.mode & 0o077) !== 0
  )
    throw new TypeError("Private update file is unsafe");
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Private update file is invalid");
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 100 ||
    value.trim() !== value
  )
    throw new TypeError(`${label} is invalid`);
  return value;
}

async function sha256(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function assertUpdateDiskBudget(
  path: string,
  archiveBytes: number,
  availableDiskBytes?: () => Promise<number>,
): Promise<void> {
  const available = await (
    availableDiskBytes ??
    (async () => {
      const filesystem = await statfs(path);
      return filesystem.bavail * filesystem.bsize;
    })
  )();
  const required = archiveBytes * 3 + 512 * 1024 * 1024;
  if (!Number.isSafeInteger(available) || available < required)
    throw new Error("Insufficient disk space for verified update and rollback");
}

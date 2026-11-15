import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  ChildCommandError,
  sanitizeDiagnostic,
} from "../agent/child-process.js";
import type { ChildResponse } from "../agent/ipc/child-protocol.js";
import {
  ControlPlaneError,
  type WorkerControlPlaneClient,
  type WorkerFailureCode,
  type WorkerIdentity,
} from "./control-plane-client.js";
import {
  parseChildProcessResult,
  type Claim,
  type ConfigResponse,
  type ObjectIdentity,
  type OutputGrantResponse,
  type WorkerCommandResult,
  type WorkerRemoteCommand,
  type WorkerRecipeId,
} from "./contracts.js";
import { LeaseAuthority, OwnershipLostError } from "./lease-authority.js";
import {
  loadLocalLifecycle,
  localLifecycleAllowsClaims,
} from "./local-lifecycle.js";
import { writeLocalRuntimeStatus } from "./local-runtime-status.js";
import type { RuntimeJobSummary } from "./local-runtime-status.js";
import type { ChildProgress } from "../agent/ipc/child-progress.js";
import {
  DiagnosticSpool,
  type RuntimeDiagnostics,
} from "./diagnostic-spool.js";
import {
  RuntimeResourceGate,
  RuntimeResourceLimitError,
} from "./resource-limits.js";
import { TransferError, type WorkerTransferClient } from "./transfers.js";
import { WorkspaceManager, type AttemptWorkspace } from "./workspace.js";
import {
  AttemptProgressReporter,
  publicAttemptProgress,
} from "./progress-reporter.js";
import type { RuntimeCommandExecutor } from "./remote-command-executor.js";

export interface RuntimeSlotDefinition {
  workerId: string;
  gpuId: string;
  slotIndex: number;
  recipeIds: readonly WorkerRecipeId[];
  provider: "mps" | "directml";
  directmlDeviceId?: number;
}

export interface WorkerRuntimeOptions {
  machineId: string;
  slots: readonly RuntimeSlotDefinition[];
  workRoot: string;
  localLifecyclePath?: string;
  localRuntimeStatusPath?: string;
  modelCacheRoot: string;
  ffmpegPath: string;
  ffprobePath: string;
  leaseRenewIntervalMs?: number;
  leaseSafetyMarginMs?: number;
  idlePollMinimumMs?: number;
  idlePollMaximumMs?: number;
  uploadAttempts?: number;
  validatedMaxWorkersPerGpu?: 1 | 2;
  diagnostics?: RuntimeDiagnostics;
  resources?: Pick<RuntimeResourceGate, "assertAvailable">;
  commandExecutor?: RuntimeCommandExecutor;
  onEvent?: (event: RuntimeEvent) => void;
  hintClientFactory?: (onHint: () => void) => RuntimeHintClient;
}

export interface RuntimeHintClient {
  start(signal?: AbortSignal): void;
  stop(): Promise<void>;
}

interface AttemptEventIdentity {
  workerId: string;
  jobId: string;
  attemptId: string;
}

export type AttemptStage =
  | "resource-check"
  | "input-download"
  | ChildProgress["stage"]
  | "output-upload"
  | "completion";

type RuntimeEventInput =
  | { kind: "started" }
  | {
      kind: "model-ready";
      workerId: string;
      gpuId: string;
      provider: "mps" | "directml";
      childIncarnation: string;
      loadReason:
        | "initial-start"
        | "attempt-recovery"
        | "slot-recovery"
        | "remote-benchmark";
    }
  | ({
      kind: "attempt-started";
      attemptNumber: number;
      provider: "mps" | "directml";
      gpuId: string;
      recipeId: string;
      recipeDigest: string;
      modelDigest: string;
      outputBitrateKbps: number;
      groupSize: 1 | 2;
      modelLoadState: "preloaded";
      childIncarnation: string;
    } & AttemptEventIdentity)
  | ({
      kind: "attempt-progress";
      stage: AttemptStage;
      work?: NonNullable<ChildProgress["work"]>;
    } & AttemptEventIdentity)
  | ({
      kind: "attempt-succeeded";
      stageTimings: Array<{ stage: string; durationMs: number }>;
      measuredInputDurationSeconds: number;
      outputBytes: number;
      outputBitrateKbps: number;
    } & AttemptEventIdentity)
  | ({
      kind: "attempt-failed";
      code: string;
      stage: AttemptStage;
      retryable: boolean | null;
    } & AttemptEventIdentity)
  | ({
      kind: "attempt-stopped";
      code: string;
      stage: AttemptStage;
    } & AttemptEventIdentity)
  | ({
      kind: "transfer-failed" | "child-failed";
      code: string;
      detail: string;
      stage: AttemptStage;
    } & AttemptEventIdentity)
  | ({
      kind: "progress-sync-failed";
      code: string;
      stage: AttemptStage;
    } & AttemptEventIdentity)
  | ({ kind: "child-restarted" } & AttemptEventIdentity)
  | ({ kind: "resource-blocked"; code: string } & AttemptEventIdentity)
  | {
      kind: "child-unavailable";
      workerId: string;
      jobId?: string;
      attemptId?: string;
      code: string;
      detail: string;
    }
  | { kind: "child-recovered"; workerId: string }
  | {
      kind: "command-started" | "command-completed" | "command-report-deferred";
      code: string;
      detail: string;
    };

export type RuntimeEvent = RuntimeEventInput & {
  schemaVersion: 2;
  recordedAt: string;
  sequence: number;
  sessionId: string;
  incarnation: string;
  component: "worker-runtime";
  severity: "info" | "warning" | "error";
};

interface RuntimeControlPlane {
  openSession: WorkerControlPlaneClient["openSession"];
  config: WorkerControlPlaneClient["config"];
  applyConfig: WorkerControlPlaneClient["applyConfig"];
  registerSlot: WorkerControlPlaneClient["registerSlot"];
  claim: WorkerControlPlaneClient["claim"];
  renew: WorkerControlPlaneClient["renew"];
  inputGrant: WorkerControlPlaneClient["inputGrant"];
  outputGrant: WorkerControlPlaneClient["outputGrant"];
  progress?: WorkerControlPlaneClient["progress"];
  complete: WorkerControlPlaneClient["complete"];
  fail: WorkerControlPlaneClient["fail"];
  completeCommand: WorkerControlPlaneClient["completeCommand"];
}

interface RuntimeTransfers {
  download: WorkerTransferClient["download"];
  upload: WorkerTransferClient["upload"];
}

interface RuntimeSupervisor {
  start(
    onStage?: (workerId: string, stage: "loading" | "warming") => void,
  ): Promise<void>;
  stop(): Promise<void>;
  child(workerId: string): ProcessingChild;
  restart(
    workerId: string,
    onStage?: (workerId: string, stage: "loading" | "warming") => void,
  ): Promise<ProcessingChild>;
}

interface ProcessingChild {
  readonly incarnation: string;
  request(
    command: "ping" | "process",
    payload: Record<string, unknown>,
    timeoutMs?: number,
    onProgress?: (progress: ChildProgress) => void,
  ): Promise<ChildResponse>;
  terminateActive(): void;
  isProcessing(): boolean;
  diagnosticTail?(): string;
}

function eventSeverity(
  kind: RuntimeEventInput["kind"],
): RuntimeEvent["severity"] {
  if (
    kind === "attempt-failed" ||
    kind === "child-failed" ||
    kind === "transfer-failed" ||
    kind === "child-unavailable"
  )
    return "error";
  if (
    kind === "resource-blocked" ||
    kind === "attempt-stopped" ||
    kind === "progress-sync-failed" ||
    kind === "command-report-deferred"
  )
    return "warning";
  return "info";
}

class PublicationUncertainError extends Error {
  constructor() {
    super("Attempt publication could not be confirmed");
    this.name = "PublicationUncertainError";
  }
}

export class WorkerRuntime {
  readonly sessionId = randomUUID();
  readonly incarnation = randomUUID();
  private readonly workspace: WorkspaceManager;
  private readonly diagnostics: RuntimeDiagnostics;
  private readonly resources: Pick<RuntimeResourceGate, "assertAvailable">;
  private readonly busy = new Map<string, Promise<void>>();
  private readonly activeAttemptIds = new Map<string, string>();
  private readonly activeJobs = new Map<
    string,
    {
      attemptId: string;
      jobId: string;
      provider: "mps" | "directml";
      modelDigest: string;
      startedAt: string;
      stage: AttemptStage;
      stageStartedAt: string;
      lastProgressAt: string;
      work?: NonNullable<ChildProgress["work"]>;
    }
  >();
  private readonly lastProgressSnapshotAt = new Map<string, number>();
  private readonly pendingClaims = new Map<string, string>();
  private readonly unavailable = new Set<string>();
  private readonly childRecoveryAfter = new Map<string, number>();
  private readonly pendingCommandResults = new Map<
    string,
    { requestId: string; result: WorkerCommandResult }
  >();
  private readonly stopping = new AbortController();
  private readonly hintClient: RuntimeHintClient | undefined;
  private machineId = "";
  private childState:
    "loading" | "warming" | "ready" | "unavailable" | "stopped" = "loading";
  private cachedPolicy?: {
    machineStatus: ConfigResponse["machineStatus"];
    claimAllowed: boolean;
    revision: number;
    observedAt: string;
  };
  private statusWrites: Promise<void> = Promise.resolve();
  private lastSuccessfulJob?: RuntimeJobSummary;
  private lastFailedJob?: RuntimeJobSummary & { code: string };
  private started = false;
  private wakeResolver: (() => void) | null = null;
  private wakeGeneration = 0;
  private eventSequence = 0;

  constructor(
    private readonly options: WorkerRuntimeOptions,
    private readonly control: RuntimeControlPlane,
    private readonly transfers: RuntimeTransfers,
    private readonly supervisor: RuntimeSupervisor,
  ) {
    validateOptions(options);
    this.workspace = new WorkspaceManager(options.workRoot);
    this.diagnostics =
      options.diagnostics ??
      new DiagnosticSpool(join(dirname(options.workRoot), "logs"));
    this.resources =
      options.resources ?? new RuntimeResourceGate(options.workRoot);
    this.hintClient = options.hintClientFactory?.(() =>
      this.hintAvailableWork(),
    );
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("Worker runtime has already started");
    await this.diagnostics.initialize();
    await this.workspace.initialize();
    this.childState = "loading";
    await this.publishLocalStatus();
    try {
      await this.supervisor.start((_workerId, stage) => {
        this.childState = stage;
        void this.publishLocalStatus().catch(() => undefined);
      });
      this.childState = "ready";
      for (const slot of this.options.slots)
        this.emitModelReady(slot, "initial-start");
    } catch (error) {
      this.childState = "unavailable";
      await this.publishLocalStatus();
      throw error;
    }
    try {
      const session = await this.control.openSession(
        this.sessionId,
        this.incarnation,
        this.stopping.signal,
      );
      if (session.machineId !== this.options.machineId)
        throw new Error("Machine credential resolved to an unexpected machine");
      this.machineId = session.machineId;
      await this.synchronizeConfig();
      for (const slot of this.options.slots) {
        await this.control.registerSlot(
          this.identity(slot),
          slot.gpuId,
          slot.slotIndex,
          slot.recipeIds,
          this.stopping.signal,
        );
      }
      this.started = true;
      this.hintClient?.start(this.stopping.signal);
      await this.publishLocalStatus();
      this.emit({ kind: "started" });
    } catch (error) {
      await this.hintClient?.stop();
      await this.supervisor.stop();
      throw error;
    }
  }

  async run(signal?: AbortSignal): Promise<void> {
    const onAbort = () => void this.stop();
    signal?.addEventListener("abort", onAbort, { once: true });
    let lifecycleWatcher: FSWatcher | undefined;
    try {
      if (!this.started) await this.start();
      if (this.options.localLifecyclePath !== undefined) {
        const lifecyclePath = this.options.localLifecyclePath;
        try {
          lifecycleWatcher = watch(
            dirname(lifecyclePath),
            (_event, filename) => {
              if (
                filename === null ||
                String(filename) === basename(lifecyclePath)
              )
                this.wake();
            },
          );
          lifecycleWatcher.on("error", () => lifecycleWatcher?.close());
        } catch {
          // The bounded idle poll remains the fallback when watching is unavailable.
        }
      }
      while (!this.stopping.signal.aborted) {
        const wakeGeneration = this.wakeGeneration;
        await this.reconcileOnce();
        if (this.stopping.signal.aborted) break;
        await this.waitForWake(
          randomPollDelay(this.options),
          wakeGeneration,
          this.stopping.signal,
        );
      }
    } finally {
      lifecycleWatcher?.close();
      signal?.removeEventListener("abort", onAbort);
      await this.stop();
    }
  }

  async reconcileOnce(): Promise<number> {
    this.assertStarted();
    if (this.stopping.signal.aborted) return 0;
    const config = await this.synchronizeConfig();
    await this.publishLocalStatus();
    await this.processRemoteCommands(config);
    await this.recoverChildren();
    await this.publishLocalStatus();
    if (!(await this.diagnostics.canAdmitJobs())) return 0;
    const idle = this.options.slots.filter(
      (slot) =>
        !this.busy.has(slot.workerId) && !this.unavailable.has(slot.workerId),
    );
    if (idle.length === 0) return 0;
    if (!config.claimAllowed) return 0;
    if (this.options.localLifecyclePath !== undefined) {
      const lifecycle = await loadLocalLifecycle(
        this.options.localLifecyclePath,
      );
      if (!localLifecycleAllowsClaims(lifecycle)) return 0;
    }
    let claimed = 0;
    for (const slot of idle) {
      const requestId = this.pendingClaims.get(slot.workerId) ?? randomUUID();
      this.pendingClaims.set(slot.workerId, requestId);
      const response = await this.control.claim(
        this.identity(slot),
        slot.gpuId,
        slot.slotIndex,
        config.appliedRevision,
        requestId,
        this.stopping.signal,
      );
      this.pendingClaims.delete(slot.workerId);
      if (!response.claim) continue;
      claimed += 1;
      const startedAt = new Date().toISOString();
      this.activeAttemptIds.set(slot.workerId, response.claim.attemptId);
      this.activeJobs.set(slot.workerId, {
        attemptId: response.claim.attemptId,
        jobId: response.claim.jobId,
        provider: slot.provider,
        modelDigest: response.claim.recipe.modelDigest,
        startedAt,
        stage: "resource-check",
        stageStartedAt: startedAt,
        lastProgressAt: startedAt,
      });
      const attempt = this.executeAttempt(
        slot,
        response.claim,
        response.serverTime,
      )
        .catch(() => undefined)
        .finally(async () => {
          this.busy.delete(slot.workerId);
          this.activeAttemptIds.delete(slot.workerId);
          this.activeJobs.delete(slot.workerId);
          this.lastProgressSnapshotAt.delete(slot.workerId);
          await this.publishLocalStatus();
          this.wake();
        });
      this.busy.set(slot.workerId, attempt);
      await this.publishLocalStatus();
    }
    return claimed;
  }

  hintAvailableWork(): void {
    this.wake();
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled(this.busy.values());
  }

  async stop(): Promise<void> {
    if (!this.stopping.signal.aborted)
      this.stopping.abort(new OwnershipLostError("runtime-stopping"));
    this.wake();
    for (const slot of this.options.slots) {
      if (this.busy.has(slot.workerId))
        this.supervisor.child(slot.workerId).terminateActive();
    }
    await this.waitForIdle();
    await this.hintClient?.stop();
    await this.supervisor.stop();
    this.childState = "stopped";
    await this.publishLocalStatus();
    await this.diagnostics.flush();
    this.started = false;
  }

  private async publishLocalStatus(): Promise<void> {
    if (this.options.localRuntimeStatusPath === undefined) return;
    const path = this.options.localRuntimeStatusPath;
    const attemptIds = [...this.activeAttemptIds.values()];
    const coverage = this.diagnostics.coverage?.();
    const details = {
      currentAttempts: [...this.activeJobs].map(([workerId, attempt]) => ({
        workerId,
        ...attempt,
      })),
      childState: this.childState,
      sessionId: this.sessionId,
      incarnation: this.incarnation,
      processId: process.pid,
      slots: this.options.slots.map((slot) => ({
        workerId: slot.workerId,
        gpuId: slot.gpuId,
        provider: slot.provider,
      })),
      ...(this.cachedPolicy === undefined
        ? {}
        : { cachedPolicy: this.cachedPolicy }),
      ...(coverage === undefined
        ? {}
        : {
            diagnostics: {
              blockedReason: coverage.blockedReason,
              earliestAvailableAt: coverage.earliestAvailableAt,
              incompleteHistory: coverage.incompleteHistory,
              retainedBytes: coverage.retainedBytes,
            },
          }),
      ...(this.lastSuccessfulJob === undefined
        ? {}
        : { lastSuccessfulJob: this.lastSuccessfulJob }),
      ...(this.lastFailedJob === undefined
        ? {}
        : { lastFailedJob: this.lastFailedJob }),
    };
    const write = this.statusWrites.then(async () => {
      await writeLocalRuntimeStatus(path, attemptIds, details);
    });
    this.statusWrites = write.catch(() => undefined);
    await write;
  }

  private async synchronizeConfig(): Promise<ConfigResponse> {
    let config = await this.control.config(
      this.sessionId,
      this.incarnation,
      this.stopping.signal,
    );
    if (config.machineId !== this.machineId)
      throw new Error("Worker configuration machine identity changed");
    if (
      config.desiredRevision !== config.policy.revision ||
      config.appliedRevision > config.desiredRevision
    )
      throw new Error("Worker configuration revisions are inconsistent");
    if (config.appliedRevision !== config.desiredRevision) {
      await this.control.applyConfig(
        this.sessionId,
        this.incarnation,
        config.desiredRevision,
        this.stopping.signal,
      );
      config = await this.control.config(
        this.sessionId,
        this.incarnation,
        this.stopping.signal,
      );
      if (
        config.machineId !== this.machineId ||
        config.appliedRevision !== config.desiredRevision ||
        config.desiredRevision !== config.policy.revision
      )
        throw new Error(
          "Worker configuration acknowledgement did not converge",
        );
    }
    this.cachedPolicy = {
      machineStatus: config.machineStatus,
      claimAllowed: config.claimAllowed,
      revision: config.appliedRevision,
      observedAt: new Date().toISOString(),
    };
    return config;
  }

  private async executeAttempt(
    slot: RuntimeSlotDefinition,
    claim: Claim,
    serverTime: string,
  ): Promise<void> {
    const identity = this.identity(slot);
    const authority = new LeaseAuthority(
      serverTime,
      claim.leaseExpiresAt,
      claim.deadlineAt,
      this.options.leaseSafetyMarginMs ?? 5_000,
    );
    const controller = new AbortController();
    const child = this.supervisor.child(slot.workerId);
    let workspace: AttemptWorkspace | null = null;
    let terminal = false;
    let childTerminated = false;
    const lose = (reason: string) => {
      if (terminal || controller.signal.aborted) return;
      authority.lose(reason);
      if (child.isProcessing()) {
        childTerminated = true;
        child.terminateActive();
      }
      controller.abort(new OwnershipLostError(reason));
    };
    const stopListener = () => lose("runtime-stopping");
    this.stopping.signal.addEventListener("abort", stopListener, {
      once: true,
    });
    const watchdog = this.watchAuthority(authority, controller.signal, lose);
    const renewal = this.renewAttempt(
      identity,
      claim,
      authority,
      controller.signal,
      lose,
    );
    this.emit({
      kind: "attempt-started",
      workerId: slot.workerId,
      jobId: claim.jobId,
      attemptId: claim.attemptId,
      attemptNumber: claim.attemptNumber,
      provider: slot.provider,
      gpuId: slot.gpuId,
      recipeId: claim.recipe.recipeId,
      recipeDigest: claim.recipe.recipeDigest,
      modelDigest: claim.recipe.modelDigest,
      outputBitrateKbps: claim.recipe.outputBitrateKbps,
      groupSize: slot.provider === "mps" ? 2 : 1,
      modelLoadState: "preloaded",
      childIncarnation: child.incarnation,
    });
    let downloadMs: number | null = null;
    let uploadMs: number | null = null;
    let completionMs: number | null = null;
    let currentStage: AttemptStage = "resource-check";
    const progressReporter = new AttemptProgressReporter(
      async (update) => {
        if (this.control.progress)
          await this.control.progress(
            claim.attemptId,
            identity,
            update,
            controller.signal,
          );
      },
      (error) => {
        if (controller.signal.aborted || terminal) return;
        this.emit({
          kind: "progress-sync-failed",
          workerId: slot.workerId,
          jobId: claim.jobId,
          attemptId: claim.attemptId,
          stage: currentStage,
          code:
            error instanceof ControlPlaneError
              ? error.code
              : "PROGRESS_SYNC_FAILED",
        });
      },
    );
    const enterStage = (stage: AttemptStage, work?: ChildProgress["work"]) => {
      if (controller.signal.aborted || terminal) return;
      const previousStage = currentStage;
      currentStage = stage;
      const active = this.activeJobs.get(slot.workerId);
      if (active) {
        const now = new Date().toISOString();
        const firstObservedWork =
          work !== undefined && active.work === undefined;
        active.stage = stage;
        if (previousStage !== stage) active.stageStartedAt = now;
        active.lastProgressAt = now;
        if (work !== undefined) active.work = work;
        else if (previousStage !== stage) delete active.work;
        if (
          previousStage !== stage ||
          firstObservedWork ||
          Date.now() - (this.lastProgressSnapshotAt.get(slot.workerId) ?? 0) >=
            5_000 ||
          (work !== undefined && work.completed === work.total)
        ) {
          this.lastProgressSnapshotAt.set(slot.workerId, Date.now());
          void this.publishLocalStatus().catch(() => undefined);
        }
      }
      this.emit({
        kind: "attempt-progress",
        workerId: slot.workerId,
        jobId: claim.jobId,
        attemptId: claim.attemptId,
        stage,
        ...(work === undefined ? {} : { work }),
      });
      progressReporter.update(publicAttemptProgress(stage, work));
    };
    try {
      enterStage("resource-check");
      await this.resources.assertAvailable(claim.input.bytes);
      workspace = await this.workspace.create(
        claim.attemptId,
        claim.input.contentType,
      );
      const input = await this.control.inputGrant(
        claim.attemptId,
        identity,
        controller.signal,
      );
      if (!sameObject(input.object, claim.input))
        throw new TransferError("DOWNLOAD_FAILED", false);
      enterStage("input-download");
      const downloadStarted = performance.now();
      await this.transfers.download(
        input.grant,
        claim.input,
        workspace.input,
        controller.signal,
      );
      downloadMs = Math.max(0, performance.now() - downloadStarted);
      authority.assertCurrent();

      let childResponse: ChildResponse;
      try {
        childResponse = await child.request(
          "process",
          {
            attemptId: claim.attemptId,
            attemptDirectory: workspace.root,
            input: {
              path: workspace.input,
              bytes: claim.input.bytes,
              sha256: claim.input.sha256,
            },
            modelCacheRoot: this.options.modelCacheRoot,
            provider: slot.provider,
            directmlDeviceId: slot.directmlDeviceId ?? 0,
            ffmpegPath: this.options.ffmpegPath,
            ffprobePath: this.options.ffprobePath,
            recipe: claim.recipe,
          },
          Math.max(
            100,
            Math.min(7_200_000, Math.floor(authority.deadlineRemainingMs())),
          ),
          (progress) => enterStage(progress.stage, progress.work),
        );
      } catch (error) {
        if (error instanceof ChildCommandError) {
          this.emit({
            kind: "child-failed",
            workerId: slot.workerId,
            jobId: claim.jobId,
            attemptId: claim.attemptId,
            stage: currentStage,
            code: error.code,
            detail: sanitizeDiagnostic(error.summary ?? "child-command-error"),
          });
        } else {
          childTerminated = true;
          if (!controller.signal.aborted && !this.stopping.signal.aborted) {
            this.emit({
              kind: "child-failed",
              workerId: slot.workerId,
              jobId: claim.jobId,
              attemptId: claim.attemptId,
              stage: currentStage,
              code: "child-process-failed",
              detail: safeChildDiagnostic(error, child),
            });
          }
        }
        throw error;
      }
      if (childResponse.type !== "result")
        throw new TransferError("OUTPUT_UPLOAD_FAILED", false);
      const result = parseChildProcessResult(childResponse.payload);
      assertChildResult(result, claim, workspace);
      await assertSafeOutput(result.outputPath, workspace.output);
      authority.assertCurrent();

      enterStage("output-upload");
      const uploadStarted = performance.now();
      const versionId = await this.publishOutput(
        identity,
        claim,
        result,
        authority,
        controller.signal,
      );
      uploadMs = Math.max(0, performance.now() - uploadStarted);
      authority.assertCurrent();
      enterStage("completion");
      const completionStarted = performance.now();
      try {
        await this.control.complete(
          claim.attemptId,
          identity,
          {
            versionId,
            recipeId: result.recipeId,
            recipeRevision: result.recipeRevision,
            recipeDigest: result.recipeDigest,
            modelDigest: result.modelDigest,
            trimEnabled: result.trimEnabled,
            denoiseEnabled: result.denoiseEnabled,
            outputFormat: result.outputFormat,
            outputBitrateKbps: result.outputBitrateKbps,
            stageTimings: result.stageTimings,
          },
          controller.signal,
        );
        completionMs = Math.max(0, performance.now() - completionStarted);
      } catch (error) {
        if (isOwnershipRejection(error)) throw error;
        throw new PublicationUncertainError();
      }
      terminal = true;
      this.lastSuccessfulJob = {
        jobId: claim.jobId,
        attemptId: claim.attemptId,
        at: new Date().toISOString(),
      };
      this.emit({
        kind: "attempt-succeeded",
        workerId: slot.workerId,
        jobId: claim.jobId,
        attemptId: claim.attemptId,
        stageTimings: [
          ...result.stageTimings,
          ...(result.separationTimings ?? []),
          ...(downloadMs === null
            ? []
            : [{ stage: "download", durationMs: downloadMs }]),
          ...(uploadMs === null
            ? []
            : [{ stage: "upload", durationMs: uploadMs }]),
          ...(completionMs === null
            ? []
            : [{ stage: "completionAck", durationMs: completionMs }]),
        ],
        measuredInputDurationSeconds: result.measuredInputDurationSeconds,
        outputBytes: result.bytes,
        outputBitrateKbps: result.outputBitrateKbps,
      });
    } catch (error) {
      if (error instanceof RuntimeResourceLimitError) {
        this.unavailable.add(slot.workerId);
        this.emit({
          kind: "resource-blocked",
          workerId: slot.workerId,
          jobId: claim.jobId,
          attemptId: claim.attemptId,
          code: error.resource,
        });
      }
      if (
        error instanceof OwnershipLostError ||
        error instanceof PublicationUncertainError ||
        isOwnershipRejection(error) ||
        controller.signal.aborted ||
        this.stopping.signal.aborted
      ) {
        this.emit({
          kind: "attempt-stopped",
          workerId: slot.workerId,
          jobId: claim.jobId,
          attemptId: claim.attemptId,
          code:
            error instanceof PublicationUncertainError
              ? "completion-uncertain"
              : isOwnershipRejection(error)
                ? "ownership-rejected"
                : ownershipCode(error, controller.signal.reason),
          stage: currentStage,
        });
      } else {
        const failure = failureFor(error);
        this.lastFailedJob = {
          jobId: claim.jobId,
          attemptId: claim.attemptId,
          code: failure.code,
          at: new Date().toISOString(),
        };
        if (error instanceof TransferError) {
          this.emit({
            kind: "transfer-failed",
            workerId: slot.workerId,
            jobId: claim.jobId,
            attemptId: claim.attemptId,
            stage: currentStage,
            code: error.code,
            detail: sanitizeDiagnostic(error.diagnostic ?? "transfer-failed"),
          });
        }
        try {
          authority.assertCurrent();
          await this.control.fail(
            claim.attemptId,
            identity,
            failure,
            controller.signal,
          );
          terminal = true;
        } catch (failureError) {
          if (!isOwnershipRejection(failureError)) throw failureError;
        }
        this.emit({
          kind: "attempt-failed",
          workerId: slot.workerId,
          jobId: claim.jobId,
          attemptId: claim.attemptId,
          code: failure.code,
          stage: currentStage,
          retryable: error instanceof TransferError ? error.retryable : null,
        });
      }
    } finally {
      terminal = true;
      progressReporter.close();
      controller.abort(new OwnershipLostError("attempt-finished"));
      this.stopping.signal.removeEventListener("abort", stopListener);
      await Promise.allSettled([watchdog, renewal]);
      if (workspace) await this.workspace.cleanup(workspace);
      if (childTerminated && !this.stopping.signal.aborted) {
        try {
          await this.supervisor.restart(slot.workerId, (_workerId, stage) => {
            this.childState = stage;
            void this.publishLocalStatus().catch(() => undefined);
          });
          this.childState = "ready";
          await this.publishLocalStatus();
          this.emitModelReady(slot, "attempt-recovery");
          this.emit({
            kind: "child-restarted",
            workerId: slot.workerId,
            jobId: claim.jobId,
            attemptId: claim.attemptId,
          });
        } catch (error) {
          this.unavailable.add(slot.workerId);
          this.childState = "unavailable";
          this.childRecoveryAfter.set(slot.workerId, Date.now() + 5_000);
          this.emit({
            kind: "child-unavailable",
            workerId: slot.workerId,
            jobId: claim.jobId,
            attemptId: claim.attemptId,
            code: "child-restart-failed",
            detail: safeChildDiagnostic(error, child),
          });
        }
      }
    }
  }

  private async publishOutput(
    identity: WorkerIdentity,
    claim: Claim,
    output: ReturnType<typeof parseChildProcessResult>,
    authority: LeaseAuthority,
    signal: AbortSignal,
  ): Promise<string> {
    const maximum = this.options.uploadAttempts ?? 3;
    let lastError: unknown;
    for (let attempt = 0; attempt < maximum; attempt += 1) {
      authority.assertCurrent();
      const response = await this.control.outputGrant(
        claim.attemptId,
        identity,
        {
          bytes: output.bytes,
          sha256: output.sha256,
          contentType: output.contentType,
          measuredDurationSeconds: output.measuredOutputDurationSeconds,
        },
        signal,
      );
      assertReservation(response, output);
      if (response.object) {
        if (!sameOutput(response.object, response.reservation))
          throw new TransferError("OUTPUT_UPLOAD_FAILED", false);
        return response.object.versionId;
      }
      try {
        return await this.transfers.upload(
          response.grant!,
          output.outputPath,
          output,
          signal,
        );
      } catch (error) {
        lastError = error;
        if (!(error instanceof TransferError) || !error.retryable) throw error;
      }
    }
    throw lastError ?? new TransferError("OUTPUT_UPLOAD_FAILED", true);
  }

  private async processRemoteCommands(config: ConfigResponse): Promise<void> {
    const executor = this.options.commandExecutor;
    if (!executor) return;
    const serverTime = Date.parse(config.serverTime);
    for (const command of config.commands) {
      if (Date.parse(command.expiresAt) <= serverTime) continue;
      if (command.kind === "benchmark" && this.busy.size > 0) continue;
      let pending = this.pendingCommandResults.get(command.commandId);
      if (!pending) {
        this.emit({
          kind: "command-started",
          code: command.kind,
          detail: command.commandId,
        });
        const result = await this.executeRemoteCommand(executor, command);
        pending = { requestId: randomUUID(), result };
        this.pendingCommandResults.set(command.commandId, pending);
      }
      try {
        await this.control.completeCommand(
          command.commandId,
          this.sessionId,
          this.incarnation,
          pending.requestId,
          pending.result,
          this.stopping.signal,
        );
        this.pendingCommandResults.delete(command.commandId);
        this.emit({
          kind: "command-completed",
          code: pending.result.outcome,
          detail: command.commandId,
        });
      } catch (error) {
        if (
          error instanceof ControlPlaneError &&
          ["WORKER_EXPIRED", "WORKER_CONFLICT"].includes(error.code)
        )
          this.pendingCommandResults.delete(command.commandId);
        this.emit({
          kind: "command-report-deferred",
          code:
            error instanceof ControlPlaneError ? error.code : "report-failed",
          detail: command.commandId,
        });
      }
    }
  }

  private async executeRemoteCommand(
    executor: RuntimeCommandExecutor,
    command: WorkerRemoteCommand,
  ): Promise<WorkerCommandResult> {
    if (command.kind !== "benchmark")
      return executor.execute(command, this.stopping.signal);
    await this.supervisor.stop();
    let result: WorkerCommandResult;
    let childrenAvailable = true;
    try {
      result = await executor.execute(command, this.stopping.signal);
    } finally {
      if (!this.stopping.signal.aborted) {
        try {
          await this.supervisor.start();
          this.childState = "ready";
          for (const slot of this.options.slots)
            this.emitModelReady(slot, "remote-benchmark");
          this.unavailable.clear();
          this.childRecoveryAfter.clear();
        } catch {
          childrenAvailable = false;
          this.childState = "unavailable";
          for (const slot of this.options.slots) {
            this.unavailable.add(slot.workerId);
            this.childRecoveryAfter.set(slot.workerId, Date.now() + 5_000);
          }
        }
      }
    }
    if (!childrenAvailable)
      return {
        outcome: "failed",
        summary: "Benchmark finished but worker child recovery failed",
        metrics: [],
      };
    return result;
  }

  private async recoverChildren(): Promise<void> {
    const now = Date.now();
    for (const [workerId, retryAt] of this.childRecoveryAfter) {
      if (retryAt > now || this.busy.has(workerId)) continue;
      try {
        await this.supervisor.restart(workerId, (_workerId, stage) => {
          this.childState = stage;
          void this.publishLocalStatus().catch(() => undefined);
        });
        this.unavailable.delete(workerId);
        this.childState = "ready";
        this.childRecoveryAfter.delete(workerId);
        const slot = this.options.slots.find(
          (candidate) => candidate.workerId === workerId,
        );
        if (slot) this.emitModelReady(slot, "slot-recovery");
        this.emit({ kind: "child-recovered", workerId });
      } catch (error) {
        this.childRecoveryAfter.set(workerId, now + 30_000);
        this.emit({
          kind: "child-unavailable",
          workerId,
          code: "child-recovery-failed",
          detail: sanitizeDiagnostic(
            error instanceof Error ? error.message : "Child recovery failed",
          ).slice(-2_000),
        });
      }
    }
  }

  private async renewAttempt(
    identity: WorkerIdentity,
    claim: Claim,
    authority: LeaseAuthority,
    signal: AbortSignal,
    lose: (reason: string) => void,
  ): Promise<void> {
    const interval = this.options.leaseRenewIntervalMs ?? 20_000;
    while (!signal.aborted) {
      try {
        await abortableDelay(
          Math.max(
            100,
            Math.min(interval, Math.floor(authority.remainingMs() / 3)),
          ),
          signal,
        );
        authority.assertCurrent();
        const started = authority.sample();
        const response = await this.control.renew(
          this.sessionId,
          this.incarnation,
          [
            {
              jobId: claim.jobId,
              attemptId: claim.attemptId,
              workerId: identity.workerId,
            },
          ],
          signal,
        );
        const result = response.results[0];
        if (
          response.results.length !== 1 ||
          !result ||
          result.jobId !== claim.jobId ||
          result.attemptId !== claim.attemptId
        ) {
          lose("renewal-response-invalid");
          return;
        }
        if (result.disposition !== "accepted" || !result.leaseExpiresAt) {
          lose(result.disposition);
          return;
        }
        authority.refresh(response.serverTime, result.leaseExpiresAt, started);
      } catch (error) {
        if (signal.aborted) return;
        if (isImmediateOwnershipLoss(error)) {
          lose("renewal-rejected");
          return;
        }
        await abortableDelay(
          Math.max(
            100,
            Math.min(1_000, Math.floor(authority.remainingMs() / 4)),
          ),
          signal,
        ).catch(() => undefined);
      }
    }
  }

  private async watchAuthority(
    authority: LeaseAuthority,
    signal: AbortSignal,
    lose: (reason: string) => void,
  ): Promise<void> {
    while (!signal.aborted) {
      const remaining = authority.remainingMs();
      if (remaining <= 0) {
        lose("authority-window-expired");
        return;
      }
      await abortableDelay(
        Math.max(10, Math.min(1_000, remaining)),
        signal,
      ).catch(() => undefined);
    }
  }

  private identity(slot: RuntimeSlotDefinition): WorkerIdentity {
    return {
      workerId: slot.workerId,
      sessionId: this.sessionId,
      incarnation: this.incarnation,
    };
  }

  private emitModelReady(
    slot: RuntimeSlotDefinition,
    loadReason: Extract<
      RuntimeEventInput,
      { kind: "model-ready" }
    >["loadReason"],
  ): void {
    this.emit({
      kind: "model-ready",
      workerId: slot.workerId,
      gpuId: slot.gpuId,
      provider: slot.provider,
      childIncarnation: this.supervisor.child(slot.workerId).incarnation,
      loadReason,
    });
  }

  private emit(event: RuntimeEventInput): void {
    const record: RuntimeEvent = {
      schemaVersion: 2,
      recordedAt: new Date().toISOString(),
      sequence: ++this.eventSequence,
      sessionId: this.sessionId,
      incarnation: this.incarnation,
      component: "worker-runtime",
      severity: eventSeverity(event.kind),
      ...event,
    };
    this.options.onEvent?.(record);
    this.diagnostics.record(record);
  }

  private wake(): void {
    this.wakeGeneration += 1;
    this.wakeResolver?.();
    this.wakeResolver = null;
  }

  private async waitForWake(
    milliseconds: number,
    observedGeneration: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.wakeGeneration !== observedGeneration) return;
    await Promise.race([
      abortableDelay(milliseconds, signal),
      new Promise<void>((resolveWake) => {
        this.wakeResolver = resolveWake;
        if (this.wakeGeneration !== observedGeneration) resolveWake();
      }),
    ]).catch(() => undefined);
    this.wakeResolver = null;
  }

  private assertStarted(): void {
    if (!this.started) throw new Error("Worker runtime is not started");
  }
}

function validateOptions(options: WorkerRuntimeOptions): void {
  if (options.slots.length === 0 || options.slots.length > 16)
    throw new TypeError("Worker runtime requires 1 to 16 slots");
  if (
    new Set(options.slots.map((slot) => slot.workerId)).size !==
    options.slots.length
  )
    throw new TypeError("Worker runtime slot IDs must be unique");
  const validatedMaxWorkersPerGpu = options.validatedMaxWorkersPerGpu ?? 1;
  const perGpu = new Map<string, Set<number>>();
  for (const slot of options.slots) {
    const indexes = perGpu.get(slot.gpuId) ?? new Set<number>();
    if (indexes.has(slot.slotIndex))
      throw new TypeError("Worker runtime slot indexes must be unique per GPU");
    indexes.add(slot.slotIndex);
    if (indexes.size > validatedMaxWorkersPerGpu)
      throw new TypeError("Worker runtime exceeds validated GPU capacity");
    perGpu.set(slot.gpuId, indexes);
  }
  for (const path of [
    options.workRoot,
    options.modelCacheRoot,
    options.ffmpegPath,
    options.ffprobePath,
    ...(options.localLifecyclePath === undefined
      ? []
      : [options.localLifecyclePath]),
    ...(options.localRuntimeStatusPath === undefined
      ? []
      : [options.localRuntimeStatusPath]),
  ]) {
    if (resolve(path) !== path)
      throw new TypeError("Worker runtime paths must be absolute");
  }
  boundedRuntimeInteger(options.leaseRenewIntervalMs ?? 20_000, 100, 60_000);
  boundedRuntimeInteger(options.leaseSafetyMarginMs ?? 5_000, 100, 30_000);
  const minimum = boundedRuntimeInteger(
    options.idlePollMinimumMs ?? 60_000,
    100,
    300_000,
  );
  const maximum = boundedRuntimeInteger(
    options.idlePollMaximumMs ?? 120_000,
    minimum,
    300_000,
  );
  if (minimum > maximum) throw new TypeError("Worker poll range is invalid");
  boundedRuntimeInteger(options.uploadAttempts ?? 3, 1, 5);
}

function boundedRuntimeInteger(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new TypeError("Worker runtime interval is invalid");
  return value;
}

function randomPollDelay(options: WorkerRuntimeOptions): number {
  const minimum = options.idlePollMinimumMs ?? 60_000;
  const maximum = options.idlePollMaximumMs ?? 120_000;
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

function sameObject(left: ObjectIdentity, right: ObjectIdentity): boolean {
  return (
    left.key === right.key &&
    left.versionId === right.versionId &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256 &&
    left.contentType === right.contentType
  );
}

function assertChildResult(
  output: ReturnType<typeof parseChildProcessResult>,
  claim: Claim,
  workspace: AttemptWorkspace,
): void {
  if (
    output.attemptId !== claim.attemptId ||
    resolve(output.outputPath) !== resolve(workspace.output) ||
    output.recipeId !== claim.recipe.recipeId ||
    output.recipeRevision !== claim.recipe.recipeRevision ||
    output.recipeDigest !== claim.recipe.recipeDigest ||
    output.modelDigest !== claim.recipe.modelDigest ||
    output.trimEnabled !== claim.recipe.trimEnabled ||
    output.denoiseEnabled !== claim.recipe.denoiseEnabled ||
    output.outputFormat !== claim.recipe.outputFormat ||
    output.outputBitrateKbps > claim.recipe.outputBitrateKbps ||
    output.outputBitrateKbps < 32
  )
    throw new TransferError("OUTPUT_UPLOAD_FAILED", false);
}

async function assertSafeOutput(
  actual: string,
  expected: string,
): Promise<void> {
  const information = await lstat(actual).catch(() => null);
  if (
    !information?.isFile() ||
    information.isSymbolicLink() ||
    (await realpath(actual)) !== resolve(expected)
  )
    throw new TransferError("OUTPUT_UPLOAD_FAILED", false);
}

function assertReservation(
  response: OutputGrantResponse,
  output: ReturnType<typeof parseChildProcessResult>,
): void {
  if (
    response.reservation.bytes !== output.bytes ||
    response.reservation.sha256 !== output.sha256 ||
    response.reservation.contentType !== output.contentType ||
    response.reservation.measuredDurationSeconds !==
      output.measuredOutputDurationSeconds
  )
    throw new TransferError("OUTPUT_UPLOAD_FAILED", false);
}

function sameOutput(
  object: ObjectIdentity,
  reservation: OutputGrantResponse["reservation"],
): boolean {
  return (
    object.key === reservation.key &&
    object.bytes === reservation.bytes &&
    object.sha256 === reservation.sha256 &&
    object.contentType === reservation.contentType
  );
}

function failureFor(error: unknown): {
  code: WorkerFailureCode;
  summary: string;
} {
  if (error instanceof TransferError)
    return { code: error.code, summary: safeFailureSummary(error.code) };
  if (error instanceof ChildCommandError) {
    const code = childFailureCode(error.code);
    return { code, summary: safeFailureSummary(code) };
  }
  return { code: "SEPARATOR_FAILED", summary: "Worker processing failed" };
}

function safeChildDiagnostic(error: unknown, child: ProcessingChild): string {
  const message =
    error instanceof Error ? error.message : "Worker child failed";
  const tail = child.diagnosticTail?.().trim();
  const safeMessage = sanitizeDiagnostic(message).slice(0, 500);
  const safeTail = tail ? sanitizeDiagnostic(tail).slice(-1_400) : "";
  return safeTail ? `${safeMessage}\n${safeTail}` : safeMessage;
}

function childFailureCode(code: string): WorkerFailureCode {
  if (
    code === "INVALID_AUDIO" ||
    code === "INPUT_TOO_LONG" ||
    code === "INPUT_CHECKSUM_MISMATCH" ||
    code === "OUTPUT_INVALID"
  )
    return code;
  return "SEPARATOR_FAILED";
}

function safeFailureSummary(code: WorkerFailureCode): string {
  const summaries: Record<WorkerFailureCode, string> = {
    INVALID_AUDIO: "The assigned input is not valid audio",
    INPUT_TOO_LONG: "The assigned input exceeds the processing limit",
    INPUT_CHECKSUM_MISMATCH: "The assigned input identity did not match",
    SEPARATOR_FAILED: "Worker processing failed",
    OUTPUT_INVALID: "The processed output is invalid",
    DOWNLOAD_FAILED: "The assigned input download failed",
    OUTPUT_UPLOAD_FAILED: "The processed output upload failed",
  };
  return summaries[code];
}

function ownershipCode(error: unknown, signalReason: unknown): string {
  const candidate = error instanceof OwnershipLostError ? error : signalReason;
  return candidate instanceof OwnershipLostError
    ? candidate.reason
    : "ownership-lost";
}

function isOwnershipRejection(error: unknown): boolean {
  return (
    error instanceof OwnershipLostError ||
    (error instanceof ControlPlaneError &&
      [401, 403, 409, 410].includes(error.status))
  );
}

function isImmediateOwnershipLoss(error: unknown): boolean {
  return (
    error instanceof OwnershipLostError ||
    (error instanceof ControlPlaneError &&
      [401, 403, 409, 410].includes(error.status))
  );
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolveDelay, reject) => {
    const timeout = setTimeout(resolveDelay, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

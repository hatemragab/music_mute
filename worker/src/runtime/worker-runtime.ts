import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { ChildCommandError } from "../agent/child-process.js";
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
  type WorkerRecipeId,
} from "./contracts.js";
import { LeaseAuthority, OwnershipLostError } from "./lease-authority.js";
import { TransferError, type WorkerTransferClient } from "./transfers.js";
import { WorkspaceManager, type AttemptWorkspace } from "./workspace.js";

export interface RuntimeSlotDefinition {
  workerId: string;
  gpuId: string;
  slotIndex: number;
  recipeIds: readonly WorkerRecipeId[];
  provider: "coreml" | "directml";
  directmlDeviceId?: number;
}

export interface WorkerRuntimeOptions {
  machineId: string;
  slots: readonly RuntimeSlotDefinition[];
  workRoot: string;
  modelCacheRoot: string;
  ffmpegPath: string;
  ffprobePath: string;
  leaseRenewIntervalMs?: number;
  leaseSafetyMarginMs?: number;
  idlePollMinimumMs?: number;
  idlePollMaximumMs?: number;
  uploadAttempts?: number;
  onEvent?: (event: RuntimeEvent) => void;
}

export interface RuntimeEvent {
  kind:
    | "started"
    | "attempt-started"
    | "attempt-succeeded"
    | "attempt-failed"
    | "attempt-stopped"
    | "child-unavailable";
  workerId?: string;
  attemptId?: string;
  code?: string;
}

interface RuntimeControlPlane {
  openSession: WorkerControlPlaneClient["openSession"];
  config: WorkerControlPlaneClient["config"];
  applyConfig: WorkerControlPlaneClient["applyConfig"];
  registerSlot: WorkerControlPlaneClient["registerSlot"];
  claim: WorkerControlPlaneClient["claim"];
  renew: WorkerControlPlaneClient["renew"];
  inputGrant: WorkerControlPlaneClient["inputGrant"];
  outputGrant: WorkerControlPlaneClient["outputGrant"];
  complete: WorkerControlPlaneClient["complete"];
  fail: WorkerControlPlaneClient["fail"];
}

interface RuntimeTransfers {
  download: WorkerTransferClient["download"];
  upload: WorkerTransferClient["upload"];
}

interface RuntimeSupervisor {
  start(): Promise<void>;
  stop(): Promise<void>;
  child(workerId: string): ProcessingChild;
  restart(workerId: string): Promise<ProcessingChild>;
}

interface ProcessingChild {
  request(
    command: "ping" | "process",
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<ChildResponse>;
  terminateActive(): void;
  isProcessing(): boolean;
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
  private readonly busy = new Map<string, Promise<void>>();
  private readonly pendingClaims = new Map<string, string>();
  private readonly unavailable = new Set<string>();
  private readonly stopping = new AbortController();
  private machineId = "";
  private started = false;
  private wakeResolver: (() => void) | null = null;
  private wakeGeneration = 0;

  constructor(
    private readonly options: WorkerRuntimeOptions,
    private readonly control: RuntimeControlPlane,
    private readonly transfers: RuntimeTransfers,
    private readonly supervisor: RuntimeSupervisor,
  ) {
    validateOptions(options);
    this.workspace = new WorkspaceManager(options.workRoot);
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("Worker runtime has already started");
    await this.workspace.initialize();
    await this.supervisor.start();
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
      this.emit({ kind: "started" });
    } catch (error) {
      await this.supervisor.stop();
      throw error;
    }
  }

  async run(signal?: AbortSignal): Promise<void> {
    const onAbort = () => void this.stop();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (!this.started) await this.start();
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
      signal?.removeEventListener("abort", onAbort);
      await this.stop();
    }
  }

  async reconcileOnce(): Promise<number> {
    this.assertStarted();
    if (this.stopping.signal.aborted) return 0;
    const idle = this.options.slots.filter(
      (slot) =>
        !this.busy.has(slot.workerId) && !this.unavailable.has(slot.workerId),
    );
    if (idle.length === 0) return 0;
    const config = await this.synchronizeConfig();
    if (!config.claimAllowed) return 0;
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
      const attempt = this.executeAttempt(
        slot,
        response.claim,
        response.serverTime,
      )
        .catch(() => undefined)
        .finally(() => {
          this.busy.delete(slot.workerId);
          this.wake();
        });
      this.busy.set(slot.workerId, attempt);
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
    await this.supervisor.stop();
    this.started = false;
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
      attemptId: claim.attemptId,
    });
    try {
      workspace = await this.workspace.create(
        claim.attemptId,
        claim.input.contentType,
        claim.input.key,
      );
      const input = await this.control.inputGrant(
        claim.attemptId,
        identity,
        controller.signal,
      );
      if (!sameObject(input.object, claim.input))
        throw new TransferError("DOWNLOAD_FAILED", false);
      await this.transfers.download(
        input.grant,
        claim.input,
        workspace.input,
        controller.signal,
      );
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
            Math.min(7_200_000, Math.floor(authority.remainingMs())),
          ),
        );
      } catch (error) {
        if (!(error instanceof ChildCommandError)) childTerminated = true;
        throw error;
      }
      if (childResponse.type !== "result")
        throw new TransferError("OUTPUT_UPLOAD_FAILED", false);
      const result = parseChildProcessResult(childResponse.payload);
      assertChildResult(result, claim, workspace);
      await assertSafeOutput(result.outputPath, workspace.output);
      authority.assertCurrent();

      const versionId = await this.publishOutput(
        identity,
        claim,
        result,
        authority,
        controller.signal,
      );
      authority.assertCurrent();
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
          },
          controller.signal,
        );
      } catch (error) {
        if (isOwnershipRejection(error)) throw error;
        throw new PublicationUncertainError();
      }
      terminal = true;
      this.emit({
        kind: "attempt-succeeded",
        workerId: slot.workerId,
        attemptId: claim.attemptId,
      });
    } catch (error) {
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
          attemptId: claim.attemptId,
          code:
            error instanceof PublicationUncertainError
              ? "completion-uncertain"
              : isOwnershipRejection(error)
                ? "ownership-rejected"
                : ownershipCode(error, controller.signal.reason),
        });
      } else {
        const failure = failureFor(error);
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
          attemptId: claim.attemptId,
          code: failure.code,
        });
      }
    } finally {
      terminal = true;
      controller.abort(new OwnershipLostError("attempt-finished"));
      this.stopping.signal.removeEventListener("abort", stopListener);
      await Promise.allSettled([watchdog, renewal]);
      if (workspace) await this.workspace.cleanup(workspace);
      if (childTerminated && !this.stopping.signal.aborted) {
        try {
          await this.supervisor.restart(slot.workerId);
        } catch {
          this.unavailable.add(slot.workerId);
          this.emit({
            kind: "child-unavailable",
            workerId: slot.workerId,
            attemptId: claim.attemptId,
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

  private emit(event: RuntimeEvent): void {
    this.options.onEvent?.(event);
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
  if (
    new Set(options.slots.map((slot) => slot.gpuId)).size !==
    options.slots.length
  )
    throw new TypeError("Worker runtime allows one initial slot per GPU");
  for (const path of [
    options.workRoot,
    options.modelCacheRoot,
    options.ffmpegPath,
    options.ffprobePath,
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
    output.outputBitrateKbps !== claim.recipe.outputBitrateKbps
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

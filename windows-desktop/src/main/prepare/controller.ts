import { randomUUID } from "node:crypto";
import { isCurrentUserSid } from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import {
  PREPARE_STAGES,
  type PrepareErrorCode,
  type PrepareStage,
  type PrepareView,
} from "../../shared/prepare-contracts.js";
export interface PrepareTarget {
  identity: string;
  sid: string;
}
export interface PrepareJournal {
  version: 1;
  transaction: string;
  target: string;
  sid: string;
  state: "running" | "cancelled" | "failed" | "complete";
  completed: PrepareStage[];
}
export interface PrepareJournalPort {
  read(): Promise<unknown | null>;
  write(journal: PrepareJournal): Promise<void>;
}
export interface PrepareLease {
  release(): Promise<void>;
}
export interface PreparationOperations {
  /** Verified signed artifact/model/recipe identity; not a filename-existence check. */
  target(signal: AbortSignal): Promise<PrepareTarget>;
  /** Bounded UI-status receipt only; completed journal and unchanged identities are required. */
  cachedReady?(target: PrepareTarget, signal: AbortSignal): Promise<boolean>;
  browserReady?(target: PrepareTarget, signal: AbortSignal): Promise<boolean>;
  lock(target: PrepareTarget): Promise<PrepareLease | null>;
  space(
    target: PrepareTarget,
    signal: AbortSignal,
  ): Promise<{ requiredBytes: number; availableBytes: number }>;
  reuse(
    stage: PrepareStage,
    target: PrepareTarget,
    signal: AbortSignal,
  ): Promise<boolean>;
  perform(
    stage: PrepareStage,
    target: PrepareTarget,
    signal: AbortSignal,
    progress: (completed: number, total: number) => void,
  ): Promise<void>;
  verifyReady(target: PrepareTarget, signal: AbortSignal): Promise<boolean>;
  registerBrowser(target: PrepareTarget, signal: AbortSignal): Promise<boolean>;
  /** Terminate only processes owned by this setup transaction, never worker/Chrome jobs. */
  cancelOwned(): Promise<void>;
  /** Unknown child/physical-guard cleanup keeps the installation/admission leases. */
  cleanupPending?(): boolean;
  recoverCleanup?(): Promise<void>;
  cancelCleanup?(): Promise<void>;
  /** Retire only exact verified disposable archives after a cached activation. Readonly check never calls this. */
  finishCachedReady?(target: PrepareTarget, signal: AbortSignal): Promise<void>;
  repair(
    target: PrepareTarget,
    previous: PrepareJournal | null,
    signal: AbortSignal,
  ): Promise<void>;
}
export interface PrepareMutationAdmission {
  /** Called once only for actual mutation, under the Prepare lease. Cached status bypasses it. */
  beforeMutation(
    target: PrepareTarget,
    signal: AbortSignal,
  ): Promise<PrepareLease>;
  /** Failed/unknown admission keeps Prepare held until its exact transaction settles. */
  cleanupPending?(): boolean;
  recoverCleanup?(): Promise<void>;
  cancelCleanup?(): Promise<void>;
  /** Recover only the retained mutation assertion under the still-held Setup
   * lease; this does not release the coordinator or start another transaction. */
  recoverMutation?(): Promise<void>;
  /** Resume an existing durable mutation fence before accepting warm readiness. */
  recoverBeforeReady?(
    target: PrepareTarget,
    signal: AbortSignal,
  ): Promise<PrepareLease | null>;
  recoveryPending?(): boolean;
  cancelRecovery?(
    target: PrepareTarget,
    signal: AbortSignal,
  ): Promise<PrepareLease | null>;
}
export class PrepareFailure extends Error {
  constructor(
    readonly code: PrepareErrorCode,
    readonly component?: "model",
  ) {
    super(code);
  }
}
export function preparationFailure(error: unknown): PrepareFailure {
  if (error instanceof PrepareFailure) return error;
  let code: string | undefined;
  try {
    const descriptor =
      error && typeof error === "object"
        ? Object.getOwnPropertyDescriptor(error, "code")
        : undefined;
    if (
      descriptor &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
    )
      code = descriptor.value;
  } catch {
    /* Unknown objects do not supply a trusted native error code. */
  }
  if (["EACCES", "EPERM", "ACL_UNSAFE"].includes(code ?? ""))
    return new PrepareFailure("PERMISSION_DENIED");
  if (code === "ENOSPC") return new PrepareFailure("LOW_DISK");
  if (
    [
      "HELPER_UNAVAILABLE",
      "HELPER_INTEGRITY_INVALID",
      "LAUNCH_VERIFICATION_REQUIRED",
    ].includes(code ?? "")
  )
    return new PrepareFailure("NATIVE_HELPER_UNAVAILABLE");
  if (
    ["PATH_UNSAFE", "VAULT_CORRUPT", "PROTOCOL_MISMATCH"].includes(code ?? "")
  )
    return new PrepareFailure("INTEGRITY_INVALID");
  return new PrepareFailure("OPERATION_FAILED");
}
export function parsePrepareJournal(
  value: unknown,
  target: PrepareTarget,
): PrepareJournal | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PrepareFailure("JOURNAL_CORRUPT");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 6 ||
    row.version !== 1 ||
    typeof row.transaction !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      row.transaction,
    ) ||
    typeof row.target !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.target) ||
    !isCurrentUserSid(row.sid) ||
    typeof row.state !== "string" ||
    !["running", "cancelled", "failed", "complete"].includes(row.state) ||
    !Array.isArray(row.completed) ||
    row.completed.length > PREPARE_STAGES.length ||
    row.completed.some((stage, index) => stage !== PREPARE_STAGES[index])
  )
    throw new PrepareFailure("JOURNAL_CORRUPT");
  if (row.sid !== target.sid) throw new PrepareFailure("JOURNAL_CORRUPT");
  if (row.target !== target.identity) return null;
  return structuredClone(row) as unknown as PrepareJournal;
}
export class PrepareController {
  private value: PrepareView = {
    state: "missing",
    stage: null,
    percent: null,
    completedBytes: null,
    totalBytes: null,
    requiredBytes: null,
    availableBytes: null,
    errorCode: null,
    browser: "unknown",
  };
  private readonly listeners = new Set<(view: PrepareView) => void>();
  private current:
    | {
        abort: AbortController;
        promise: Promise<PrepareView>;
        epoch: symbol;
        kind: "check" | "prepare";
      }
    | undefined;
  private retained:
    { setup: PrepareLease | null; mutation: PrepareLease | null } | undefined;
  constructor(
    private readonly operations: PreparationOperations,
    private readonly journal: PrepareJournalPort,
    private readonly admission?: PrepareMutationAdmission,
  ) {}
  view(): PrepareView {
    return { ...this.value };
  }
  subscribe(listener: (view: PrepareView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => {
      this.listeners.delete(listener);
    };
  }
  isRunning(): boolean {
    return !!this.current || !!this.retained;
  }
  /** Explicit readonly readiness inspection never downloads, qualifies, activates,
   * repairs registration or rewrites the preparation journal. */
  check(): Promise<PrepareView> {
    if (this.current) return this.current.promise;
    const abort = new AbortController(),
      epoch = Symbol();
    const promise = Promise.resolve()
      .then(() => this.inspect(epoch, abort.signal))
      .finally(() => {
        if (this.current?.epoch === epoch) this.current = undefined;
      });
    this.current = { abort, epoch, promise, kind: "check" };
    return promise;
  }
  private async inspect(
    epoch: symbol,
    signal: AbortSignal,
  ): Promise<PrepareView> {
    let lease: PrepareLease | null = null,
      ready = false,
      browser: PrepareView["browser"] = "unknown";
    this.publish({
      state: "preparing",
      stage: "inspect",
      percent: null,
      errorCode: null,
    });
    try {
      if (this.retained) throw new PrepareFailure("BUSY");
      const target = await this.operations.target(signal);
      this.assertCurrent(epoch, signal);
      if (
        !/^[a-f0-9]{64}$/u.test(target.identity) ||
        !isCurrentUserSid(target.sid)
      )
        throw new PrepareFailure("INTEGRITY_INVALID");
      lease = await this.operations.lock(target);
      this.assertCurrent(epoch, signal);
      if (!lease) throw new PrepareFailure("BUSY");
      const record = parsePrepareJournal(await this.journal.read(), target);
      ready =
        record?.state === "complete" &&
        record.completed.length === PREPARE_STAGES.length &&
        (await this.operations.cachedReady?.(target, signal)) === true;
      this.assertCurrent(epoch, signal);
      if (ready) {
        try {
          browser = (await this.operations.browserReady?.(target, signal))
            ? "registered"
            : "attention-needed";
        } catch {
          browser = "attention-needed";
        }
      }
      this.assertCurrent(epoch, signal);
      await lease.release();
      lease = null;
      this.assertCurrent(epoch, signal);
      this.publish({
        state: ready ? "ready" : "missing",
        stage: null,
        percent: null,
        completedBytes: null,
        totalBytes: null,
        requiredBytes: null,
        availableBytes: null,
        browser,
        errorCode: null,
      });
    } catch (error) {
      this.publish({
        state: signal.aborted ? "cancelled" : "error",
        stage: null,
        percent: null,
        errorCode: signal.aborted
          ? "PREPARE_INTERRUPTED"
          : preparationFailure(error).code,
        errorComponent: signal.aborted
          ? null
          : (preparationFailure(error).component ?? null),
      });
    } finally {
      if (lease)
        try {
          await lease.release();
        } catch {
          this.retained = { setup: lease, mutation: null };
          this.publish({ state: "error", errorCode: "OPERATION_FAILED" });
        }
    }
    return this.view();
  }
  start(options: { repair?: boolean } = {}): Promise<PrepareView> {
    if (this.current?.kind === "check")
      return this.current.promise.then(() => this.start(options));
    if (this.current) return this.current.promise;
    const abort = new AbortController(),
      epoch = Symbol();
    // Defer execution so even a synchronous target implementation observes current ownership.
    const promise = Promise.resolve()
      .then(() => this.run(epoch, abort.signal, options.repair === true))
      .finally(() => {
        if (this.current?.epoch === epoch) this.current = undefined;
      });
    this.current = { abort, promise, epoch, kind: "prepare" };
    return promise;
  }
  async cancel(): Promise<void> {
    const current = this.current;
    this.publish({ errorComponent: null });
    if (!current) {
      await this.recoverRetained(true);
      await this.cancelDurableRecovery();
      return;
    }
    current.abort.abort();
    if (current.kind === "prepare") await this.operations.cancelOwned();
    await current.promise;
    await this.recoverRetained(true);
    await this.cancelDurableRecovery();
  }
  private async cancelDurableRecovery(): Promise<void> {
    if (!this.admission?.recoveryPending?.() || !this.admission.cancelRecovery)
      return;
    const signal = AbortSignal.timeout(30_000),
      target = await this.operations.target(signal);
    let setup: PrepareLease | null = await this.operations.lock(target),
      mutation: PrepareLease | null = null;
    if (!setup) throw new PrepareFailure("BUSY");
    try {
      mutation = await this.admission.cancelRecovery(target, signal);
      await setup.release();
      setup = null;
      await mutation?.release();
      mutation = null;
    } catch (error) {
      if (setup && !this.admission.cleanupPending?.()) {
        try {
          await setup.release();
          setup = null;
        } catch {
          /* A lost release ACK retains the actual lease. */
        }
      }
      throw error;
    } finally {
      if (setup || mutation) this.retained = { setup, mutation };
    }
  }
  private async recoverRetained(cancel = false): Promise<void> {
    const retained = this.retained;
    if (!retained) return;
    if (this.operations.cleanupPending?.()) {
      await this.admission?.recoverMutation?.();
      const recover = cancel
        ? (this.operations.cancelCleanup ?? this.operations.recoverCleanup)
        : this.operations.recoverCleanup;
      if (!recover) throw new PrepareFailure("BUSY");
      await recover.call(this.operations);
      if (this.operations.cleanupPending()) throw new PrepareFailure("BUSY");
    }
    if (this.admission?.cleanupPending?.()) {
      const recover = cancel
        ? this.admission.cancelCleanup
        : this.admission.recoverCleanup;
      if (!recover) throw new PrepareFailure("BUSY");
      await recover.call(this.admission);
      if (this.admission.cleanupPending()) throw new PrepareFailure("BUSY");
    }
    // Keep maintenance closed until Prepare is positively released; its release
    // may rebind a worker that itself needs to acquire the Prepare mutex.
    if (retained.setup) {
      await retained.setup.release();
      retained.setup = null;
    }
    if (retained.mutation) {
      await retained.mutation.release();
      retained.mutation = null;
    }
    this.retained = undefined;
  }
  private publish(patch: Partial<PrepareView>): void {
    if (patch.errorCode !== undefined)
      patch = { errorComponent: null, ...patch };
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.view());
      } catch {
        /* An observer cannot claim Ready or alter ownership. */
      }
    }
  }
  private assertCurrent(epoch: symbol, signal: AbortSignal): void {
    if (this.current?.epoch !== epoch || signal.aborted)
      throw new PrepareFailure("PREPARE_INTERRUPTED");
  }
  private async run(
    epoch: symbol,
    signal: AbortSignal,
    repair: boolean,
  ): Promise<PrepareView> {
    let lease: PrepareLease | null = null,
      record: PrepareJournal | null = null,
      mutation: PrepareLease | null = null;
    let ready: Partial<PrepareView> | undefined;
    this.publish({
      state: "preparing",
      stage: "inspect",
      percent: null,
      completedBytes: null,
      totalBytes: null,
      errorCode: null,
      browser: "unknown",
    });
    try {
      await this.recoverRetained();
      this.assertCurrent(epoch, signal);
      const target = await this.operations.target(signal);
      this.assertCurrent(epoch, signal);
      if (
        !/^[a-f0-9]{64}$/.test(target.identity) ||
        !isCurrentUserSid(target.sid)
      )
        throw new PrepareFailure("INTEGRITY_INVALID");
      lease = await this.operations.lock(target);
      this.assertCurrent(epoch, signal);
      if (!lease) throw new PrepareFailure("BUSY");
      try {
        record = parsePrepareJournal(await this.journal.read(), target);
      } catch (error) {
        if (
          !repair ||
          !(error instanceof PrepareFailure) ||
          error.code !== "JOURNAL_CORRUPT"
        )
          throw error;
        record = null;
      }
      mutation =
        (await this.admission?.recoverBeforeReady?.(target, signal)) ?? null;
      this.assertCurrent(epoch, signal);
      if (
        !repair &&
        record?.state === "complete" &&
        record.completed.length === PREPARE_STAGES.length &&
        (await this.operations.cachedReady?.(target, signal))
      ) {
        this.assertCurrent(epoch, signal);
        await this.operations.finishCachedReady?.(target, signal);
        this.assertCurrent(epoch, signal);
        let registered = false;
        try {
          registered = await this.operations.registerBrowser(target, signal);
        } catch {
          /* Browser repair is independent. */
        }
        this.assertCurrent(epoch, signal);
        ready = {
          state: "ready",
          stage: null,
          percent: null,
          browser: registered ? "registered" : "attention-needed",
          errorCode: null,
        };
        const cachedLease = lease,
          cachedView = ready,
          cachedMutation = mutation;
        lease = null;
        mutation = null;
        ready = undefined;
        return await this.finishReady(
          cachedView,
          cachedLease,
          epoch,
          signal,
          cachedMutation,
        );
      }
      mutation ??=
        (await this.admission?.beforeMutation(target, signal)) ?? null;
      this.assertCurrent(epoch, signal);
      if (repair) {
        await this.operations.repair(target, record, signal);
        this.assertCurrent(epoch, signal);
        record = null;
      }
      record ??= {
        version: 1,
        transaction: randomUUID(),
        target: target.identity,
        sid: target.sid,
        state: "running",
        completed: [],
      };
      record.state = "running";
      const reusableCompleted = new Set(record.completed);
      await this.journal.write(record);
      for (const stage of PREPARE_STAGES) {
        this.assertCurrent(epoch, signal);
        this.publish({
          stage,
          percent: null,
          completedBytes: null,
          totalBytes: null,
        });
        if (stage === "space") {
          const space = await this.operations.space(target, signal);
          this.assertCurrent(epoch, signal);
          if (
            !Number.isSafeInteger(space.requiredBytes) ||
            !Number.isSafeInteger(space.availableBytes) ||
            space.requiredBytes < 0 ||
            space.availableBytes < 0
          )
            throw new PrepareFailure("OPERATION_FAILED");
          this.publish(space);
          if (space.availableBytes < space.requiredBytes)
            throw new PrepareFailure("LOW_DISK");
        }
        const previouslyDone = reusableCompleted.has(stage);
        if (
          !previouslyDone ||
          !(await this.operations.reuse(stage, target, signal))
        ) {
          record.completed = record.completed.slice(
            0,
            PREPARE_STAGES.indexOf(stage),
          );
          for (const remaining of PREPARE_STAGES.slice(
            PREPARE_STAGES.indexOf(stage),
          ))
            reusableCompleted.delete(remaining);
          await this.journal.write(record);
          this.assertCurrent(epoch, signal);
          await this.operations.perform(
            stage,
            target,
            signal,
            (completed, total) => {
              if (
                this.current?.epoch !== epoch ||
                signal.aborted ||
                !Number.isSafeInteger(completed) ||
                !Number.isSafeInteger(total) ||
                completed < 0 ||
                total < 1 ||
                completed > total
              )
                return;
              this.publish({
                completedBytes: completed,
                totalBytes: total,
                percent: Math.floor((completed * 100) / total),
              });
            },
          );
        }
        this.assertCurrent(epoch, signal);
        record.completed = PREPARE_STAGES.slice(
          0,
          PREPARE_STAGES.indexOf(stage) + 1,
        );
        await this.journal.write(record);
      }
      if (!(await this.operations.verifyReady(target, signal)))
        throw new PrepareFailure("INTEGRITY_INVALID");
      this.assertCurrent(epoch, signal);
      let registered = false;
      try {
        registered = await this.operations.registerBrowser(target, signal);
      } catch {
        /* Browser repair is separate from verified GPU readiness. */
      }
      this.assertCurrent(epoch, signal);
      record.state = "complete";
      await this.journal.write(record);
      this.assertCurrent(epoch, signal);
      ready = {
        state: "ready",
        stage: null,
        percent: null,
        browser: registered ? "registered" : "attention-needed",
        errorCode: null,
      };
    } catch (error) {
      const cancelled = signal.aborted;
      if (record) {
        record.state = cancelled ? "cancelled" : "failed";
        try {
          await this.journal.write(record);
        } catch {
          /* A failed journal write must never establish Ready. */
        }
      }
      this.publish({
        state: cancelled ? "cancelled" : "error",
        percent: null,
        errorCode: cancelled
          ? "PREPARE_INTERRUPTED"
          : preparationFailure(error).code,
        errorComponent: cancelled
          ? null
          : (preparationFailure(error).component ?? null),
      });
    } finally {
      if (
        (lease || mutation) &&
        (this.operations.cleanupPending?.() ||
          this.admission?.cleanupPending?.())
      ) {
        this.retained = { setup: lease, mutation };
        lease = null;
        mutation = null;
        ready = undefined;
        this.publish({
          state: "error",
          errorCode: "OPERATION_FAILED",
          percent: null,
        });
      }
      if (lease || mutation) {
        try {
          if (lease) {
            await lease.release();
            lease = null;
          }
          if (mutation) {
            await mutation.release();
            mutation = null;
          }
        } catch {
          this.retained = { setup: lease, mutation };
          ready = undefined;
          this.publish({
            state: "error",
            errorCode: "OPERATION_FAILED",
            percent: null,
          });
        }
      }
    }
    if (ready) {
      if (signal.aborted)
        this.publish({
          state: "cancelled",
          percent: null,
          errorCode: "PREPARE_INTERRUPTED",
        });
      else this.publish(ready);
    }
    return this.view();
  }
  private async finishReady(
    ready: Partial<PrepareView>,
    lease: PrepareLease,
    epoch: symbol,
    signal: AbortSignal,
    mutation: PrepareLease | null = null,
  ): Promise<PrepareView> {
    try {
      await lease.release();
    } catch (error) {
      this.retained = { setup: lease, mutation };
      throw error;
    }
    try {
      await mutation?.release();
    } catch (error) {
      this.retained = { setup: null, mutation };
      throw error;
    }
    this.assertCurrent(epoch, signal);
    this.publish(ready);
    return this.view();
  }
}

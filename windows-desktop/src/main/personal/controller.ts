import { createHash, randomUUID } from "node:crypto";
import {
  parsePersonalScope,
  parsePersonalSubmission,
  PERSONAL_MAX_JOBS,
  type PersonalArtifact,
  type PersonalError,
  type PersonalJobView,
  type PersonalStage,
  type PersonalSubmission,
  type PersonalWaitReason,
} from "../../shared/personal-contracts.js";
import type { SessionAccountScope } from "../../shared/session-contracts.js";
import type { ReuseSourceIdentity } from "../../shared/reuse-contracts.js";
import type { PersonalTimeline } from "./timeline.js";

export class PersonalFailure extends Error {
  constructor(readonly code: PersonalError) {
    super(code);
  }
}
export interface PersonalStoredInput {
  path: string;
  name: string;
  bytes: number;
  sha256: string;
  sourceIdentity?: ReuseSourceIdentity;
}
export interface PersonalStoredResult {
  original: PersonalArtifact;
  vocals: PersonalArtifact;
  timeline?: PersonalTimeline;
}
export interface PersonalStoragePort {
  recover?(
    receipt: PersonalRequestReceipt,
  ): Promise<{ view: PersonalJobView; result: PersonalStoredResult } | null>;
  consume(
    capability: string,
    ownerId: string,
    scope: SessionAccountScope | null,
    signal: AbortSignal,
    jobId: string,
  ): Promise<PersonalStoredInput>;
  workDirectory(jobId: string): Promise<string>;
  commit(
    jobId: string,
    input: PersonalStoredInput,
    result: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PersonalStoredResult>;
  cleanup(jobId: string, keepResult: boolean): Promise<void>;
}
export interface PersonalRunContext {
  jobId: string;
  ownerId: string;
  requestId: string;
  scope: SessionAccountScope | null;
  recipeId: PersonalSubmission["recipeId"];
  workDirectory: string;
  signal: AbortSignal;
  progress(
    stage: PersonalStage,
    fraction?: number,
    waitReason?: PersonalWaitReason | null,
  ): void;
}
export type PersonalReuseHit =
  | {
      kind: "pair";
      adopt(): Promise<PersonalStoredResult>;
      release(): Promise<void>;
    }
  | { kind: "original"; input: PersonalStoredInput; release(): Promise<void> };
export interface PersonalReusePort {
  idle?(): boolean;
  lookup(
    videoId: string,
    context: PersonalRunContext,
  ): Promise<PersonalReuseHit | null>;
  completed?(view: PersonalJobView, context: PersonalRunContext): Promise<void>;
  settled?(jobId: string): void;
}
export interface PersonalRunnerPort {
  acquireYouTube(
    videoId: string,
    context: PersonalRunContext,
  ): Promise<PersonalStoredInput>;
  process(
    input: PersonalStoredInput,
    context: PersonalRunContext,
  ): Promise<Record<string, unknown>>;
  /** Positive per-job detach and exact native quiescence; legacy runners stop. */
  finish?(jobId: string): Promise<void>;
  /** Evict an idle retained model, or fence retirement after active cleanup. */
  yieldIdle?(): Promise<boolean>;
  dispose?(): Promise<void>;
  /** Resolves only after the owned per-job child tree has exited. */
  stop(jobId: string): Promise<void>;
  /** Release admission only after owned output/scratch cleanup completed. */
  releaseAfterCleanup(jobId: string): Promise<void>;
}
export interface PersonalRequestReceipt {
  ownerId: string;
  requestId: string;
  digest: string;
  jobId: string;
  state: "inflight" | "settled";
  capturedAccountScope?: SessionAccountScope | null;
}
export interface PersonalRequestJournal {
  read(): Promise<PersonalRequestReceipt[]>;
  write(receipts: PersonalRequestReceipt[]): Promise<void>;
}
interface Job {
  submission: PersonalSubmission;
  scope: SessionAccountScope | null;
  view: PersonalJobView;
  abort: AbortController;
  cleanupConfirmed: boolean;
  cleanup?: () => Promise<void>;
  cleaning?: Promise<void>;
  completed: Promise<void>;
  resolve(): void;
  input?: Promise<PersonalStoredInput>;
  work?: Promise<string>;
}
function scopeKey(scope: SessionAccountScope | null): string {
  return scope ? `${scope.firebaseUid}:${scope.generation}` : "signed-out";
}
/** Account-free local queue. Every publication is fenced by immutable owner and account generation. */
export class PersonalProcessingController {
  private readonly jobs = new Map<string, Job>();
  private readonly receipts = new Map<
    string,
    { digest: string; jobId: string }
  >();
  private readonly durableSettled = new Set<string>();
  private scope: SessionAccountScope | null = null;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  readonly instanceId = randomUUID();
  private version = 0;
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly options: {
      storage: PersonalStoragePort;
      runner: PersonalRunnerPort;
      journal?: PersonalRequestJournal;
      reuse?: PersonalReusePort;
      onChange?(view: PersonalJobView): void;
      onResult?(
        view: PersonalJobView,
        scope: SessionAccountScope | null,
        result?: PersonalStoredResult,
      ): Promise<void>;
    },
  ) {}
  async initialize(): Promise<void> {
    if (!this.options.journal) return;
    const rows = await this.options.journal.read();
    for (const row of rows) {
      const submission: PersonalSubmission = {
        ownerId: row.ownerId,
        requestId: row.requestId,
        input: { kind: "file", capability: randomUUID() },
        rightsConfirmed: true,
        recipeId: "kim-vocals-v2",
      };
      this.receipts.set(`${row.ownerId}:${row.requestId}`, {
        digest: row.digest,
        jobId: row.jobId,
      });
      if (row.state === "settled") this.durableSettled.add(row.jobId);
      this.jobs.set(row.jobId, {
        submission,
        scope: structuredClone(row.capturedAccountScope ?? null),
        abort: new AbortController(),
        cleanupConfirmed: false,
        completed: Promise.resolve(),
        resolve: () => {},
        view: {
          id: row.jobId,
          ownerId: row.ownerId,
          state: "failed",
          stage: "queued",
          progress: null,
          waitReason: null,
          name: "Local file",
          error: "PROCESSING_FAILED",
          original: null,
          vocals: null,
        },
      });
      await this.options.runner.stop(row.jobId);
      const recovered = await this.options.storage.recover?.(row);
      if (recovered) {
        const job = this.jobs.get(row.jobId)!;
        job.view = { ...recovered.view, waitReason: null };
        this.durableSettled.add(row.jobId);
        await this.options.onResult?.(
          structuredClone(job.view),
          structuredClone(job.scope),
          structuredClone(recovered.result),
        );
      }
      await this.options.storage.cleanup(
        row.jobId,
        !!recovered || row.state === "settled",
      );
      await this.options.runner.releaseAfterCleanup(row.jobId);
      this.jobs.get(row.jobId)!.cleanupConfirmed = true;
    }
    await this.persistJournal();
  }
  submit(
    value: PersonalSubmission,
    capturedScope: SessionAccountScope | null = this.scope,
  ): PersonalJobView {
    const submission = parsePersonalSubmission(value);
    const scope = parsePersonalScope(capturedScope);
    if (scope && scopeKey(scope) !== scopeKey(this.scope))
      throw new PersonalFailure("SCOPE_CHANGED");
    if (this.stopped) throw new PersonalFailure("OWNER_DETACHED");
    const key = `${submission.ownerId}:${submission.requestId}`;
    const digest = createHash("sha256")
      .update(JSON.stringify(submission))
      .digest("hex");
    const previous = this.receipts.get(key);
    if (previous) {
      if (previous.digest !== digest)
        throw new PersonalFailure("INVALID_REQUEST");
      const job = this.jobs.get(previous.jobId)!;
      if (job.scope && scopeKey(job.scope) !== scopeKey(scope))
        throw new PersonalFailure("SCOPE_CHANGED");
      return structuredClone(job.view);
    }
    if (
      [...this.jobs.values()].filter((job) => !job.cleanupConfirmed).length >=
      PERSONAL_MAX_JOBS
    )
      throw new PersonalFailure("INPUT_LIMIT");
    const jobId = randomUUID();
    let resolve!: () => void;
    const job: Job = {
      submission,
      scope: structuredClone(scope),
      abort: new AbortController(),
      cleanupConfirmed: false,
      completed: new Promise<void>((done) => {
        resolve = done;
      }),
      resolve: () => resolve(),
      view: {
        id: jobId,
        ownerId: submission.ownerId,
        state: "preparing",
        stage: "queued",
        progress: null,
        waitReason: null,
        name: submission.input.kind === "youtube" ? "YouTube" : "Local file",
        error: null,
        original: null,
        vocals: null,
        source:
          submission.input.kind === "youtube"
            ? { kind: "youtube", videoId: submission.input.videoId }
            : { kind: "file" },
      },
    };
    this.jobs.set(jobId, job);
    this.receipts.set(key, { digest, jobId });
    // Quarantine the already selected private file while its short-lived grant
    // is valid, before an earlier GPU job can delay this submission.
    if (submission.input.kind === "file") {
      job.work = this.options.storage.workDirectory(jobId);
      job.input = this.persistJournal().then(async () => {
        await job.work;
        return this.options.storage.consume(
          submission.input.kind === "file" ? submission.input.capability : "",
          submission.ownerId,
          job.scope,
          job.abort.signal,
          jobId,
        );
      });
      void job.input.catch(() => {});
    }
    this.publish(job);
    this.queue = this.queue.then(() => this.execute(job)).catch(() => {});
    return structuredClone(job.view);
  }
  snapshot(
    ownerId: string,
    capturedScope: SessionAccountScope | null = this.scope,
  ): PersonalJobView[] {
    if (capturedScope && scopeKey(capturedScope) !== scopeKey(this.scope))
      return [];
    return [...this.jobs.values()]
      .filter(
        (job) =>
          job.submission.ownerId === ownerId &&
          (job.scope === null ||
            scopeKey(job.scope) === scopeKey(capturedScope)),
      )
      .slice(-PERSONAL_MAX_JOBS)
      .map((job) => structuredClone(job.view));
  }
  async cancel(
    ownerId: string,
    jobId: string,
    reason: PersonalError = "CANCELLED",
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.submission.ownerId !== ownerId)
      throw new PersonalFailure("INVALID_REQUEST");
    if (job.view.state !== "preparing") {
      if (job.view.waitReason) {
        job.view.waitReason = null;
        this.publish(job);
      }
      await job.completed;
      if (!job.cleanupConfirmed) {
        job.abort.abort(new PersonalFailure(reason));
        await this.settleCleanup(job);
        job.view.state = "cancelled";
        job.view.error = reason;
        job.view.original = null;
        job.view.vocals = null;
        this.publish(job);
      }
      return;
    }
    job.abort.abort(new PersonalFailure(reason));
    if (job.view.waitReason) {
      job.view.waitReason = null;
      this.publish(job);
    }
    try {
      await this.options.runner.stop(jobId);
    } catch {
      job.view.error = "STOP_UNCONFIRMED";
      this.publish(job);
      throw new PersonalFailure("STOP_UNCONFIRMED");
    }
    await job.completed;
    if (!job.cleanupConfirmed) {
      await this.settleCleanup(job);
      job.view.state = "cancelled";
      job.view.error = reason;
      job.view.original = null;
      job.view.vocals = null;
      this.publish(job);
    }
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  changes(
    ownerId: string,
    afterVersion: number,
    instanceId?: string,
    capturedScope: SessionAccountScope | null = this.scope,
  ): Promise<{
    changeVersion: number;
    instanceId: string;
    jobs: PersonalJobView[];
    unchanged: boolean;
  }> {
    if (instanceId !== this.instanceId || afterVersion < this.version)
      return Promise.resolve({
        changeVersion: this.version,
        instanceId: this.instanceId,
        jobs: this.snapshot(ownerId, capturedScope),
        unchanged: false,
      });
    if (afterVersion > this.version)
      throw new PersonalFailure("INVALID_REQUEST");
    return new Promise((resolve) => {
      let off = () => {};
      const finish = (unchanged: boolean) => {
        clearTimeout(timer);
        off();
        resolve({
          changeVersion: this.version,
          instanceId: this.instanceId,
          jobs: this.snapshot(ownerId, capturedScope),
          unchanged,
        });
      };
      const timer = setTimeout(() => finish(true), 20000);
      off = this.subscribe(() => finish(false));
    });
  }
  currentScope(): SessionAccountScope | null {
    return structuredClone(this.scope);
  }
  async detachOwner(ownerId: string): Promise<void> {
    await Promise.all(
      [...this.jobs.values()]
        .filter(
          (job) => job.submission.ownerId === ownerId && !job.cleanupConfirmed,
        )
        .map((job) => this.cancel(ownerId, job.view.id, "OWNER_DETACHED")),
    );
  }
  async applyAccountScope(value: SessionAccountScope | null): Promise<void> {
    const scope = parsePersonalScope(value);
    if (scopeKey(scope) === scopeKey(this.scope)) return;
    this.scope = structuredClone(scope);
    this.changed();
    // A detached account generation cannot consume or publish an earlier generation's private input.
    await Promise.all(
      [...this.jobs.values()]
        .filter(
          (job) =>
            job.view.state === "preparing" &&
            job.scope !== null &&
            scopeKey(job.scope) !== scopeKey(scope),
        )
        .map((job) =>
          this.cancel(job.submission.ownerId, job.view.id, "SCOPE_CHANGED"),
        ),
    );
  }
  requestGpuYield(): void {
    // The admission pipe must acknowledge before release re-enters guard_release.
    // Failure leaves the retained runner/physical lease fenced for explicit recovery.
    void this.options.runner.yieldIdle?.().catch(() => {});
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(
      [...this.jobs.values()]
        .filter((job) => !job.cleanupConfirmed)
        .map((job) =>
          this.cancel(job.submission.ownerId, job.view.id, "OWNER_DETACHED"),
        ),
    );
    await this.options.runner.dispose?.();
  }
  wait(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new PersonalFailure("INVALID_REQUEST");
    return job.completed;
  }
  private async execute(job: Job): Promise<void> {
    let committed = false;
    let publishedPair = false;
    let hit: PersonalReuseHit | null = null;
    const signal = job.abort.signal;
    const context: PersonalRunContext = {
      jobId: job.view.id,
      ownerId: job.submission.ownerId,
      requestId: job.submission.requestId,
      scope: job.scope,
      recipeId: job.submission.recipeId,
      workDirectory: "",
      signal,
      progress: (stage, fraction, waitReason) => {
        if (!signal.aborted && job.view.state === "preparing") {
          job.view.stage = stage;
          job.view.progress =
            fraction === undefined ? null : Math.max(0, Math.min(1, fraction));
          job.view.waitReason =
            stage === "preparation" &&
            (waitReason === "waiting-for-worker" ||
              waitReason === "gpu-busy" ||
              waitReason === "recovering")
              ? waitReason
              : null;
          this.publish(job);
        }
      },
    };
    try {
      this.assertCurrent(job);
      await this.persistJournal();
      context.workDirectory = await (job.work ??
        this.options.storage.workDirectory(job.view.id));
      this.assertCurrent(job);
      if (
        job.submission.input.kind === "youtube" &&
        job.submission.recipeId === "kim-vocals-v2"
      )
        hit =
          (await this.options.reuse?.lookup(
            job.submission.input.videoId,
            context,
          )) ?? null;
      this.assertCurrent(job);
      let result: PersonalStoredResult;
      if (hit?.kind === "pair") result = await hit.adopt();
      else {
        const input =
          hit?.kind === "original"
            ? hit.input
            : job.submission.input.kind === "file"
              ? await job.input!
              : await this.options.runner.acquireYouTube(
                  job.submission.input.videoId,
                  context,
                );
        this.assertCurrent(job);
        job.view.name = displayName(input.name);
        this.publish(job);
        const raw = await this.options.runner.process(input, context);
        this.assertCurrent(job);
        result = await this.options.storage.commit(
          job.view.id,
          input,
          {
            ...raw,
            completionContext: {
              ownerId: job.submission.ownerId,
              requestId: job.submission.requestId,
              capturedAccountScope: structuredClone(job.scope),
              submittedSource: structuredClone(job.view.source),
            },
          },
          signal,
        );
      }
      publishedPair = true;
      this.assertCurrent(job);
      job.view.original = result.original;
      job.view.vocals = result.vocals;
      job.view.original.name = displayName(job.view.original.name);
      job.view.vocals.name = displayName(job.view.vocals.name);
      job.view.progress = 1;
      job.view.waitReason = null;
      this.durableSettled.add(job.view.id);
      await this.persistJournal();
      // The callback runs synchronously with the final generation check; it must retain this exact scope.
      if (this.options.onResult)
        await this.options.onResult(
          structuredClone(job.view),
          structuredClone(job.scope),
          structuredClone(result),
        );
      this.assertCurrent(job);
      // Optional publication cannot erase or block a successfully retained personal pair.
      try {
        await this.options.reuse?.completed?.(
          structuredClone(job.view),
          context,
        );
      } catch {
        this.assertCurrent(job);
      }
      committed = true;
      job.view.stage = "output-validation";
      this.publish(job);
    } catch (error) {
      job.view.original = null;
      job.view.vocals = null;
      const reason = signal.aborted ? signal.reason : error;
      job.view.error =
        reason instanceof PersonalFailure ? reason.code : "PROCESSING_FAILED";
      // Outcome is known, but public terminal/idle still waits for owned teardown.
      job.view.stage = "output-validation";
      job.view.progress = null;
      job.view.waitReason = null;
      this.publish(job);
    } finally {
      job.cleanup = async () => {
        // A cancelled queued job may still be quarantining its selected file.
        // Wait for that bounded descriptor operation before deleting its scratch.
        await job.input?.catch(() => {});
        await job.work?.catch(() => {});
        if (committed && !signal.aborted && this.options.runner.finish)
          await this.options.runner.finish(job.view.id);
        else await this.options.runner.stop(job.view.id);
        await this.options.storage.cleanup(
          job.view.id,
          committed || publishedPair,
        );
        await this.options.runner.releaseAfterCleanup(job.view.id);
        await hit?.release();
      };
      try {
        await this.settleCleanup(job);
      } catch {
        job.view.state = "failed";
        job.view.error = "STOP_UNCONFIRMED";
        this.publish(job);
      }
      if (job.cleanupConfirmed) {
        try {
          this.assertCurrent(job);
          job.view.state = committed ? "ready" : "failed";
          if (committed) job.view.error = null;
        } catch (error) {
          const reason = signal.aborted ? signal.reason : error;
          job.view.error =
            reason instanceof PersonalFailure
              ? reason.code
              : "PROCESSING_FAILED";
          job.view.state = signal.aborted ? "cancelled" : "failed";
          job.view.original = null;
          job.view.vocals = null;
          job.view.progress = null;
        }
      }
      await this.persistJournal().catch(() => {});
      this.options.reuse?.settled?.(job.view.id);
      if (job.cleanupConfirmed) this.publish(job);
      job.resolve();
    }
  }
  private async settleCleanup(job: Job): Promise<void> {
    if (job.cleanupConfirmed) return;
    if (!job.cleanup) throw new PersonalFailure("STOP_UNCONFIRMED");
    const pending = (job.cleaning ??= (async () => {
      try {
        await job.cleanup!();
        job.cleanupConfirmed = true;
        await this.persistJournal().catch(() => {});
      } catch {
        throw new PersonalFailure("STOP_UNCONFIRMED");
      }
    })());
    try {
      await pending;
    } finally {
      if (job.cleaning === pending) delete job.cleaning;
    }
  }
  private assertCurrent(job: Job): void {
    job.abort.signal.throwIfAborted();
    if (job.scope !== null && scopeKey(job.scope) !== scopeKey(this.scope))
      throw new PersonalFailure("SCOPE_CHANGED");
  }
  isIdle(): boolean {
    return (
      [...this.jobs.values()].every((job) => job.cleanupConfirmed) &&
      (this.options.reuse?.idle?.() ?? true)
    );
  }
  private publish(job: Job): void {
    this.changed();
    try {
      this.options.onChange?.(structuredClone(job.view));
    } catch {}
  }
  private changed(): void {
    this.version++;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
  }
  private async persistJournal(): Promise<void> {
    if (!this.options.journal) return;
    const receipts: PersonalRequestReceipt[] = [...this.receipts]
      .slice(-32)
      .map(([key, value]) => ({
        ownerId: key.slice(0, 36),
        requestId: key.slice(37),
        digest: value.digest,
        jobId: value.jobId,
        state:
          this.durableSettled.has(value.jobId) ||
          this.jobs.get(value.jobId)?.view.state !== "preparing"
            ? "settled"
            : "inflight",
        capturedAccountScope: structuredClone(
          this.jobs.get(value.jobId)?.scope ?? null,
        ),
      }));
    await this.options.journal.write(receipts);
  }
}
function displayName(value: string): string {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > 180) break;
    result += character;
  }
  return result;
}

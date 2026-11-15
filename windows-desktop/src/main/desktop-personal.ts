import { randomUUID } from "node:crypto";
import { parseYouTubeVideoId } from "../../../chrome-extension/src/shared/protocol.js";
import type {
  PersonalCommand,
  PersonalJobView,
} from "../shared/personal-contracts.js";
import {
  PERSONAL_MAX_JOBS,
  PERSONAL_UUID,
} from "../shared/personal-contracts.js";
import type { SessionAccountScope } from "../shared/session-contracts.js";
import {
  parsePersonalUiCommand,
  type PersonalUiCommand,
  type PersonalUiView,
} from "../shared/personal-ui-contracts.js";
import type { PersonalReply } from "./personal/session-port.js";
import type { PersonalPlaybackIntent } from "./personal/playback-intents.js";
export interface DesktopPersonalLifecycle {
  created?(intent: PersonalPlaybackIntent): void;
  accepted?(intent: PersonalPlaybackIntent, job: PersonalJobView): void;
  retired?(
    intent: PersonalPlaybackIntent,
    reason: "failed" | "reused" | "scope-changed",
  ): void;
  cancelled?(ownerId: string, jobId: string): void;
  failedJob?(ownerId: string, jobId: string): void;
  disposed?(ownerId: string): void;
}
export interface DesktopPersonalPort {
  /** Submission scope comes only from this trusted desktop intake, never the renderer. */
  command(
    command: PersonalCommand,
    capturedScope?: SessionAccountScope | null,
  ): Promise<PersonalReply>;
  stage(
    capability: string,
    capabilityOwner: string,
    ownerId: string,
    scope: SessionAccountScope | null,
    signal: AbortSignal,
  ): Promise<string>;
  scope(): SessionAccountScope | null;
  tryReuse?(
    request: {
      ownerId: string;
      requestId: string;
      videoId: string;
      scope: SessionAccountScope | null;
    },
    signal: AbortSignal,
  ): Promise<boolean>;
  /** Event-driven full snapshots. No timed HTTP or status polling. */
  watch(
    ownerId: string,
    listener: (jobs: PersonalJobView[]) => void,
    signal: AbortSignal,
  ): Promise<void>;
}
function scopeKey(scope: SessionAccountScope | null): string {
  return scope ? `${scope.firebaseUid}:${scope.generation}` : "guest";
}
function ownErrorString(error: unknown, key: string): string | undefined {
  if (!error || typeof error !== "object") return;
  try {
    const property = Object.getOwnPropertyDescriptor(error, key);
    return property && "value" in property && typeof property.value === "string"
      ? property.value
      : undefined;
  } catch {
    return;
  }
}
function safeError(error: unknown): string {
  if (ownErrorString(error, "name") === "AbortError") return "CANCELLED";
  try {
    // Use the built-in brand-checked getter for AbortController's DOMException;
    // never read an unknown object's accessor or invoke code coercion.
    if (
      Object.getOwnPropertyDescriptor(
        DOMException.prototype,
        "name",
      )?.get?.call(error) === "AbortError"
    )
      return "CANCELLED";
  } catch {
    /* Other exception objects have no DOMException brand. */
  }
  const code =
    ownErrorString(error, "code") ?? ownErrorString(error, "message") ?? "";
  return [
    "INPUT_UNSUPPORTED",
    "INPUT_CHANGED",
    "INPUT_LIMIT",
    "PREPARE_REQUIRED",
    "GPU_BUSY",
    "GPU_UNSUPPORTED",
    "SOURCE_UNAVAILABLE",
    "SOURCE_BOT_CHALLENGE",
    "ACQUISITION_RATE_LIMITED",
    "ACQUISITION_COOLDOWN",
    "DURATION_LIMIT",
    "OUTPUT_INVALID",
    "CANCELLED",
    "SCOPE_CHANGED",
    "STOP_UNCONFIRMED",
  ].includes(code)
    ? code
    : "PROCESSING_FAILED";
}
interface DesktopIntake {
  intent: PersonalPlaybackIntent;
  done: Promise<void>;
  finish(): void;
  submitStarted: boolean;
  submitReplied: boolean;
  cancellationFailure: boolean;
  jobId?: string;
}
/** One personal-app owner persists while windows close/reopen; Chrome and fleet use separate owners. */
export class DesktopPersonalController {
  readonly ownerId = randomUUID();
  private value: PersonalUiView = {
    connected: false,
    busy: false,
    jobs: [],
    error: null,
  };
  private readonly listeners = new Set<(view: PersonalUiView) => void>();
  private readonly staging = new Map<AbortController, DesktopIntake>();
  // A presentation snapshot cannot certify that a failed worker tree was cleaned.
  private readonly unconfirmedJobs = new Set<string>();
  private watch: AbortController | undefined;
  private watchRequested = false;
  private disposed = false;
  constructor(
    private readonly port: DesktopPersonalPort,
    private readonly lifecycle: DesktopPersonalLifecycle = {},
  ) {}
  view(): PersonalUiView {
    return structuredClone(this.value);
  }
  /** Called only after the independent session authority returned a verified control response. */
  connected(): void {
    if (!this.disposed) this.publish({ connected: true, error: null });
  }
  subscribe(listener: (view: PersonalUiView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => this.listeners.delete(listener);
  }
  private publish(patch: Partial<PersonalUiView>): void {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.view());
      } catch {}
    }
  }
  private jobs(jobs: PersonalJobView[], confirmedJobId?: string): void {
    const owned = jobs.filter((job) => job.ownerId === this.ownerId).slice(-16);
    for (const job of owned) {
      if (job.error === "STOP_UNCONFIRMED" && job.id !== confirmedJobId)
        this.unconfirmedJobs.add(job.id);
      if (job.state === "failed")
        this.lifecycle.failedJob?.(this.ownerId, job.id);
      else if (job.state === "cancelled")
        this.lifecycle.cancelled?.(this.ownerId, job.id);
    }
    this.publish({
      jobs: owned,
      busy:
        this.staging.size > 0 ||
        this.unconfirmedJobs.size > 0 ||
        owned.some((job) => job.state === "preparing"),
    });
  }
  private retainUnconfirmed(jobId: string): void {
    this.unconfirmedJobs.add(jobId);
    this.jobs(
      this.value.jobs.map((job) =>
        job.id === jobId ? { ...job, error: "STOP_UNCONFIRMED" } : job,
      ),
    );
    this.publish({ error: "STOP_UNCONFIRMED" });
    this.watch?.abort();
    this.watch = undefined;
    this.startWatch();
  }
  private startWatch(): void {
    if (this.watch || this.disposed) return;
    this.watchRequested = true;
    const abort = new AbortController();
    this.watch = abort;
    void this.port
      .watch(
        this.ownerId,
        (jobs) => {
          if (!abort.signal.aborted) this.jobs(jobs);
        },
        abort.signal,
      )
      .catch((error) => {
        if (!abort.signal.aborted)
          this.publish({ connected: false, error: safeError(error) });
      })
      .finally(() => {
        if (this.watch === abort) this.watch = undefined;
      });
  }
  async execute(
    input: PersonalUiCommand,
    capabilityOwner: string,
  ): Promise<PersonalUiView> {
    const command = parsePersonalUiCommand(input);
    if (this.disposed) throw new Error("OWNER_DETACHED");
    if (command.type === "CANCEL_REQUEST") {
      const active = [...this.staging].find(
        ([, value]) => value.intent.requestId === command.requestId,
      );
      if (!active) throw new Error("INVALID_REQUEST");
      const [abort, intake] = active;
      abort.abort();
      this.lifecycle.retired?.(structuredClone(intake.intent), "failed");
      await intake.done;
      if (intake.cancellationFailure) throw new Error("STOP_UNCONFIRMED");
      return this.view();
    }
    if (command.type === "CANCEL") {
      if (!this.value.jobs.some((job) => job.id === command.jobId))
        throw new Error("INVALID_REQUEST");
      this.lifecycle.cancelled?.(this.ownerId, command.jobId);
      try {
        const reply = await this.port.command({
          version: 1,
          requestId: randomUUID(),
          action: "cancel",
          ownerId: this.ownerId,
          jobId: command.jobId,
        });
        if (!reply.ok) throw new Error("STOP_UNCONFIRMED");
        this.unconfirmedJobs.delete(command.jobId);
        for (const [abort, intake] of this.staging) {
          if (intake.cancellationFailure && intake.jobId === command.jobId) {
            intake.cancellationFailure = false;
            this.staging.delete(abort);
          }
        }
        this.jobs(reply.jobs ?? this.value.jobs, command.jobId);
      } catch {
        this.retainUnconfirmed(command.jobId);
        throw new Error("STOP_UNCONFIRMED");
      }
      return this.view();
    }
    if (this.unconfirmedJobs.size >= PERSONAL_MAX_JOBS)
      throw new Error("STOP_UNCONFIRMED");
    const abort = new AbortController(),
      scope = structuredClone(this.port.scope()),
      fence = scopeKey(scope),
      intent: PersonalPlaybackIntent = {
        requestId: randomUUID(),
        ownerId: this.ownerId,
        scope,
      };
    let finish!: () => void;
    const intake: DesktopIntake = {
      intent,
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      finish: () => finish(),
      submitStarted: false,
      submitReplied: false,
      cancellationFailure: false,
    };
    this.staging.set(abort, intake);
    this.publish({ busy: true, error: null });
    try {
      this.lifecycle.created?.(structuredClone(intent));
      const input =
        command.type === "SUBMIT_FILE"
          ? {
              kind: "file" as const,
              capability: await this.port.stage(
                command.capability,
                capabilityOwner,
                this.ownerId,
                scope,
                abort.signal,
              ),
            }
          : {
              kind: "youtube" as const,
              videoId: parseYouTubeVideoId(command.url),
            };
      abort.signal.throwIfAborted();
      if (scope !== null && scopeKey(this.port.scope()) !== fence)
        throw new Error("SCOPE_CHANGED");
      if (input.kind === "youtube" && !input.videoId)
        throw new Error("SOURCE_UNAVAILABLE");
      let reused = false;
      if (
        input.kind === "youtube" &&
        input.videoId &&
        !command.trimEnabled &&
        this.port.tryReuse
      ) {
        reused = await this.port.tryReuse(
          {
            ownerId: this.ownerId,
            requestId: intent.requestId,
            videoId: input.videoId,
            scope,
          },
          abort.signal,
        );
        abort.signal.throwIfAborted();
        if (scope !== null && scopeKey(this.port.scope()) !== fence)
          throw new Error("SCOPE_CHANGED");
      }
      if (!reused) {
        intake.submitStarted = true;
        const reply = await this.port.command(
          {
            version: 1,
            requestId: randomUUID(),
            action: "submit",
            submission: {
              ownerId: this.ownerId,
              requestId: intent.requestId,
              input: input as
                | { kind: "file"; capability: string }
                | { kind: "youtube"; videoId: string },
              rightsConfirmed: true,
              recipeId: command.trimEnabled
                ? "kim-vocals-v2-trim"
                : "kim-vocals-v2",
            },
          },
          scope,
        );
        intake.submitReplied = true;
        if (
          abort.signal.aborted &&
          reply.ok &&
          (!reply.job || !PERSONAL_UUID.test(reply.job.id))
        ) {
          intake.cancellationFailure = true;
          throw new Error("STOP_UNCONFIRMED");
        }
        if (abort.signal.aborted && reply.ok && reply.job) {
          if (reply.job.ownerId !== this.ownerId) {
            intake.cancellationFailure = true;
            throw new Error("STOP_UNCONFIRMED");
          }
          intake.jobId = reply.job.id;
          this.jobs([
            ...this.value.jobs.filter((job) => job.id !== reply.job!.id),
            reply.job,
          ]);
          try {
            const cancellation = await this.port.command({
              version: 1,
              requestId: randomUUID(),
              action: "cancel",
              ownerId: this.ownerId,
              jobId: reply.job.id,
            });
            if (!cancellation.ok) throw new Error("STOP_UNCONFIRMED");
            this.unconfirmedJobs.delete(reply.job.id);
            this.jobs(
              cancellation.jobs ??
                this.value.jobs.filter((job) => job.id !== reply.job!.id),
            );
          } catch {
            intake.cancellationFailure = true;
            this.retainUnconfirmed(reply.job.id);
            throw new Error("STOP_UNCONFIRMED");
          }
        }
        abort.signal.throwIfAborted();
        if (!reply.ok || !reply.job)
          throw new Error(reply.error ?? "PROCESSING_FAILED");
        if (reply.job.ownerId !== this.ownerId)
          throw new Error("OWNER_DETACHED");
        intake.jobId = reply.job.id;
        this.publish({ connected: true });
        this.jobs([
          ...this.value.jobs.filter((job) => job.id !== reply.job!.id),
          reply.job,
        ]);
        this.lifecycle.accepted?.(
          structuredClone(intent),
          structuredClone(reply.job),
        );
        this.startWatch();
      } else {
        this.lifecycle.retired?.(structuredClone(intent), "reused");
      }
    } catch (error) {
      if (abort.signal.aborted && intake.submitStarted && !intake.submitReplied)
        intake.cancellationFailure = true;
      const failure = intake.cancellationFailure
        ? new Error("STOP_UNCONFIRMED")
        : abort.signal.aborted
          ? abort.signal.reason
          : error;
      this.lifecycle.retired?.(
        structuredClone(intent),
        ownErrorString(failure, "message") === "SCOPE_CHANGED"
          ? "scope-changed"
          : "failed",
      );
      this.publish({ error: safeError(failure) });
    } finally {
      if (!intake.cancellationFailure) this.staging.delete(abort);
      intake.finish();
      this.jobs(this.value.jobs);
    }
    return this.view();
  }
  scopeChanging(
    nextScope: SessionAccountScope | null = this.port.scope(),
  ): void {
    for (const [abort, intake] of this.staging) {
      const captured = intake.intent.scope;
      if (captured !== null && scopeKey(captured) !== scopeKey(nextScope))
        abort.abort(new Error("SCOPE_CHANGED"));
    }
    this.watch?.abort();
    this.watch = undefined;
  }
  /** Called only after the session authority acknowledges the new account scope. */
  scopeChanged(acknowledgedScope: SessionAccountScope | null): void {
    if (
      this.disposed ||
      scopeKey(acknowledgedScope) !== scopeKey(this.port.scope())
    )
      return;
    this.connected();
    if (this.watchRequested) this.startWatch();
  }
  private abortIntake(): void {
    for (const abort of this.staging.keys()) abort.abort();
  }
  async cancelOwnedWork(): Promise<void> {
    this.lifecycle.disposed?.(this.ownerId);
    this.abortIntake();
    await Promise.all([...this.staging.values()].map((intake) => intake.done));
    const reply = await this.port.command({
      version: 1,
      requestId: randomUUID(),
      action: "detach",
      ownerId: this.ownerId,
    });
    if (!reply.ok) throw new Error("STOP_UNCONFIRMED");
    this.watch?.abort();
    this.watch = undefined;
    this.watchRequested = false;
    this.staging.clear();
    this.unconfirmedJobs.clear();
    this.publish({ jobs: [], busy: false });
  }
  async dispose(): Promise<void> {
    this.lifecycle.disposed?.(this.ownerId);
    this.disposed = true;
    this.watch?.abort();
    this.abortIntake();
    if (this.value.busy) await this.cancelOwnedWork();
    this.listeners.clear();
  }
}

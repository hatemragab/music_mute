import type { ExecutionStageTiming } from "./stage-clock.js";
import type { WorkerProgressPhase } from "../../protocol/v1/protocol.js";
import type { ChildProgress } from "../agent/ipc/child-progress.js";
import type { AttemptStage } from "./worker-runtime.js";

export interface AttemptProgressUpdate {
  executionTimings?: ExecutionStageTiming[];
  sequence: number;
  phase: WorkerProgressPhase;
  phasePercent: number | null;
}

type ProgressValue = Omit<AttemptProgressUpdate, "sequence">;

export function publicAttemptProgress(
  stage: AttemptStage,
  work?: ChildProgress["work"],
): ProgressValue {
  const phase: WorkerProgressPhase =
    stage === "separation"
      ? "separating"
      : stage === "resource-check" ||
          stage === "input-download" ||
          stage === "input-validation" ||
          stage === "preparation" ||
          stage === "model-load"
        ? "preparing"
        : "saving-result";
  return {
    phase,
    phasePercent:
      phase === "separating" && work !== undefined
        ? Math.min(99, Math.floor((work.completed / work.total) * 100))
        : null,
  };
}

/** Sends only the newest observed stage, one request at a time. */
export class AttemptProgressReporter {
  private pending: ProgressValue | null = null;
  private lastSent: ProgressValue | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private nextSequence = 1;
  private inFlight = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (update: AttemptProgressUpdate) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly minimumIntervalMs = 2_000,
    private readonly now: () => number = Date.now,
  ) {
    if (
      !Number.isSafeInteger(minimumIntervalMs) ||
      minimumIntervalMs < 100 ||
      minimumIntervalMs > 30_000
    )
      throw new TypeError("Progress interval is invalid");
  }

  update(value: ProgressValue): void {
    if (this.closed || sameProgress(value, this.pending)) return;
    if (this.pending === null && sameProgress(value, this.lastSent)) return;
    this.pending = value;
    this.schedule();
  }

  close(): void {
    this.closed = true;
    this.pending = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.closed || this.inFlight || this.timer !== null || !this.pending)
      return;
    const delay = Math.max(
      0,
      this.minimumIntervalMs - (this.now() - this.lastSentAt),
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private async flush(): Promise<void> {
    if (this.closed || this.inFlight || !this.pending) return;
    const value = this.pending;
    this.pending = null;
    this.inFlight = true;
    this.lastSentAt = this.now();
    try {
      await this.send({ ...value, sequence: this.nextSequence++ });
      this.lastSent = value;
    } catch (error) {
      this.onError(error);
      if (!this.closed && this.pending === null) this.pending = value;
    } finally {
      this.inFlight = false;
      this.schedule();
    }
  }
}

function sameProgress(
  left: ProgressValue,
  right: ProgressValue | null,
): boolean {
  return (
    right !== null &&
    left.phase === right.phase &&
    left.phasePercent === right.phasePercent &&
    JSON.stringify(left.executionTimings) ===
      JSON.stringify(right.executionTimings)
  );
}

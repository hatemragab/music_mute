import type { AttemptStage } from "./worker-runtime.js";

export interface ExecutionStageTiming {
  stage: AttemptStage;
  durationMs: number;
  complete: boolean;
}

/** Monotonic, attempt-local measurements. Snapshots replace, never increment, server data. */
export class StageClock {
  private readonly completed = new Map<AttemptStage, number>();
  private stage: AttemptStage = "resource-check";
  private started: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.started = now();
  }

  enter(stage: AttemptStage): void {
    if (this.stage === stage) return;
    const now = this.now();
    this.completed.set(
      this.stage,
      (this.completed.get(this.stage) ?? 0) + now - this.started,
    );
    this.stage = stage;
    this.started = now;
  }

  snapshot(): ExecutionStageTiming[] {
    const result: ExecutionStageTiming[] = [...this.completed]
      .filter(([stage]) => stage !== this.stage)
      .map(([stage, ms]) => ({
        stage,
        durationMs: Math.round(ms),
        complete: true,
      }));
    result.push({
      stage: this.stage,
      durationMs: Math.round(
        (this.completed.get(this.stage) ?? 0) + this.now() - this.started,
      ),
      complete: false,
    });
    return result;
  }
}

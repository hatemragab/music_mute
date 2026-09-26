import { Schema } from 'mongoose';
import type { Job } from './job.schema.js';

export const EXECUTION_TIMING_STAGES = [
  'resource-check',
  'input-download',
  'input-validation',
  'preparation',
  'model-load',
  'separation',
  'denoise',
  'trim',
  'encoding',
  'output-validation',
  'output-ready',
  'output-upload',
  'completion',
] as const;
export interface StageMeasurement {
  stage: string;
  durationMs: number;
  complete: boolean;
}
export interface AttemptMeasurements {
  attemptId: string;
  attemptNumber: number;
  stages: StageMeasurement[];
}
export interface ImportMeasurements {
  startedAt: Date;
  stages: StageMeasurement[];
}
export const StageMeasurementSchema = new Schema<StageMeasurement>(
  {
    stage: { type: String, required: true, maxlength: 64 },
    durationMs: {
      type: Number,
      required: true,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      validate: Number.isSafeInteger,
    },
    complete: { type: Boolean, required: true },
  },
  { _id: false, strict: 'throw' },
);
export const AttemptMeasurementsSchema = new Schema<AttemptMeasurements>(
  {
    attemptId: { type: String, required: true },
    attemptNumber: { type: Number, required: true, min: 1, max: 10 },
    stages: {
      type: [StageMeasurementSchema],
      default: [],
      validate: (v: StageMeasurement[]) =>
        v.length <= EXECUTION_TIMING_STAGES.length,
    },
  },
  { _id: false, strict: 'throw' },
);

export function elapsedMs(
  start: Date | null | undefined,
  end: Date | null | undefined,
): number | null {
  if (!start || !end) return null;
  const ms = end.getTime() - start.getTime();
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
}

/** Close only the current queue interval, never time spent executing earlier attempts. */
export function closeQueueTiming(job: Job, now: Date): Partial<Job> {
  if (!job.queueTimingStartedAt || job.queueAccumulatedMs == null) return {};
  const wait = elapsedMs(job.queueTimingStartedAt, now);
  const backoff = elapsedMs(
    job.queueTimingStartedAt,
    new Date(
      Math.min(
        now.getTime(),
        job.retryEligibility?.nextAttemptAt?.getTime() ??
          job.queueTimingStartedAt.getTime(),
      ),
    ),
  );
  return {
    queueTimingStartedAt: null,
    queueAccumulatedMs:
      wait === null || backoff === null
        ? null
        : job.queueAccumulatedMs + wait - backoff,
    retryWaitAccumulatedMs:
      backoff === null || job.retryWaitAccumulatedMs == null
        ? null
        : job.retryWaitAccumulatedMs + backoff,
  };
}

/** A sequence-fenced snapshot replaces its own attempt; it never adds a replay twice. */
export function withAttemptMeasurements(
  job: Job,
  attemptId: string,
  attemptNumber: number,
  stages: StageMeasurement[] | undefined,
): AttemptMeasurements[] {
  const history = job.stageTimingAttempts ?? [];
  if (stages === undefined) return history;
  return [
    ...history.filter((item) => item.attemptId !== attemptId),
    { attemptId, attemptNumber, stages },
  ].sort((a, b) => a.attemptNumber - b.attemptNumber);
}

export function presentServerStageTimings(job: Job, now: Date) {
  // Old jobs have no reliable queue ledger or import start. Do not backfill guesses.
  if (!job.serverTimingStartedAt) return null;
  const terminal = job.finishedAt != null;
  const stages: StageMeasurement[] = [...(job.importStageTimings ?? [])].map(
    (s) => ({ stage: s.stage, durationMs: s.durationMs, complete: s.complete }),
  );
  if (!job.importStageTimings?.length && !job.retryOfJobId) {
    const submission = elapsedMs(
      job.createdAt,
      job.confirmedUploadAccountedAt ?? job.finishedAt ?? now,
    );
    if (submission !== null)
      stages.push({
        stage: 'submission-window',
        durationMs: submission,
        complete: job.confirmedUploadAccountedAt != null,
      });
  }
  const queue = { ...job, ...closeQueueTiming(job, job.finishedAt ?? now) };
  if (queue.queueAccumulatedMs != null && job.queuedAt)
    stages.push({
      stage: 'queue',
      durationMs: queue.queueAccumulatedMs,
      complete: terminal || job.queueTimingStartedAt == null,
    });
  if (queue.retryWaitAccumulatedMs)
    stages.push({
      stage: 'retry-wait',
      durationMs: queue.retryWaitAccumulatedMs,
      complete: terminal || job.queueTimingStartedAt == null,
    });
  const combined = new Map<string, StageMeasurement>();
  for (const attempt of job.stageTimingAttempts ?? []) {
    for (const entry of attempt.stages) {
      const prior = combined.get(entry.stage);
      combined.set(entry.stage, {
        stage: entry.stage,
        durationMs: (prior?.durationMs ?? 0) + entry.durationMs,
        complete:
          (prior?.complete ?? true) &&
          entry.complete &&
          (job.stageTimingAttempts?.length ?? 0) === job.attemptNumber,
      });
    }
  }
  stages.push(
    ...EXECUTION_TIMING_STAGES.flatMap((stage) =>
      combined.has(stage) ? [combined.get(stage)!] : [],
    ),
  );
  return {
    totalMs: elapsedMs(job.serverTimingStartedAt, job.finishedAt ?? now),
    totalComplete: terminal,
    stages,
    attempts: (job.stageTimingAttempts ?? []).map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      stages: attempt.stages.map((s) => ({
        stage: s.stage,
        durationMs: s.durationMs,
        complete: s.complete,
      })),
    })),
  };
}

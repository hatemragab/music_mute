import type { Job } from './job.schema.js';

const MAX_CLIENT_PREPARATION_MS = 7 * 24 * 60 * 60 * 1_000;

/** Close once, in the same transaction as the lifecycle transition. */
export function closeProcessingInterval(
  job: Job,
  now: Date,
  approximate = false,
): Partial<Job> {
  const start = job.processingIntervalStartedAt;
  if (!start) return {};
  const end = new Date(
    Math.max(
      start.getTime(),
      Math.min(
        now.getTime(),
        approximate
          ? (job.processingObservedAt ?? start).getTime()
          : now.getTime(),
      ),
    ),
  );
  return {
    processingAccumulatedMs:
      job.processingAccumulatedMs == null
        ? null
        : job.processingAccumulatedMs + end.getTime() - start.getTime(),
    processingIntervalStartedAt: null,
    processingFinishedAt: end,
    processingElapsedApproximate: Boolean(
      job.processingElapsedApproximate || approximate,
    ),
  };
}

export function presentJobTiming(job: Job, now: Date) {
  let processingElapsedMs = job.processingAccumulatedMs ?? null;
  let processingElapsedApproximate = Boolean(job.processingElapsedApproximate);
  if (job.processingIntervalStartedAt && processingElapsedMs !== null) {
    const end = job.processingObservedAt ?? now;
    processingElapsedMs += Math.max(
      0,
      end.getTime() - job.processingIntervalStartedAt.getTime(),
    );
    processingElapsedApproximate ||= job.processingObservedAt !== null;
  }
  const start = job.clientStartedAt?.getTime();
  const end = (job.finishedAt ?? now).getTime();
  const created = job.createdAt.getTime();
  const validClientTime =
    start !== undefined &&
    Number.isFinite(start) &&
    start <= created &&
    created - start <= MAX_CLIENT_PREPARATION_MS &&
    end >= start;
  return {
    processingElapsedMs,
    processingElapsedApproximate,
    totalElapsedMs: validClientTime ? end - start : null,
    totalElapsedApproximate: true,
  };
}

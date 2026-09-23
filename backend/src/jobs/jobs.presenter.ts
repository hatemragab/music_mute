import type { Job } from './job.schema.js';
import { presentJobTiming } from './job-timing.js';

export function presentJob(job: Job) {
  const now = new Date();
  const progress = job.workerProgress;
  const processingProgress =
    (job.status === 'processing' || job.status === 'uploading_result') &&
    progress &&
    progress.attemptId === job.currentExecution?.attemptId
      ? {
          phase: progress.phase,
          phasePercent: progress.phasePercent,
          observedAt: progress.observedAt.toISOString(),
          stale: now.getTime() - progress.observedAt.getTime() > 30_000,
        }
      : null;
  return {
    id: job._id.toHexString(),
    requestId: job.requestId,
    sourceTitle: job.sourceTitle ?? null,
    displayName: job.displayName ?? job.sourceTitle ?? null,
    sourceKind: job.sourceKind ?? null,
    status: job.status,
    serverTime: now.toISOString(),
    timing: presentJobTiming(job, now),
    processingProgress,
    stages: {
      validatingAt: job.validatingAt?.toISOString() ?? null,
      processingStartedAt: job.processingStartedAt?.toISOString() ?? null,
      processingFinishedAt: job.processingFinishedAt?.toISOString() ?? null,
      uploadingResultAt: job.uploadingResultAt?.toISOString() ?? null,
    },
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    queuedAt: job.queuedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    retryOfJobId: job.retryOfJobId?.toHexString() ?? null,
    input: {
      extension: job.inputReservation.extension,
      bytes: job.inputReservation.bytes,
      durationSeconds: job.inputReservation.durationSeconds,
    },
    error: job.lastError
      ? {
          code: job.lastError.code,
          message: job.lastError.message,
          at: job.lastError.at.toISOString(),
        }
      : null,
    canDownloadInput: job.inputObject !== null,
    canDownloadOutput: job.status === 'ready' && job.outputObject !== null,
  };
}

import { presentServerStageTimings } from './job-stage-timing.js';
import type { Job } from './job.schema.js';
import { YOUTUBE_SOURCE_URL_PATTERN } from './job-metadata.js';
import { presentJobTiming } from './job-timing.js';

export function presentJob(job: Job, includeAttemptTimings = true) {
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
    ...(job.processingOrigin ? { processingOrigin: job.processingOrigin } : {}),
    requestId: job.requestId,
    sourceUrl:
      job.sourceUrl && YOUTUBE_SOURCE_URL_PATTERN.test(job.sourceUrl)
        ? job.sourceUrl
        : null,
    recipeDigest:
      (job.outputRecipeSnapshot ?? job.recipeSnapshot)?.recipeDigest ?? null,
    localProfileId:
      job.processingOrigin === 'local_device'
        ? 'kim-vocal-2-full-timeline-v1'
        : null,
    output: job.outputObject
      ? {
          extension: 'mp3' as const,
          contentType: job.outputObject.contentType,
          bytes: job.outputObject.bytes,
          sha256: job.outputObject.sha256,
          durationSeconds: job.measuredOutputDurationSeconds ?? null,
        }
      : null,
    sourceTitle: job.sourceTitle ?? null,
    displayName: job.displayName ?? job.sourceTitle ?? null,
    sourceKind: job.sourceKind ?? null,
    status: job.status,
    serverTime: now.toISOString(),
    serverStageTimings: presentServerStageTimings(
      job,
      now,
      includeAttemptTimings,
    ),
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
      contentType: job.inputReservation.contentType,
      sha256: job.inputReservation.sha256,
      durationSeconds: job.inputReservation.durationSeconds,
    },
    error: job.lastError
      ? {
          code: job.lastError.code,
          message: job.lastError.message,
          at: job.lastError.at.toISOString(),
        }
      : null,
    canDownloadInput:
      job.inputObject != null && !job.reservationCleanupScheduledAt,
    comparisonRanges: job.comparisonRanges ?? null,
    trimEnabled:
      job.outputRecipeSnapshot?.trimEnabled ??
      job.requestedTrimEnabled ??
      job.recipeSnapshot?.trimEnabled ??
      true,
    canDownloadOutput: job.status === 'ready' && job.outputObject !== null,
  };
}

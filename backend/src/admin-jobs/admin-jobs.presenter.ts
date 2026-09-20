import type { AdminActor } from '../admin/admin.types.js';
import type { Job } from '../jobs/job.schema.js';
import { presentJobTiming } from '../jobs/job-timing.js';
import { safeJobMessage } from '../job-errors/safe-job-error.js';
const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;
const seconds = (
  start: Date | null | undefined,
  end: Date | null | undefined,
) =>
  start && end && end >= start
    ? (end.getTime() - start.getTime()) / 1000
    : null;
export function presentAdminJob(
  job: Job,
  actor: AdminActor,
  queuePosition: number | null,
  now: Date,
  detail = false,
) {
  const timing = presentJobTiming(job, now),
    error = job.lastError && safeJobMessage(job.lastError.code);
  // Recovery replaces validatingAt but retains the first processing start.
  // The original queue boundary is no longer available on this projection.
  const stage = (
    name: string,
    start: Date | null | undefined,
    end: Date | null | undefined,
    duration = seconds(start, end),
  ) => ({
    stage: name,
    startedAt: iso(start),
    finishedAt: iso(start && end && end < start ? null : end),
    durationSeconds: duration,
  });
  return {
    id: job._id.toHexString(),
    userId: job.userId.toHexString(),
    status: job.status,
    createdAt: iso(job.createdAt),
    queuedAt: iso(job.queuedAt),
    startedAt: iso(job.validatingAt),
    finishedAt: iso(job.finishedAt),
    elapsedSeconds:
      timing.processingElapsedMs === null
        ? null
        : timing.processingElapsedMs / 1000,
    queuePosition,
    revision: job.adminRevision ?? 0,
    lastError: error ? { code: job.lastError!.code, message: error } : null,
    ...(actor.permissions.includes('media.read')
      ? {
          displayName: job.displayName ?? job.sourceTitle ?? null,
          sourceUrl: job.sourceUrl ?? null,
        }
      : {}),
    ...(detail
      ? {
          retryOfJobId: job.retryOfJobId?.toHexString() ?? null,
          stageTimings: [
            stage('upload', job.createdAt, job.queuedAt),
            stage('queued', job.queuedAt, job.validatingAt),
            stage('validating', job.validatingAt, job.processingStartedAt),
            stage(
              'processing',
              job.processingStartedAt,
              job.processingFinishedAt,
              timing.processingElapsedMs === null
                ? null
                : timing.processingElapsedMs / 1000,
            ),
            stage('uploading_result', job.uploadingResultAt, job.finishedAt),
          ],
          source:
            job.admissionSnapshot?.source ??
            (job.sourceKind === 'url' ? 'youtube' : 'audio_file'),
          declaredBytes: job.inputReservation.bytes,
          measuredBytes: job.inputObject?.bytes ?? null,
          policyVersion: job.admissionSnapshot?.policyVersion ?? 1,
          declaredDurationSeconds: job.inputReservation.durationSeconds,
          measuredDurationSeconds: job.measuredDurationSeconds ?? null,
          media: {
            inputAvailable: !!job.inputObject,
            resultAvailable: job.status === 'ready' && !!job.outputObject,
          },
        }
      : {}),
  };
}

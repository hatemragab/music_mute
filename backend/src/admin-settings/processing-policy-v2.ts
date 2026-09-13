import type { ProcessingQualification } from './processing-qualification.js';
import type { QueuePolicyValues } from './queue-policy.schema.js';
import { jobError } from '../jobs/job-errors.js';

export const PREPARATION_PROFILE_ID = 'preserve-or-aac-lc-256-v1';
export type InputSource = 'audio_file' | 'video_file' | 'youtube';
export type EvidenceStatus = 'verified' | 'unavailable' | 'stale';

/** Physical validation and readiness are separate: numerical ceilings do not prove capacity. */
export function assertPreparedAudioV2(
  input: { bytes: number; durationSeconds: number },
  evidence: { evidenceStatus: EvidenceStatus },
): void {
  if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0)
    throw jobError('MEDIA_UNSUPPORTED');
  if (input.bytes > 100_000_000) throw jobError('MEDIA_TOO_LARGE');
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0)
    throw jobError('MEDIA_DURATION_UNKNOWN');
  if (input.durationSeconds > 1800) throw jobError('MEDIA_TOO_LONG');
  if (evidence.evidenceStatus !== 'verified')
    throw jobError('PROCESSING_CAPACITY_UNAVAILABLE');
}

/** Until local media and registered worker evidence exists, expansion is explicitly unavailable. */
export function normalizeProcessingPolicyV2(
  settings: {
    revision: number;
    acceptNewJobs: boolean;
    messageEn: string;
    messageAr: string | null;
  },
  queuePolicy?: QueuePolicyValues & {
    qualification?: ProcessingQualification | null;
  },
  expandedAdmissionAvailable = false,
) {
  if (
    !Number.isSafeInteger(settings.revision) ||
    settings.revision < 0 ||
    typeof settings.acceptNewJobs !== 'boolean' ||
    typeof settings.messageEn !== 'string' ||
    (settings.messageAr !== null && typeof settings.messageAr !== 'string')
  )
    throw jobError('PROCESSING_POLICY_INCOMPATIBLE');
  return {
    schemaVersion: 2 as const,
    revision: settings.revision,
    acceptNewJobs:
      settings.acceptNewJobs &&
      queuePolicy?.acceptNewJobs !== false &&
      expandedAdmissionAvailable,
    acceptLongJobs:
      settings.acceptNewJobs &&
      queuePolicy?.acceptLongJobs === true &&
      expandedAdmissionAvailable,
    checkedAt: new Date().toISOString(),
    messageEn: settings.messageEn,
    messageAr: settings.messageAr,
    limits: {
      maxDurationSeconds: queuePolicy?.maxDurationSeconds ?? 1800,
      maxPreparedAudioBytes: queuePolicy?.maxPreparedAudioBytes ?? 100_000_000,
      maxActiveJobsPerUser: 1,
      allowanceAudioSeconds: queuePolicy?.allowanceAudioSeconds ?? 3600,
      allowanceWindowSeconds: 86400,
      maxLocalSourceBytes:
        queuePolicy?.qualification?.maxLocalSourceBytes ?? null,
      longJobThresholdSeconds: 600,
      maxSourceDownloadBytes:
        queuePolicy?.qualification?.maxSourceDownloadBytes ?? null,
      maxPreparationSeconds:
        queuePolicy?.qualification?.maxPreparationSeconds ?? null,
      maxSourceDownloadSeconds:
        queuePolicy?.qualification?.maxSourceDownloadSeconds ?? null,
    },
    preparationProfile: {
      id: PREPARATION_PROFILE_ID,
      preserveCompatibleAudio: true as const,
      fallbackConversion: {
        outputContentType: 'audio/mp4' as const,
        codec: 'aac-lc' as const,
        targetBitrate: 256000 as const,
      },
      compatibilityRevision:
        queuePolicy?.qualification?.compatibilityRevision ?? 'unavailable',
    },
  };
}

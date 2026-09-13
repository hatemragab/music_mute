import { adminError } from '../admin/admin-errors.js';
export interface ProcessingQualification {
  evidenceReference: string;
  compatibilityRevision: string;
  measuredAt: string;
  expiresAt: string;
  qualifiedWorkerIds: string[];
  maxLocalSourceBytes: number;
  maxSourceDownloadBytes: number;
  maxPreparationSeconds: number;
  maxSourceDownloadSeconds: number;
  maxOutputBytes: number;
  probeTimeoutSeconds: number;
  processingTimeoutSeconds: number;
  maxOutstandingEstimatedWorkerSeconds: number;
  costModelRevision: string;
  referenceProcessingSecondsPerAudioSecond: number;
  fixedJobOverheadSeconds: number;
}
export function assertQualification(
  value: ProcessingQualification,
  now: Date,
  allowExpired = false,
): void {
  const numbers: Array<[number, number, number]> = [
    [value.maxLocalSourceBytes, 1, 20_000_000_000],
    [value.maxSourceDownloadBytes, 1, 2_000_000_000],
    [value.maxPreparationSeconds, 1, 86400],
    [value.maxSourceDownloadSeconds, 1, 86400],
    [value.maxOutputBytes, 1, 100_000_000],
    [value.probeTimeoutSeconds, 1, 600],
    [value.processingTimeoutSeconds, 1, 86400],
    [value.maxOutstandingEstimatedWorkerSeconds, 1, 86400_000],
  ];
  const measured = Date.parse(value.measuredAt),
    expires = Date.parse(value.expiresAt);
  if (
    [
      value.evidenceReference,
      value.compatibilityRevision,
      value.costModelRevision,
    ].some(
      (v) => typeof v !== 'string' || v.trim().length < 1 || v.length > 200,
    ) ||
    numbers.some(
      ([v, min, max]) => !Number.isSafeInteger(v) || v < min || v > max,
    ) ||
    !Number.isFinite(value.referenceProcessingSecondsPerAudioSecond) ||
    value.referenceProcessingSecondsPerAudioSecond <= 0 ||
    value.referenceProcessingSecondsPerAudioSecond > 1000 ||
    !Number.isFinite(value.fixedJobOverheadSeconds) ||
    value.fixedJobOverheadSeconds < 0 ||
    value.fixedJobOverheadSeconds > 3600 ||
    !Array.isArray(value.qualifiedWorkerIds) ||
    value.costModelRevision.length > 128 ||
    value.qualifiedWorkerIds.length < 1 ||
    value.qualifiedWorkerIds.length > 100 ||
    new Set(value.qualifiedWorkerIds).size !==
      value.qualifiedWorkerIds.length ||
    value.qualifiedWorkerIds.some(
      (id) => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id),
    ) ||
    !Number.isFinite(measured) ||
    measured > now.getTime() + 5000 ||
    !Number.isFinite(expires) ||
    expires <= measured ||
    expires - measured > 30 * 86400_000 ||
    (!allowExpired && expires <= now.getTime())
  )
    throw adminError('INVALID_REQUEST');
}
export function qualificationReady(
  value: ProcessingQualification | null | undefined,
  now: Date,
): value is ProcessingQualification {
  if (!value) return false;
  try {
    assertQualification(value, now);
    return true;
  } catch {
    return false;
  }
}

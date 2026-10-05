import type { MediaImport } from './media-import.schema.js';
import { trusted } from 'mongoose';

export const MAX_ACQUISITION_ATTEMPTS = 4;

/** Missing historical generation fields are equivalent to the initial generation. */
export function handoffAttemptFilter(
  record: Pick<MediaImport, 'handoffAttempt'>,
) {
  const attempt = record.handoffAttempt ?? 0;
  return {
    $or: [
      { handoffAttempt: attempt },
      ...(attempt === 0
        ? [{ handoffAttempt: trusted({ $exists: false }) }]
        : []),
    ],
  };
}

/** A private adapter may shorten backoff without increasing the attempt ceiling. */
export function boundedRetryAfterSeconds(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 20
    ? value
    : undefined;
}

/** Only pre-upload transient failures may start another acquisition. */
export function acquisitionRetryDelay(
  record: MediaImport,
  code: string,
  retryAfterSeconds?: number,
): number | null {
  const attempt = record.acquisitionAttempt ?? 0;
  const maximum = record.maxAcquisitionAttempts ?? 1;
  if (
    ![
      'IMPORT_DEPENDENCY_FAILED',
      'IMPORT_UPSTREAM_REFUSED',
      'IMPORT_DISK_FULL',
    ].includes(code) ||
    !['downloading', 'validating'].includes(record.status) ||
    record.handoffPending ||
    record.jobId ||
    record.input ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !Number.isSafeInteger(maximum) ||
    maximum > MAX_ACQUISITION_ATTEMPTS ||
    attempt >= maximum
  )
    return null;
  const hint = boundedRetryAfterSeconds(retryAfterSeconds);
  return hint === undefined ? 5_000 * 2 ** (attempt - 1) : hint * 1_000;
}

/** Reuse only a confirmed source; transaction outages have their own capped backoff. */
export function handoffRetryDelay(
  record: MediaImport,
  code: string,
): number | null {
  const attempt = record.handoffAttempt ?? 0;
  if (
    code !== 'IMPORT_DEPENDENCY_FAILED' ||
    !['queued', 'downloading', 'validating', 'uploading'].includes(
      record.status,
    ) ||
    !record.sharedSourceKey ||
    !record.sharedResultKey ||
    record.jobId ||
    !Number.isSafeInteger(attempt) ||
    attempt < 0 ||
    attempt >= Number.MAX_SAFE_INTEGER
  )
    return null;
  return Math.min(30_000, 5_000 * 2 ** Math.min(attempt, 3));
}

/** Completed queue entries from an earlier attempt cannot collide with a retry. */
export function importExecutionJobId(record: MediaImport): string {
  const id = record._id.toHexString();
  if (record.handoffPending) return `${id}-handoff-${record.handoffAttempt}`;
  return (record.maxAcquisitionAttempts ?? 1) > 1
    ? `${id}-${(record.acquisitionAttempt ?? 0) + (record.status === 'queued' ? 1 : 0)}`
    : id;
}

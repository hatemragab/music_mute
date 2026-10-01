import type { MediaImport } from './media-import.schema.js';

export const MAX_ACQUISITION_ATTEMPTS = 4;

/** Only pre-upload transient failures may start another acquisition. */
export function acquisitionRetryDelay(
  record: MediaImport,
  code: string,
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
    record.jobId ||
    record.input ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !Number.isSafeInteger(maximum) ||
    maximum > MAX_ACQUISITION_ATTEMPTS ||
    attempt >= maximum
  )
    return null;
  return 5_000 * 2 ** (attempt - 1);
}

/** Completed queue entries from an earlier attempt cannot collide with a retry. */
export function importExecutionJobId(record: MediaImport): string {
  const id = record._id.toHexString();
  return (record.maxAcquisitionAttempts ?? 1) > 1
    ? `${id}-${(record.acquisitionAttempt ?? 0) + (record.status === 'queued' ? 1 : 0)}`
    : id;
}

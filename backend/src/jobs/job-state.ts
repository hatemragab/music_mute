import {
  MAX_AUDIO_DURATION_SECONDS,
  MAX_PREPARED_AUDIO_BYTES,
} from './media-limits.js';
import { authError } from '../auth/auth.errors.js';
import { jobError } from './job-errors.js';
import {
  AUDIO_TYPES,
  type InputDeclaration,
  type JobStatus,
} from './job.types.js';
export { ACTIVE_ADMISSION_STATUSES } from './job-lifecycle-policy.js';

export function isSha256(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9+/]{43}=$/.test(value) &&
    Buffer.from(value, 'base64').length === 32 &&
    Buffer.from(value, 'base64').toString('base64') === value
  );
}

export function assertInputDeclaration(input: InputDeclaration): void {
  if (
    !input ||
    !Object.hasOwn(AUDIO_TYPES, input.extension) ||
    AUDIO_TYPES[input.extension] !== input.contentType ||
    !Number.isInteger(input.bytes) ||
    input.bytes < 1 ||
    input.bytes > MAX_PREPARED_AUDIO_BYTES ||
    !Number.isFinite(input.durationSeconds) ||
    input.durationSeconds <= 0 ||
    input.durationSeconds > MAX_AUDIO_DURATION_SECONDS ||
    !isSha256(input.sha256)
  ) {
    throw authError('INVALID_INPUT');
  }
}

export function assertMeasuredDuration(
  durationSeconds: number,
  maxDurationSeconds = MAX_AUDIO_DURATION_SECONDS,
): void {
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > maxDurationSeconds ||
    maxDurationSeconds <= 0 ||
    maxDurationSeconds > MAX_AUDIO_DURATION_SECONDS
  )
    throw authError('INVALID_INPUT');
}

export function nextCancellationState(status: JobStatus): JobStatus {
  if (
    [
      'awaiting_upload',
      'queued',
      'validating',
      'processing',
      'uploading_result',
      'interrupted',
      'cancel_requested',
      'cancelled',
    ].includes(status)
  )
    return 'cancelled';
  throw jobError('JOB_STATE_CONFLICT');
}

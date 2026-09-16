import { authError } from '../auth/auth.errors.js';
import { jobError } from './job-errors.js';
import {
  AUDIO_TYPES,
  type InputDeclaration,
  type JobStatus,
} from './job.types.js';

export const ACTIVE_ADMISSION_STATUSES: readonly JobStatus[] = [
  'awaiting_upload',
  'queued',
  'validating',
  'processing',
  'uploading_result',
  'interrupted',
  'cancel_requested',
];

export function isSha256(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9+/]{43}=$/.test(value) &&
    Buffer.from(value, 'base64').length === 32 &&
    Buffer.from(value, 'base64').toString('base64') === value
  );
}

export function assertInputDeclaration(
  input: InputDeclaration,
  policyVersion: 1 | 2 = 1,
): void {
  if (
    !input ||
    !Object.hasOwn(AUDIO_TYPES, input.extension) ||
    AUDIO_TYPES[input.extension] !== input.contentType ||
    !Number.isInteger(input.bytes) ||
    input.bytes < 1 ||
    (policyVersion === 2
      ? input.bytes > 100_000_000
      : input.bytes >= 30_000_000) ||
    !Number.isFinite(input.durationSeconds) ||
    input.durationSeconds <= 0 ||
    (policyVersion === 2
      ? input.durationSeconds > 1800
      : input.durationSeconds >= 600) ||
    !isSha256(input.sha256)
  ) {
    throw authError('INVALID_INPUT');
  }
}

export function assertMeasuredDuration(
  durationSeconds: number,
  maxDurationSecondsExclusive = 600,
): void {
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds >= maxDurationSecondsExclusive ||
    maxDurationSecondsExclusive <= 0 ||
    maxDurationSecondsExclusive > 600
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

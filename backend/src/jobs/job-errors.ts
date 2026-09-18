import { HttpException } from '@nestjs/common';

const errors = {
  MEDIA_TOO_LONG: [400, 'Audio must be at most 30 minutes'],
  MEDIA_TOO_LARGE: [400, 'Prepared audio exceeds the size limit'],
  MEDIA_UNSUPPORTED: [400, 'This audio format is unsupported'],
  MEDIA_DURATION_UNKNOWN: [400, 'Audio duration could not be verified'],
  PROCESSING_ALLOWANCE_EXHAUSTED: [
    409,
    'The rolling processing allowance is exhausted',
  ],
  PROCESSING_POLICY_INCOMPATIBLE: [
    409,
    'Refresh the processing policy before continuing',
  ],
  PROCESSING_LIMIT_REACHED: [
    409,
    'The active processing job limit was reached',
  ],
  NEW_INPUT_REQUIRED: [409, 'A new input upload is required for this retry'],
  JOB_NOT_FOUND: [404, 'Job not found'],
  JOB_ACTIVE: [409, 'Cancel this job before deleting it'],
  JOB_STATE_CONFLICT: [409, 'This action is not available for this job'],
  IDEMPOTENCY_CONFLICT: [409, 'The request identifier was already used'],
  UPLOAD_NOT_READY: [409, 'The uploaded file is not ready or does not match'],
  UPLOAD_RESERVATION_EXPIRED: [409, 'The upload reservation expired'],
  PROCESSING_UNAVAILABLE: [503, 'New audio processing work is unavailable'],
} as const;
export type JobHttpErrorCode = keyof typeof errors;
export function jobError(
  code: JobHttpErrorCode,
  details: { nextReplenishmentAt?: string | null } = {},
): HttpException {
  const [statusCode, message] = errors[code];
  return new HttpException(
    { statusCode, code, message, ...details },
    statusCode,
  );
}

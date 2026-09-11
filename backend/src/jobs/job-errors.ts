import { HttpException } from '@nestjs/common';

const errors = {
  JOB_NOT_FOUND: [404, 'Job not found'],
  JOB_ACTIVE: [409, 'Cancel this job before deleting it'],
  JOB_STATE_CONFLICT: [409, 'This action is not available for this job'],
  IDEMPOTENCY_CONFLICT: [409, 'The request identifier was already used'],
  WORKER_RECOVERY_REQUIRED: [409, 'The previous assignment requires recovery'],
  STALE_ATTEMPT: [409, 'The processing assignment is no longer current'],
  NEW_INPUT_REQUIRED: [409, 'Submit a corrected audio file'],
  UPLOAD_NOT_READY: [409, 'The uploaded file is not ready or does not match'],
  UPLOAD_RESERVATION_EXPIRED: [409, 'The upload reservation expired'],
  PROCESSING_UNAVAILABLE: [503, 'New audio processing work is unavailable'],
  PROCESSING_LIMIT_REACHED: [409, 'The active processing limit was reached'],
} as const;
export type JobHttpErrorCode = keyof typeof errors;
export function jobError(code: JobHttpErrorCode): HttpException {
  const [statusCode, message] = errors[code];
  return new HttpException({ statusCode, code, message }, statusCode);
}

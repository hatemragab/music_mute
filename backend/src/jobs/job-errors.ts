import { HttpException } from '@nestjs/common';

const errors = {
  MEDIA_TOO_LONG: [400, 'Audio must be at most 20 minutes'],
  MEDIA_TOO_LARGE: [400, 'Prepared audio exceeds the size limit'],
  MEDIA_UNSUPPORTED: [400, 'This audio format is unsupported'],
  MEDIA_DURATION_UNKNOWN: [400, 'Audio duration could not be verified'],
  PROCESSING_ALLOWANCE_EXHAUSTED: [
    409,
    'The monthly processing allowance is exhausted',
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
  UPLOAD_GRANT_LIMIT_REACHED: [
    409,
    'The account upload grant limit was reached',
  ],
  UPLOAD_BYTE_LIMIT_REACHED: [
    409,
    'The monthly confirmed upload byte limit was reached',
  ],
  UPLOAD_ATTEMPT_LIMIT_REACHED: [
    409,
    'The maximum input upload attempts were used',
  ],
  RETAINED_STORAGE_LIMIT_REACHED: [
    409,
    'The retained result storage limit was reached',
  ],
  DOWNLOAD_RESERVATION_EXPIRED: [409, 'The download grant request expired'],
  DOWNLOAD_GRANT_LIMIT_REACHED: [
    409,
    'The monthly result access limit was reached',
  ],
  DOWNLOAD_BYTE_LIMIT_REACHED: [
    409,
    'The monthly estimated result byte limit was reached',
  ],
  SERVICE_BANDWIDTH_LIMIT_REACHED: [
    503,
    'New transfer grants are temporarily unavailable',
  ],
  PROCESSING_UNAVAILABLE: [503, 'New audio processing work is unavailable'],
} as const;
export type JobHttpErrorCode = keyof typeof errors;

export interface JobCapacityDetails {
  waitingJobs: number;
  maxWaitingJobs: number;
  processingJobs: number;
  maxProcessingJobs: number;
}

export interface JobErrorDetails {
  nextResetAt?: string | null;
  capacity?: JobCapacityDetails;
  action?: 'wait_for_job_to_finish';
}

export function jobError(
  code: JobHttpErrorCode,
  details: JobErrorDetails = {},
): HttpException {
  const [statusCode, message] = errors[code];
  return new HttpException(
    { statusCode, code, message, ...details },
    statusCode,
  );
}

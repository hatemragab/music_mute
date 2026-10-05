import { HttpException } from '@nestjs/common';
import { authError, type AuthErrorCode } from '../auth/auth.errors.js';
import { jobError, type JobHttpErrorCode } from '../jobs/job-errors.js';
import { boundedRetryAfterSeconds } from './import-retry.js';

export type SafeImportError = {
  code: string;
  message: string;
  retryAfterSeconds?: number;
};

const businessCodes: JobHttpErrorCode[] = [
  'IDEMPOTENCY_CONFLICT',
  'PROCESSING_ALLOWANCE_EXHAUSTED',
  'PROCESSING_LIMIT_REACHED',
  'PROCESSING_UNAVAILABLE',
  'UPLOAD_GRANT_LIMIT_REACHED',
  'UPLOAD_BYTE_LIMIT_REACHED',
  'RETAINED_STORAGE_LIMIT_REACHED',
  'SERVICE_BANDWIDTH_LIMIT_REACHED',
  'UPLOAD_RESERVATION_EXPIRED',
  'PROCESSING_POLICY_INCOMPATIBLE',
  'MEDIA_TOO_LONG',
  'MEDIA_TOO_LARGE',
  'MEDIA_UNSUPPORTED',
  'MEDIA_DURATION_UNKNOWN',
  'UPLOAD_ATTEMPT_LIMIT_REACHED',
  'JOB_NOT_FOUND',
  'JOB_STATE_CONFLICT',
];
const accountCodes: AuthErrorCode[] = [
  'INVALID_INPUT',
  'ACCOUNT_RESTRICTED',
  'ACCOUNT_DISABLED',
  'ACCOUNT_DELETION_PENDING',
];

const errors = {
  IMPORT_DISABLED: [503, 'URL import is unavailable'],
  IMPORT_INVALID_URL: [400, 'Enter a valid media link'],
  IMPORT_UNSUPPORTED_PROVIDER: [
    422,
    'This website is not supported for URL import',
  ],
  IMPORT_SINGLE_ITEM_REQUIRED: [
    422,
    'Submit a clean single-item link without a playlist',
  ],
  IMPORT_UNSUPPORTED_AUDIO_SOURCE: [
    422,
    'This link cannot provide verified native audio without downloading video',
  ],
  IMPORT_TOO_LARGE: [422, 'The audio exceeds the permitted file size'],
  IMPORT_TOO_LONG: [422, 'The audio exceeds the permitted duration'],
  IMPORT_INVALID_AUDIO: [
    422,
    'The source did not provide valid supported audio',
  ],
  IMPORT_QUEUE_FULL: [503, 'Import capacity is full; try again later'],
  IMPORT_UPSTREAM_REFUSED: [
    502,
    'The source platform temporarily refused the request',
  ],
  IMPORT_SOURCE_UNAVAILABLE: [
    422,
    'The source is unavailable or requires unsupported access',
  ],
  IMPORT_DEPENDENCY_FAILED: [503, 'An import dependency is unavailable'],
  IMPORT_ACQUISITION_EXHAUSTED: [
    503,
    'The audio acquisition budget was exhausted',
  ],
  IMPORT_DISK_FULL: [503, 'Temporary import storage is full; try again later'],
  IMPORT_NOT_FOUND: [404, 'Import not found'],
  IMPORT_CACHE_MISS: [404, 'No completed matching shared audio is available'],
  IMPORT_REQUEST_CONFLICT: [
    409,
    'This request identifier was used for a different import',
  ],
} as const;

export type ImportErrorCode = keyof typeof errors;

export function importError(
  code: ImportErrorCode,
  limit?: number,
  retryAfterSeconds?: number,
): HttpException {
  const [statusCode, message] = errors[code];
  const detail =
    limit === undefined
      ? message
      : `${message} (maximum ${limit} ${code === 'IMPORT_TOO_LONG' ? 'seconds' : 'bytes'})`;
  const retryAfter = boundedRetryAfterSeconds(retryAfterSeconds);
  return new HttpException(
    {
      statusCode,
      code,
      message: detail,
      ...(limit === undefined ? {} : { limit }),
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
    },
    statusCode,
  );
}

/** Never persist upstream exception messages, which can contain signed URLs. */
export function safeImportError(error: unknown): SafeImportError {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (
      typeof response === 'object' &&
      'code' in response &&
      accountCodes.includes(response.code as AuthErrorCode)
    ) {
      const safe = authError(response.code as AuthErrorCode).getResponse() as {
        code: string;
        message: string;
      };
      return { code: safe.code, message: safe.message };
    }
    if (
      typeof response === 'object' &&
      'code' in response &&
      typeof response.code === 'string' &&
      Object.hasOwn(errors, response.code)
    ) {
      const code = response.code as ImportErrorCode;
      const limit =
        'limit' in response &&
        typeof response.limit === 'number' &&
        Number.isFinite(response.limit) &&
        response.limit > 0
          ? response.limit
          : undefined;
      const retryAfterSeconds =
        'retryAfterSeconds' in response
          ? boundedRetryAfterSeconds(response.retryAfterSeconds)
          : undefined;
      const safe = importError(code, limit).getResponse() as SafeImportError;
      return {
        code,
        message: safe.message,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      };
    }
    if (
      typeof response === 'object' &&
      'code' in response &&
      businessCodes.includes(response.code as JobHttpErrorCode)
    ) {
      const safe = jobError(
        response.code as JobHttpErrorCode,
      ).getResponse() as { code: string; message: string };
      return { code: safe.code, message: safe.message };
    }
  }
  return {
    code: 'IMPORT_DEPENDENCY_FAILED',
    message: errors.IMPORT_DEPENDENCY_FAILED[1],
  };
}

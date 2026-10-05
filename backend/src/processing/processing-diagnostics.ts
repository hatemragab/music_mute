import { HttpException } from '@nestjs/common';

export type ProcessingHandoffStep =
  | 'session-start'
  | 'idempotency-read'
  | 'purged-request-check'
  | 'admission'
  | 'job-create'
  | 'upload-reservation'
  | 'upload-confirmation'
  | 'input-attachment'
  | 'retained-media'
  | 'notification-outbox'
  | 'commit'
  | 'session-end';

export interface ProcessingTransactionDiagnostics {
  operation: 'url-import-handoff';
  acquisitionId: string;
  /** The caller updates this immediately before each awaited handoff operation. */
  step: ProcessingHandoffStep;
}

const HANDOFF_STEPS = new Set<ProcessingHandoffStep>([
  'session-start',
  'idempotency-read',
  'purged-request-check',
  'admission',
  'job-create',
  'upload-reservation',
  'upload-confirmation',
  'input-attachment',
  'retained-media',
  'notification-outbox',
  'commit',
  'session-end',
]);

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Runtime allowlisting protects logs even if an untyped caller passes context. */
export function safeTransactionDiagnostics(
  value: ProcessingTransactionDiagnostics | undefined,
) {
  if (property(value, 'operation') !== 'url-import-handoff') return undefined;
  const acquisitionId = property(value, 'acquisitionId');
  const step = property(value, 'step');
  return {
    operation: 'url-import-handoff' as const,
    ...(typeof acquisitionId === 'string' && UUID.test(acquisitionId)
      ? { acquisition_id: acquisitionId.toLowerCase() }
      : {}),
    step:
      typeof step === 'string' &&
      HANDOFF_STEPS.has(step as ProcessingHandoffStep)
        ? (step as ProcessingHandoffStep)
        : ('unknown' as const),
  };
}

const ERROR_TYPES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'HttpException',
  'BadRequestException',
  'ForbiddenException',
  'ServiceUnavailableException',
  'ValidationError',
  'CastError',
  'StrictModeError',
  'MissingSchemaError',
  'MongoError',
  'MongoServerError',
  'MongoDriverError',
  'MongoRuntimeError',
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoOperationTimeoutError',
  'MongoServerSelectionError',
  'MongooseServerSelectionError',
  'MongoTopologyClosedError',
  'MongoNotConnectedError',
  'MongoServerClosedError',
  'MongoTransactionError',
  'MongoExpiredSessionError',
  'TimeoutError',
  'AbortError',
]);

const RETRY_LABELS = [
  'TransientTransactionError',
  'UnknownTransactionCommitResult',
  'RetryableWriteError',
  'NoWritesPerformed',
] as const;

const DOMAIN_CODES = new Set([
  'INVALID_INPUT',
  'UNAUTHENTICATED',
  'ACCOUNT_DISABLED',
  'ACCOUNT_RESTRICTED',
  'ACCOUNT_DELETION_PENDING',
  'SERVICE_UNAVAILABLE',
  'DEPENDENCY_UNAVAILABLE',
  'DEPENDENCY_TIMEOUT',
  'MEDIA_TOO_LONG',
  'MEDIA_TOO_LARGE',
  'MEDIA_UNSUPPORTED',
  'MEDIA_DURATION_UNKNOWN',
  'PROCESSING_ALLOWANCE_EXHAUSTED',
  'PROCESSING_POLICY_INCOMPATIBLE',
  'PROCESSING_LIMIT_REACHED',
  'PROCESSING_UNAVAILABLE',
  'IDEMPOTENCY_CONFLICT',
  'JOB_NOT_FOUND',
  'JOB_STATE_CONFLICT',
  'UPLOAD_NOT_READY',
  'UPLOAD_RESERVATION_EXPIRED',
  'UPLOAD_GRANT_LIMIT_REACHED',
  'UPLOAD_BYTE_LIMIT_REACHED',
  'UPLOAD_ATTEMPT_LIMIT_REACHED',
  'RETAINED_STORAGE_LIMIT_REACHED',
  'SERVICE_BANDWIDTH_LIMIT_REACHED',
  'IMPORT_DISABLED',
  'IMPORT_INVALID_URL',
  'IMPORT_UNSUPPORTED_PROVIDER',
  'IMPORT_SINGLE_ITEM_REQUIRED',
  'IMPORT_UNSUPPORTED_AUDIO_SOURCE',
  'IMPORT_TOO_LARGE',
  'IMPORT_TOO_LONG',
  'IMPORT_INVALID_AUDIO',
  'IMPORT_QUEUE_FULL',
  'IMPORT_UPSTREAM_REFUSED',
  'IMPORT_SOURCE_UNAVAILABLE',
  'IMPORT_DEPENDENCY_FAILED',
  'IMPORT_ACQUISITION_EXHAUSTED',
  'IMPORT_DISK_FULL',
  'IMPORT_NOT_FOUND',
  'IMPORT_REQUEST_CONFLICT',
]);

export interface SafeProcessingFailure {
  error_type: string;
  reason:
    | 'timeout'
    | 'write-conflict'
    | 'validation'
    | 'runtime-type-error'
    | 'network'
    | 'unknown';
  code?: number;
  retry_labels: (typeof RETRY_LABELS)[number][];
  http_status?: number;
  domain_code?: string;
  cause?: SafeProcessingFailure;
}

function property(value: unknown, key: string): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function'))
    return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function reason(name: string, code: unknown): SafeProcessingFailure['reason'] {
  if (code === 112) return 'write-conflict';
  if (
    [
      'MongoOperationTimeoutError',
      'MongoNetworkTimeoutError',
      'TimeoutError',
      'AbortError',
    ].includes(name) ||
    [50, 89, 202, 262].includes(code as number) ||
    code === 'ETIMEDOUT'
  )
    return 'timeout';
  if (['ValidationError', 'CastError', 'StrictModeError'].includes(name))
    return 'validation';
  if (
    ['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'].includes(name)
  )
    return 'runtime-type-error';
  if (
    [
      'MongoNetworkError',
      'MongoServerSelectionError',
      'MongooseServerSelectionError',
      'MongoTopologyClosedError',
      'MongoNotConnectedError',
      'MongoServerClosedError',
    ].includes(name) ||
    ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(
      code as string,
    )
  )
    return 'network';
  return 'unknown';
}

function describeFailure(
  error: unknown,
  depth: number,
  seen: Set<unknown>,
): SafeProcessingFailure {
  const rawName = property(error, 'name');
  const name =
    typeof rawName === 'string' && ERROR_TYPES.has(rawName)
      ? rawName
      : 'unknown';
  const rawCode = property(error, 'code');
  const code =
    typeof rawCode === 'number' &&
    Number.isSafeInteger(rawCode) &&
    rawCode >= 0 &&
    rawCode <= 2_147_483_647
      ? rawCode
      : undefined;
  const rawLabels = property(error, 'errorLabels');
  const labels = new Set<unknown>();
  if (Array.isArray(rawLabels)) {
    // Driver labels are few; do not scan unbounded or invoke custom array methods.
    for (let index = 0; index < 16; index += 1)
      labels.add(property(rawLabels, String(index)));
  }
  const retryLabels = RETRY_LABELS.filter((label) => labels.has(label));
  let httpStatus: number | undefined;
  let domainCode: string | undefined;
  try {
    if (error instanceof HttpException) {
      const status = error.getStatus();
      if (Number.isInteger(status) && status >= 100 && status <= 599)
        httpStatus = status;
      const responseCode = property(error.getResponse(), 'code');
      if (typeof responseCode === 'string' && DOMAIN_CODES.has(responseCode))
        domainCode = responseCode;
    }
  } catch {
    // Diagnostics must never replace the original failure.
  }
  const result: SafeProcessingFailure = {
    error_type: name,
    reason: reason(name, rawCode),
    ...(code === undefined ? {} : { code }),
    retry_labels: retryLabels,
    ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
    ...(domainCode === undefined ? {} : { domain_code: domainCode }),
  };
  seen.add(error);
  const cause = property(error, 'cause');
  if (depth < 2 && cause !== undefined && !seen.has(cause))
    result.cause = describeFailure(cause, depth + 1, seen);
  return result;
}

/** Never includes messages, stacks, queries, response bodies, identities or URLs. */
export function safeProcessingFailure(error: unknown): SafeProcessingFailure {
  try {
    return describeFailure(error, 0, new Set());
  } catch {
    return { error_type: 'unknown', reason: 'unknown', retry_labels: [] };
  }
}

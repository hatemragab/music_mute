import { HttpException } from '@nestjs/common';

export type WorkerErrorCode =
  | 'WORKER_INVALID_REQUEST'
  | 'WORKER_UNAUTHENTICATED'
  | 'WORKER_FORBIDDEN'
  | 'WORKER_NOT_FOUND'
  | 'WORKER_CONFLICT'
  | 'WORKER_EXPIRED'
  | 'WORKER_RATE_LIMITED'
  | 'WORKER_DEPENDENCY_UNAVAILABLE';

const status: Record<WorkerErrorCode, number> = {
  WORKER_INVALID_REQUEST: 400,
  WORKER_UNAUTHENTICATED: 401,
  WORKER_FORBIDDEN: 403,
  WORKER_NOT_FOUND: 404,
  WORKER_CONFLICT: 409,
  WORKER_EXPIRED: 410,
  WORKER_RATE_LIMITED: 429,
  WORKER_DEPENDENCY_UNAVAILABLE: 503,
};

const message: Record<WorkerErrorCode, string> = {
  WORKER_INVALID_REQUEST: 'Invalid worker request',
  WORKER_UNAUTHENTICATED: 'Worker authentication is required',
  WORKER_FORBIDDEN: 'Worker operation is not allowed',
  WORKER_NOT_FOUND: 'Worker resource was not found',
  WORKER_CONFLICT: 'Worker resource changed',
  WORKER_EXPIRED: 'Worker credential has expired',
  WORKER_RATE_LIMITED: 'Worker request limit exceeded',
  WORKER_DEPENDENCY_UNAVAILABLE: 'Worker dependency is unavailable',
};

export function workerError(code: WorkerErrorCode): HttpException {
  return new HttpException(
    { statusCode: status[code], code, message: message[code] },
    status[code],
  );
}

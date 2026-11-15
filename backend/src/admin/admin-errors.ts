import { randomUUID } from 'node:crypto';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

export type AdminErrorCode =
  | 'MEDIA_UNAVAILABLE'
  | 'EXPORT_TOO_LARGE'
  | 'JOB_STATE_CONFLICT'
  | 'INVALID_UPDATE_POLICY'
  | 'INVALID_REQUEST'
  | 'INVALID_CURSOR'
  | 'INVALID_DATE_RANGE'
  | 'UNAUTHENTICATED'
  | 'ADMIN_ACCESS_DENIED'
  | 'ADMIN_REAUTH_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'RESOURCE_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'OPERATION_IN_PROGRESS'
  | 'LAST_OWNER_REQUIRED'
  | 'UPLOAD_TOO_LARGE';

const definitions: Record<AdminErrorCode, { status: number; message: string }> =
  {
    MEDIA_UNAVAILABLE: {
      status: HttpStatus.GONE,
      message: 'Media unavailable',
    },
    EXPORT_TOO_LARGE: {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      message: 'Export exceeds the permitted size',
    },
    JOB_STATE_CONFLICT: {
      status: HttpStatus.CONFLICT,
      message: 'Job state conflict',
    },
    INVALID_UPDATE_POLICY: {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      message: 'Invalid update policy',
    },
    INVALID_REQUEST: {
      status: HttpStatus.BAD_REQUEST,
      message: 'Invalid request',
    },
    INVALID_CURSOR: {
      status: HttpStatus.BAD_REQUEST,
      message: 'Invalid cursor',
    },
    INVALID_DATE_RANGE: {
      status: HttpStatus.BAD_REQUEST,
      message: 'Invalid date range',
    },
    UNAUTHENTICATED: {
      status: HttpStatus.UNAUTHORIZED,
      message: 'Authentication required',
    },
    ADMIN_ACCESS_DENIED: {
      status: HttpStatus.FORBIDDEN,
      message: 'Administrator access denied',
    },
    ADMIN_REAUTH_REQUIRED: {
      status: HttpStatus.FORBIDDEN,
      message: 'Administrator reauthentication required',
    },
    PERMISSION_DENIED: {
      status: HttpStatus.FORBIDDEN,
      message: 'Permission denied',
    },
    RATE_LIMITED: {
      status: HttpStatus.TOO_MANY_REQUESTS,
      message: 'Too many requests',
    },
    DEPENDENCY_UNAVAILABLE: {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message: 'Service unavailable',
    },
    RESOURCE_NOT_FOUND: {
      status: HttpStatus.NOT_FOUND,
      message: 'Resource not found',
    },
    REVISION_CONFLICT: {
      status: HttpStatus.CONFLICT,
      message: 'Revision conflict',
    },
    OPERATION_IN_PROGRESS: {
      status: HttpStatus.CONFLICT,
      message: 'Operation in progress',
    },
    LAST_OWNER_REQUIRED: {
      status: HttpStatus.CONFLICT,
      message: 'At least one active owner is required',
    },
    UPLOAD_TOO_LARGE: {
      status: HttpStatus.PAYLOAD_TOO_LARGE,
      message: 'Upload too large',
    },
  };

const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function adminRequestId(req: Pick<Request, 'headers'>): string {
  const supplied = req.headers['x-request-id'];
  return typeof supplied === 'string' && requestIdPattern.test(supplied)
    ? supplied.toLowerCase()
    : randomUUID();
}

export function adminError(
  code: AdminErrorCode,
  requestId: string = randomUUID(),
): HttpException {
  const definition = definitions[code];
  return new HttpException(
    { code, message: definition.message, requestId },
    definition.status,
  );
}

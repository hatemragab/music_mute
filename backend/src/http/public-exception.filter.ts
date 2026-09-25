import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import type { Request, Response } from 'express';
import { AuthRateLimitException } from '../auth/rate-limit.exception.js';
import { adminRequestId } from '../admin/admin-errors.js';
import type { AuthRequest } from '../auth/auth-request.js';
import { captureBackendFailure } from '../observability/sentry.js';

const parserStatuses: Record<string, number> = {
  'entity.too.large': 413,
  'entity.parse.failed': 400,
  'request.aborted': 400,
  'request.size.invalid': 400,
  'charset.unsupported': 415,
  'encoding.unsupported': 415,
};

const genericCodeByStatus: Record<number, string> = {
  400: 'INVALID_INPUT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'RESOURCE_NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  410: 'RESOURCE_GONE',
  413: 'UPLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  502: 'DEPENDENCY_UNAVAILABLE',
  503: 'SERVICE_UNAVAILABLE',
  504: 'DEPENDENCY_TIMEOUT',
};

interface PublicErrorBody {
  code: string;
  message: string;
  nextResetAt?: string | null;
  capacity?: {
    waitingJobs: number;
    maxWaitingJobs: number;
    processingJobs: number;
    maxProcessingJobs: number;
  };
  action?: 'wait_for_job_to_finish';
}

function publicErrorBody(value: unknown): PublicErrorBody | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.code !== 'string' ||
    !/^[A-Z][A-Z0-9_]{1,79}$/.test(body.code) ||
    typeof body.message !== 'string'
  )
    return null;
  const nextResetAt =
    body.nextResetAt === null
      ? null
      : typeof body.nextResetAt === 'string' &&
          !Number.isNaN(Date.parse(body.nextResetAt)) &&
          new Date(body.nextResetAt).toISOString() === body.nextResetAt
        ? body.nextResetAt
        : undefined;
  const rawCapacity = body.capacity as Record<string, unknown> | undefined;
  const capacity =
    rawCapacity &&
    [
      'waitingJobs',
      'maxWaitingJobs',
      'processingJobs',
      'maxProcessingJobs',
    ].every(
      (key) =>
        Number.isSafeInteger(rawCapacity[key]) &&
        (rawCapacity[key] as number) >= 0,
    )
      ? {
          waitingJobs: rawCapacity.waitingJobs as number,
          maxWaitingJobs: rawCapacity.maxWaitingJobs as number,
          processingJobs: rawCapacity.processingJobs as number,
          maxProcessingJobs: rawCapacity.maxProcessingJobs as number,
        }
      : undefined;
  return {
    code: body.code,
    message: body.message,
    ...(nextResetAt !== undefined ? { nextResetAt } : {}),
    ...(capacity ? { capacity } : {}),
    ...(body.action === 'wait_for_job_to_finish'
      ? { action: body.action }
      : {}),
  };
}

@Catch()
export class PublicExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PublicExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const adminRoute = /^\/admin(?:\/|$)/.test(
      (request?.originalUrl ?? '').split('?', 1)[0],
    );
    const parserStatus =
      exception instanceof Error && 'type' in exception
        ? parserStatuses[String(exception.type)]
        : undefined;
    const status =
      parserStatus ??
      (exception instanceof HttpException ? exception.getStatus() : 500);
    const body =
      exception instanceof HttpException
        ? publicErrorBody(exception.getResponse())
        : null;
    const requestId =
      (request as AuthRequest).adminRequestId ?? adminRequestId(request);

    if (exception instanceof AuthRateLimitException)
      response.setHeader('Retry-After', exception.retryAfterSeconds);
    if (status === 500) {
      this.logger.error('Unhandled request failure');
      captureBackendFailure(exception);
    }

    const code =
      parserStatus && adminRoute && parserStatus === 413
        ? 'UPLOAD_TOO_LARGE'
        : parserStatus
          ? adminRoute
            ? 'INVALID_REQUEST'
            : genericCodeByStatus[status]
          : status >= 500 && status !== 503
            ? genericCodeByStatus[status]
            : (body?.code ??
              (adminRoute && status === 400
                ? 'INVALID_REQUEST'
                : genericCodeByStatus[status]));
    const detail =
      parserStatus && status === 413
        ? 'Upload too large'
        : parserStatus
          ? 'Invalid request body'
          : status >= 500 && status !== 503
            ? 'Service unavailable'
            : (body?.message ??
              (status >= 500
                ? 'Service unavailable'
                : (STATUS_CODES[status] ?? 'Request failed')));
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('Content-Type', 'application/problem+json');
    response.status(status).json({
      type: 'about:blank',
      title: STATUS_CODES[status] ?? 'Request failed',
      status,
      detail,
      code: code ?? 'REQUEST_FAILED',
      request_id: requestId,
      ...(body?.nextResetAt !== undefined
        ? { next_reset_at: body.nextResetAt }
        : {}),
      ...(body?.capacity
        ? {
            capacity: {
              waiting_jobs: body.capacity.waitingJobs,
              max_waiting_jobs: body.capacity.maxWaitingJobs,
              processing_jobs: body.capacity.processingJobs,
              max_processing_jobs: body.capacity.maxProcessingJobs,
            },
          }
        : {}),
      ...(body?.action ? { action: body.action } : {}),
    });
  }
}

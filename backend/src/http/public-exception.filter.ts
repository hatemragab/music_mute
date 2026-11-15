import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Request } from 'express';
import { AuthRateLimitException } from '../auth/rate-limit.exception.js';
import { adminError, adminRequestId } from '../admin/admin-errors.js';
import { captureBackendFailure } from '../observability/sentry.js';

@Catch()
export class PublicExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PublicExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const adminRoute = /^\/api\/v1\/admin(?:\/|$)/.test(
      (request?.originalUrl ?? '').split('?', 1)[0],
    );
    if (adminRoute) {
      const parserStatuses: Record<string, number> = {
        'entity.too.large': 413,
        'entity.parse.failed': 400,
        'request.aborted': 400,
        'request.size.invalid': 400,
        'charset.unsupported': 415,
        'encoding.unsupported': 415,
      };
      const parserStatus =
        exception instanceof Error && 'type' in exception
          ? parserStatuses[String(exception.type)]
          : undefined;
      const status =
        exception instanceof HttpException ? exception.getStatus() : 500;
      if (status === 500 && !parserStatus) captureBackendFailure(exception);
      const body =
        exception instanceof HttpException ? exception.getResponse() : null;
      const existing =
        typeof body === 'object' &&
        body !== null &&
        'code' in body &&
        'message' in body &&
        'requestId' in body
          ? body
          : null;
      const requestId =
        existing && typeof existing.requestId === 'string'
          ? existing.requestId
          : adminRequestId(request);
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Request-Id', requestId);
      if (parserStatus) {
        if (parserStatus === 413) {
          const tooLarge = adminError('UPLOAD_TOO_LARGE', requestId);
          response.status(tooLarge.getStatus()).json(tooLarge.getResponse());
          return;
        }
        response.status(parserStatus).json({
          code: 'INVALID_REQUEST',
          message: 'Invalid request',
          requestId,
        });
        return;
      }
      if (existing) {
        response.status(status).json(existing);
        return;
      }
      const mapped = adminError(
        status === 400
          ? 'INVALID_REQUEST'
          : status === 401
            ? 'UNAUTHENTICATED'
            : status === 403
              ? 'PERMISSION_DENIED'
              : status === 404
                ? 'RESOURCE_NOT_FOUND'
                : status === 429
                  ? 'RATE_LIMITED'
                  : 'DEPENDENCY_UNAVAILABLE',
        requestId,
      );
      response.status(mapped.getStatus()).json(mapped.getResponse());
      return;
    }
    if (exception instanceof AuthRateLimitException)
      response.setHeader('Retry-After', exception.retryAfterSeconds);
    // Express body-parser errors are not Nest HttpExceptions.
    if (exception instanceof Error && 'type' in exception) {
      const parserStatus: Record<string, number> = {
        'entity.too.large': 413,
        'entity.parse.failed': 400,
        'request.aborted': 400,
        'request.size.invalid': 400,
        'charset.unsupported': 415,
        'encoding.unsupported': 415,
      };
      const status = parserStatus[String(exception.type)];
      if (status) {
        response
          .status(status)
          .json({ statusCode: status, message: 'Invalid request body' });
        return;
      }
    }
    const status =
      exception instanceof HttpException ? exception.getStatus() : 500;
    if (status === 400) {
      response.status(status).json({
        statusCode: status,
        code: 'INVALID_INPUT',
        message: 'Invalid input',
      });
      return;
    }
    if (status >= 500) {
      // Do not log exception messages: SDK/database errors can include credentials.
      if (status === 500) {
        this.logger.error('Unhandled request failure');
        captureBackendFailure(exception);
      }
      response.status(status).json({
        statusCode: status,
        ...(status === 503 ? { code: 'SERVICE_UNAVAILABLE' } : {}),
        message: 'Service unavailable',
      });
      return;
    }
    const body = (exception as HttpException).getResponse();
    response
      .status(status)
      .json(
        typeof body === 'string' ? { statusCode: status, message: body } : body,
      );
  }
}

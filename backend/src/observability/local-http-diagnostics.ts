import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { AuthRequest } from '../auth/auth-request.js';
import { diagnosticHeaders, localDiagnostics } from './local-diagnostics.js';

/** Observe JSON responses without buffering streams or replacing transfer behavior. */
export function localHttpDiagnostics(
  request: AuthRequest,
  response: Response,
  next: NextFunction,
): void {
  if (!localDiagnostics.isEnabled || request.method === 'OPTIONS') {
    next();
    return;
  }
  const started = performance.now();
  let responseBody: unknown = { $omitted: 'non-json-response-or-stream' };
  const originalJson = response.json;
  response.json = function (body: unknown) {
    responseBody = localDiagnostics.snapshot(body);
    return originalJson.call(this, body);
  };
  let recorded = false;
  const complete = (phase: 'completed' | 'aborted') => {
    if (recorded) return;
    recorded = true;
    localDiagnostics.event({
      category: 'http',
      name: 'http.request',
      summary: 'HTTP request observed',
      level:
        phase === 'aborted' || response.statusCode >= 500
          ? 'error'
          : response.statusCode >= 400
            ? 'warn'
            : 'info',
      requestId: request.adminRequestId,
      ...(request.identity?.uid ? { userId: request.identity.uid } : {}),
      operation: request.method,
      method: request.method,
      ...(typeof request.route?.path === 'string'
        ? { route: request.route.path }
        : {}),
      aborted: phase === 'aborted',
      phase,
      result:
        phase === 'aborted'
          ? 'aborted'
          : response.statusCode >= 400
            ? 'failed'
            : 'succeeded',
      status: response.statusCode,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      data: {
        method: request.method,
        route: request.route?.path ?? { $omitted: 'unmatched-route' },
        request: {
          headers: diagnosticHeaders(request.headers),
          params: localDiagnostics.snapshot(request.params),
          query: localDiagnostics.snapshot(request.query),
          body: request.is('application/json')
            ? localDiagnostics.snapshot(request.body)
            : {
                $omitted: 'non-json-body-or-upload',
                contentType: request.get('content-type'),
                bytes: request.get('content-length'),
              },
        },
        response: {
          headers: diagnosticHeaders(response.getHeaders()),
          body: responseBody,
        },
      },
    });
  };
  response.once('finish', () => complete('completed'));
  response.once('close', () =>
    complete(response.writableFinished ? 'completed' : 'aborted'),
  );
  localDiagnostics.run({ requestId: request.adminRequestId }, next);
}

/** Guards have already verified identity when Nest enters an interceptor. */
export class LocalIdentityDiagnosticsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    if (localDiagnostics.isEnabled && context.getType() === 'http') {
      const request = context.switchToHttp().getRequest<AuthRequest>();
      const store = localDiagnostics.context.getStore();
      if (store && request.identity?.uid) store.userId = request.identity.uid;
    }
    return next.handle();
  }
}

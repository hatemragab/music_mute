import {
  HttpException,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { catchError, throwError, type Observable } from 'rxjs';
import { AUTH_OPERATION, type AuthOperation } from '../auth/auth.decorators.js';
import type { AuthRequest } from '../auth/auth-request.js';
import type {
  AbuseEventSeverity,
  AbuseEventType,
  AbuseOperationClass,
} from './abuse-protection.types.js';
import { AbuseEventsService } from './abuse-events.service.js';

const codeMap: Partial<
  Record<
    string,
    {
      type: AbuseEventType;
      severity: AbuseEventSeverity;
      operationClass: AbuseOperationClass;
    }
  >
> = {
  UPLOAD_GRANT_LIMIT_REACHED: {
    type: 'upload_grant_limit',
    severity: 'medium',
    operationClass: 'upload_grant',
  },
  UPLOAD_ATTEMPT_LIMIT_REACHED: {
    type: 'upload_attempt_limit',
    severity: 'medium',
    operationClass: 'upload_grant',
  },
  DOWNLOAD_GRANT_LIMIT_REACHED: {
    type: 'download_grant_limit',
    severity: 'medium',
    operationClass: 'download_grant',
  },
  DOWNLOAD_BYTE_LIMIT_REACHED: {
    type: 'download_bytes_limit',
    severity: 'medium',
    operationClass: 'download_grant',
  },
  PROCESSING_ALLOWANCE_EXHAUSTED: {
    type: 'processing_quota_limit',
    severity: 'low',
    operationClass: 'job_create',
  },
  PROCESSING_LIMIT_REACHED: {
    type: 'queue_limit',
    severity: 'low',
    operationClass: 'job_create',
  },
  SERVICE_BANDWIDTH_LIMIT_REACHED: {
    type: 'service_safety_ceiling',
    severity: 'high',
    operationClass: 'download_grant',
  },
};

const operationClass: Partial<Record<AuthOperation, AbuseOperationClass>> = {
  'processing-create': 'job_create',
  'processing-upload-grant': 'upload_grant',
  'processing-upload-confirm': 'upload_confirm',
  'processing-download': 'download_grant',
  'processing-retry': 'job_retry',
  'processing-cancel': 'job_cancel',
};

@Injectable()
export class AbuseEventInterceptor implements NestInterceptor {
  constructor(
    private readonly events: AbuseEventsService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        const request = context.switchToHttp().getRequest<AuthRequest>();
        const accountId = request.user?._id?.toHexString();
        const code = this.errorCode(error);
        const mapped = code ? codeMap[code] : undefined;
        if (accountId && mapped) {
          const operation = this.reflector.getAllAndOverride<AuthOperation>(
            AUTH_OPERATION,
            [context.getHandler(), context.getClass()],
          );
          void this.events
            .record({
              accountId,
              ...mapped,
              operationClass:
                (operation && operationClass[operation]) ||
                mapped.operationClass,
            })
            .catch(() => undefined);
        }
        return throwError(() => error);
      }),
    );
  }

  private errorCode(error: unknown): string | null {
    if (!(error instanceof HttpException)) return null;
    const response = error.getResponse();
    return response && typeof response === 'object' && 'code' in response
      ? String(response.code)
      : null;
  }
}

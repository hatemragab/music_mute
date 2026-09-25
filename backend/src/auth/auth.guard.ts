import {
  HttpException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { FirebaseIdentityService } from './firebase-identity.service.js';
import { UsersService } from '../users/users.service.js';
import { RateBudgetService } from '../rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../rate-limits/rate-limit-keys.js';
import {
  ALLOW_UNPROVISIONED,
  AUTH_OPERATION,
  ACCOUNT_DELETION,
  ACCOUNT_RECOVERY,
  PUBLIC_ROUTE,
  type AuthOperation,
} from './auth.decorators.js';
import type { AuthRequest } from './auth-request.js';
import type { RateBucket } from './auth.types.js';
import { authError } from './auth.errors.js';
import { ADMIN_ROUTE } from '../admin/admin.decorators.js';
import { adminError, adminRequestId } from '../admin/admin-errors.js';
import { WORKER_ROUTE } from '../worker-fleet/auth/worker-auth.decorators.js';
import { AccountRestrictionsService } from '../abuse-protection/account-restrictions.service.js';
import type { RestrictedOperation } from '../abuse-protection/abuse-protection.types.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly firebase: FirebaseIdentityService,
    private readonly users: UsersService,
    private readonly budgets: RateBudgetService,
    private readonly keys: RateLimitKeys,
    private readonly config: ConfigService,
    private readonly restrictions: AccountRestrictionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const publicRoute =
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets) === true;
    const adminRoute =
      this.reflector.getAllAndOverride<boolean>(ADMIN_ROUTE, targets) === true;
    const workerRoute =
      this.reflector.getAllAndOverride<boolean>(WORKER_ROUTE, targets) === true;
    if ([publicRoute, adminRoute, workerRoute].filter(Boolean).length > 1)
      throw authError('UNAUTHENTICATED');
    if (publicRoute) return true;
    // WorkerRoute always installs the fail-closed WorkerAuthGuard. C2 replaces
    // its rejection path with scoped enrollment/installation/machine auth.
    if (workerRoute) return true;
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const requestId = adminRoute
      ? (req.adminRequestId ?? adminRequestId(req))
      : undefined;
    if (requestId) {
      req.adminRequestId = requestId;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Request-Id', requestId);
    }
    const fail = (code: 'UNAUTHENTICATED' | 'RATE_LIMITED') =>
      requestId ? adminError(code, requestId) : authError(code);
    const mapFirebaseFailure = (error: unknown): never => {
      if (!requestId) throw error;
      const status = error instanceof HttpException ? error.getStatus() : 503;
      if (status === 401) throw adminError('UNAUTHENTICATED', requestId);
      if (status === 403) throw adminError('ADMIN_ACCESS_DENIED', requestId);
      throw adminError('DEPENDENCY_UNAVAILABLE', requestId);
    };
    const header = req.headers.authorization;
    const count = (req.rawHeaders ?? []).filter(
      (value, index) =>
        index % 2 === 0 && value.toLowerCase() === 'authorization',
    ).length;
    if (count > 1 || typeof header !== 'string' || header.length > 8199)
      throw fail('UNAUTHENTICATED');
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/i.exec(header);
    if (!match || match[1].length > 8192) throw fail('UNAUTHENTICATED');
    const bearer = match[1];
    const signed = await this.firebase
      .verifySignature(bearer)
      .catch(mapFirebaseFailure);
    const operation = this.reflector.getAllAndOverride<AuthOperation>(
      AUTH_OPERATION,
      targets,
    );
    // Status reads have their own user budget; polling must not consume mutations.
    const buckets: RateBucket[] =
      operation === 'processing-read'
        ? []
        : [
            {
              key: this.keys.bucket('private-uid', signed.uid),
              limit: this.config.get<number>('AUTH_UID_PER_MINUTE', 120),
              windowMs: 60000,
            },
          ];
    if (operation === 'profile')
      buckets.push(
        {
          key: this.keys.bucket('profile-uid', signed.uid),
          limit: this.config.get<number>('PROFILE_UID_PER_MINUTE', 5),
          windowMs: 60000,
        },
        {
          key: this.keys.bucket('profile-ip', req.ip ?? ''),
          limit: this.config.get<number>('PROFILE_IP_PER_MINUTE', 10),
          windowMs: 60000,
        },
      );
    if (operation === 'device')
      buckets.push({
        key: this.keys.bucket('device-uid', signed.uid),
        limit: this.config.get<number>('DEVICE_UID_PER_MINUTE', 10),
        windowMs: 60000,
      });
    if (operation === 'logout')
      buckets.push({
        key: this.keys.bucket('logout-uid', signed.uid),
        limit: this.config.get<number>('LOGOUT_UID_PER_HOUR', 3),
        windowMs: 3600000,
      });
    const processingBudget = {
      'processing-read': {
        scope: 'read',
        config: 'PROCESSING_READ_UID_PER_MINUTE',
        defaultLimit: 60,
        windowMs: 60_000,
      },
      'processing-create': {
        scope: 'create',
        config: 'PROCESSING_CREATE_UID_PER_MINUTE',
        defaultLimit: 30,
        windowMs: 60_000,
      },
      'processing-upload-grant': {
        scope: 'upload-grant',
        config: 'PROCESSING_GRANT_UID_PER_MINUTE',
        defaultLimit: 60,
        windowMs: 60_000,
      },
      'processing-upload-confirm': {
        scope: 'upload-confirm',
        config: 'PROCESSING_GRANT_UID_PER_MINUTE',
        defaultLimit: 60,
        windowMs: 60_000,
      },
      'processing-download': {
        scope: 'download',
        config: 'PROCESSING_GRANT_UID_PER_MINUTE',
        defaultLimit: 60,
        windowMs: 60_000,
      },
      'processing-retry': {
        scope: 'retry',
        config: 'PROCESSING_CREATE_UID_PER_MINUTE',
        defaultLimit: 30,
        windowMs: 60_000,
      },
      'processing-cancel': {
        scope: 'cancel',
        config: 'PROCESSING_MUTATION_UID_PER_MINUTE',
        defaultLimit: 60,
        windowMs: 60_000,
      },
      'processing-mutation': {
        scope: 'mutation',
        config: 'PROCESSING_MUTATION_UID_PER_MINUTE',
        defaultLimit: 60,
        windowMs: 60_000,
      },
      'account-deletion': {
        scope: 'account-deletion',
        config: 'ACCOUNT_DELETION_UID_PER_HOUR',
        defaultLimit: 3,
        windowMs: 3_600_000,
      },
      'account-recovery': {
        scope: 'account-recovery',
        config: 'ACCOUNT_RECOVERY_UID_PER_HOUR',
        defaultLimit: 60,
        windowMs: 3_600_000,
      },
    } as const;
    if (operation && operation in processingBudget) {
      const definition =
        processingBudget[operation as keyof typeof processingBudget];
      const accountLimit = this.config.get<number>(
        definition.config,
        definition.defaultLimit,
      );
      buckets.push(
        {
          key: this.keys.bucket(
            `processing-${definition.scope}-account`,
            signed.uid,
          ),
          limit: accountLimit,
          windowMs: definition.windowMs,
        },
        {
          key: this.keys.bucket(
            `processing-${definition.scope}-ip`,
            req.ip ?? 'unknown',
          ),
          limit: this.config.get<number>(
            'PROCESSING_OPERATION_IP_PER_MINUTE',
            120,
          ),
          windowMs: 60_000,
        },
        {
          key: this.keys.bucket('processing-endpoint', definition.scope),
          limit: this.config.get<number>('PROCESSING_ENDPOINT_PER_MINUTE', 600),
          windowMs: 60_000,
        },
        {
          key: this.keys.bucket('processing-service', 'global'),
          limit: this.config.get<number>(
            'PROCESSING_SERVICE_PER_MINUTE',
            2_000,
          ),
          windowMs: 60_000,
        },
      );
    }
    const decision = await this.budgets.reserve(buckets);
    if (!decision.allowed) {
      response.setHeader('Retry-After', decision.retryAfterSeconds);
      throw fail('RATE_LIMITED');
    }
    const identity = await this.firebase
      .verifySession(bearer)
      .catch(mapFirebaseFailure);
    if (identity.uid !== signed.uid) throw fail('UNAUTHENTICATED');
    const user = adminRoute
      ? null
      : await this.users.findByFirebaseUid(identity.uid);
    if (user) {
      const deletionRetry =
        user.status === 'deleting' &&
        this.reflector.getAllAndOverride<boolean>(ACCOUNT_DELETION, targets) ===
          true;
      const accountRecovery =
        user.status === 'deleting' &&
        this.reflector.getAllAndOverride<boolean>(ACCOUNT_RECOVERY, targets) ===
          true;
      if (user.status === 'deleting' && !deletionRetry && !accountRecovery)
        throw authError('ACCOUNT_DELETION_PENDING');
      if (user.status !== 'active' && !deletionRetry && !accountRecovery)
        throw authError('ACCOUNT_DISABLED');
      if (identity.authTimeSec <= user.sessionsRevokedAfterSec)
        throw authError('UNAUTHENTICATED');
      const restrictedOperation: Partial<
        Record<AuthOperation, RestrictedOperation>
      > = {
        'processing-create': 'job_create',
        'processing-upload-grant': 'upload_grant',
        'processing-upload-confirm': 'upload_confirm',
        'processing-download': 'download_grant',
        'processing-retry': 'job_retry',
      };
      const restricted = operation ? restrictedOperation[operation] : undefined;
      if (restricted)
        await this.restrictions.assertAllowed(user._id, restricted);
    } else if (
      !adminRoute &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_UNPROVISIONED, targets)
    )
      throw authError('PROFILE_SYNC_REQUIRED');
    req.identity = identity;
    req.bearer = bearer;
    req.user = user;
    return true;
  }
}

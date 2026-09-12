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
import { WORKER_ONLY_ROUTE } from '../worker/worker-routes.js';
import { ADMIN_ROUTE } from '../admin/admin.decorators.js';
import { adminError, adminRequestId } from '../admin/admin-errors.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly firebase: FirebaseIdentityService,
    private readonly users: UsersService,
    private readonly budgets: RateBudgetService,
    private readonly keys: RateLimitKeys,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const publicRoute =
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets) === true;
    const workerOnly =
      this.reflector.getAllAndOverride<boolean>(WORKER_ONLY_ROUTE, targets) ===
      true;
    const adminRoute =
      this.reflector.getAllAndOverride<boolean>(ADMIN_ROUTE, targets) === true;
    if (
      (publicRoute && workerOnly) ||
      (publicRoute && adminRoute) ||
      (workerOnly && adminRoute)
    )
      throw authError('UNAUTHENTICATED');
    if (workerOnly || publicRoute) return true;
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const requestId = adminRoute ? adminRequestId(req) : undefined;
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
    const buckets: RateBucket[] = [
      {
        key: this.keys.bucket('private-uid', signed.uid),
        limit: this.config.get<number>('AUTH_UID_PER_MINUTE', 120),
        windowMs: 60000,
      },
    ];
    const operation = this.reflector.getAllAndOverride<AuthOperation>(
      AUTH_OPERATION,
      targets,
    );
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
      'processing-create': {
        scope: 'processing-create-uid',
        config: 'PROCESSING_CREATE_UID_PER_MINUTE',
        defaultLimit: 30,
      },
      'processing-grant': {
        scope: 'processing-grant-uid',
        config: 'PROCESSING_GRANT_UID_PER_MINUTE',
        defaultLimit: 60,
      },
      'processing-mutation': {
        scope: 'processing-mutation-uid',
        config: 'PROCESSING_MUTATION_UID_PER_MINUTE',
        defaultLimit: 60,
      },
    } as const;
    if (operation && operation in processingBudget) {
      const definition =
        processingBudget[operation as keyof typeof processingBudget];
      buckets.push({
        key: this.keys.bucket(definition.scope, signed.uid),
        limit: this.config.get<number>(
          definition.config,
          definition.defaultLimit,
        ),
        windowMs: 60_000,
      });
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

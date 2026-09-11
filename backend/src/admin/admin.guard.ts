import {
  HttpException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Reflector } from '@nestjs/core';
import type { Model } from 'mongoose';
import type { Response } from 'express';
import { FirebaseIdentityService } from '../auth/firebase-identity.service.js';
import type { AuthRequest } from '../auth/auth-request.js';
import { AdminAccess } from './admin-access.schema.js';
import {
  ADMIN_FRESH_AUTH,
  ADMIN_PERMISSION,
  ADMIN_RATE_CLASS,
  ADMIN_ROUTE,
} from './admin.decorators.js';
import { adminError, adminRequestId } from './admin-errors.js';
import { isAdminRole, permissionsForRole } from './admin-permissions.js';
import { AdminRateLimitService } from './admin-rate-limit.service.js';
import type { AdminPermission, AdminRateClass } from './admin.types.js';

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized.length <= 320 ? normalized : null;
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly firebase: FirebaseIdentityService,
    @InjectModel(AdminAccess.name)
    private readonly accesses: Model<AdminAccess>,
    private readonly rateLimits: AdminRateLimitService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean>(ADMIN_ROUTE, targets) !== true
    )
      return true;

    const http = context.switchToHttp();
    const req = http.getRequest<AuthRequest>();
    const response = http.getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    const requestId = req.adminRequestId ?? adminRequestId(req);
    response.setHeader('X-Request-Id', requestId);
    const identity = req.identity;
    if (
      !identity ||
      identity.provider !== 'google.com' ||
      identity.tokenEmailVerified !== true
    )
      throw adminError('ADMIN_ACCESS_DENIED', requestId);

    const rateClass =
      this.reflector.getAllAndOverride<AdminRateClass>(
        ADMIN_RATE_CLASS,
        targets,
      ) ?? (req.method === 'GET' ? 'read' : 'write');
    await this.rateLimits
      .assertAllowed(identity.uid, rateClass, response, requestId)
      .catch((error: unknown) => {
        if (error instanceof HttpException && error.getStatus() === 429)
          throw error;
        throw adminError('DEPENDENCY_UNAVAILABLE', requestId);
      });

    const profile = await this.firebase
      .getProfile(identity.uid)
      .catch((error: unknown) => {
        const status = error instanceof HttpException ? error.getStatus() : 503;
        if (status === 401) throw adminError('UNAUTHENTICATED', requestId);
        if (status === 403) throw adminError('ADMIN_ACCESS_DENIED', requestId);
        throw adminError('DEPENDENCY_UNAVAILABLE', requestId);
      });
    const email = normalizedEmail(profile.email);
    const hasGoogleProfile = (profile.providerData ?? []).some(
      (provider) =>
        provider.providerId === 'google.com' &&
        normalizedEmail(provider.email) === email,
    );
    if (
      profile.uid !== identity.uid ||
      profile.disabled ||
      !email ||
      !hasGoogleProfile
    )
      throw adminError('ADMIN_ACCESS_DENIED', requestId);

    const access = await this.accesses
      .findOne({ uid: identity.uid })
      .lean()
      .exec()
      .catch(() => {
        throw adminError('DEPENDENCY_UNAVAILABLE', requestId);
      });
    if (
      !access ||
      access.active !== true ||
      access.uid !== identity.uid ||
      normalizedEmail(access.verifiedEmail) !== email ||
      !isAdminRole(access.role) ||
      !Number.isSafeInteger(access.revision) ||
      access.revision < 0
    )
      throw adminError('ADMIN_ACCESS_DENIED', requestId);

    const permissions = permissionsForRole(access.role);
    const required =
      this.reflector.getAllAndOverride<readonly AdminPermission[]>(
        ADMIN_PERMISSION,
        targets,
      ) ?? [];
    if (required.some((permission) => !permissions.includes(permission)))
      throw adminError('PERMISSION_DENIED', requestId);

    const fresh =
      this.reflector.getAllAndOverride<boolean>(ADMIN_FRESH_AUTH, targets) ===
      true;
    const maxAge = this.config.get<number>('ADMIN_REAUTH_MAX_AGE_SECONDS', 300);
    const nowSec = Math.floor(Date.now() / 1000);
    if (
      fresh &&
      (identity.authTimeSec > nowSec || nowSec - identity.authTimeSec > maxAge)
    )
      throw adminError('ADMIN_REAUTH_REQUIRED', requestId);

    req.adminActor = {
      uid: identity.uid,
      verifiedEmail: email,
      role: access.role,
      permissions,
      accessRevision: access.revision,
      authTimeSec: identity.authTimeSec,
    };
    return true;
  }
}

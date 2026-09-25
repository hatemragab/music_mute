import 'reflect-metadata';
import {
  Controller,
  Get,
  Module,
  Post,
  Req,
  ValidationPipe,
  type Provider,
  type Type,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { vi } from 'vitest';
import { AuthGuard } from '../../src/auth/auth.guard.js';
import type { AuthRequest } from '../../src/auth/auth-request.js';
import { authError } from '../../src/auth/auth.errors.js';
import { FirebaseIdentityService } from '../../src/auth/firebase-identity.service.js';
import { UsersService } from '../../src/users/users.service.js';
import { RateBudgetService } from '../../src/rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../../src/rate-limits/rate-limit-keys.js';
import { AdminAccess } from '../../src/admin/admin-access.schema.js';
import {
  AdminRoute,
  RequireAdminPermission,
  RequireFreshAdminAuth,
} from '../../src/admin/admin.decorators.js';
import { AdminGuard } from '../../src/admin/admin.guard.js';
import { AdminRateLimitService } from '../../src/admin/admin-rate-limit.service.js';
import { AdminSessionController } from '../../src/admin/admin-session.controller.js';
import type { AdminRole } from '../../src/admin/admin.types.js';
import { PublicExceptionFilter } from '../../src/http/public-exception.filter.js';
import {
  SnakeCaseRequestPipe,
  SnakeCaseResponseInterceptor,
} from '../../src/http/snake-case-wire.js';
import { AccountRestrictionsService } from '../../src/abuse-protection/account-restrictions.service.js';

interface IdentityState {
  uid: string;
  email: string;
  provider: 'google.com' | 'password';
  authTimeSec: number;
  emailVerified: boolean;
  disabled: boolean;
  revoked: boolean;
}

interface AccessRecord {
  uid: string;
  verifiedEmail: string;
  role: AdminRole;
  active: boolean;
  revision: number;
  authorizationFence: number;
}

@Controller('admin/test')
class AdminTestController {
  @Get('protected')
  @RequireAdminPermission('overview.read')
  protected(@Req() req: AuthRequest) {
    return { uid: req.adminActor!.uid };
  }

  @Post('fresh')
  @AdminRoute()
  @RequireFreshAdminAuth()
  fresh() {
    return { ok: true };
  }
}

export interface AdminHarness {
  app: INestApplication;
  access: Map<string, AccessRecord>;
  identities: Map<string, IdentityState>;
  seedAdmin(role?: AdminRole): void;
  signInAs(role: AdminRole): string;
  request(
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body?: unknown,
    token?: string,
  ): request.Test;
  close(): Promise<void>;
}

/** Build an explicit snake_case HTTP fixture from an internal test value. */
export function wireJson(
  value: Record<string, unknown>,
): Record<string, unknown>;
export function wireJson(value: unknown): unknown;
export function wireJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wireJson);
  if (value === null || typeof value !== 'object' || value instanceof Date)
    return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      wireJson(entry),
    ]),
  );
}

export async function createAdminHarness(
  options: {
    controllers?: Type[];
    providers?: Provider[];
  } = {},
): Promise<AdminHarness> {
  const identities = new Map<string, IdentityState>();
  const access = new Map<string, AccessRecord>();
  const now = Math.floor(Date.now() / 1000);
  identities.set('google-owner-token', {
    uid: 'owner-uid',
    email: 'owner@example.com',
    provider: 'google.com',
    authTimeSec: now,
    emailVerified: true,
    disabled: false,
    revoked: false,
  });
  identities.set('ordinary-google-token', {
    uid: 'ordinary-uid',
    email: 'ordinary@example.com',
    provider: 'google.com',
    authTimeSec: now,
    emailVerified: true,
    disabled: false,
    revoked: false,
  });
  identities.set('password-token', {
    uid: 'password-uid',
    email: 'password@example.com',
    provider: 'password',
    authTimeSec: now,
    emailVerified: true,
    disabled: false,
    revoked: false,
  });
  identities.set('disabled-token', {
    uid: 'disabled-uid',
    email: 'disabled@example.com',
    provider: 'google.com',
    authTimeSec: now,
    emailVerified: true,
    disabled: true,
    revoked: false,
  });
  identities.set('revoked-token', {
    uid: 'revoked-uid',
    email: 'revoked@example.com',
    provider: 'google.com',
    authTimeSec: now,
    emailVerified: true,
    disabled: false,
    revoked: true,
  });

  const firebase = {
    verifySignature: vi.fn(async (token: string) => {
      const identity = identities.get(token);
      if (!identity) throw authError('UNAUTHENTICATED');
      return { uid: identity.uid };
    }),
    verifySession: vi.fn(async (token: string) => {
      const identity = identities.get(token);
      if (!identity || identity.revoked) throw authError('UNAUTHENTICATED');
      if (identity.disabled) throw authError('ACCOUNT_DISABLED');
      return {
        uid: identity.uid,
        authTimeSec: identity.authTimeSec,
        provider: identity.provider,
        tokenEmailVerified: identity.emailVerified,
      };
    }),
    getProfile: vi.fn(async (uid: string) => {
      const identity = [...identities.values()].find(
        (value) => value.uid === uid,
      );
      if (!identity) throw authError('UNAUTHENTICATED');
      return {
        uid,
        email: identity.email,
        emailVerified: identity.emailVerified,
        disabled: identity.disabled,
        providerData: [
          { providerId: identity.provider, email: identity.email },
        ],
      };
    }),
  };
  const users = { findByFirebaseUid: vi.fn(async () => null) };
  const budgets = {
    reserve: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  };
  const keys = { bucket: (scope: string, id: string) => `${scope}:${id}` };
  const model = {
    findOne: vi.fn((filter: { uid: string }) => ({
      lean: () => ({ exec: async () => access.get(filter.uid) ?? null }),
    })),
  };
  const config = new ConfigService({
    ADMIN_REAUTH_MAX_AGE_SECONDS: 300,
    AUDIO_PROCESSING_ENABLED: true,
  });

  @Module({
    controllers: [
      AdminSessionController,
      AdminTestController,
      ...(options.controllers ?? []),
    ],
    providers: [
      { provide: ConfigService, useValue: config },
      { provide: FirebaseIdentityService, useValue: firebase },
      { provide: UsersService, useValue: users },
      { provide: RateBudgetService, useValue: budgets },
      { provide: RateLimitKeys, useValue: keys },
      {
        provide: AccountRestrictionsService,
        useValue: { assertAllowed: vi.fn().mockResolvedValue(undefined) },
      },
      { provide: getModelToken(AdminAccess.name), useValue: model },
      AdminRateLimitService,
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_GUARD, useClass: AdminGuard },
      ...(options.providers ?? []),
    ],
  })
  class HarnessModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [HarnessModule],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('');
  app.useGlobalFilters(new PublicExceptionFilter());
  app.useGlobalPipes(
    new SnakeCaseRequestPipe(),
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      exceptionFactory: () => authError('INVALID_INPUT'),
    }),
  );
  app.useGlobalInterceptors(new SnakeCaseResponseInterceptor());
  await app.listen(0, '127.0.0.1');

  const seedAdmin = (role: AdminRole = 'owner') => {
    access.set('owner-uid', {
      uid: 'owner-uid',
      verifiedEmail: 'owner@example.com',
      role,
      active: true,
      revision: 0,
      authorizationFence: 0,
    });
  };
  return {
    app,
    access,
    identities,
    seedAdmin,
    signInAs(role) {
      seedAdmin(role);
      return 'google-owner-token';
    },
    request(method, path, body, token) {
      let operation = request(app.getHttpServer())[method](path);
      if (token) operation = operation.set('Authorization', `Bearer ${token}`);
      if (body !== undefined && body !== null) operation = operation.send(body);
      return operation;
    },
    close: () => app.close(),
  };
}

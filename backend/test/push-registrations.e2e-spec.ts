import 'reflect-metadata';
import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { authError } from '../src/auth/auth.errors.js';
import { FirebaseIdentityService } from '../src/auth/firebase-identity.service.js';
import { PushRegistrationController } from '../src/notifications/push-registration.controller.js';
import { PushRegistrationsService } from '../src/notifications/push-registration.service.js';
import { RateBudgetService } from '../src/rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../src/rate-limits/rate-limit-keys.js';
import { UsersService } from '../src/users/users.service.js';

const installationId = 'd7ea7de6-52e9-4b96-8834-3b517941bdb0';
const token = 'fixture-token:abc_123-XYZ';
const bearer = 'fixture-firebase-token';

describe('push registration HTTP boundary', () => {
  let app: Awaited<ReturnType<typeof startApp>>['app'];
  let registrations: Awaited<ReturnType<typeof startApp>>['registrations'];

  async function startApp() {
    const userId = new Types.ObjectId();
    const user = {
      _id: userId,
      status: 'active',
      sessionsRevokedAfterSec: 0,
    };
    const firebase = {
      verifySignature: vi.fn(async (value: string) => {
        if (value !== bearer) throw authError('UNAUTHENTICATED');
        return { uid: 'fixture-user' };
      }),
      verifySession: vi.fn(async (value: string) => {
        if (value !== bearer) throw authError('UNAUTHENTICATED');
        return {
          uid: 'fixture-user',
          authTimeSec: 101,
          provider: 'password' as const,
          tokenEmailVerified: true,
        };
      }),
    };
    const registrations = {
      register: vi.fn(async () => ({
        _id: new Types.ObjectId(),
        userId,
        installationId,
        token,
        tokenHash: 'a'.repeat(64),
        bindingRevision: 4,
        authTimeSec: 101,
        active: true,
        deactivatedAt: null,
      })),
      deactivate: vi.fn(async () => undefined),
    };

    @Module({
      controllers: [PushRegistrationController],
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService(),
        },
        { provide: FirebaseIdentityService, useValue: firebase },
        {
          provide: UsersService,
          useValue: { findByFirebaseUid: vi.fn(async () => user) },
        },
        {
          provide: RateBudgetService,
          useValue: {
            reserve: vi.fn(async () => ({
              allowed: true,
              retryAfterSeconds: 0,
            })),
          },
        },
        {
          provide: RateLimitKeys,
          useValue: {
            bucket: (scope: string, id: string) => `${scope}:${id}`,
          },
        },
        { provide: PushRegistrationsService, useValue: registrations },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    })
    class FixtureModule {}

    const module = await Test.createTestingModule({
      imports: [FixtureModule],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
        transform: true,
        exceptionFactory: () => authError('INVALID_INPUT'),
      }),
    );
    await app.init();
    return { app, registrations, user };
  }

  beforeAll(async () => {
    ({ app, registrations } = await startApp());
  });

  afterAll(async () => {
    await app?.close();
  });

  it('binds authenticated user, installation and auth time without exposing destination data', async () => {
    const response = await request(app.getHttpServer())
      .put(`/api/v1/devices/${installationId.toUpperCase()}/push`)
      .set('Authorization', `Bearer ${bearer}`)
      .send({ token })
      .expect(200);
    expect(registrations.register).toHaveBeenCalledWith(
      expect.objectContaining({ _id: expect.any(Types.ObjectId) }),
      installationId,
      token,
      101,
    );
    expect(response.body).toEqual({
      installationId,
      active: true,
      bindingRevision: 4,
    });
    expect(JSON.stringify(response.body)).not.toContain(token);
    expect(response.body).not.toHaveProperty('tokenHash');
    expect(response.body).not.toHaveProperty('userId');
  });

  it('requires authentication and rejects invalid, oversized and forged input', async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/devices/${installationId}/push`)
      .send({ token })
      .expect(401);
    for (const body of [
      { token: '' },
      { token: 'has whitespace' },
      { token: 'a'.repeat(4097) },
      { token, userId: new Types.ObjectId().toHexString() },
      { token, active: true },
    ])
      await request(app.getHttpServer())
        .put(`/api/v1/devices/${installationId}/push`)
        .set('Authorization', `Bearer ${bearer}`)
        .send(body)
        .expect(400);
    await request(app.getHttpServer())
      .put('/api/v1/devices/not-a-uuid/push')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ token })
      .expect(400);
  });

  it('preserves legacy empty-body deactivation', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/devices/${installationId}/push/deactivate`)
      .set('Authorization', `Bearer ${bearer}`)
      .send({})
      .expect(204);
    await request(app.getHttpServer())
      .post(`/api/v1/devices/${installationId}/push/deactivate`)
      .set('Authorization', `Bearer ${bearer}`)
      .send({ active: false })
      .expect(400);
    expect(registrations.deactivate).toHaveBeenCalledWith(
      expect.any(String),
      installationId,
      undefined,
    );
  });

  it('passes an expected revision to the owned deactivation operation', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/devices/${installationId.toUpperCase()}/push/deactivate`)
      .set('Authorization', `Bearer ${bearer}`)
      .send({ expectedBindingRevision: 4 })
      .expect(204);
    expect(registrations.deactivate).toHaveBeenLastCalledWith(
      expect.any(String),
      installationId,
      4,
    );
    await request(app.getHttpServer())
      .post(`/api/v1/devices/${installationId}/push/deactivate`)
      .set('Authorization', `Bearer ${bearer}`)
      .send({ expectedBindingRevision: Number.MAX_SAFE_INTEGER })
      .expect(204);
  });

  it('rejects invalid expected revisions and unknown deactivation fields before service access', async () => {
    for (const body of [
      { expectedBindingRevision: null },
      { expectedBindingRevision: '4' },
      { expectedBindingRevision: 1.5 },
      { expectedBindingRevision: 0 },
      { expectedBindingRevision: -1 },
      { expectedBindingRevision: true },
      { expectedBindingRevision: Number.MAX_SAFE_INTEGER + 1 },
      { expectedBindingRevision: 4, active: false },
      { userId: new Types.ObjectId().toHexString() },
      [],
    ]) {
      const calls = registrations.deactivate.mock.calls.length;
      await request(app.getHttpServer())
        .post(`/api/v1/devices/${installationId}/push/deactivate`)
        .set('Authorization', `Bearer ${bearer}`)
        .send(body)
        .expect(400);
      expect(registrations.deactivate).toHaveBeenCalledTimes(calls);
    }
  });
});

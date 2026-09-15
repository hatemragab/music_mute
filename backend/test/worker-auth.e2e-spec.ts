import 'reflect-metadata';
import {
  Controller,
  Get,
  Module,
  Post,
  Req,
  type INestApplication,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { request as nativeRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { Public } from '../src/auth/auth.decorators.js';
import { authError } from '../src/auth/auth.errors.js';
import type { AuthRequest } from '../src/auth/auth-request.js';
import { FirebaseIdentityService } from '../src/auth/firebase-identity.service.js';
import { UsersService } from '../src/users/users.service.js';
import { RateBudgetService } from '../src/rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../src/rate-limits/rate-limit-keys.js';
import { WorkerIdentityService } from '../src/worker/worker-identity.service.js';
import { WorkerAuthGuard } from '../src/worker/worker-auth.guard.js';
import {
  WorkerOnly,
  type WorkerAuthenticatedRequest,
} from '../src/worker/worker-routes.js';

const workerSecret = 'fixture-worker-secret-with-at-least-32-bytes';
const oldWorkerSecret = 'fixture-old-worker-secret-with-at-least-32-bytes';
const firebaseToken = 'fixture-firebase-user-token';
const workerDigest = createHash('sha256').update(workerSecret).digest('hex');

@Controller()
class WorkerAuthProbeController {
  @WorkerOnly()
  @Post('worker/claim')
  claim(@Req() req: WorkerAuthenticatedRequest) {
    return { workerId: req.workerId };
  }

  @Get('jobs')
  jobs(@Req() req: AuthRequest) {
    return { uid: req.identity.uid };
  }

  @Public()
  @Get('worker-auth/public')
  publicRoute() {
    return { ok: true };
  }

  @Public()
  @WorkerOnly()
  @Get('worker-auth/contradictory')
  contradictory() {
    return { ok: true };
  }
}

async function startApp(enabled = true) {
  const firebase = {
    verifySignature: vi.fn(async (token: string) => {
      if (token !== firebaseToken) throw authError('UNAUTHENTICATED');
      return { uid: 'fixture-user' };
    }),
    verifySession: vi.fn(async (token: string) => {
      if (token !== firebaseToken) throw authError('UNAUTHENTICATED');
      return {
        uid: 'fixture-user',
        authTimeSec: 100,
        provider: 'password' as const,
        tokenEmailVerified: true,
      };
    }),
  };
  const users = {
    findByFirebaseUid: vi.fn(async () => ({
      status: 'active',
      sessionsRevokedAfterSec: 0,
    })),
  };
  const budgets = {
    reserve: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  };
  const keys = { bucket: (scope: string, id: string) => `${scope}:${id}` };
  const config = new ConfigService({
    AUDIO_PROCESSING_ENABLED: enabled,
    AUTH_UID_PER_MINUTE: 120,
  });

  @Module({
    controllers: [WorkerAuthProbeController],
    providers: [
      { provide: ConfigService, useValue: config },
      {
        provide: WorkerIdentityService,
        useValue: {
          authenticateDigest: async (digest: string) => {
            if (digest !== workerDigest) throw authError('UNAUTHENTICATED');
            return {
              workerId: 'fixture-worker',
              installationId: '11111111-1111-4111-8111-111111111111',
              keySha256: digest,
            };
          },
        },
      },
      { provide: FirebaseIdentityService, useValue: firebase },
      { provide: UsersService, useValue: users },
      { provide: RateBudgetService, useValue: budgets },
      { provide: RateLimitKeys, useValue: keys },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_GUARD, useClass: WorkerAuthGuard },
    ],
  })
  class WorkerAuthProbeModule {}

  const module = await Test.createTestingModule({
    imports: [WorkerAuthProbeModule],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api/v1');
  await app.init();
  return { app, firebase };
}

describe('worker credential HTTP isolation', () => {
  let app: INestApplication;
  let firebase: Awaited<ReturnType<typeof startApp>>['firebase'];

  beforeAll(async () => {
    ({ app, firebase } = await startApp());
  });

  afterAll(async () => {
    await app?.close();
  });

  it('accepts only the registered worker bearer on a worker-only route', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/worker/claim')
      .set('Authorization', `Bearer ${workerSecret}`)
      .send({ sessionId: '00000000-0000-4000-8000-000000000000' })
      .expect(201);
    expect(response.body).toEqual({ workerId: 'fixture-worker' });

    await request(app.getHttpServer())
      .post('/api/v1/worker/claim')
      .send({})
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/worker/claim')
      .set('Authorization', `Bearer ${firebaseToken}`)
      .send({})
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/worker/claim')
      .set('Authorization', `Bearer ${oldWorkerSecret}`)
      .send({})
      .expect(401);
  });

  it('does not let the worker bearer become a Firebase user on ordinary routes', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/jobs')
      .set('Authorization', `Bearer ${workerSecret}`)
      .expect(401);
    expect(firebase.verifySignature).toHaveBeenCalledWith(workerSecret);

    const response = await request(app.getHttpServer())
      .get('/api/v1/jobs')
      .set('Authorization', `Bearer ${firebaseToken}`)
      .expect(200);
    expect(response.body).toEqual({ uid: 'fixture-user' });
    await request(app.getHttpServer())
      .get('/api/v1/worker-auth/public')
      .expect(200);
  });

  it('rejects malformed and oversized worker bearer values', async () => {
    for (const value of [
      'Basic fixture',
      'Bearer first second',
      `Bearer ${'a'.repeat(8193)}`,
    ])
      await request(app.getHttpServer())
        .post('/api/v1/worker/claim')
        .set('Authorization', value)
        .send({})
        .expect(401);
  });

  it('rejects real repeated authorization headers', async () => {
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = nativeRequest(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path: '/api/v1/worker/claim',
          method: 'POST',
          headers: [
            'Host',
            `127.0.0.1:${address.port}`,
            'Authorization',
            `Bearer ${workerSecret}`,
            'Authorization',
            `Bearer ${oldWorkerSecret}`,
            'Content-Length',
            '0',
          ],
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(401);
  });

  it('rejects contradictory route metadata', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/worker-auth/contradictory')
      .set('Authorization', `Bearer ${workerSecret}`)
      .expect(401);
  });

  it('refuses worker routes when processing is disabled', async () => {
    const disabled = await startApp(false);
    try {
      await request(disabled.app.getHttpServer())
        .post('/api/v1/worker/claim')
        .set('Authorization', `Bearer ${workerSecret}`)
        .send({})
        .expect(503);
    } finally {
      await disabled.app.close();
    }
  });
});

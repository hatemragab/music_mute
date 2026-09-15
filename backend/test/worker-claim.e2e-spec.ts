import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { authError } from '../src/auth/auth.errors.js';
import { WorkerAuthGuard } from '../src/worker/worker-auth.guard.js';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerRuntimeService } from '../src/worker/worker-runtime.service.js';
import { WorkerIdentityService } from '../src/worker/worker-identity.service.js';
import { WorkerController } from '../src/worker/worker.controller.js';
import { WorkerCoordinatorService } from '../src/worker/worker-coordinator.service.js';
import { WorkerClaimWaitService } from '../src/worker/worker-claim-wait.service.js';
import { WorkerOutputService } from '../src/worker/worker-output.service.js';
import { WorkerTerminalService } from '../src/worker/worker-terminal.service.js';
import { WorkerRecoveryService } from '../src/worker/worker-recovery.service.js';

describe('worker claim HTTP waiting lifecycle', () => {
  const sessionId = '00000000-0000-4000-8000-000000000002';
  let app: INestApplication;
  let url: string;
  let checks: number;
  let firstCheck: Promise<void>;
  let processingEnabled: boolean;
  const bearer = 'fixture-recovery-worker-token';

  beforeEach(async () => {
    checks = 0;
    processingEnabled = true;
    let checked!: () => void;
    firstCheck = new Promise<void>((resolve) => {
      checked = resolve;
    });
    const module = await Test.createTestingModule({
      controllers: [WorkerController],
      providers: [
        WorkerClaimWaitService,
        { provide: WorkerRuntimeService, useValue: {} },
        { provide: APP_GUARD, useClass: WorkerAuthGuard },
        { provide: ConfigService, useValue: { get: () => processingEnabled } },
        {
          provide: WorkerIdentityService,
          useValue: {
            authenticateDigest: async (digest: string) => {
              if (digest !== createHash('sha256').update(bearer).digest('hex'))
                throw authError('UNAUTHENTICATED');
              return {
                workerId: 'fixture',
                installationId: '11111111-1111-4111-8111-111111111111',
                keySha256: digest,
              };
            },
          },
        },
        {
          provide: WorkerCoordinatorService,
          useValue: {
            claim: async () => {
              checks++;
              checked();
              return null;
            },
          },
        },
        { provide: WorkerOutputService, useValue: {} },
        { provide: WorkerTerminalService, useValue: {} },
        { provide: WorkerRecoveryService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.listen(0, '127.0.0.1');
    url = `${await app.getUrl()}/worker/claim`;
  });

  afterEach(async () => {
    await app.close();
  });

  function claim(body: object, signal?: AbortSignal) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  it('validates waits and preserves immediate and waited empty responses', async () => {
    const immediate = await claim({ sessionId });
    expect(immediate.status).toBe(204);
    expect(immediate.headers.get('Retry-After')).toBe('15');
    expect((await claim({ sessionId, waitSeconds: null })).status).toBe(400);
    const startedAt = performance.now();
    const waited = await claim({ sessionId, waitSeconds: 1 });
    expect(waited.status).toBe(204);
    expect(waited.headers.get('Retry-After')).toBe('0');
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(950);
  });

  it('stops database rechecks after a real client disconnect', async () => {
    const client = new AbortController();
    const pending = claim({ sessionId, waitSeconds: 25 }, client.signal);
    await firstCheck;
    client.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await delay(1200);
    expect(checks).toBe(1);
  });

  it('discovers ownership without waiting and rejects a fresh-claim wait field', async () => {
    const recovery = (body: object) =>
      fetch(`${url}/recovery`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(body),
      });
    const response = await recovery({ sessionId, mediaPolicyVersion: 2 });
    expect(response.status).toBe(204);
    expect(response.headers.get('X-Worker-Reason')).toBe('NO_OWNED_ASSIGNMENT');
    expect(checks).toBe(1);
    expect((await recovery({ sessionId, waitSeconds: 25 })).status).toBe(400);
    expect(checks).toBe(1);
  });

  it('closes the app promptly with an active long poll', async () => {
    const pending = claim(
      { sessionId, waitSeconds: 25 },
      AbortSignal.timeout(2000),
    );
    await firstCheck;
    const startedAt = performance.now();
    await app.close();
    expect((await pending).status).toBe(204);
    expect(performance.now() - startedAt).toBeLessThan(1500);
  });

  it('authenticates recovery while processing is disabled and blocks fresh claims', async () => {
    processingEnabled = false;
    expect((await claim({ sessionId })).status).toBe(503);
    for (const token of [undefined, 'invalid-worker-token', bearer]) {
      const response = await fetch(`${url}/recovery`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ sessionId, mediaPolicyVersion: 2 }),
      });
      expect(response.status).toBe(token === bearer ? 204 : 401);
    }
    expect(checks).toBe(1);
  });
});

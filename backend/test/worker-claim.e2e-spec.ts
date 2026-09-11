import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { setTimeout as delay } from 'node:timers/promises';
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

  beforeEach(async () => {
    checks = 0;
    let checked!: () => void;
    firstCheck = new Promise<void>((resolve) => {
      checked = resolve;
    });
    const module = await Test.createTestingModule({
      controllers: [WorkerController],
      providers: [
        WorkerClaimWaitService,
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  }

  it('validates waits and preserves immediate and waited empty responses', async () => {
    const legacy = await claim({ sessionId });
    expect(legacy.status).toBe(204);
    expect(legacy.headers.get('Retry-After')).toBe('15');
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
});

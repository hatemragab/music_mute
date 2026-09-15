import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { WorkerController } from './worker.controller.js';
import { WorkerClaimWaitService } from './worker-claim-wait.service.js';
import { WorkerCoordinatorService } from './worker-coordinator.service.js';
import { WorkerOutputService } from './worker-output.service.js';
import { WorkerTerminalService } from './worker-terminal.service.js';
import { WorkerRecoveryService } from './worker-recovery.service.js';
import { WorkerRuntimeService } from './worker-runtime.service.js';
import { WorkerIdentityService } from './worker-identity.service.js';
import type {
  WorkerAuthenticatedRequest,
  WorkerIdentity,
} from './worker-routes.js';

describe('worker claim response', () => {
  const request = {
    workerIdentity: {
      workerId: 'fixture',
      installationId: '11111111-1111-4111-8111-111111111111',
      keySha256: 'a'.repeat(64),
    },
  } as WorkerAuthenticatedRequest;
  const sessionId = '00000000-0000-4000-8000-000000000002';
  let waits: WorkerClaimWaitService;
  let controller: WorkerController;
  let response: Response;
  let headers: Map<string, string>;
  let status: number;

  beforeEach(() => {
    vi.useFakeTimers();
    const coordinator = {
      claim: async () => null,
    } as unknown as WorkerCoordinatorService;
    waits = new WorkerClaimWaitService(coordinator);
    controller = new WorkerController(
      coordinator,
      {} as WorkerOutputService,
      {} as WorkerTerminalService,
      {} as WorkerRecoveryService,
      waits,
      {} as WorkerRuntimeService,
      {} as WorkerIdentityService,
    );
    headers = new Map();
    status = 200;
    response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      status: (value: number) => {
        status = value;
        return response;
      },
      setHeader: (key: string, value: string) => {
        headers.set(key, value);
        return response;
      },
    }) as unknown as Response;
  });

  afterEach(() => {
    waits.onModuleDestroy();
    vi.useRealTimers();
  });

  it('keeps immediate empty claims at 204 with a 15 second retry', async () => {
    await controller.claim({ sessionId, waitSeconds: 0 }, response, request);
    expect(status).toBe(204);
    expect(headers.get('Retry-After')).toBe('15');
    expect(response.listenerCount('close')).toBe(0);
  });

  it('allows another claim immediately after an empty long poll', async () => {
    const pending = controller.claim(
      { sessionId, waitSeconds: 1 },
      response,
      request,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(status).toBe(204);
    expect(headers.get('Retry-After')).toBe('0');
    expect(response.listenerCount('close')).toBe(0);
  });

  it('stops waiting when the HTTP response connection closes', async () => {
    const pending = controller.claim(
      { sessionId, waitSeconds: 25 },
      response,
      request,
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBe(1);
    response.emit('close');
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
  });
});

describe('worker identity response', () => {
  const identity: WorkerIdentity = {
    workerId: 'gpu-02',
    installationId: '11111111-1111-4111-8111-111111111111',
    keySha256: 'a'.repeat(64),
  };
  const request = { workerIdentity: identity } as WorkerAuthenticatedRequest;
  const describe = vi.fn(async () => ({
    workerId: 'gpu-02',
    installationId: '11111111-1111-4111-8111-111111111111',
    state: 'enabled' as const,
    protocolVersion: 3 as const,
  }));
  const controller = new WorkerController(
    {} as WorkerCoordinatorService,
    {} as WorkerOutputService,
    {} as WorkerTerminalService,
    {} as WorkerRecoveryService,
    {} as WorkerClaimWaitService,
    {} as WorkerRuntimeService,
    { describe } as unknown as WorkerIdentityService,
  );

  beforeEach(() => describe.mockClear());

  it('returns protocol 3 identity from the authenticated worker context', async () => {
    await expect(controller.identity({}, request)).resolves.toEqual({
      workerId: 'gpu-02',
      installationId: '11111111-1111-4111-8111-111111111111',
      state: 'enabled',
      protocolVersion: 3,
    });
    expect(describe).toHaveBeenCalledWith(identity);
  });

  it('rejects caller-supplied identity properties instead of trusting them', () => {
    expect(() =>
      controller.identity({ workerId: 'z440' }, request),
    ).toThrowError(expect.objectContaining({ status: 400 }));
    expect(describe).not.toHaveBeenCalled();
  });
});

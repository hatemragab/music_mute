import { ConfigService } from '@nestjs/config';
import { WorkerClaimWaitService } from './worker-claim-wait.service.js';
import { WorkerCoordinatorService } from './worker-coordinator.service.js';
import type { WorkerIdentity } from './worker-routes.js';

const identity = (workerId: string): WorkerIdentity => ({
  workerId,
  installationId: '11111111-1111-4111-8111-111111111111',
  keySha256: 'a'.repeat(64),
});

describe('per-machine long-poll admission', () => {
  it('admits one waiter per worker and frees its slot on disconnect', async () => {
    const service = new WorkerClaimWaitService(
      { claim: async () => null } as unknown as WorkerCoordinatorService,
      new ConfigService({ PROCESSING_WORKER_MAX_WAITERS: 2 }),
    );
    const first = new AbortController();
    const second = new AbortController();
    const a = service.claim('session-a', 25, first.signal, identity('a'));
    await expect(
      service.claim('session-b', 25, undefined, identity('a')),
    ).rejects.toMatchObject({ status: 429 });
    const b = service.claim('session-c', 25, second.signal, identity('b'));
    await expect(
      service.claim('session-d', 25, undefined, identity('c')),
    ).rejects.toMatchObject({ status: 429 });
    first.abort();
    await a;
    const third = service.claim('session-d', 25, undefined, identity('c'));
    service.onModuleDestroy();
    await Promise.all([b, third]);
    await expect(
      service.claim('session-e', 25, undefined, identity('a')),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('forwards the authenticated identity on every recheck and releases after revocation', async () => {
    vi.useFakeTimers();
    const worker = identity('a');
    let valid = true;
    const service = new WorkerClaimWaitService({
      claim: async (_session: string, current: WorkerIdentity) => {
        expect(current).toEqual(worker);
        if (!valid) throw new Error('fixture revoked');
        return null;
      },
    } as unknown as WorkerCoordinatorService);
    try {
      const pending = service.claim('session', 25, undefined, worker);
      const denied = expect(pending).rejects.toThrow('fixture revoked');
      await vi.advanceTimersByTimeAsync(10);
      valid = false;
      await vi.advanceTimersByTimeAsync(1000);
      await denied;
      expect(vi.getTimerCount()).toBe(0);
      valid = true;
      const next = service.claim('session', 25, undefined, worker);
      service.onModuleDestroy();
      await next;
    } finally {
      service.onModuleDestroy();
      vi.useRealTimers();
    }
  });
});

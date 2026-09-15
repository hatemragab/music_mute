import { getEventListeners } from 'node:events';
import { WorkerCoordinatorService } from './worker-coordinator.service.js';
import { WorkerClaimWaitService } from './worker-claim-wait.service.js';
import type { WorkerIdentity } from './worker-routes.js';

const machine = (workerId: string): WorkerIdentity => ({
  workerId,
  installationId: '11111111-1111-4111-8111-111111111111',
  keySha256: 'a'.repeat(64),
});

describe('bounded worker claim waiting', () => {
  type Assignment = Awaited<ReturnType<WorkerCoordinatorService['claim']>>;
  let available: Assignment;
  let checks: number;
  let service: WorkerClaimWaitService;
  const assignment = {
    jobId: '0123456789abcdef01234567',
    attemptId: '00000000-0000-4000-8000-000000000001',
    sessionId: '00000000-0000-4000-8000-000000000002',
    generation: 1,
    status: 'validating',
    cancelRequested: false,
    leaseExpiresAt: '2026-09-10T12:00:00.000Z',
    input: {
      extension: 'mp3',
      contentType: 'audio/mpeg',
      bytes: 100,
      sha256: Buffer.alloc(32).toString('base64'),
      durationSeconds: 10,
      download: {
        url: 'https://fixture.invalid/input',
        expiresAt: '2026-09-10T12:00:00.000Z',
      },
    },
  } as NonNullable<Assignment>;

  beforeEach(() => {
    vi.useFakeTimers();
    available = null;
    checks = 0;
    service = new WorkerClaimWaitService({
      claim: async () => {
        checks++;
        return available;
      },
    } as unknown as WorkerCoordinatorService);
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('returns immediately for immediate requests and already available work', async () => {
    await expect(
      service.claim(assignment.sessionId, 0, undefined, machine('fixture')),
    ).resolves.toBeNull();
    available = assignment;
    await expect(
      service.claim(assignment.sessionId, 25, undefined, machine('fixture')),
    ).resolves.toEqual(assignment);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('picks up durable work arriving during the wait within one second', async () => {
    const pending = service.claim(
      assignment.sessionId,
      25,
      undefined,
      machine('fixture'),
    );
    await vi.advanceTimersByTimeAsync(500);
    available = assignment;
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toEqual(assignment);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits until the requested deadline with bounded database checks', async () => {
    let settled = false;
    const pending = service
      .claim(assignment.sessionId, 25, undefined, machine('fixture'))
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(24999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
    expect(checks).toBeLessThanOrEqual(26);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases its timer and abort listener when the client disconnects', async () => {
    const client = new AbortController();
    const pending = service.claim(
      assignment.sessionId,
      25,
      client.signal,
      machine('fixture'),
    );
    await vi.advanceTimersByTimeAsync(10);
    client.abort();
    await expect(pending).resolves.toBeNull();
    const checksAtAbort = checks;
    await vi.advanceTimersByTimeAsync(25000);
    expect(checks).toBe(checksAtAbort);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(client.signal, 'abort')).toHaveLength(0);
  });

  it('does not claim work for an already disconnected client', async () => {
    const client = new AbortController();
    client.abort();
    available = assignment;
    await expect(
      service.claim(
        assignment.sessionId,
        25,
        client.signal,
        machine('fixture'),
      ),
    ).resolves.toBeNull();
    expect(checks).toBe(0);
  });

  it('releases all waits on shutdown and refuses new waits', async () => {
    const waits = [
      service.claim(assignment.sessionId, 25, undefined, machine('fixture')),
      service.claim(assignment.sessionId, 25, undefined, machine('another')),
    ];
    await vi.advanceTimersByTimeAsync(10);
    service.onModuleDestroy();
    await expect(Promise.all(waits)).resolves.toEqual([null, null]);
    expect(vi.getTimerCount()).toBe(0);
    await expect(
      service.claim(assignment.sessionId, 25, undefined, machine('fixture')),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('bounds simultaneous waiters and permits another after disconnect', async () => {
    const clients = Array.from({ length: 32 }, () => new AbortController());
    const waits = clients.map((client, index) =>
      service.claim(
        assignment.sessionId,
        25,
        client.signal,
        machine(`machine-${index}`),
      ),
    );
    await vi.advanceTimersByTimeAsync(10);
    await expect(
      service.claim(assignment.sessionId, 25, undefined, machine('fixture')),
    ).rejects.toMatchObject({ status: 429 });
    clients[0].abort();
    await waits[0];
    available = assignment;
    await expect(
      service.claim(assignment.sessionId, 25, undefined, machine('fixture')),
    ).resolves.toEqual(assignment);
    clients.forEach((client) => client.abort());
    await Promise.all(waits);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves coordinator conflicts and releases waiter capacity on failure', async () => {
    const conflict = new Error('fixture recovery conflict');
    const failing = new WorkerClaimWaitService({
      claim: async () => {
        throw conflict;
      },
    } as unknown as WorkerCoordinatorService);
    for (let i = 0; i < 10; i++) {
      await expect(
        failing.claim(assignment.sessionId, 25, undefined, machine('fixture')),
      ).rejects.toBe(conflict);
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthSamplerService } from './health-sampler.service.js';

function setup() {
  const database = {
    readyState: 1,
    db: { command: vi.fn().mockResolvedValue({ ok: 1 }) },
  };
  const redis = { ping: vi.fn().mockResolvedValue('PONG') };
  const storage = { assertReady: vi.fn().mockResolvedValue(undefined) };
  const registrations = {
    aggregate: vi.fn(() => ({ option: vi.fn().mockResolvedValue([]) })),
  };
  const releases = {
    find: vi.fn(() => ({
      select: () => ({
        maxTimeMS: () => ({ lean: vi.fn().mockResolvedValue([]) }),
      }),
    })),
  };
  const alerts = {
    reconcile: vi.fn().mockResolvedValue(undefined),
    countActive: vi.fn().mockResolvedValue(0),
  };
  const service = new HealthSamplerService(
    database as never,
    redis as never,
    storage as never,
    registrations as never,
    releases as never,
    alerts as never,
    new ConfigService({ PROCESSING_LEASE_SECONDS: 60 }),
  );
  return { service, database, redis, storage, registrations, releases, alerts };
}

describe('HealthSamplerService', () => {
  afterEach(() => vi.useRealTimers());

  it('starts unknown and coalesces concurrent cached samples', async () => {
    const f = setup();
    expect(
      f.service
        .snapshot()
        .components.every((item) => item.status === 'unknown'),
    ).toBe(true);
    const [first, second] = await Promise.all([
      f.service.sample(),
      f.service.sample(),
    ]);
    expect(first).toEqual(second);
    expect(f.database.db.command).toHaveBeenCalledOnce();
    expect(f.redis.ping).toHaveBeenCalledOnce();
    expect(f.storage.assertReady).toHaveBeenCalledOnce();
  });

  it('alerts for enabled offline and recovery slots but not draining or revoked idle workers', async () => {
    const f = setup();
    const expired = new Date(Date.now() - 120_000);
    f.registrations.aggregate.mockReturnValue({
      option: vi.fn().mockResolvedValue([
        {
          _id: 'enabled-offline',
          state: 'enabled',
          control: { lastSeenAt: expired, activeJobId: null },
        },
        {
          _id: 'draining-offline',
          state: 'draining',
          control: { lastSeenAt: expired, activeJobId: null },
        },
        {
          _id: 'stuck-worker',
          state: 'enabled',
          control: {
            lastSeenAt: expired,
            activeJobId: 'job',
            leaseExpiresAt: expired,
          },
        },
        {
          _id: 'revoked-idle',
          state: 'revoked',
          control: { lastSeenAt: expired, activeJobId: null },
        },
        {
          _id: 'revoked-active',
          state: 'revoked',
          control: {
            lastSeenAt: new Date(),
            activeJobId: 'job',
            leaseExpiresAt: new Date(Date.now() + 120_000),
          },
        },
      ]),
    });
    const result = await f.service.sample();
    expect(
      result.components.find((item) => item.name === 'workers')?.status,
    ).toBe('unavailable');
    const conditions = f.alerts.reconcile.mock.calls[0]![0];
    expect(
      conditions.map(
        (item: { type: string; resourceId: string }) =>
          `${item.type}:${item.resourceId}`,
      ),
    ).toEqual([
      'worker_offline:enabled-offline',
      'worker_recovery_required:stuck-worker',
      'worker_recovery_required:revoked-active',
    ]);
  });

  it('returns safe dependency failure codes and observes recovery after the cache expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));
    const f = setup();
    f.redis.ping.mockRejectedValueOnce(
      new Error('redis://private-host:6379 secret detail'),
    );
    const failed = await f.service.sample();
    expect(failed.components.find((item) => item.name === 'redis')).toEqual({
      name: 'redis',
      status: 'unavailable',
      checkedAt: '2026-09-11T00:00:00.000Z',
      code: 'DEPENDENCY_UNAVAILABLE',
    });
    expect(JSON.stringify(failed)).not.toContain('private-host');

    await vi.advanceTimersByTimeAsync(30_001);
    const recovered = await f.service.sample();
    expect(
      recovered.components.find((item) => item.name === 'redis')?.status,
    ).toBe('healthy');
    expect(f.redis.ping).toHaveBeenCalledTimes(2);
  });
});

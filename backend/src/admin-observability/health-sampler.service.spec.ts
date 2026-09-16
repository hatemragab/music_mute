import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthSamplerService } from './health-sampler.service.js';

function setup() {
  const database = {
    readyState: 1,
    db: { command: vi.fn().mockResolvedValue({ ok: 1 }) },
  };
  const redis = { ping: vi.fn().mockResolvedValue('PONG') };
  const storage = { assertReady: vi.fn().mockResolvedValue(undefined) };
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
    releases as never,
    alerts as never,
  );
  return { service, database, redis, storage, releases, alerts };
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
    expect(first.components.map((item) => item.name)).toEqual([
      'api',
      'mongodb',
      'redis',
      'storage',
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

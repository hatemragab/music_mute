import { ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RateBudgetService } from './rate-budget.service.js';

describe('RateBudgetService', () => {
  it('rejects invalid weighted quotas before contacting Redis', async () => {
    const redis = { eval: vi.fn() };
    const service = new RateBudgetService(redis as unknown as Redis);
    for (const buckets of [
      [],
      [{ key: 'bytes', weight: 0, limit: 100, windowMs: 1000 }],
      [{ key: 'bytes', weight: 1.5, limit: 100, windowMs: 1000 }],
      [{ key: 'bytes', weight: 1, limit: 100, windowMs: 0 }],
    ])
      await expect(service.reserveWeighted(buckets)).rejects.toThrow(TypeError);
    expect(redis.eval).not.toHaveBeenCalled();
  });
  it('maps the atomic reservation result and passes every bucket to one eval', async () => {
    const redis = { eval: vi.fn().mockResolvedValue([1, 0]) };
    const service = new RateBudgetService(redis as unknown as Redis);
    const buckets = [
      { key: 'one', limit: 3, windowMs: 60_000 },
      { key: 'two', limit: 10, windowMs: 3_600_000 },
    ];

    await expect(service.reserve(buckets)).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    expect(redis.eval).toHaveBeenCalledOnce();
    expect(redis.eval.mock.calls[0]?.slice(1, 4)).toEqual([2, 'one', 'two']);
  });

  it('rejects invalid and duplicate buckets before touching Redis', async () => {
    const redis = { eval: vi.fn() };
    const service = new RateBudgetService(redis as unknown as Redis);

    await expect(service.reserve([])).rejects.toThrow();
    await expect(
      service.reserve([{ key: 'x', limit: 0, windowMs: 1 }]),
    ).rejects.toThrow();
    await expect(
      service.reserve([
        { key: 'x', limit: 1, windowMs: 1 },
        { key: 'x', limit: 1, windowMs: 1 },
      ]),
    ).rejects.toThrow();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('fails closed when Redis is unavailable', async () => {
    const redis = {
      eval: vi.fn().mockRejectedValue(new Error('secret endpoint')),
    };
    const service = new RateBudgetService(redis as unknown as Redis);

    await expect(
      service.reserve([{ key: 'x', limit: 1, windowMs: 1000 }]),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('stores and reads project pauses with a bounded expiry', async () => {
    const redis = {
      set: vi.fn().mockResolvedValue('OK'),
      exists: vi.fn().mockResolvedValue(1),
    };
    const service = new RateBudgetService(redis as unknown as Redis);

    await service.pause('pause-key', 900_000);
    await expect(service.isPaused('pause-key')).resolves.toBe(true);
    expect(redis.set).toHaveBeenCalledWith('pause-key', '1', 'PX', 900_000);
  });
});

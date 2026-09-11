import { ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';

describe('RedisThrottlerStorage', () => {
  it('converts millisecond script results to the seconds required by Nest', async () => {
    const redis = { eval: vi.fn().mockResolvedValue([4, 59_001, 1, 7_001]) };
    const storage = new RedisThrottlerStorage(redis as unknown as Redis);

    await expect(
      storage.increment('shared', 60_000, 3, 10_000, 'default'),
    ).resolves.toEqual({
      totalHits: 4,
      timeToExpire: 60,
      isBlocked: true,
      timeToBlockExpire: 8,
    });
  });

  it('passes TTL and block duration separately to the atomic script', async () => {
    const redis = { eval: vi.fn().mockResolvedValue([1, 1000, 0, 0]) };
    const storage = new RedisThrottlerStorage(redis as unknown as Redis);

    await storage.increment('shared', 1000, 2, 9000, 'default');

    const call = redis.eval.mock.calls[0];
    expect(call?.slice(1, 4)).toEqual([2, 'shared:hits', 'shared:block']);
    expect(call?.slice(4, 7)).toEqual(['1000', '2', '9000']);
  });

  it('rejects invalid limits and fails closed on Redis errors', async () => {
    const redis = {
      eval: vi.fn().mockRejectedValue(new Error('private redis')),
    };
    const storage = new RedisThrottlerStorage(redis as unknown as Redis);

    await expect(
      storage.increment('key', 1000, 0, 1000, 'default'),
    ).rejects.toThrow();
    await expect(
      storage.increment('key', 1000, 1, 1000, 'default'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

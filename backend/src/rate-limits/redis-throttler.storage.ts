import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { SECURITY_REDIS } from './security-redis.provider.js';

export const THROTTLER_COUNTER_SCRIPT = `
local stamp = redis.call('TIME')
local now = tonumber(stamp[1]) * 1000 + math.floor(tonumber(stamp[2]) / 1000)
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])
local blockTtl = redis.call('PTTL', KEYS[2])

if blockTtl > 0 then
  local hitsTtl = redis.call('PTTL', KEYS[1])
  return {limit + 1, math.max(hitsTtl, 0), 1, blockTtl}
end

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - ttl)
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], ttl + 1000)
local count = redis.call('ZCARD', KEYS[1])
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local expires = math.max(tonumber(oldest[2]) + ttl - now, 0)

if count > limit then
  redis.call('SET', KEYS[2], '1', 'PX', blockDuration)
  redis.call('DEL', KEYS[1])
  return {count, expires, 1, blockDuration}
end

return {count, expires, 0, 0}
`;

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(@Inject(SECURITY_REDIS) private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    _throttlerName: string,
  ): Promise<{
    totalHits: number;
    timeToExpire: number;
    isBlocked: boolean;
    timeToBlockExpire: number;
  }> {
    if (
      !key ||
      !validPositiveInteger(ttl) ||
      !validPositiveInteger(limit) ||
      !validPositiveInteger(blockDuration)
    )
      throw new TypeError('Invalid throttler request');

    try {
      const result = await this.redis.eval(
        THROTTLER_COUNTER_SCRIPT,
        2,
        `${key}:hits`,
        `${key}:block`,
        String(ttl),
        String(limit),
        String(blockDuration),
        randomUUID(),
      );
      if (!Array.isArray(result) || result.length !== 4)
        throw new TypeError('Invalid Redis throttler response');
      const values = result.map(Number);
      if (values.some((value) => !Number.isFinite(value) || value < 0))
        throw new TypeError('Invalid Redis throttler response');
      const [totalHits, timeToExpireMs, blocked, timeToBlockExpireMs] = values;
      return {
        totalHits,
        timeToExpire: Math.ceil(timeToExpireMs / 1000),
        isBlocked: blocked === 1,
        timeToBlockExpire: Math.ceil(timeToBlockExpireMs / 1000),
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('Service unavailable');
    }
  }
}

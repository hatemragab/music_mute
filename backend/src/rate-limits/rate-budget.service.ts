import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { RateBucket, RateDecision } from '../auth/auth.types.js';
import { QUOTA_RESERVATION_SCRIPT } from './quota-script.js';
import { SECURITY_REDIS } from './security-redis.provider.js';

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

@Injectable()
export class RateBudgetService {
  constructor(@Inject(SECURITY_REDIS) private readonly redis: Redis) {}

  async reserve(buckets: RateBucket[]): Promise<RateDecision> {
    if (buckets.length === 0)
      throw new TypeError('At least one bucket is required');
    const keys = new Set<string>();
    for (const bucket of buckets) {
      if (
        bucket.key.length === 0 ||
        !positiveInteger(bucket.limit) ||
        !positiveInteger(bucket.windowMs)
      )
        throw new TypeError('Invalid rate-limit bucket');
      if (keys.has(bucket.key))
        throw new TypeError('Rate-limit bucket keys must be unique');
      keys.add(bucket.key);
    }

    try {
      const result = await this.redis.eval(
        QUOTA_RESERVATION_SCRIPT,
        buckets.length,
        ...buckets.map((bucket) => bucket.key),
        randomUUID(),
        ...buckets.flatMap((bucket) => [
          String(bucket.windowMs),
          String(bucket.limit),
        ]),
      );
      const [allowed, retryAfterSeconds] = this.parseResult(result);
      return {
        allowed: allowed === 1,
        retryAfterSeconds,
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('Service unavailable');
    }
  }

  async isPaused(key: string): Promise<boolean> {
    if (!key) throw new TypeError('Pause key is required');
    try {
      return (await this.redis.exists(key)) === 1;
    } catch {
      throw new ServiceUnavailableException('Service unavailable');
    }
  }

  async pause(key: string, milliseconds: number): Promise<void> {
    if (!key || !positiveInteger(milliseconds))
      throw new TypeError('Invalid pause request');
    try {
      await this.redis.set(key, '1', 'PX', milliseconds);
    } catch {
      throw new ServiceUnavailableException('Service unavailable');
    }
  }

  private parseResult(result: unknown): [number, number] {
    if (!Array.isArray(result) || result.length !== 2)
      throw new TypeError('Invalid Redis quota response');
    const allowed = Number(result[0]);
    const retryAfterSeconds = Number(result[1]);
    if (
      ![0, 1].includes(allowed) ||
      !Number.isSafeInteger(retryAfterSeconds) ||
      retryAfterSeconds < 0
    )
      throw new TypeError('Invalid Redis quota response');
    return [allowed, retryAfterSeconds];
  }
}

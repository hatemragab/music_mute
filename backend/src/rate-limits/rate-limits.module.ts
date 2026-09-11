import { Global, Module } from '@nestjs/common';
import { RateBudgetService } from './rate-budget.service.js';
import { RateLimitKeys } from './rate-limit-keys.js';
import { RedisThrottlerStorage } from './redis-throttler.storage.js';
import {
  securityRedisProvider,
  SecurityRedisLifecycle,
  SECURITY_REDIS,
} from './security-redis.provider.js';

@Global()
@Module({
  providers: [
    securityRedisProvider,
    SecurityRedisLifecycle,
    RateBudgetService,
    RateLimitKeys,
    RedisThrottlerStorage,
  ],
  exports: [
    SECURITY_REDIS,
    RateBudgetService,
    RateLimitKeys,
    RedisThrottlerStorage,
  ],
})
export class RateLimitsModule {}

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ApiThrottlerGuard } from '../rate-limits/api-throttler.guard.js';
import { RateLimitsModule } from '../rate-limits/rate-limits.module.js';
import { RedisThrottlerStorage } from '../rate-limits/redis-throttler.storage.js';

@Module({
  imports: [
    RateLimitsModule,
    ThrottlerModule.forRootAsync({
      imports: [RateLimitsModule],
      inject: [ConfigService, RedisThrottlerStorage],
      useFactory: (config: ConfigService, storage: RedisThrottlerStorage) => ({
        storage,
        throttlers: [
          {
            ttl: config.getOrThrow<number>('RATE_TTL_MS'),
            limit: config.getOrThrow<number>('RATE_LIMIT'),
          },
        ],
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ApiThrottlerGuard }],
  exports: [RateLimitsModule],
})
export class SecurityModule {}

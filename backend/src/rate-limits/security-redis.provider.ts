import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type Provider,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

export const SECURITY_REDIS = Symbol('SECURITY_REDIS');

export const securityRedisProvider: Provider = {
  provide: SECURITY_REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis => {
    const redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      connectTimeout: 5000,
      commandTimeout: 5000,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt: number) => Math.min(attempt * 100, 1000),
    });
    // Callers receive sanitized 503 errors; do not let ioredis print connection
    // details through its default unhandled-error diagnostic.
    redis.on('error', () => undefined);
    return redis;
  },
};

@Injectable()
export class SecurityRedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(SECURITY_REDIS) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.redis.status === 'ready') await this.redis.quit?.();
    } finally {
      this.redis.disconnect?.(false);
    }
  }
}

import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { SkipThrottle } from '@nestjs/throttler';
import type { Connection } from 'mongoose';
import type { Redis } from 'ioredis';
import { SECURITY_REDIS } from '../rate-limits/security-redis.provider.js';
import { setTimeout } from 'node:timers/promises';
import { Public } from '../auth/auth.decorators.js';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    @InjectConnection() private readonly database: Connection,
    @Inject(SECURITY_REDIS) private readonly redis: Redis,
  ) {}
  @SkipThrottle()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const deadline = new AbortController();
    try {
      if (this.database.readyState !== 1) throw new Error('Not connected');
      await Promise.race([
        Promise.all([
          this.database.db!.command({ ping: 1 }, { timeoutMS: 2000 }),
          this.redis.ping(),
        ]),
        setTimeout(5000, undefined, { signal: deadline.signal }).then(() => {
          throw new Error('Deadline exceeded');
        }),
      ]);
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('Service unavailable');
    } finally {
      deadline.abort();
    }
  }
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { RateBudgetService } from '../rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../rate-limits/rate-limit-keys.js';
import { adminError } from './admin-errors.js';
import type { AdminRateClass } from './admin.types.js';

const configByClass: Record<
  AdminRateClass,
  { key: string; fallback: number; windowMs: number }
> = {
  read: { key: 'ADMIN_READS_PER_MINUTE', fallback: 120, windowMs: 60_000 },
  write: { key: 'ADMIN_WRITES_PER_MINUTE', fallback: 30, windowMs: 60_000 },
  media: {
    key: 'ADMIN_MEDIA_GRANTS_PER_MINUTE',
    fallback: 20,
    windowMs: 60_000,
  },
  sensitive: {
    key: 'ADMIN_SENSITIVE_OPERATIONS_PER_MINUTE',
    fallback: 5,
    windowMs: 60_000,
  },
  export: { key: 'ADMIN_EXPORTS_PER_HOUR', fallback: 5, windowMs: 3_600_000 },
};

@Injectable()
export class AdminRateLimitService {
  constructor(
    private readonly budgets: RateBudgetService,
    private readonly keys: RateLimitKeys,
    private readonly config: ConfigService,
  ) {}

  async assertAllowed(
    uid: string,
    rateClass: AdminRateClass,
    response: Pick<Response, 'setHeader'>,
    requestId: string,
  ): Promise<void> {
    const definition = configByClass[rateClass];
    const decision = await this.budgets.reserve([
      {
        key: this.keys.bucket(`admin-${rateClass}-uid`, uid),
        limit: this.config.get<number>(definition.key, definition.fallback),
        windowMs: definition.windowMs,
      },
    ]);
    if (!decision.allowed) {
      response.setHeader('Retry-After', decision.retryAfterSeconds);
      throw adminError('RATE_LIMITED', requestId);
    }
  }
}

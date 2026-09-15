import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { RateBudgetService } from '../rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../rate-limits/rate-limit-keys.js';
import { AuthRateLimitException } from '../auth/rate-limit.exception.js';
import { adminError } from '../admin/admin-errors.js';
import { randomUUID } from 'node:crypto';
@Injectable()
export class InstallationLimitsService {
  constructor(
    private readonly budgets: RateBudgetService,
    private readonly keys: RateLimitKeys,
  ) {}
  async approvalAttempt(uid: string, response: Response) {
    const key = this.keys.bucket('installation-approval-failed', uid);
    const reservationId = randomUUID();
    const result = await this.budgets.reserve(
      [{ key, limit: 5, windowMs: 900000 }],
      reservationId,
    );
    if (!result.allowed) {
      response.setHeader('Retry-After', result.retryAfterSeconds);
      throw adminError('RATE_LIMITED');
    }
    return () => this.budgets.release(key, reservationId);
  }
  async take(
    scopes: Array<[string, string, number, number]>,
    response: Response,
    admin = false,
  ) {
    const result = await this.budgets.reserve(
      scopes.map(([scope, id, limit, windowMs]) => ({
        key: this.keys.bucket(scope, id),
        limit,
        windowMs,
      })),
    );
    if (!result.allowed) {
      response.setHeader('Retry-After', result.retryAfterSeconds);
      if (admin) throw adminError('RATE_LIMITED');
      throw new AuthRateLimitException(result.retryAfterSeconds);
    }
  }
}

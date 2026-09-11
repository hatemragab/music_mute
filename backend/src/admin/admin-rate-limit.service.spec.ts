import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { AdminRateLimitService } from './admin-rate-limit.service.js';

describe('AdminRateLimitService', () => {
  it.each([
    ['read', 120, 60_000],
    ['write', 30, 60_000],
    ['media', 20, 60_000],
    ['sensitive', 5, 60_000],
    ['export', 5, 3_600_000],
  ] as const)(
    'reserves the %s UID budget',
    async (rateClass, limit, windowMs) => {
      const budgets = {
        reserve: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
      };
      const service = new AdminRateLimitService(
        budgets as never,
        { bucket: (scope: string, id: string) => `${scope}:${id}` } as never,
        new ConfigService(),
      );
      await service.assertAllowed(
        'fixture-uid',
        rateClass,
        { setHeader: vi.fn() } as never,
        'fixture-request',
      );
      expect(budgets.reserve).toHaveBeenCalledWith([
        { key: `admin-${rateClass}-uid:fixture-uid`, limit, windowMs },
      ]);
    },
  );

  it('returns Retry-After with the bounded admin error when denied', async () => {
    const response = { setHeader: vi.fn() };
    const service = new AdminRateLimitService(
      {
        reserve: async () => ({ allowed: false, retryAfterSeconds: 17 }),
      } as never,
      { bucket: () => 'fixture-key' } as never,
      new ConfigService(),
    );
    await expect(
      service.assertAllowed(
        'fixture-uid',
        'write',
        response as never,
        'request-id',
      ),
    ).rejects.toMatchObject({
      response: { code: 'RATE_LIMITED', requestId: 'request-id' },
    });
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', 17);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  ADMIN_FRESH_AUTH,
  ADMIN_RATE_CLASS,
} from '../admin/admin.decorators.js';
import { AppUpdatesController } from './app-updates.controller.js';
import { AdminReleaseUploadsController } from './admin-release-uploads.controller.js';

describe('release controller security metadata', () => {
  it.each(['reserve', 'complete'] as const)(
    'requires fresh sensitive admin authorization for %s',
    (method) => {
      const handler = AdminReleaseUploadsController.prototype[method];
      expect(Reflect.getMetadata(ADMIN_FRESH_AUTH, handler)).toBe(true);
      expect(Reflect.getMetadata(ADMIN_RATE_CLASS, handler)).toBe('sensitive');
    },
  );

  it.each(['download', 'open'] as const)(
    'limits public APK grant endpoint %s to 10 requests per minute per IP',
    (method) => {
      const handler = AppUpdatesController.prototype[method];
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(10);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
    },
  );

  it('rejects public APK grants at the shared service ceiling before storage access', async () => {
    const grant = vi.fn();
    const reserve = vi.fn(async () => ({
      allowed: false,
      retryAfterSeconds: 23,
    }));
    const controller = new AppUpdatesController(
      {} as never,
      { grant } as never,
      { reserve } as never,
      { bucket: (scope: string, id: string) => `${scope}:${id}` } as never,
      { get: (_key: string, fallback: number) => fallback } as never,
    );
    const response = { setHeader: vi.fn() };
    await expect(
      controller.download(
        { ip: '192.0.2.4' } as never,
        response as never,
        'release-id',
        {},
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(reserve).toHaveBeenCalledWith([
      {
        key: 'public-release-grant-ip:192.0.2.4',
        limit: 10,
        windowMs: 60_000,
      },
      {
        key: 'public-release-grant-service:global',
        limit: 300,
        windowMs: 60_000,
      },
    ]);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', 23);
    expect(grant).not.toHaveBeenCalled();
  });
});

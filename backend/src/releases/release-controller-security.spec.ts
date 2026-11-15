import { describe, expect, it } from 'vitest';
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
});

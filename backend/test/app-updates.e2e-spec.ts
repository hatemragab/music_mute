import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAdminHarness,
  type AdminHarness,
} from './helpers/admin-harness.js';
import { AppUpdatesController } from '../src/releases/app-updates.controller.js';
import { ReleasePolicyService } from '../src/releases/release-policy.service.js';
import { parseDistribution } from '../src/releases/release-policy.js';
describe('public release policy HTTP boundary', () => {
  let harness: AdminHarness;
  afterEach(async () => harness?.close());
  it('admits unsigned clients, rejects unsupported channels and sends no-store', async () => {
    const snapshots = {
      snapshot: vi.fn(async (platform, distribution) => ({
        schemaVersion: 1,
        ...parseDistribution(platform, distribution),
        target: null,
        minimumBuild: null,
      })),
    };
    harness = await createAdminHarness({
      controllers: [AppUpdatesController],
      providers: [{ provide: ReleasePolicyService, useValue: snapshots }],
    });
    const response = await harness
      .request('get', '/app-updates/policy?platform=android&distribution=play')
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.platform).toBe('android');
    await harness
      .request(
        'get',
        '/app-updates/policy?platform=android&distribution=direct',
      )
      .expect(400);
    await harness
      .request('get', '/app-updates/policy?platform=ios&distribution=direct')
      .expect(400);
    await harness
      .request(
        'get',
        '/app-updates/policy?platform=android&distribution=play&secret=true',
      )
      .expect(400);
    const id = 'a'.repeat(24);
    for (const [method, path] of [
      ['get', `/app-updates/releases/${id}`],
      ['post', `/app-updates/releases/${id}/download-grants`],
      ['post', `/app-updates/releases/${id}/download-redirects`],
    ] as const) {
      const retired = await harness.request(method, path).expect(404);
      expect(retired.body.code).toBe('RESOURCE_NOT_FOUND');
      expect(retired.headers.location).toBeUndefined();
      expect(retired.headers['cache-control']).toBe('no-store');
      expect(retired.text).not.toContain('https://');
      expect(retired.text).not.toContain('Download APK');
    }
  });
});

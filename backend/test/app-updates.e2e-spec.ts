import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAdminHarness,
  type AdminHarness,
} from './helpers/admin-harness.js';
import { AppUpdatesController } from '../src/releases/app-updates.controller.js';
import { ReleasePolicyService } from '../src/releases/release-policy.service.js';
import { ReleaseDownloadService } from '../src/releases/release-download.service.js';
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
      providers: [
        { provide: ReleasePolicyService, useValue: snapshots },
        { provide: ReleaseDownloadService, useValue: {} },
      ],
    });
    const response = await harness
      .request(
        'get',
        '/app-updates/policy?platform=android&distribution=direct',
      )
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.platform).toBe('android');
    await harness
      .request('get', '/app-updates/policy?platform=ios&distribution=direct')
      .expect(400);
    await harness
      .request(
        'get',
        '/app-updates/policy?platform=android&distribution=play&secret=true',
      )
      .expect(400);
  });
});

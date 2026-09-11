import { describe, expect, it, vi } from 'vitest';
import {
  evaluateProcessingAccess,
  defaultPolicy,
  validatePolicy,
} from './access-policy.js';
import { AppPolicyService } from './app-policy.service.js';
import { ConfigService } from '@nestjs/config';

describe('processing access policy', () => {
  const device = { platform: 'ios' as const, buildNumber: 1 };
  it('allows unverified users initially, but requires an owned device', () => {
    expect(evaluateProcessingAccess(defaultPolicy(), false, device)).toEqual({
      allowed: true,
    });
    expect(evaluateProcessingAccess(defaultPolicy(), true, null)).toEqual({
      allowed: false,
      reason: 'DEVICE_SYNC_REQUIRED',
    });
  });
  it('enforces the verification toggle and per-platform integer builds', () => {
    const policy = defaultPolicy();
    policy.requireVerifiedEmail = true;
    expect(evaluateProcessingAccess(policy, false, device)).toEqual({
      allowed: false,
      reason: 'EMAIL_VERIFICATION_REQUIRED',
    });
    policy.platforms.ios = {
      minimumBuild: 2,
      latestBuild: 3,
      downloadUrl: 'https://example.invalid/download',
    };
    expect(evaluateProcessingAccess(policy, true, device)).toEqual({
      allowed: false,
      reason: 'APP_UPDATE_REQUIRED',
      downloadUrl: policy.platforms.ios.downloadUrl,
    });
    expect(
      evaluateProcessingAccess(policy, true, {
        ...device,
        platform: 'android',
      }),
    ).toEqual({ allowed: true });
  });
  it.each([
    { minimumBuild: 2, latestBuild: 1, downloadUrl: 'https://example.invalid' },
    {
      minimumBuild: 2,
      latestBuild: null,
      downloadUrl: 'https://example.invalid',
    },
    { minimumBuild: 2, latestBuild: 2, downloadUrl: null },
    {
      minimumBuild: null,
      latestBuild: 2,
      downloadUrl: 'http://example.invalid',
    },
    {
      minimumBuild: null,
      latestBuild: 2,
      downloadUrl: 'https://user:password@example.invalid',
    },
    {
      minimumBuild: 1.5,
      latestBuild: 2,
      downloadUrl: 'https://example.invalid',
    },
  ])('rejects invalid operator policy %j', (platform) => {
    const policy = defaultPolicy();
    policy.platforms.ios = platform;
    expect(() => validatePolicy(policy)).toThrow();
  });
  it('returns fresh permissive defaults and rejects unknown operator fields', () => {
    const first = defaultPolicy();
    first.platforms.ios.minimumBuild = 3;
    expect(defaultPolicy().platforms.ios.minimumBuild).toBeNull();
    expect(() =>
      validatePolicy({ ...defaultPolicy(), bypass: true }),
    ).toThrow();
  });

  it('fails closed when a rich selected admission target is unavailable', async () => {
    const policy = defaultPolicy();
    policy.platforms.android = {
      minimumBuild: 10,
      latestBuild: 12,
      downloadUrl: 'https://example.invalid/releases/selected',
      releaseSelection: {
        source: 'direct_apk',
        directReleaseId: 'a'.repeat(24),
        storeReleaseId: null,
      },
    };
    const releases = {
      findById: () => ({
        maxTimeMS: () => ({ lean: vi.fn().mockResolvedValue(null) }),
      }),
    };
    const service = new AppPolicyService({} as never, releases as never);
    await expect(
      service.assertProcessingTargetAvailable(policy, 'android'),
    ).rejects.toMatchObject({
      response: { code: 'SERVICE_UNAVAILABLE' },
    });
  });

  it('accepts a published rich target that matches the policy projection', async () => {
    const policy = defaultPolicy();
    policy.platforms.ios = {
      minimumBuild: 10,
      latestBuild: 12,
      downloadUrl: 'https://apps.apple.com/app/id123456789',
      releaseSelection: {
        source: 'app_store',
        directReleaseId: null,
        storeReleaseId: 'b'.repeat(24),
      },
    };
    const releases = {
      findById: () => ({
        maxTimeMS: () => ({
          lean: vi.fn().mockResolvedValue({
            state: 'published',
            platform: 'ios',
            source: 'app_store',
            buildNumber: 12,
            storeUrl: policy.platforms.ios.downloadUrl,
          }),
        }),
      }),
    };
    const service = new AppPolicyService({} as never, releases as never);
    await expect(
      service.assertProcessingTargetAvailable(policy, 'ios'),
    ).resolves.toBeUndefined();
  });

  it.each([
    [undefined, 'https://api.example.invalid/app-updates/releases/'],
    ['not-a-url', 'https://api.example.invalid/app-updates/releases/'],
    [
      'https://api.example.invalid/api/v1',
      'https://stale.example.invalid/release',
    ],
  ])(
    'fails closed for a direct target with base %s and projected URL %s',
    async (base, downloadUrl) => {
      const id = 'c'.repeat(24);
      const policy = defaultPolicy();
      policy.platforms.android = {
        minimumBuild: 10,
        latestBuild: 12,
        downloadUrl,
        releaseSelection: {
          source: 'direct_apk',
          directReleaseId: id,
          storeReleaseId: null,
        },
      };
      const releases = {
        findById: () => ({
          maxTimeMS: () => ({
            lean: vi.fn().mockResolvedValue({
              state: 'published',
              platform: 'android',
              source: 'direct_apk',
              buildNumber: 12,
              storeUrl: null,
              artifactState: 'verified',
              artifact: { versionId: 'v1' },
            }),
          }),
        }),
      };
      const service = new AppPolicyService(
        {} as never,
        releases as never,
        new ConfigService({ RELEASE_LANDING_BASE_URL: base }),
      );
      await expect(
        service.assertProcessingTargetAvailable(policy, 'android'),
      ).rejects.toMatchObject({ response: { code: 'SERVICE_UNAVAILABLE' } });
    },
  );
});

import { describe, expect, it, vi } from 'vitest';
import {
  evaluateProcessingAccess,
  defaultPolicy,
  validatePolicy,
} from './access-policy.js';
import { AppPolicyService } from './app-policy.service.js';

describe('processing access policy', () => {
  const device = { platform: 'ios' as const, buildNumber: 1 };

  it('requires an owned device and enforces verified email when configured', () => {
    expect(evaluateProcessingAccess(defaultPolicy(), false, device)).toEqual({
      allowed: true,
    });
    expect(evaluateProcessingAccess(defaultPolicy(), true, null)).toEqual({
      allowed: false,
      reason: 'DEVICE_SYNC_REQUIRED',
    });
    const policy = defaultPolicy();
    policy.requireVerifiedEmail = true;
    expect(evaluateProcessingAccess(policy, false, device)).toEqual({
      allowed: false,
      reason: 'EMAIL_VERIFICATION_REQUIRED',
    });
  });

  it('enforces the selected platform minimum build', () => {
    const policy = defaultPolicy();
    policy.platforms.ios.minimumBuild = 2;
    expect(evaluateProcessingAccess(policy, true, device)).toEqual({
      allowed: false,
      reason: 'APP_UPDATE_REQUIRED',
    });
    expect(
      evaluateProcessingAccess(policy, true, {
        ...device,
        platform: 'android',
      }),
    ).toEqual({ allowed: true });
  });

  it('admits an owned web device without a native build channel while retaining verification', async () => {
    const policy = defaultPolicy();
    policy.platforms.android.minimumBuild = 10;
    policy.platforms.android.releaseSelection.directReleaseId = 'a'.repeat(24);
    policy.requireVerifiedEmail = true;
    const web = { platform: 'web' as const, buildNumber: 1 };
    expect(evaluateProcessingAccess(policy, false, web)).toEqual({
      allowed: false,
      reason: 'EMAIL_VERIFICATION_REQUIRED',
    });
    expect(evaluateProcessingAccess(policy, true, web)).toEqual({
      allowed: true,
    });
    const releases = { findById: vi.fn() };
    const service = new AppPolicyService({} as never, releases as never);
    await expect(
      service.assertProcessingTargetAvailable(policy, 'web'),
    ).resolves.toBeUndefined();
    expect(releases.findById).not.toHaveBeenCalled();
  });

  it.each([
    {
      minimumBuild: 2,
      releaseSelection: {
        source: 'app_store',
        directReleaseId: null,
        storeReleaseId: null,
      },
    },
    {
      minimumBuild: 1.5,
      releaseSelection: {
        source: 'app_store',
        directReleaseId: null,
        storeReleaseId: 'a'.repeat(24),
      },
    },
    {
      minimumBuild: null,
      releaseSelection: {
        source: 'direct_apk',
        directReleaseId: 'a'.repeat(24),
        storeReleaseId: null,
      },
    },
  ])('rejects invalid operator policy %j', (platform) => {
    const policy = defaultPolicy();
    policy.platforms.ios = platform as never;
    expect(() => validatePolicy(policy)).toThrow();
  });

  it('requires the current policy shape', () => {
    const policy = defaultPolicy();
    expect(() => validatePolicy(policy)).not.toThrow();
    expect(() => validatePolicy({ ...policy, bypass: true })).toThrow();
  });

  it('rejects an unavailable selected release', async () => {
    const policy = defaultPolicy();
    policy.platforms.android.minimumBuild = 10;
    policy.platforms.android.releaseSelection.directReleaseId = 'a'.repeat(24);
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

  it('accepts a published selected release at or above the minimum build', async () => {
    const policy = defaultPolicy();
    policy.platforms.ios.minimumBuild = 10;
    policy.platforms.ios.releaseSelection.storeReleaseId = 'b'.repeat(24);
    const releases = {
      findById: () => ({
        maxTimeMS: () => ({
          lean: vi.fn().mockResolvedValue({
            state: 'published',
            platform: 'ios',
            source: 'app_store',
            buildNumber: 12,
          }),
        }),
      }),
    };
    const service = new AppPolicyService({} as never, releases as never);
    await expect(
      service.assertProcessingTargetAvailable(policy, 'ios'),
    ).resolves.toBeUndefined();
  });
});

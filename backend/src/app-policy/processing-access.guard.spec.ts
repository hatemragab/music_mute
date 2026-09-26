import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { ProcessingAccessGuard } from './processing-access.guard.js';
import { defaultPolicy } from './access-policy.js';

function context(request: Record<string, unknown>) {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

describe('ProcessingAccessGuard', () => {
  it('uses the persisted owned installation and validates its selected target', async () => {
    const policy = defaultPolicy();
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(true) };
    const devices = {
      findOwned: vi
        .fn()
        .mockResolvedValue({ platform: 'android', buildNumber: 10 }),
    };
    const policies = {
      current: vi.fn().mockResolvedValue(policy),
      assertProcessingTargetAvailable: vi.fn().mockResolvedValue(undefined),
    };
    const guard = new ProcessingAccessGuard(
      reflector as never,
      devices as never,
      policies as never,
    );
    await expect(
      guard.canActivate(
        context({
          identity: { tokenEmailVerified: true },
          user: { _id: new Types.ObjectId('64b000000000000000000001') },
          headers: {
            'x-installation-id': 'e183f234-ac55-4d06-9d08-b92d5d829ed8',
          },
        }),
      ),
    ).resolves.toBe(true);
    expect(policies.assertProcessingTargetAvailable).toHaveBeenCalledWith(
      policy,
      'android',
    );
  });
  it('requires an owned web installation and applies shared verification policy', async () => {
    const policy = defaultPolicy();
    policy.requireVerifiedEmail = true;
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(true) };
    const devices = {
      findOwned: vi.fn().mockResolvedValue({ platform: 'web', buildNumber: 1 }),
    };
    const policies = {
      current: vi.fn().mockResolvedValue(policy),
      assertProcessingTargetAvailable: vi.fn().mockResolvedValue(undefined),
    };
    const guard = new ProcessingAccessGuard(
      reflector as never,
      devices as never,
      policies as never,
    );
    const request = {
      identity: { tokenEmailVerified: true },
      user: { _id: new Types.ObjectId('64b000000000000000000001') },
      headers: { 'x-installation-id': 'e183f234-ac55-4d06-9d08-b92d5d829ed8' },
    };
    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(policies.assertProcessingTargetAvailable).toHaveBeenCalledWith(
      policy,
      'web',
    );
    devices.findOwned.mockResolvedValueOnce(null);
    await expect(guard.canActivate(context(request))).rejects.toMatchObject({
      response: { code: 'DEVICE_SYNC_REQUIRED' },
    });
    await expect(
      guard.canActivate(
        context({ ...request, identity: { tokenEmailVerified: false } }),
      ),
    ).rejects.toMatchObject({
      response: { code: 'EMAIL_VERIFICATION_REQUIRED' },
    });
  });
});

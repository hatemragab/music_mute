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
});

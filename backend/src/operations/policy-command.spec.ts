import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppPolicyService } from '../app-policy/app-policy.service.js';
import { defaultPolicy } from '../app-policy/access-policy.js';
import { PolicyCommand } from './policy-command.js';

describe('PolicyCommand', () => {
  it('prevents release-policy bypass while retaining email policy changes', async () => {
    const current = vi.fn().mockResolvedValue(defaultPolicy());
    const replace = vi.fn().mockImplementation(async (policy) => policy);
    const service = new PolicyCommand(
      { current, replace } as unknown as AppPolicyService,
      new ConfigService({ APP_UPDATES_ENABLED: true }),
    );
    await expect(
      service.setPolicy(
        { platforms: { android: { minimumBuild: null } } },
        0,
        true,
      ),
    ).rejects.toThrow();
    expect(replace).not.toHaveBeenCalled();
    await service.setPolicy({ requireVerifiedEmail: true }, 0, true);
    expect(replace).toHaveBeenCalledOnce();
  });
  function fixture() {
    const current = vi.fn().mockResolvedValue(defaultPolicy());
    const replace = vi.fn().mockImplementation(async (policy) => ({
      ...policy,
      revision: policy.revision + 1,
      updatedAt: new Date(),
    }));
    return {
      service: new PolicyCommand({
        current,
        replace,
      } as unknown as AppPolicyService),
      current,
      replace,
    };
  }

  it('validates and previews an optional-verification patch without writes', async () => {
    const { service, replace } = fixture();

    const result = await service.setPolicy(
      { requireVerifiedEmail: true },
      0,
      false,
    );

    expect(result.applied).toBe(false);
    expect(result.current.requireVerifiedEmail).toBe(false);
    expect(result.next.requireVerifiedEmail).toBe(true);
    expect(result.next.revision).toBe(0);
    expect(replace).not.toHaveBeenCalled();
  });

  it('deep-merges platform patches before full validation and apply', async () => {
    const { service, replace } = fixture();
    const patch = {
      platforms: {
        ios: {
          minimumBuild: 10,
          latestBuild: 12,
          downloadUrl: 'https://apps.example.test/musicmute',
        },
      },
    };

    const result = await service.setPolicy(patch, 0, true);

    expect(result.applied).toBe(true);
    expect(result.next.platforms.android.minimumBuild).toBeNull();
    expect(replace).toHaveBeenCalledOnce();
  });

  it('rejects caller-controlled revision, identity and timestamps', async () => {
    const { service, replace } = fixture();
    for (const patch of [
      { _id: 'global' },
      { revision: 1 },
      { updatedAt: new Date() },
      { platforms: { ios: { unknown: true } } },
    ])
      await expect(service.setPolicy(patch, 0, false)).rejects.toBeInstanceOf(
        HttpException,
      );
    expect(replace).not.toHaveBeenCalled();
  });

  it('rejects a stale expected revision before writing', async () => {
    const { service, current, replace } = fixture();
    current.mockResolvedValue({ ...defaultPolicy(), revision: 3 });

    await expect(
      service.setPolicy({ requireVerifiedEmail: true }, 2, true),
    ).rejects.toMatchObject({ status: 409 });
    expect(replace).not.toHaveBeenCalled();
  });
});

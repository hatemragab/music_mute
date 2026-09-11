import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { AuthMailService } from './auth-mail.service.js';
import { FirebaseMailQuotaError } from './firebase-mail.service.js';
import type { FirebaseMailService } from './firebase-mail.service.js';
import type { FirebaseIdentityService } from './firebase-identity.service.js';
import type { RateBudgetService } from '../rate-limits/rate-budget.service.js';
import type { RateLimitKeys } from '../rate-limits/rate-limit-keys.js';

describe('voluntary email and recovery orchestration', () => {
  const context = {
    uid: 'fixture-owner',
    bearer: 'fixture-token',
    ip: '127.0.0.1',
    identity: {
      uid: 'fixture-owner',
      authTimeSec: 100,
      provider: 'password' as const,
      tokenEmailVerified: false,
    },
  };
  function setup() {
    const firebase = {
      getProfile: vi.fn().mockResolvedValue({
        uid: context.uid,
        email: 'User@fixture.invalid',
        emailVerified: false,
        disabled: false,
      }),
    };
    const mail = {
      sendVerification: vi.fn().mockResolvedValue(undefined),
      sendPasswordReset: vi.fn().mockResolvedValue(undefined),
    };
    const budgets = {
      reserve: vi
        .fn()
        .mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
      isPaused: vi.fn().mockResolvedValue(false),
      pause: vi.fn().mockResolvedValue(undefined),
    };
    const keys = { bucket: (scope: string, id: string) => `${scope}:${id}` };
    return {
      firebase,
      mail,
      budgets,
      service: new AuthMailService(
        firebase as unknown as FirebaseIdentityService,
        mail as unknown as FirebaseMailService,
        budgets as unknown as RateBudgetService,
        keys as unknown as RateLimitKeys,
        new ConfigService(),
      ),
    };
  }
  it('does not send or reserve mail budget for currently verified profiles', async () => {
    const f = setup();
    f.firebase.getProfile.mockResolvedValue({
      uid: context.uid,
      emailVerified: true,
    });
    expect(await f.service.requestVerification(context)).toEqual({
      alreadyVerified: true,
    });
    expect(f.budgets.reserve).not.toHaveBeenCalled();
    expect(f.mail.sendVerification).not.toHaveBeenCalled();
  });
  it.each(['google.com', 'apple.com'] as const)(
    'does not send verification mail for a %s profile',
    async (providerId) => {
      const f = setup();
      f.firebase.getProfile.mockResolvedValue({
        uid: context.uid,
        email: 'user@fixture.invalid',
        emailVerified: false,
        disabled: false,
        providerData: [{ providerId }],
      });

      expect(
        await f.service.requestVerification({
          ...context,
          identity: {
            ...context.identity,
            provider: providerId,
            tokenEmailVerified: true,
          },
        }),
      ).toEqual({ alreadyVerified: true });
      expect(f.budgets.reserve).not.toHaveBeenCalled();
      expect(f.mail.sendVerification).not.toHaveBeenCalled();
    },
  );
  it('sends verification mail for an unverified password session with a linked Google provider', async () => {
    const f = setup();
    f.firebase.getProfile.mockResolvedValue({
      uid: context.uid,
      email: 'user@fixture.invalid',
      emailVerified: false,
      disabled: false,
      providerData: [{ providerId: 'password' }, { providerId: 'google.com' }],
    });

    expect(await f.service.requestVerification(context)).toEqual({
      alreadyVerified: false,
    });
    expect(f.mail.sendVerification).toHaveBeenCalledOnce();
  });
  it('rejects missing email before consuming a mail budget', async () => {
    const f = setup();
    f.firebase.getProfile.mockResolvedValue({
      uid: context.uid,
      emailVerified: false,
    });
    await expect(f.service.requestVerification(context)).rejects.toMatchObject({
      status: 400,
    });
    expect(f.budgets.reserve).not.toHaveBeenCalled();
  });
  it('reserves all five verification buckets before a single send', async () => {
    const f = setup();
    await f.service.requestVerification(context);
    const buckets = f.budgets.reserve.mock.calls[0][0];
    expect(buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ limit: 1, windowMs: 60000 }),
        expect.objectContaining({
          key: 'verify-uid-day:fixture-owner',
          limit: 3,
          windowMs: 86400000,
        }),
        expect.objectContaining({
          key: 'verify-email-day:user@fixture.invalid',
          limit: 3,
        }),
        expect.objectContaining({ key: 'verify-ip-hour:127.0.0.1', limit: 10 }),
        expect.objectContaining({
          key: 'verify-project-day:project',
          limit: 200,
        }),
      ]),
    );
    expect(buckets).toHaveLength(5);
    expect(f.budgets.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      f.mail.sendVerification.mock.invocationCallOrder[0],
    );
    expect(f.mail.sendVerification).toHaveBeenCalledWith(context.bearer);
  });
  it('refused reservation produces retry information and no outbound call', async () => {
    const f = setup();
    f.budgets.reserve.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 60,
    });
    await expect(f.service.requestVerification(context)).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 60,
    });
    expect(f.mail.sendVerification).not.toHaveBeenCalled();
  });
  it('keeps accepted quota after an ambiguous send and never retries', async () => {
    const f = setup();
    f.mail.sendVerification.mockRejectedValue(new Error('fixture timeout'));
    await expect(f.service.requestVerification(context)).rejects.toMatchObject({
      status: 503,
    });
    expect(f.budgets.reserve).toHaveBeenCalledTimes(1);
    expect(f.mail.sendVerification).toHaveBeenCalledTimes(1);
  });
  it('pauses the project adapter for 15 minutes after upstream quota response', async () => {
    const f = setup();
    f.mail.sendVerification.mockRejectedValue(new FirebaseMailQuotaError());
    await expect(f.service.requestVerification(context)).rejects.toMatchObject({
      status: 503,
    });
    expect(f.budgets.pause).toHaveBeenCalledWith('mail-pause:project', 900000);
    f.budgets.isPaused.mockResolvedValue(true);
    await expect(
      f.service.requestPasswordReset('another@fixture.invalid', context.ip),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.mail.sendPasswordReset).not.toHaveBeenCalled();
  });
  it('uses separate password reset budgets without looking up account existence', async () => {
    const f = setup();
    await f.service.requestPasswordReset('Unknown@fixture.invalid', context.ip);
    expect(f.firebase.getProfile).not.toHaveBeenCalled();
    expect(f.budgets.reserve.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'reset-project-day:project',
          limit: 50,
        }),
        expect.objectContaining({
          key: 'reset-email-day:unknown@fixture.invalid',
          limit: 3,
        }),
      ]),
    );
    expect(f.mail.sendPasswordReset).toHaveBeenCalledWith(
      'Unknown@fixture.invalid',
    );
  });
  it('fails closed when security storage is unavailable', async () => {
    const f = setup();
    f.budgets.isPaused.mockRejectedValue(new Error('Redis unavailable'));
    await expect(f.service.requestVerification(context)).rejects.toMatchObject({
      status: 503,
    });
    expect(f.mail.sendVerification).not.toHaveBeenCalled();
  });
});

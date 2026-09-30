import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { DEFAULT_ACCOUNT_POLICY_VALUES } from './account-policy.schema.js';
import {
  AccountPolicyService,
  validateAccountPolicyValues,
} from './account-policy.service.js';

const query = <T>(value: T) => ({
  select: vi.fn().mockReturnThis(),
  session: vi.fn().mockReturnThis(),
  lean: vi.fn().mockResolvedValue(value),
});

function fixture(options?: {
  global?: Record<string, unknown> | null;
  override?: Record<string, unknown> | null;
  enabled?: boolean;
  user?: { emailVerified?: boolean } | null;
}) {
  const policies = {
    findById: vi.fn(() => query(options?.global ?? null)),
  };
  const overrides = {
    findOne: vi.fn(() => query(options?.override ?? null)),
  };
  return new AccountPolicyService(
    policies as never,
    overrides as never,
    {} as never,
    {
      findById: vi.fn(() =>
        query(
          options?.user === undefined ? { emailVerified: true } : options.user,
        ),
      ),
    } as never,
    {} as never,
    new ConfigService({ AUDIO_PROCESSING_ENABLED: options?.enabled ?? true }),
  );
}

describe('account policy', () => {
  it('publishes the accepted standard defaults without inserting a document', async () => {
    await expect(fixture().current()).resolves.toMatchObject({
      plan: 'standard',
      revision: 0,
      values: DEFAULT_ACCOUNT_POLICY_VALUES,
      enforcedFeatures: [
        'processing_minutes',
        'media_limits',
        'upload_limits',
        'download_limits',
        'retained_storage',
        'service_outbound',
      ],
      updatedBy: 'system',
    });
  });

  it('validates the complete policy and cross-field cost boundaries', () => {
    expect(() =>
      validateAccountPolicyValues(DEFAULT_ACCOUNT_POLICY_VALUES),
    ).not.toThrow();
    expect(() =>
      validateAccountPolicyValues({
        ...DEFAULT_ACCOUNT_POLICY_VALUES,
        monthlyProcessingSeconds: 0,
      }),
    ).toThrow();
    expect(() =>
      validateAccountPolicyValues({
        ...DEFAULT_ACCOUNT_POLICY_VALUES,
        signedUrlTtlSeconds: 601,
      }),
    ).toThrow();
    expect(() =>
      validateAccountPolicyValues({
        ...DEFAULT_ACCOUNT_POLICY_VALUES,
        dailyUploadGrants: 1_001,
      }),
    ).toThrow();
    expect(() =>
      validateAccountPolicyValues({
        ...DEFAULT_ACCOUNT_POLICY_VALUES,
        monthlyEstimatedDownloadBytes: 500_000_000_001,
      }),
    ).toThrow();
  });

  it('uses one active account override and ignores it at the exact expiry', async () => {
    const now = new Date('2026-09-19T12:00:00.000Z');
    const global = {
      _id: 'standard',
      revision: 3,
      acceptNewJobs: true,
      maintenanceMessageEn: '',
      maintenanceMessageAr: null,
      ...DEFAULT_ACCOUNT_POLICY_VALUES,
      updatedBy: 'admin',
      updatedAt: new Date('2026-09-18T00:00:00.000Z'),
    };
    const active = fixture({
      global,
      override: {
        revision: 2,
        monthlyProcessingSeconds: 14_400,
        monthlyUploadGrants: 300,
        monthlyEstimatedDownloadBytes: 12_000_000_000,
        maxRetainedOutputBytes: 2_000_000_000,
        expiresAt: new Date(now.getTime() + 1),
      },
    });
    await expect(
      active.effective(new Types.ObjectId(), now),
    ).resolves.toMatchObject({
      source: 'account_override',
      overrideRevision: 2,
      values: {
        monthlyProcessingSeconds: 14_400,
        monthlyUploadGrants: 300,
        monthlyEstimatedDownloadBytes: 12_000_000_000,
        maxRetainedOutputBytes: 2_000_000_000,
        signedUrlTtlSeconds: 600,
      },
    });
    const expired = fixture({
      global,
      override: {
        revision: 2,
        monthlyProcessingSeconds: 14_400,
        expiresAt: now,
      },
    });
    await expect(
      expired.effective(new Types.ObjectId(), now),
    ).resolves.toMatchObject({
      source: 'global',
      overrideRevision: null,
      values: { monthlyProcessingSeconds: 36_000 },
    });
  });

  it('exposes expanded media limits only to opted-in clients', async () => {
    await expect(fixture().publicPolicy('2', '2')).resolves.toMatchObject({
      limits: { maxDurationSeconds: 1800, maxPreparedAudioBytes: 100_000_000 },
    });
    await expect(fixture().publicPolicy('2', '3')).rejects.toThrow();
  });

  it.each([false, undefined])(
    'limits accounts without verified email (%s) to one fifth of account quotas',
    async (emailVerified) => {
      const policy = await fixture({ user: { emailVerified } }).effective(
        new Types.ObjectId(),
      );
      expect(policy.values).toEqual({
        ...DEFAULT_ACCOUNT_POLICY_VALUES,
        monthlyProcessingSeconds: 7_200,
        dailyUploadGrants: 20,
        monthlyUploadGrants: 200,
        monthlyConfirmedUploadBytes: 1_000_000_000,
        monthlyDownloadGrants: 200,
        monthlyEstimatedDownloadBytes: 10_000_000_000,
        maxRetainedOutputBytes: 1_000_000_000,
      });
      expect(policy.source).toBe('global');
      await expect(
        fixture({ user: { emailVerified } }).current(),
      ).resolves.toMatchObject({
        values: DEFAULT_ACCOUNT_POLICY_VALUES,
      });
    },
  );

  it('reduces active overrides after resolution and rounds quotas down, including to zero', async () => {
    const now = new Date('2026-09-30T12:00:00.000Z');
    const override = {
      revision: 2,
      monthlyProcessingSeconds: 103,
      dailyUploadGrants: 4,
      monthlyUploadGrants: 11,
      monthlyConfirmedUploadBytes: 109,
      monthlyDownloadGrants: 12,
      monthlyEstimatedDownloadBytes: 114,
      maxRetainedOutputBytes: 119,
      expiresAt: new Date(now.getTime() + 1),
    };
    const unverified = fixture({ override, user: { emailVerified: false } });
    await expect(
      unverified.effective(new Types.ObjectId(), now),
    ).resolves.toMatchObject({
      source: 'account_override',
      overrideRevision: 2,
      overrideExpiresAt: override.expiresAt,
      values: {
        monthlyProcessingSeconds: 20,
        dailyUploadGrants: 0,
        monthlyUploadGrants: 2,
        monthlyConfirmedUploadBytes: 21,
        monthlyDownloadGrants: 2,
        monthlyEstimatedDownloadBytes: 22,
        maxRetainedOutputBytes: 23,
      },
    });
    await expect(
      fixture({ override }).effective(new Types.ObjectId(), now),
    ).resolves.toMatchObject({
      values: { monthlyProcessingSeconds: 103, dailyUploadGrants: 4 },
    });
    await expect(
      unverified.effective(new Types.ObjectId(), override.expiresAt),
    ).resolves.toMatchObject({
      source: 'global',
      overrideRevision: null,
      values: { monthlyProcessingSeconds: 7_200, dailyUploadGrants: 20 },
    });
  });

  it('reads verification within the admission transaction and fails closed for a missing account', async () => {
    const accountId = new Types.ObjectId();
    const userQuery = query({ emailVerified: false });
    const service = fixture();
    const findById = vi.fn(() => userQuery);
    Object.assign(service, { users: { findById } });
    const session = {} as never;
    await service.effective(accountId, new Date(), session);
    expect(findById).toHaveBeenCalledWith(accountId);
    expect(userQuery.select).toHaveBeenCalledWith('emailVerified');
    expect(userQuery.session).toHaveBeenCalledWith(session);
    await expect(
      fixture({ user: null }).effective(accountId),
    ).rejects.toMatchObject({
      response: { code: 'PROCESSING_UNAVAILABLE' },
    });
  });

  it('fails the public admission gate closed while keeping safe limits visible', async () => {
    await expect(
      fixture({ enabled: false }).publicPolicy('2'),
    ).resolves.toMatchObject({
      schemaVersion: 2,
      acceptNewJobs: false,
      limits: {
        maxDurationSeconds: 1_200,
        maxPreparedAudioBytes: 50_000_000,
      },
    });
  });
});

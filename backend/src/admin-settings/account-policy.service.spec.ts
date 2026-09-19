import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { DEFAULT_ACCOUNT_POLICY_VALUES } from './account-policy.schema.js';
import {
  AccountPolicyService,
  validateAccountPolicyValues,
} from './account-policy.service.js';

const query = <T>(value: T) => ({
  session: vi.fn().mockReturnThis(),
  lean: vi.fn().mockResolvedValue(value),
});

function fixture(options?: {
  global?: Record<string, unknown> | null;
  override?: Record<string, unknown> | null;
  enabled?: boolean;
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
    {} as never,
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
      enforcedFeatures: ['processing_minutes'],
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
        dailyUploadGrants: 201,
      }),
    ).toThrow();
    expect(() =>
      validateAccountPolicyValues({
        ...DEFAULT_ACCOUNT_POLICY_VALUES,
        monthlyEstimatedDownloadBytes: 80_000_000_001,
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
        expiresAt: new Date(now.getTime() + 1),
      },
    });
    await expect(
      active.effective(new Types.ObjectId(), now),
    ).resolves.toMatchObject({
      source: 'account_override',
      overrideRevision: 2,
      values: { monthlyProcessingSeconds: 14_400 },
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
      values: { monthlyProcessingSeconds: 7_200 },
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

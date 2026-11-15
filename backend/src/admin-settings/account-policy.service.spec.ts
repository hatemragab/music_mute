import { ConfigService } from '@nestjs/config';
import { mongo, Types, trusted } from 'mongoose';
import { DEFAULT_ACCOUNT_POLICY_VALUES } from './account-policy.schema.js';
import type { UpdateAccountPolicyDto } from './dto/account-policy.dto.js';
import {
  AccountPolicyService,
  validateAccountPolicyValues,
  linkImportVisibility,
  validateLinkImportVisibility,
} from './account-policy.service.js';

const query = <T>(value: T) => ({
  select: vi.fn().mockReturnThis(),
  session: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  lean: vi.fn().mockResolvedValue(value),
});

function fixture(options?: {
  global?: Record<string, unknown> | null;
  override?: Record<string, unknown> | null;
  enabled?: boolean;
  linkImportEnabled?: boolean;
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
    new ConfigService({
      AUDIO_PROCESSING_ENABLED: options?.enabled ?? true,
      URL_IMPORT_ENABLED: options?.linkImportEnabled ?? false,
    }),
  );
}

const storedPolicy = (fields: Record<string, unknown> = {}) => ({
  ...DEFAULT_ACCOUNT_POLICY_VALUES,
  revision: 1,
  acceptNewJobs: true,
  maintenanceMessageEn: '',
  maintenanceMessageAr: null,
  updatedBy: 'admin',
  updatedAt: new Date(),
  linkImportEnabled: true,
  linkImportDisabledCountries: [],
  ...fields,
});

function updateFixture(currentUserIds: string[], existingUserIds: string[]) {
  let stored = storedPolicy({ linkImportDisabledUserIds: currentUserIds });
  const service = fixture({ global: stored, linkImportEnabled: true });
  const session = {} as never;
  const userQuery = query(
    existingUserIds.map((id) => ({ _id: new Types.ObjectId(id) })),
  );
  const find = vi.fn(() => userQuery);
  const run = vi.fn(
    async (
      _actor: unknown,
      _operation: unknown,
      mutation: (session: never) => Promise<{ processingChanges: unknown[] }>,
    ) => mutation(session),
  );
  Object.assign(service, {
    policies: {
      findById: vi.fn(() => query(stored)),
      findOneAndUpdate: vi.fn((_filter: unknown, update: { $set: object }) => {
        stored = { ...stored, ...update.$set, revision: stored.revision + 1 };
        return query(stored);
      }),
    },
    users: { find },
    fences: { updateOne: vi.fn(async () => ({ acknowledged: true })) },
    operations: { run },
  });
  const command: UpdateAccountPolicyDto = {
    ...DEFAULT_ACCOUNT_POLICY_VALUES,
    acceptNewJobs: true,
    maintenanceMessageEn: '',
    maintenanceMessageAr: null,
    expectedRevision: 1,
    operationId: '12345678-1234-4123-8123-123456789012',
    reason: 'Reviewed user visibility',
  };
  return { service, session, userQuery, find, run, command };
}

describe('account policy', () => {
  it('reads legacy fields as hidden without changing processing admission', async () => {
    await expect(fixture().publicPolicy()).resolves.toMatchObject({
      linkImportEnabled: false,
      linkImportDisabledCountries: [],
      visitorCountry: null,
      linkImportVisible: false,
      linkImportReason: 'globally_hidden',
      linkImportPolicyRevision: 0,
      acceptNewJobs: true,
    });
    await expect(fixture().current()).resolves.toMatchObject({
      linkImportEnabled: false,
      linkImportDisabledCountries: [],
      linkImportDisabledUserIds: [],
      linkImportForcedOff: true,
    });
  });

  it.each([
    [false, false, [], 'EG', 'globally_hidden'],
    [true, true, [], 'US', 'globally_hidden'],
    [true, false, [], null, 'allowed'],
    [true, false, ['EG'], 'EG', 'country_hidden'],
    [true, false, ['EG'], 'US', 'allowed'],
    ...['XX', 'T1', '', 'ZZ', null].map((country) => [
      true,
      false,
      ['EG'],
      country,
      'unknown_country',
    ]),
  ])(
    'evaluates native visibility (%j %j %j %j)',
    (enabled, forcedOff, codes, country, reason) => {
      const result = linkImportVisibility(
        {
          linkImportEnabled: enabled as boolean,
          linkImportDisabledCountries: codes as string[],
          revision: 9,
        },
        forcedOff as boolean,
        country as string | null,
      );
      expect(result.linkImportReason).toBe(reason);
      expect(result.linkImportVisible).toBe(reason === 'allowed');
      expect(result.linkImportPolicyRevision).toBe(9);
    },
  );

  it.each(
    [
      ['XX'],
      ['T1'],
      ['ZZ'],
      ['eg'],
      ['EG', 'EG'],
      Array.from({ length: 251 }, () => 'EG'),
    ].map((codes) => [codes]),
  )('rejects invalid admin country lists %j', (codes) => {
    expect(() =>
      validateLinkImportVisibility({
        linkImportEnabled: true,
        linkImportDisabledCountries: codes,
      }),
    ).toThrow();
  });

  const selectedUser = '000000000000000000000001';
  const otherUser = '000000000000000000000002';

  it.each([
    [false, false, 'US', selectedUser, 'globally_hidden'],
    [true, true, 'US', selectedUser, 'globally_hidden'],
    [true, false, 'US', selectedUser, 'user_hidden'],
    [true, false, null, selectedUser, 'user_hidden'],
    [true, false, 'EG', selectedUser, 'user_hidden'],
    [true, false, 'US', otherUser, 'allowed'],
    [true, false, 'EG', otherUser, 'country_hidden'],
    [true, false, 'US', null, 'allowed'],
  ])(
    'uses global, selected-user and country precedence (%j %j %j %j)',
    (enabled, forcedOff, country, accountId, reason) => {
      const result = linkImportVisibility(
        {
          linkImportEnabled: enabled as boolean,
          linkImportDisabledCountries: ['EG'],
          linkImportDisabledUserIds: [selectedUser],
          revision: 3,
        },
        forcedOff as boolean,
        country as string | null,
        accountId as string | null,
      );
      expect(result.linkImportReason).toBe(reason);
      expect(result.linkImportVisible).toBe(reason === 'allowed');
      expect(result).not.toHaveProperty('linkImportDisabledUserIds');
    },
  );

  it.each([
    [null],
    [[selectedUser, selectedUser]],
    [['ABCDEFABCDEFABCDEFABCDEF']],
    [['not-an-account']],
    [[`${selectedUser}\n`]],
    [[123]],
    [Array.from({ length: 1001 }, (_, i) => i.toString(16).padStart(24, '0'))],
  ])('rejects invalid user exclusions %j', (userIds) => {
    expect(() =>
      validateLinkImportVisibility({
        linkImportEnabled: true,
        linkImportDisabledCountries: [],
        linkImportDisabledUserIds: userIds as string[],
      }),
    ).toThrow();
  });

  it('keeps selected IDs private and evaluates signed-in users independently from guests', async () => {
    const service = fixture({
      global: storedPolicy({ linkImportDisabledUserIds: [selectedUser] }),
      linkImportEnabled: true,
    });
    const hidden = await service.publicPolicy('2', '1', 'US', selectedUser);
    expect(hidden).toMatchObject({
      linkImportVisible: false,
      linkImportReason: 'user_hidden',
      acceptNewJobs: true,
    });
    expect(hidden).not.toHaveProperty('linkImportDisabledUserIds');
    expect(JSON.stringify(hidden)).not.toContain(selectedUser);
    await expect(
      service.publicPolicy('2', '1', 'US', otherUser),
    ).resolves.toMatchObject({ linkImportVisible: true });
    await expect(service.publicPolicy('2', '1', 'US')).resolves.toMatchObject({
      linkImportVisible: true,
    });
    await expect(service.current()).resolves.toMatchObject({
      linkImportDisabledUserIds: [selectedUser],
    });
  });

  it.each([null, [`${selectedUser}\n`]])(
    'fails closed for malformed stored exclusions %j',
    async (userIds) => {
      await expect(
        fixture({
          global: storedPolicy({ linkImportDisabledUserIds: userIds }),
        }).current(),
      ).rejects.toMatchObject({ response: { code: 'DEPENDENCY_UNAVAILABLE' } });
    },
  );

  it('validates only new selections in the policy transaction and records sorted IDs in the same audit', async () => {
    const f = updateFixture([otherUser], [selectedUser]);
    const result = await f.service.update({ uid: 'admin' } as never, {
      ...f.command,
      linkImportDisabledUserIds: [otherUser, selectedUser],
    });
    expect(result.linkImportDisabledUserIds).toEqual([selectedUser, otherUser]);
    expect(f.find).toHaveBeenCalledWith({
      _id: trusted({ $in: [new Types.ObjectId(selectedUser)] }),
    });
    expect(f.userQuery.select).toHaveBeenCalledWith('_id');
    expect(f.userQuery.limit).toHaveBeenCalledWith(1);
    expect(f.userQuery.session).toHaveBeenCalledWith(f.session);
    const mutationResult = await f.run.mock.results[0].value;
    expect(mutationResult.processingChanges).toContainEqual({
      field: 'linkImportDisabledUserIds',
      before: otherUser,
      after: `${selectedUser},${otherUser}`,
    });
  });

  it('rejects nonexistent selections before persisting a policy', async () => {
    const f = updateFixture([], []);
    await expect(
      f.service.update({ uid: 'admin' } as never, {
        ...f.command,
        linkImportDisabledUserIds: [selectedUser],
      }),
    ).rejects.toMatchObject({ response: { code: 'RESOURCE_NOT_FOUND' } });
    await expect(f.service.current()).resolves.toMatchObject({ revision: 1 });
  });

  it('preserves omitted exclusions on legacy writes and can remove a previously deleted user', async () => {
    const legacy = updateFixture([selectedUser], []);
    await expect(
      legacy.service.update({ uid: 'admin' } as never, legacy.command),
    ).resolves.toMatchObject({ linkImportDisabledUserIds: [selectedUser] });
    expect(legacy.find).not.toHaveBeenCalled();
    const cleared = updateFixture([selectedUser], []);
    await expect(
      cleared.service.update({ uid: 'admin' } as never, {
        ...cleared.command,
        linkImportDisabledUserIds: [],
      }),
    ).resolves.toMatchObject({ linkImportDisabledUserIds: [] });
    expect(cleared.find).not.toHaveBeenCalled();
    await expect(
      cleared.service.publicPolicy('2', '1', 'US', selectedUser),
    ).resolves.toMatchObject({ linkImportVisible: true });
  });

  it('uses the actual request country and leaves media limits and admission intact', async () => {
    const global = {
      ...DEFAULT_ACCOUNT_POLICY_VALUES,
      revision: 5,
      acceptNewJobs: true,
      maintenanceMessageEn: '',
      maintenanceMessageAr: null,
      updatedBy: 'admin',
      updatedAt: new Date(),
      linkImportEnabled: true,
      linkImportDisabledCountries: ['US', 'EG'],
    };
    const service = fixture({ global, linkImportEnabled: true });
    await expect(service.publicPolicy('2', '1', 'EG')).resolves.toMatchObject({
      linkImportVisible: false,
      linkImportReason: 'country_hidden',
      visitorCountry: 'EG',
      linkImportDisabledCountries: ['EG', 'US'],
      acceptNewJobs: true,
    });
    await expect(service.publicPolicy('2', '1', 'GB')).resolves.toMatchObject({
      linkImportVisible: true,
    });
  });
  it('preserves the exact MongoDB query error and retry labels inside a session', async () => {
    const error = new mongo.MongoServerError({
      message: 'Synthetic write conflict',
      code: 112,
    });
    error.addErrorLabel('TransientTransactionError');
    const policyQuery = query(null);
    policyQuery.lean.mockRejectedValue(error);
    const service = fixture();
    Object.assign(service, {
      policies: { findById: vi.fn(() => policyQuery) },
    });
    const session = {} as never;
    await expect(service.global(session)).rejects.toBe(error);
    expect(policyQuery.session).toHaveBeenCalledWith(session);
    expect(error.hasErrorLabel('TransientTransactionError')).toBe(true);
  });

  it('sanitizes database query failures outside a session', async () => {
    const error = new mongo.MongoServerError({
      message: 'Synthetic database failure',
      code: 112,
    });
    error.addErrorLabel('TransientTransactionError');
    const policyQuery = query(null);
    policyQuery.lean.mockRejectedValue(error);
    const service = fixture();
    Object.assign(service, {
      policies: { findById: vi.fn(() => policyQuery) },
    });
    await expect(service.global()).rejects.toMatchObject({
      response: {
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'Service unavailable',
      },
    });
    expect(policyQuery.session).not.toHaveBeenCalled();
  });

  it.each([undefined, {} as never])(
    'sanitizes malformed stored policy independently of transaction query errors (%s)',
    async (session) => {
      const service = fixture({
        global: {
          ...DEFAULT_ACCOUNT_POLICY_VALUES,
          revision: 1,
          acceptNewJobs: true,
          maintenanceMessageEn: '',
          maintenanceMessageAr: null,
          updatedBy: 'system',
          updatedAt: new Date(),
          monthlyProcessingSeconds: 0,
        },
      });
      await expect(service.global(session)).rejects.toMatchObject({
        response: {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'Service unavailable',
        },
      });
    },
  );

  it('publishes the accepted standard defaults without inserting a document', async () => {
    await expect(fixture().current()).resolves.toMatchObject({
      plan: 'standard',
      revision: 0,
      values: {
        ...DEFAULT_ACCOUNT_POLICY_VALUES,
        maxInfrastructureAttempts: 4,
      },
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

  it('retains a saved three-attempt policy after the default increases', async () => {
    const service = fixture({
      global: {
        _id: 'standard',
        revision: 9,
        acceptNewJobs: true,
        maintenanceMessageEn: '',
        maintenanceMessageAr: null,
        ...DEFAULT_ACCOUNT_POLICY_VALUES,
        maxInfrastructureAttempts: 3,
        updatedBy: 'admin',
        updatedAt: new Date('2026-09-30T00:00:00.000Z'),
      },
    });
    await expect(service.current()).resolves.toMatchObject({
      revision: 9,
      values: { maxInfrastructureAttempts: 3 },
    });
    await expect(
      service.effective(new Types.ObjectId()),
    ).resolves.toMatchObject({
      globalRevision: 9,
      values: { maxInfrastructureAttempts: 3 },
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

import { mongo, Query, Types } from 'mongoose';
import { ProcessingUsageService } from './processing-usage.service.js';
import type { Job } from '../jobs/job.schema.js';
import type { EffectiveAccountPolicy } from '../admin-settings/account-policy.service.js';
import { DEFAULT_ACCOUNT_POLICY_VALUES } from '../admin-settings/account-policy.schema.js';

const session = { inTransaction: () => true };
const userId = new Types.ObjectId('64b000000000000000000002');
const jobId = new Types.ObjectId('64b000000000000000000001');
const original = {
  key: `shared/url/${'a'.repeat(64)}/c9107c58-bf4a-493f-8079-4bfbcf9bbb06/input/source.mp3`,
  etag: '"original"',
  bytes: 2_048,
  sha256: Buffer.alloc(32, 2).toString('base64'),
  contentType: 'audio/mpeg',
};
const output = {
  ...original,
  key: original.key.replace('/input/source.mp3', '/output/voice.mp3'),
  etag: '"voice"',
  bytes: 1_024,
};
const job = { _id: jobId, userId, inputObject: original, outputObject: output };

function writeFixture() {
  const now = new Date('2026-10-04T00:00:00.000Z');
  const policy: EffectiveAccountPolicy = {
    plan: 'standard',
    globalRevision: 7,
    overrideRevision: null,
    source: 'global',
    overrideExpiresAt: null,
    acceptNewJobs: true,
    maintenanceMessageEn: '',
    maintenanceMessageAr: null,
    values: {
      ...DEFAULT_ACCOUNT_POLICY_VALUES,
      maxDurationSeconds: 60,
      monthlyProcessingSeconds: 100,
      signedUrlTtlSeconds: 90,
      dailyUploadGrants: 3,
      monthlyUploadGrants: 5,
      monthlyConfirmedUploadBytes: 4_000,
      maxRetainedOutputBytes: 5_000,
    },
  };
  function query<T>(value: T) {
    const result = new Query<T, never>();
    vi.spyOn(result, 'exec').mockImplementation(async () => value);
    return result;
  }
  const periods = {
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    findOneAndUpdate: vi.fn().mockImplementation(() => query({})),
  };
  const dailyPeriods = {
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    findOneAndUpdate: vi.fn().mockImplementation(() => query({})),
  };
  const reservations = {
    findById: vi.fn().mockImplementation(() => query(null)),
    create: vi.fn(async ([value]) => [value]),
  };
  const uploadGrants = {
    findById: vi.fn().mockImplementation(() => query(null)),
    create: vi.fn(async ([value]) => [{ toObject: () => value }]),
  };
  const jobs = {
    findOneAndUpdate: vi
      .fn()
      .mockImplementation(() => query({ uploadAttemptCount: 1 })),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    findById: vi.fn(),
  };
  const users = { updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }) };
  const policies = { effective: vi.fn().mockResolvedValue(policy) };
  const uploadJob = {
    ...job,
    inputObject: null,
    logicalAudioId: jobId,
    admissionSnapshot: {
      policyVersion: 2,
      maxDurationSeconds: 60,
      maxInputBytes: 100_000_000,
      preparationProfileId: 'audio-cap-aac-lc-160-v1',
      source: 'youtube',
      settingsRevision: 7,
      maxWaitingJobs: 20,
      maxProcessingJobs: 1,
      maxInfrastructureAttempts: 4,
      maxClientInputAttempts: 5,
      reservationExpiresAt: new Date(now.getTime() + 600_000),
    } satisfies NonNullable<Job['admissionSnapshot']>,
  };
  return {
    service: new ProcessingUsageService(
      periods as never,
      dailyPeriods as never,
      reservations as never,
      uploadGrants as never,
      {} as never,
      {} as never,
      jobs as never,
      users as never,
      policies as never,
    ),
    now,
    policy,
    query,
    periods,
    dailyPeriods,
    reservations,
    uploadGrants,
    jobs,
    users,
    policies,
    uploadJob,
  };
}

function fixture() {
  const counters = {
    updateOne: vi.fn(),
    create: vi.fn(),
  };
  const jobs = {
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    findById: vi.fn(),
  };
  const users = {
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const policies = {
    effective: vi
      .fn()
      .mockResolvedValue({ values: { maxRetainedOutputBytes: 5_000 } }),
  };
  return {
    service: new ProcessingUsageService(
      counters as never,
      counters as never,
      counters as never,
      counters as never,
      counters as never,
      counters as never,
      jobs as never,
      users as never,
      policies as never,
    ),
    jobs,
    users,
    policies,
    counters,
  };
}

function usageFixture(monthlyError?: Error) {
  const events: string[] = [];
  let activeReads = 0;
  let maxActiveReads = 0;
  function read<T>(name: string, value: T, error?: Error) {
    return async () => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      events.push(`${name}:start`);
      await Promise.resolve();
      events.push(`${name}:end`);
      activeReads -= 1;
      if (error) throw error;
      return value;
    };
  }
  function lazyQuery<T>(execute: () => Promise<T>) {
    const query = new Query<T, never>();
    vi.spyOn(query, 'exec').mockImplementation(execute);
    vi.spyOn(query, 'session');
    vi.spyOn(query, 'maxTimeMS');
    vi.spyOn(query, 'lean');
    return query;
  }
  const userQuery = lazyQuery(read('user', { retainedOutputBytes: 50 }));
  const monthlyQuery = lazyQuery(read('monthly', null, monthlyError));
  const dailyQuery = lazyQuery(read('daily', null));
  const waitingQuery = lazyQuery(read('waiting', 2));
  const processingQuery = lazyQuery(read('processing', 1));
  const policies = {
    effective: vi.fn(
      read('policy', {
        plan: 'standard',
        globalRevision: 0,
        overrideRevision: null,
        source: 'global',
        overrideExpiresAt: null,
        acceptNewJobs: true,
        values: DEFAULT_ACCOUNT_POLICY_VALUES,
      }),
    ),
  };
  return {
    service: new ProcessingUsageService(
      { findById: vi.fn(() => monthlyQuery) } as never,
      { findById: vi.fn(() => dailyQuery) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        countDocuments: vi
          .fn()
          .mockReturnValueOnce(waitingQuery)
          .mockReturnValueOnce(processingQuery),
      } as never,
      { findById: vi.fn(() => userQuery) } as never,
      policies as never,
    ),
    events,
    maxActiveReads: () => maxActiveReads,
    queries: [
      userQuery,
      monthlyQuery,
      dailyQuery,
      waitingQuery,
      processingQuery,
    ],
    dailyQuery,
    policies,
  };
}

describe('processing usage reads', () => {
  it('executes reads sequentially on the same admission session', async () => {
    const f = usageFixture();
    const now = new Date('2026-10-04T00:00:00.000Z');
    await expect(
      f.service.readUsage(userId, session as never, now),
    ).resolves.toMatchObject({
      waitingJobs: 2,
      processingJobs: 1,
      availability: { status: 'available', reason: null },
    });
    expect(f.maxActiveReads()).toBe(1);
    expect(f.events).toEqual(
      ['user', 'policy', 'monthly', 'daily', 'waiting', 'processing'].flatMap(
        (name) => [`${name}:start`, `${name}:end`],
      ),
    );
    for (const query of f.queries)
      expect(query.session).toHaveBeenCalledWith(session);
    expect(f.policies.effective).toHaveBeenCalledWith(userId, now, session);
  });

  it('keeps independent nontransaction reads parallel', async () => {
    const f = usageFixture();
    await expect(f.service.readUsage(userId)).resolves.toMatchObject({
      waitingJobs: 2,
      processingJobs: 1,
    });
    expect(f.maxActiveReads()).toBe(2);
    expect(f.events).toContain('daily:start');
    expect(f.events.indexOf('daily:start')).toBeLessThan(
      f.events.indexOf('monthly:end'),
    );
    expect(f.events.indexOf('processing:start')).toBeLessThan(
      f.events.indexOf('waiting:end'),
    );
  });

  it('preserves a transaction query failure without starting another session read', async () => {
    const error = new mongo.MongoServerError({
      message: 'Synthetic write conflict',
      code: 112,
    });
    error.addErrorLabel('TransientTransactionError');
    const f = usageFixture(error);
    await expect(f.service.readUsage(userId, session as never)).rejects.toBe(
      error,
    );
    expect(f.dailyQuery.lean).not.toHaveBeenCalled();
    expect(f.events).not.toContain('waiting:start');
    expect(f.events).not.toContain('processing:start');
  });
});

describe('transaction-local admission policy accounting', () => {
  const requestId = 'f4b4d60c-5ee4-46d9-a5af-bf32d78e805d';

  it('accounts a fresh source using the fenced policy without repeating policy reads', async () => {
    const f = writeFixture();
    f.policies.effective.mockRejectedValue(new Error('Duplicate policy read'));
    await f.service.reserveForJob(
      jobId,
      userId,
      30,
      session as never,
      f.now,
      f.policy,
    );
    const receipt = await f.service.reserveUploadGrant(
      f.uploadJob,
      requestId,
      session as never,
      f.now,
      f.policy,
    );
    await f.service.confirmUploadBytes(
      f.uploadJob,
      original.bytes,
      session as never,
      f.now,
      f.policy,
    );
    expect(f.policies.effective).not.toHaveBeenCalled();
    expect(receipt.expiresAt).toEqual(new Date(f.now.getTime() + 90_000));
    expect(f.reservations.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          _id: jobId,
          accountId: userId,
          globalPolicyRevision: 7,
          acceptedLimitSeconds: 100,
        }),
      ],
      { session },
    );
    expect(f.periods.findOneAndUpdate.mock.calls[0]![0].$expr.$lt[1]).toBe(100);
    expect(
      f.dailyPeriods.findOneAndUpdate.mock.calls[0]![0].uploadGrants,
    ).toEqual({ $lt: 3 });
    expect(f.periods.findOneAndUpdate.mock.calls[1]![0].uploadGrants).toEqual({
      $lt: 5,
    });
    expect(f.periods.updateOne.mock.calls.at(-1)![0].$expr.$lte).toEqual([
      { $add: ['$confirmedUploadBytes', original.bytes] },
      4_000,
    ]);
  });

  it('preserves existing callers by resolving policy separately when none is supplied', async () => {
    const f = writeFixture();
    await f.service.reserveForJob(jobId, userId, 30, session as never, f.now);
    await f.service.reserveUploadGrant(
      f.uploadJob,
      requestId,
      session as never,
      f.now,
    );
    await f.service.confirmUploadBytes(
      f.uploadJob,
      original.bytes,
      session as never,
      f.now,
    );
    await f.service.recordRetainedCachedMedia(job, session as never, f.now);
    expect(f.policies.effective).toHaveBeenCalledTimes(4);
    for (const call of f.policies.effective.mock.calls)
      expect(call).toEqual([userId, f.now, session]);
  });

  it('keeps duration and monthly allowance enforcement with a supplied policy', async () => {
    const f = writeFixture();
    await expect(
      f.service.reserveForJob(
        jobId,
        userId,
        61,
        session as never,
        f.now,
        f.policy,
      ),
    ).rejects.toMatchObject({ response: { code: 'MEDIA_TOO_LONG' } });
    expect(f.periods.updateOne).not.toHaveBeenCalled();
    f.periods.findOneAndUpdate.mockReturnValueOnce(f.query(null));
    await expect(
      f.service.reserveForJob(
        jobId,
        userId,
        30,
        session as never,
        f.now,
        f.policy,
      ),
    ).rejects.toMatchObject({
      response: { code: 'PROCESSING_ALLOWANCE_EXHAUSTED' },
    });
    expect(f.reservations.create).not.toHaveBeenCalled();
    expect(f.policies.effective).not.toHaveBeenCalled();
  });

  it.each(['daily', 'monthly'] as const)(
    'retains the atomic %s upload grant limit when reusing policy',
    async (limit) => {
      const f = writeFixture();
      const model = limit === 'daily' ? f.dailyPeriods : f.periods;
      model.findOneAndUpdate.mockReturnValueOnce(f.query(null));
      await expect(
        f.service.reserveUploadGrant(
          f.uploadJob,
          requestId,
          session as never,
          f.now,
          f.policy,
        ),
      ).rejects.toMatchObject({
        response: { code: 'UPLOAD_GRANT_LIMIT_REACHED' },
      });
      expect(f.uploadGrants.create).not.toHaveBeenCalled();
      expect(f.policies.effective).not.toHaveBeenCalled();
    },
  );

  it('retains the atomic byte ceiling and does not charge an already confirmed upload twice', async () => {
    const f = writeFixture();
    f.periods.updateOne
      .mockResolvedValueOnce({ modifiedCount: 1 })
      .mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(
      f.service.confirmUploadBytes(
        f.uploadJob,
        original.bytes,
        session as never,
        f.now,
        f.policy,
      ),
    ).rejects.toMatchObject({
      response: { code: 'UPLOAD_BYTE_LIMIT_REACHED' },
    });
    f.jobs.updateOne.mockResolvedValue({ modifiedCount: 0 });
    f.jobs.findById.mockReturnValue(
      f.query({
        ...f.uploadJob,
        confirmedUploadBytes: original.bytes,
        confirmedUploadPeriodKey: '2026-10',
      }),
    );
    const previousWrites = f.periods.updateOne.mock.calls.length;
    await f.service.confirmUploadBytes(
      f.uploadJob,
      original.bytes,
      session as never,
      f.now,
      f.policy,
    );
    expect(f.periods.updateOne).toHaveBeenCalledTimes(previousWrites);
    expect(f.policies.effective).not.toHaveBeenCalled();
  });

  it('uses the supplied cached-media ceiling while retaining the active-account receipt guard', async () => {
    const f = writeFixture();
    await f.service.recordRetainedCachedMedia(
      job,
      session as never,
      f.now,
      f.policy,
    );
    expect(f.users.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: userId,
        status: 'active',
        $expr: expect.objectContaining({
          $lte: [
            { $add: [{ $ifNull: ['$retainedOutputBytes', 0] }, 3_072] },
            5_000,
          ],
        }),
      }),
      { $inc: { retainedOutputBytes: 3_072 } },
      { session, runValidators: true },
    );
    f.users.updateOne.mockResolvedValue({ modifiedCount: 0 });
    await expect(
      f.service.recordRetainedCachedMedia(
        job,
        session as never,
        f.now,
        f.policy,
      ),
    ).rejects.toMatchObject({
      response: { code: 'RETAINED_STORAGE_LIMIT_REACHED' },
    });
    expect(f.policies.effective).not.toHaveBeenCalled();
  });

  it('requires a transaction even when a caller supplies a fenced policy', async () => {
    const f = writeFixture();
    const outside = { inTransaction: () => false } as never;
    for (const operation of [
      () =>
        f.service.reserveForJob(jobId, userId, 30, outside, f.now, f.policy),
      () =>
        f.service.reserveUploadGrant(
          f.uploadJob,
          requestId,
          outside,
          f.now,
          f.policy,
        ),
      () =>
        f.service.confirmUploadBytes(
          f.uploadJob,
          original.bytes,
          outside,
          f.now,
          f.policy,
        ),
      () => f.service.recordRetainedCachedMedia(job, outside, f.now, f.policy),
    ])
      await expect(operation()).rejects.toThrow(
        'Usage accounting requires a transaction',
      );
    expect(f.jobs.updateOne).not.toHaveBeenCalled();
    expect(f.periods.updateOne).not.toHaveBeenCalled();
    expect(f.users.updateOne).not.toHaveBeenCalled();
  });
});

describe('shared retained-media accounting', () => {
  it('claims an existing job receipt and charges logical original plus voice bytes atomically', async () => {
    const f = fixture();
    const now = new Date();
    await f.service.recordRetainedCachedMedia(job, session as never, now);
    expect(f.jobs.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: jobId,
        userId,
        status: 'ready',
        deletedAt: null,
        retainedOutputAccountedAt: null,
        retainedOutputReleasedAt: null,
        'inputObject.key': original.key,
        'outputObject.key': output.key,
      }),
      { $set: { retainedOutputAccountedAt: now, retainedInputBytes: 2_048 } },
      { session, runValidators: true },
    );
    expect(f.users.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: userId,
        status: 'active',
        $expr: expect.objectContaining({
          $lte: [
            { $add: [{ $ifNull: ['$retainedOutputBytes', 0] }, 3_072] },
            5_000,
          ],
        }),
      }),
      { $inc: { retainedOutputBytes: 3_072 } },
      { session, runValidators: true },
    );
    expect(f.counters.updateOne).not.toHaveBeenCalled();
    expect(f.counters.create).not.toHaveBeenCalled();
  });

  it('does not charge a repeated retained-media receipt twice', async () => {
    const f = fixture();
    f.jobs.updateOne.mockResolvedValue({ modifiedCount: 0 });
    f.jobs.findById.mockReturnValue({
      session: vi.fn(() => ({
        lean: vi.fn().mockResolvedValue({
          ...job,
          status: 'ready',
          deletedAt: null,
          retainedOutputAccountedAt: new Date(),
          retainedInputBytes: original.bytes,
          retainedOutputReleasedAt: null,
        }),
      })),
    });
    await expect(
      f.service.recordRetainedCachedMedia(job, session as never),
    ).resolves.toBeUndefined();
    expect(f.users.updateOne).not.toHaveBeenCalled();
    expect(f.policies.effective).not.toHaveBeenCalled();
  });

  it('rejects a different media identity against an existing receipt', async () => {
    const f = fixture();
    f.jobs.updateOne.mockResolvedValue({ modifiedCount: 0 });
    f.jobs.findById.mockReturnValue({
      session: vi.fn(() => ({
        lean: vi.fn().mockResolvedValue({
          ...job,
          status: 'ready',
          retainedOutputAccountedAt: new Date(),
          retainedInputBytes: original.bytes,
          outputObject: { ...output, bytes: output.bytes + 1 },
        }),
      })),
    });
    await expect(
      f.service.recordRetainedCachedMedia(job, session as never),
    ).rejects.toMatchObject({ response: { code: 'JOB_STATE_CONFLICT' } });
    expect(f.users.updateOne).not.toHaveBeenCalled();
  });

  it('rejects cache retention that crosses the effective storage ceiling', async () => {
    const f = fixture();
    f.users.updateOne.mockResolvedValue({ modifiedCount: 0 });
    await expect(
      f.service.recordRetainedCachedMedia(job, session as never),
    ).rejects.toMatchObject({
      response: { code: 'RETAINED_STORAGE_LIMIT_REACHED' },
    });
    expect(f.counters.updateOne).not.toHaveBeenCalled();
  });

  it('requires the creation transaction before claiming bytes', async () => {
    const f = fixture();
    await expect(
      f.service.recordRetainedCachedMedia(job, {
        inTransaction: () => false,
      } as never),
    ).rejects.toThrow('Usage accounting requires a transaction');
    expect(f.jobs.updateOne).not.toHaveBeenCalled();
    expect(f.users.updateOne).not.toHaveBeenCalled();
  });

  it('releases the same logical original-plus-voice amount after account job cleanup', async () => {
    const f = fixture();
    await f.service.releaseRetainedOutput(
      {
        ...job,
        retainedOutputAccountedAt: new Date(),
        retainedOutputReleasedAt: null,
        retainedInputBytes: original.bytes,
      } as Job,
      session as never,
    );
    expect(f.users.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: userId,
        retainedOutputBytes: expect.objectContaining({ $gte: 3_072 }),
      }),
      { $inc: { retainedOutputBytes: -3_072 } },
      { session, runValidators: true },
    );
  });
});

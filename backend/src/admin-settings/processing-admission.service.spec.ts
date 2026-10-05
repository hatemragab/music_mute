import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { jobError } from '../jobs/job-errors.js';
import { DEFAULT_ACCOUNT_POLICY_VALUES } from './account-policy.schema.js';
import { ProcessingAdmissionService } from './processing-admission.service.js';

const session = { inTransaction: () => true };
const metadata = {
  policyVersion: 2 as const,
  preparationProfileId: 'audio-cap-aac-lc-160-v1',
  source: 'audio_file' as const,
};

function fixture(enabled = true) {
  const countDocuments = vi.fn(() => ({
    session: vi.fn().mockResolvedValue(0),
  }));
  const jobs = { countDocuments, base: { Types } };
  const fences = {
    updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
  };
  const users = {
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const policies = {
    touchGlobalFence: vi.fn().mockResolvedValue(undefined),
    effective: vi.fn().mockResolvedValue({
      globalRevision: 4,
      overrideRevision: null,
      source: 'global',
      acceptNewJobs: true,
      values: DEFAULT_ACCOUNT_POLICY_VALUES,
    }),
  };
  const usage = {
    releaseImport: vi.fn().mockResolvedValue(undefined),
    assertRetainedCapacity: vi.fn().mockResolvedValue(undefined),
    reserveForJob: vi.fn().mockResolvedValue(undefined),
    hasReservedProcessing: vi.fn().mockResolvedValue(true),
  };
  return {
    service: new ProcessingAdmissionService(
      fences as never,
      users as never,
      jobs as never,
      policies as never,
      usage as never,
      new ConfigService({
        AUDIO_PROCESSING_ENABLED: enabled,
        PROCESSING_URL_SECONDS: 600,
      }),
    ),
    fences,
    jobs,
    countDocuments,
    policies,
    users,
    usage,
  };
}

describe('processing admission', () => {
  it('returns the fenced policy for shared fresh and cached accounting', async () => {
    const f = fixture();
    const owner = new Types.ObjectId();
    const fresh = await f.service.assertNewWorkWithPolicy(
      owner,
      { bytes: 1_024, durationSeconds: 30 },
      session as never,
      new Types.ObjectId(),
      metadata,
    );
    expect(fresh.policy).toBe(
      await f.policies.effective.mock.results[0]!.value,
    );
    expect(fresh.admissionSnapshot.settingsRevision).toBe(
      fresh.policy.globalRevision,
    );
    expect(f.usage.reserveForJob.mock.calls[0]![5]).toBe(fresh.policy);
    const cached = await f.service.assertCachedWorkWithPolicy(
      owner,
      { bytes: 1_024, durationSeconds: 30 },
      session as never,
      metadata,
    );
    expect(cached.policy).toBe(
      await f.policies.effective.mock.results[1]!.value,
    );
    expect(f.policies.effective).toHaveBeenCalledTimes(2);
    expect(f.policies.touchGlobalFence).toHaveBeenCalledTimes(2);
    expect(f.usage.reserveForJob).toHaveBeenCalledOnce();
  });

  it('keeps concurrent account policies separate within their own fenced callbacks', async () => {
    const f = fixture();
    const owners = [new Types.ObjectId(), new Types.ObjectId()];
    const policies = [4, 5].map((globalRevision) => ({
      globalRevision,
      overrideRevision: null,
      source: 'global',
      acceptNewJobs: true,
      values: {
        ...DEFAULT_ACCOUNT_POLICY_VALUES,
        maxWaitingJobs: globalRevision,
      },
    }));
    f.policies.effective.mockImplementation(async (owner: Types.ObjectId) => {
      await Promise.resolve();
      return policies[owners.findIndex((value) => value.equals(owner))]!;
    });
    const results = await Promise.all(
      owners.map((owner) =>
        f.service.assertNewWorkWithPolicy(
          owner,
          { bytes: 1_024, durationSeconds: 30 },
          { inTransaction: () => true } as never,
          new Types.ObjectId(),
          metadata,
        ),
      ),
    );
    for (const [index, result] of results.entries()) {
      expect(result.policy).toBe(policies[index]);
      expect(result.admissionSnapshot.maxWaitingJobs).toBe(index + 4);
      const reservation = f.usage.reserveForJob.mock.calls.find((call) =>
        (call[1] as Types.ObjectId).equals(owners[index]!),
      );
      expect(reservation?.[5]).toBe(policies[index]);
    }
    expect(f.policies.effective).toHaveBeenCalledTimes(2);
    expect(f.policies.touchGlobalFence).toHaveBeenCalledTimes(2);
    expect(f.fences.updateOne).toHaveBeenCalledTimes(2);
    expect(f.users.updateOne).toHaveBeenCalledTimes(2);
  });

  it('resolves policy again on a later callback and enforces a changed limit', async () => {
    const f = fixture();
    const owner = new Types.ObjectId();
    await f.service.assertNewWorkWithPolicy(
      owner,
      { bytes: 1_024, durationSeconds: 30 },
      session as never,
      new Types.ObjectId(),
      metadata,
    );
    f.policies.effective.mockResolvedValue({
      globalRevision: 5,
      overrideRevision: null,
      source: 'global',
      acceptNewJobs: true,
      values: { ...DEFAULT_ACCOUNT_POLICY_VALUES, maxDurationSeconds: 20 },
    });
    await expect(
      f.service.assertNewWorkWithPolicy(
        owner,
        { bytes: 1_024, durationSeconds: 30 },
        session as never,
        new Types.ObjectId(),
        metadata,
      ),
    ).rejects.toMatchObject({ response: { code: 'PROCESSING_UNAVAILABLE' } });
    expect(f.policies.effective).toHaveBeenCalledTimes(2);
    expect(f.policies.touchGlobalFence).toHaveBeenCalledTimes(2);
    expect(f.usage.reserveForJob).toHaveBeenCalledOnce();
  });

  it('admits completed cache media without queue reads or monthly reservations', async () => {
    const f = fixture();
    f.countDocuments.mockImplementation(() => {
      throw new Error('Cache hits must not read queue capacity');
    });
    f.usage.reserveForJob.mockRejectedValue(
      jobError('PROCESSING_ALLOWANCE_EXHAUSTED'),
    );
    await expect(
      f.service.assertCachedWork(
        new Types.ObjectId(),
        { bytes: 1_024, durationSeconds: 30 },
        session as never,
        { ...metadata, source: 'youtube' },
      ),
    ).resolves.toMatchObject({
      policyVersion: 2,
      source: 'youtube',
      settingsRevision: 4,
    });
    expect(f.policies.touchGlobalFence).toHaveBeenCalledOnce();
    expect(f.fences.updateOne).toHaveBeenCalledOnce();
    expect(f.users.updateOne).toHaveBeenCalledOnce();
    expect(f.countDocuments).not.toHaveBeenCalled();
    expect(f.usage.reserveForJob).not.toHaveBeenCalled();
  });

  it.each(['feature_gate', 'account_status', 'global_policy', 'media_limit'])(
    'still enforces %s for completed cache results',
    async (restriction) => {
      const f = fixture(restriction !== 'feature_gate');
      if (restriction === 'account_status')
        f.users.updateOne.mockResolvedValue({ modifiedCount: 0 });
      if (restriction === 'global_policy')
        f.policies.effective.mockResolvedValue({
          globalRevision: 4,
          overrideRevision: null,
          source: 'global',
          acceptNewJobs: false,
          values: DEFAULT_ACCOUNT_POLICY_VALUES,
        });
      await expect(
        f.service.assertCachedWork(
          new Types.ObjectId(),
          {
            bytes: 1_024,
            durationSeconds: restriction === 'media_limit' ? 1_801 : 30,
          },
          session as never,
          metadata,
        ),
      ).rejects.toMatchObject({ response: { code: 'PROCESSING_UNAVAILABLE' } });
      expect(f.usage.reserveForJob).not.toHaveBeenCalled();
    },
  );

  it('requires a transaction even when no processing allowance is consumed', async () => {
    const f = fixture();
    await expect(
      f.service.assertCachedWork(
        new Types.ObjectId(),
        { bytes: 1_024, durationSeconds: 30 },
        { inTransaction: () => false } as never,
        metadata,
      ),
    ).rejects.toThrow('Processing admission requires a transaction');
    expect(f.policies.touchGlobalFence).not.toHaveBeenCalled();
  });

  it('fails closed behind the explicit processing feature gate', async () => {
    const f = fixture(false);
    await expect(
      f.service.assertNewWork(
        new Types.ObjectId(),
        { bytes: 1024, durationSeconds: 30 },
        session as never,
        new Types.ObjectId(),
      ),
    ).rejects.toMatchObject({ response: { code: 'PROCESSING_UNAVAILABLE' } });
    expect(f.usage.reserveForJob).not.toHaveBeenCalled();
    expect(f.usage.assertRetainedCapacity).not.toHaveBeenCalled();
  });

  it('serializes admission and reserves monthly account usage in one transaction', async () => {
    const f = fixture();
    const owner = new Types.ObjectId();
    const jobId = new Types.ObjectId();
    await expect(
      f.service.assertNewWork(
        owner,
        { bytes: 50_000_000, durationSeconds: 1_200 },
        session as never,
        jobId,
        metadata,
      ),
    ).resolves.toMatchObject({
      policyVersion: 2,
      settingsRevision: 4,
      maxWaitingJobs: 20,
      maxProcessingJobs: 1,
      maxInfrastructureAttempts: 4,
      maxClientInputAttempts: 5,
      maxDurationSeconds: 1_800,
      maxInputBytes: 100_000_000,
    });
    expect(f.fences.updateOne).toHaveBeenCalledTimes(1);
    expect(f.users.updateOne).toHaveBeenCalledTimes(1);
    expect(f.usage.reserveForJob).toHaveBeenCalledWith(
      jobId,
      owner,
      1_200,
      session,
      expect.any(Date),
      await f.policies.effective.mock.results[0]!.value,
    );
    expect(f.usage.assertRetainedCapacity).toHaveBeenCalledWith(
      owner,
      5_000_000_000,
      session,
    );
  });

  it('locks admission before exchanging an import hold at an exhausted allowance', async () => {
    const f = fixture();
    const owner = new Types.ObjectId();
    const importId = new Types.ObjectId();
    const jobId = new Types.ObjectId();
    const operations: string[] = [];
    let reservedSeconds = 100;
    f.policies.touchGlobalFence.mockImplementation(async () => {
      operations.push('global');
    });
    f.fences.updateOne.mockImplementation(async () => {
      operations.push('account');
      return { acknowledged: true };
    });
    f.users.updateOne.mockImplementation(async () => {
      operations.push('user');
      return { modifiedCount: 1 };
    });
    f.usage.releaseImport.mockImplementation(async () => {
      operations.push('release');
      reservedSeconds -= 100;
    });
    f.policies.effective.mockImplementation(async () => {
      operations.push('policy');
      return {
        globalRevision: 4,
        overrideRevision: null,
        source: 'global',
        acceptNewJobs: true,
        values: {
          ...DEFAULT_ACCOUNT_POLICY_VALUES,
          monthlyProcessingSeconds: 100,
        },
      };
    });
    f.usage.reserveForJob.mockImplementation(async () => {
      operations.push('reserve');
      if (reservedSeconds >= 100)
        throw jobError('PROCESSING_ALLOWANCE_EXHAUSTED');
      reservedSeconds += 40;
    });

    await expect(
      f.service.assertNewWork(
        owner.toHexString(),
        { bytes: 1_024, durationSeconds: 40 },
        session as never,
        jobId,
        metadata,
        importId,
      ),
    ).resolves.toMatchObject({ policyVersion: 2 });
    expect(operations).toEqual([
      'global',
      'account',
      'user',
      'release',
      'policy',
      'reserve',
    ]);
    expect(reservedSeconds).toBe(40);
    expect(f.usage.releaseImport).toHaveBeenCalledWith(
      importId,
      owner,
      session,
      true,
    );
    expect(f.usage.reserveForJob).toHaveBeenCalledWith(
      jobId,
      owner,
      40,
      session,
      expect.any(Date),
      await f.policies.effective.mock.results[0]!.value,
    );
    expect(f.policies.touchGlobalFence).toHaveBeenCalledOnce();
    expect(f.fences.updateOne).toHaveBeenCalledOnce();
    expect(f.users.updateOne).toHaveBeenCalledOnce();
  });

  it('does not mutate an import hold when its owner is inactive', async () => {
    const f = fixture();
    f.users.updateOne.mockResolvedValue({ modifiedCount: 0 });
    await expect(
      f.service.assertNewWork(
        new Types.ObjectId(),
        { bytes: 1_024, durationSeconds: 30 },
        session as never,
        new Types.ObjectId(),
        metadata,
        new Types.ObjectId(),
      ),
    ).rejects.toMatchObject({ response: { code: 'PROCESSING_UNAVAILABLE' } });
    expect(f.usage.releaseImport).not.toHaveBeenCalled();
    expect(f.usage.reserveForJob).not.toHaveBeenCalled();
  });

  it('requires the import hold before reserving its replacement', async () => {
    const f = fixture();
    f.usage.releaseImport.mockRejectedValue(
      jobError('UPLOAD_RESERVATION_EXPIRED'),
    );
    await expect(
      f.service.assertNewWork(
        new Types.ObjectId(),
        { bytes: 1_024, durationSeconds: 30 },
        session as never,
        new Types.ObjectId(),
        metadata,
        new Types.ObjectId(),
      ),
    ).rejects.toMatchObject({
      response: { code: 'UPLOAD_RESERVATION_EXPIRED' },
    });
    expect(f.policies.effective).not.toHaveBeenCalled();
    expect(f.countDocuments).not.toHaveBeenCalled();
    expect(f.usage.reserveForJob).not.toHaveBeenCalled();
  });

  it('releases an import hold for cached media without reserving monthly processing', async () => {
    const f = fixture();
    const owner = new Types.ObjectId();
    const importId = new Types.ObjectId();
    await f.service.assertCachedWork(
      owner,
      { bytes: 1_024, durationSeconds: 30 },
      session as never,
      metadata,
      importId,
    );
    expect(f.users.updateOne.mock.invocationCallOrder[0]).toBeLessThan(
      f.usage.releaseImport.mock.invocationCallOrder[0]!,
    );
    expect(f.usage.releaseImport).toHaveBeenCalledWith(
      importId,
      owner,
      session,
      true,
    );
    expect(f.countDocuments).not.toHaveBeenCalled();
    expect(f.usage.reserveForJob).not.toHaveBeenCalled();
    expect(f.policies.touchGlobalFence).toHaveBeenCalledOnce();
    expect(f.fences.updateOne).toHaveBeenCalledOnce();
    expect(f.users.updateOne).toHaveBeenCalledOnce();
  });

  it('does not overlap capacity queries on the transaction session', async () => {
    const f = fixture();
    let finishWaiting!: (value: number) => void;
    let waitingStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      waitingStarted = resolve;
    });
    f.countDocuments.mockReturnValueOnce({
      session: vi.fn(() => {
        waitingStarted();
        return new Promise<number>((resolve) => {
          finishWaiting = resolve;
        });
      }),
    });
    const admitting = f.service.assertNewWork(
      new Types.ObjectId(),
      { bytes: 1_024, durationSeconds: 30 },
      session as never,
      new Types.ObjectId(),
      metadata,
    );
    await started;
    expect(f.countDocuments).toHaveBeenCalledOnce();
    finishWaiting(0);
    await admitting;
    expect(f.countDocuments).toHaveBeenCalledTimes(2);
    expect(f.usage.reserveForJob).toHaveBeenCalledOnce();
  });

  it('allows the twentieth waiting job while one job is processing', async () => {
    const f = fixture();
    f.countDocuments
      .mockReturnValueOnce({ session: vi.fn().mockResolvedValue(19) })
      .mockReturnValueOnce({ session: vi.fn().mockResolvedValue(1) });

    await expect(
      f.service.assertNewWork(
        new Types.ObjectId(),
        { bytes: 1_024, durationSeconds: 30 },
        session as never,
        new Types.ObjectId(),
        metadata,
      ),
    ).resolves.toMatchObject({ maxWaitingJobs: 20, maxProcessingJobs: 1 });
    expect(f.usage.reserveForJob).toHaveBeenCalledOnce();
  });

  it('rejects the twenty-first waiting job with safe capacity guidance', async () => {
    const f = fixture();
    f.countDocuments
      .mockReturnValueOnce({ session: vi.fn().mockResolvedValue(20) })
      .mockReturnValueOnce({ session: vi.fn().mockResolvedValue(1) });

    await expect(
      f.service.assertNewWork(
        new Types.ObjectId(),
        { bytes: 1_024, durationSeconds: 30 },
        session as never,
        new Types.ObjectId(),
        metadata,
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'PROCESSING_LIMIT_REACHED',
        nextResetAt: null,
        action: 'wait_for_job_to_finish',
        capacity: {
          waitingJobs: 20,
          maxWaitingJobs: 20,
          processingJobs: 1,
          maxProcessingJobs: 1,
        },
      },
    });
    expect(f.usage.reserveForJob).not.toHaveBeenCalled();
  });

  it('serializes processing claims behind the account fence', async () => {
    const f = fixture();
    f.countDocuments.mockReturnValueOnce({
      session: vi.fn().mockResolvedValue(1),
    });

    await expect(
      f.service.claimProcessingSlot(
        {
          _id: new Types.ObjectId(),
          userId: new Types.ObjectId(),
          admissionSnapshot: { maxProcessingJobs: 1 },
        } as never,
        session as never,
      ),
    ).resolves.toBe(false);
    expect(f.fences.updateOne).toHaveBeenCalledOnce();
  });

  it('fails closed for restricted or deleting accounts', async () => {
    const f = fixture();
    f.users.updateOne.mockResolvedValue({ modifiedCount: 0 });

    await expect(
      f.service.assertNewWork(
        new Types.ObjectId(),
        { bytes: 1_024, durationSeconds: 30 },
        session as never,
        new Types.ObjectId(),
        metadata,
      ),
    ).rejects.toMatchObject({ response: { code: 'PROCESSING_UNAVAILABLE' } });
    expect(f.usage.reserveForJob).not.toHaveBeenCalled();
  });

  it('does not claim a processing slot after an account is restricted or starts deletion', async () => {
    const f = fixture();
    f.users.updateOne.mockResolvedValue({ modifiedCount: 0 });

    await expect(
      f.service.claimProcessingSlot(
        {
          _id: new Types.ObjectId(),
          userId: new Types.ObjectId(),
          admissionSnapshot: { maxProcessingJobs: 1 },
        } as never,
        session as never,
      ),
    ).resolves.toBe(false);
    expect(f.fences.updateOne).toHaveBeenCalledOnce();
    expect(f.usage.hasReservedProcessing).not.toHaveBeenCalled();
  });

  it('does not admit work when monthly quota reservation fails', async () => {
    const f = fixture();
    f.usage.reserveForJob.mockRejectedValue(
      jobError('PROCESSING_ALLOWANCE_EXHAUSTED'),
    );

    await expect(
      f.service.assertNewWork(
        new Types.ObjectId(),
        { bytes: 1_024, durationSeconds: 30 },
        session as never,
        new Types.ObjectId(),
        metadata,
      ),
    ).rejects.toMatchObject({
      response: { code: 'PROCESSING_ALLOWANCE_EXHAUSTED' },
    });
  });

  it('blocks later admission when retained successful output is at the ceiling', async () => {
    const f = fixture();
    f.usage.assertRetainedCapacity.mockRejectedValue(
      jobError('RETAINED_STORAGE_LIMIT_REACHED'),
    );

    await expect(
      f.service.assertNewWork(
        new Types.ObjectId(),
        { bytes: 1_024, durationSeconds: 30 },
        session as never,
        new Types.ObjectId(),
        metadata,
      ),
    ).rejects.toMatchObject({
      response: { code: 'RETAINED_STORAGE_LIMIT_REACHED' },
    });
    expect(f.usage.reserveForJob).not.toHaveBeenCalled();
  });
});

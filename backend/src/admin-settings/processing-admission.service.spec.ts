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
    );
    expect(f.usage.assertRetainedCapacity).toHaveBeenCalledWith(
      owner,
      5_000_000_000,
      session,
    );
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

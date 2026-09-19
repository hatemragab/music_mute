import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { jobError } from '../jobs/job-errors.js';
import { DEFAULT_ACCOUNT_POLICY_VALUES } from './account-policy.schema.js';
import { ProcessingAdmissionService } from './processing-admission.service.js';

const session = { inTransaction: () => true };

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
    users,
    usage,
  };
}

describe('processing admission', () => {
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
        {
          policyVersion: 2,
          preparationProfileId: 'preserve-or-aac-lc-256-v1',
          source: 'audio_file',
        },
      ),
    ).resolves.toMatchObject({
      policyVersion: 2,
      settingsRevision: 4,
      maxActiveJobsPerUser: 1,
      maxDurationSeconds: 1_200,
      maxInputBytes: 50_000_000,
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
      1_000_000_000,
      session,
    );
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
        {
          policyVersion: 2,
          preparationProfileId: 'preserve-or-aac-lc-256-v1',
          source: 'audio_file',
        },
      ),
    ).rejects.toMatchObject({
      response: { code: 'RETAINED_STORAGE_LIMIT_REACHED' },
    });
    expect(f.usage.reserveForJob).not.toHaveBeenCalled();
  });
});

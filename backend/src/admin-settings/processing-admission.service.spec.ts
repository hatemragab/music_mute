import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { ProcessingAdmissionService } from './processing-admission.service.js';

const session = { inTransaction: () => true };
const chained = <T>(value: T) => ({
  session: vi.fn().mockReturnThis(),
  maxTimeMS: vi.fn().mockReturnThis(),
  lean: vi.fn().mockResolvedValue(value),
});

function fixture(enabled = true) {
  const ledger = {
    findById: vi.fn(() => chained(null)),
    find: vi.fn(() => chained([])),
    create: vi.fn().mockResolvedValue([]),
  };
  const userModel = { findById: vi.fn(() => chained({})) };
  const settingsModel = {
    findById: vi.fn(() => chained({ revision: 4 })),
  };
  const countDocuments = vi.fn(() => ({
    session: vi.fn().mockResolvedValue(0),
  }));
  const jobs = {
    countDocuments,
    db: {
      model: vi.fn((name: string) => {
        if (name === 'ProcessingUsageLedger') return ledger;
        if (name === 'User') return userModel;
        if (name === 'ProcessingSettings') return settingsModel;
        throw new Error(`Unexpected model ${name}`);
      }),
    },
    base: { Types },
  };
  const fences = {
    updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
  };
  const users = {
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const settings = {
    touchGlobalFence: vi.fn().mockResolvedValue(undefined),
    effective: vi.fn().mockResolvedValue({
      revision: 4,
      acceptNewJobs: true,
      maxInputBytesExclusive: 30_000_000,
      maxDurationSecondsExclusive: 600,
      maxActiveJobsPerUser: null,
    }),
  };
  return {
    service: new ProcessingAdmissionService(
      fences as never,
      users as never,
      jobs as never,
      settings as never,
      new ConfigService({
        AUDIO_PROCESSING_ENABLED: enabled,
        PROCESSING_URL_SECONDS: 900,
      }),
    ),
    fences,
    users,
    jobs,
    ledger,
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
    expect(f.ledger.create).not.toHaveBeenCalled();
  });

  it('serializes admission and reserves allowance in the same transaction', async () => {
    const f = fixture();
    const owner = new Types.ObjectId();
    const jobId = new Types.ObjectId();
    await expect(
      f.service.assertNewWork(
        owner,
        { bytes: 1024, durationSeconds: 30 },
        session as never,
        jobId,
      ),
    ).resolves.toMatchObject({
      policyVersion: 1,
      settingsRevision: 4,
      maxActiveJobsPerUser: 1,
    });
    expect(f.fences.updateOne).toHaveBeenCalledTimes(1);
    expect(f.users.updateOne).toHaveBeenCalledTimes(1);
    expect(f.ledger.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          _id: jobId,
          userId: owner,
          audioSeconds: 30,
        }),
      ],
      { session },
    );
  });
});

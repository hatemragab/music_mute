import { Types } from 'mongoose';
import { ProcessingUsageService } from './processing-usage.service.js';
import type { Job } from '../jobs/job.schema.js';

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

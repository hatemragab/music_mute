import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { RestrictionJobsService } from './restriction-jobs.service.js';

describe('RestrictionJobsService', () => {
  it('cancels unfinished jobs, fences worker ownership, and releases usage', async () => {
    const accountId = new Types.ObjectId();
    const jobId = new Types.ObjectId();
    const execution = {
      attemptId: '11111111-1111-4111-8111-111111111111',
      machineId: '22222222-2222-4222-8222-222222222222',
      workerId: '33333333-3333-4333-8333-333333333333',
      sessionId: '44444444-4444-4444-8444-444444444444',
      incarnation: '55555555-5555-4555-8555-555555555555',
    };
    const active = {
      _id: jobId,
      userId: accountId,
      status: 'processing',
      revision: 4,
      currentExecution: execution,
      retryEligibility: {
        eligible: true,
        attemptsRemaining: 2,
        nextAttemptAt: null,
      },
    };
    const session = {};
    const findChain: Record<string, ReturnType<typeof vi.fn>> = {};
    findChain.sort = vi.fn(() => findChain);
    findChain.limit = vi.fn(() => findChain);
    findChain.session = vi.fn().mockResolvedValue([active]);
    const attempts = {
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const slots = {
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const updated = { ...active, status: 'cancelled', currentExecution: null };
    const jobs = {
      find: vi.fn(() => findChain),
      findOneAndUpdate: vi.fn(() => ({
        lean: vi.fn().mockResolvedValue(updated),
      })),
      db: {
        model: vi.fn((name: string) =>
          name === 'WorkerAttempt' ? attempts : slots,
        ),
      },
    };
    const usage = { settleJob: vi.fn().mockResolvedValue(undefined) };
    const service = new RestrictionJobsService(jobs as never, usage as never);

    await expect(
      service.cancelNotFinalized(accountId, session as never),
    ).resolves.toBe(1);
    expect(jobs.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: jobId, revision: 4, deletedAt: null },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'cancelled',
          currentExecution: null,
          retryEligibility: expect.objectContaining({ eligible: false }),
        }),
      }),
      expect.objectContaining({ session }),
    );
    expect(attempts.updateOne).toHaveBeenCalledOnce();
    expect(slots.updateOne).toHaveBeenCalledOnce();
    expect(usage.settleJob).toHaveBeenCalledWith(
      updated,
      session,
      expect.any(Date),
    );
  });
});

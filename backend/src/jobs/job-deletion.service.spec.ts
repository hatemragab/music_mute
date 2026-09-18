import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { JobDeletionService } from './job-deletion.service.js';

const machineId = 'cb56441d-f2df-4b44-a320-6f37dfa81f7f';
const workerId = 'a69d3899-2214-4427-98cf-b9a4449aeae1';
const sessionId = 'df10b680-7663-49ee-a251-4c20721e9ca8';
const incarnation = 'e221c880-7196-4fa5-b1b8-ee504e87c04c';
const attemptId = '99f8016b-67f3-4f4b-beb4-205a7b87147e';

describe('job deletion worker fencing', () => {
  it('cancels stale terminal-job ownership before scheduling cleanup', async () => {
    const userId = new Types.ObjectId();
    const jobId = new Types.ObjectId();
    const execution = {
      attemptId,
      machineId,
      workerId,
      sessionId,
      incarnation,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      deadlineAt: new Date(Date.now() + 120_000),
    };
    const attemptModel = {
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const slotModel = {
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const jobs = {
      findOne: vi.fn(() => ({
        session: vi.fn().mockResolvedValue({
          _id: jobId,
          userId,
          status: 'cancelled',
          revision: 4,
          deletedAt: null,
          currentExecution: execution,
          retryEligibility: {
            eligible: true,
            attemptsRemaining: 2,
            nextAttemptAt: null,
          },
        }),
      })),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      db: {
        model: vi.fn((name: string) =>
          name === 'WorkerAttempt' ? attemptModel : slotModel,
        ),
      },
    };
    const outbox = {
      updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
    };
    const transactions = {
      run: vi.fn(async (operation: (session: unknown) => Promise<void>) =>
        operation({}),
      ),
    };
    const service = new JobDeletionService(
      jobs as never,
      outbox as never,
      transactions as never,
      {} as never,
      { getOrThrow: vi.fn().mockReturnValue(900) } as never,
    );

    await service.delete(userId.toString(), jobId.toString());

    expect(jobs.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: jobId, revision: 4 }),
      expect.objectContaining({
        $set: expect.objectContaining({
          deletedAt: expect.any(Date),
          currentExecution: null,
          retryEligibility: {
            eligible: false,
            attemptsRemaining: 0,
            nextAttemptAt: null,
          },
        }),
      }),
      expect.any(Object),
    );
    expect(attemptModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: attemptId }),
      expect.objectContaining({
        $set: expect.objectContaining({ state: 'cancelled' }),
      }),
      expect.any(Object),
    );
    expect(slotModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ currentAttemptId: attemptId }),
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'idle',
          currentAttemptId: null,
        }),
      }),
      expect.any(Object),
    );
  });
});

import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { WorkerRecoveryService } from './worker-recovery.service.js';

const machineId = 'cb56441d-f2df-4b44-a320-6f37dfa81f7f';
const workerId = 'a69d3899-2214-4427-98cf-b9a4449aeae1';
const sessionId = 'df10b680-7663-49ee-a251-4c20721e9ca8';
const incarnation = 'e221c880-7196-4fa5-b1b8-ee504e87c04c';
const attemptId = '99f8016b-67f3-4f4b-beb4-205a7b87147e';

const sessionLean = (value: unknown) => ({
  session: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }),
});
const observedQuery = (value: unknown) => ({
  sort: vi.fn().mockReturnValue({
    maxTimeMS: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(value),
    }),
  }),
});

function fixture() {
  const transaction = {
    withTransaction: vi.fn(async (operation: () => Promise<unknown>) =>
      operation(),
    ),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const attempts = { findOne: vi.fn(), updateOne: vi.fn() };
  const slots = { updateOne: vi.fn() };
  const jobs = { findById: vi.fn(), updateOne: vi.fn() };
  const usage = { settleJob: vi.fn().mockResolvedValue(undefined) };
  const service = new WorkerRecoveryService(
    { startSession: vi.fn().mockResolvedValue(transaction) } as never,
    attempts as never,
    slots as never,
    jobs as never,
    usage as never,
  );
  return { service, transaction, attempts, slots, jobs, usage };
}

function ownership(attemptNumber: number, leaseExpiresAt: Date) {
  const jobId = new Types.ObjectId();
  const attempt = {
    _id: attemptId,
    jobId,
    machineId,
    workerId,
    sessionId,
    incarnation,
    attemptNumber,
    state: 'running',
    leaseExpiresAt,
    revision: 5,
  };
  const currentExecution = {
    attemptId,
    machineId,
    workerId,
    sessionId,
    incarnation,
    leaseExpiresAt,
  };
  return { jobId, attempt, currentExecution };
}

describe('worker lease recovery', () => {
  it('does not overwrite a racing successful renewal', async () => {
    const f = fixture();
    const now = new Date();
    const value = ownership(1, new Date(now.getTime() - 1_000));
    f.attempts.findOne.mockReturnValue(observedQuery(value.attempt));
    f.jobs.findById.mockReturnValue(
      sessionLean({
        _id: value.jobId,
        status: 'processing',
        deletedAt: null,
        revision: 7,
        currentExecution: value.currentExecution,
        retryEligibility: { eligible: true, attemptsRemaining: 3 },
        admissionSnapshot: { maxInfrastructureAttempts: 3 },
      }),
    );
    f.attempts.updateOne.mockResolvedValue({ modifiedCount: 0 });

    await expect(f.service.recoverOne(now)).resolves.toBe(false);
    expect(f.jobs.updateOne).not.toHaveBeenCalled();
    expect(f.slots.updateOne).not.toHaveBeenCalled();
  });

  it('requeues a lost attempt with bounded backoff and releases its slot', async () => {
    const f = fixture();
    const now = new Date();
    const value = ownership(1, new Date(now.getTime() - 1_000));
    f.attempts.findOne.mockReturnValue(observedQuery(value.attempt));
    f.jobs.findById.mockReturnValue(
      sessionLean({
        _id: value.jobId,
        status: 'processing',
        deletedAt: null,
        revision: 7,
        currentExecution: value.currentExecution,
        retryEligibility: { eligible: true, attemptsRemaining: 3 },
        admissionSnapshot: { maxInfrastructureAttempts: 3 },
      }),
    );
    f.attempts.updateOne.mockResolvedValue({ modifiedCount: 1 });
    f.jobs.updateOne.mockResolvedValue({ modifiedCount: 1 });
    f.slots.updateOne.mockResolvedValue({ modifiedCount: 1 });

    await expect(f.service.recoverOne(now)).resolves.toBe(true);
    const update = f.jobs.updateOne.mock.calls[0][1].$set;
    expect(update).toMatchObject({
      status: 'queued',
      currentExecution: null,
      retryEligibility: { eligible: true, attemptsRemaining: 2 },
    });
    expect(update.retryEligibility.nextAttemptAt.getTime()).toBe(
      now.getTime() + 5_000,
    );
    expect(f.attempts.updateOne).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({
          terminalCode: 'LEASE_EXPIRED',
          failureClass: 'infrastructure_transient',
        }),
      }),
      expect.any(Object),
    );
    expect(f.slots.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ currentAttemptId: attemptId }),
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'idle',
          currentAttemptId: null,
        }),
      }),
      expect.any(Object),
    );
    expect(f.usage.settleJob).not.toHaveBeenCalled();
  });

  it('fails finally when the policy attempt limit is exhausted', async () => {
    const f = fixture();
    const now = new Date();
    const value = ownership(3, new Date(now.getTime() - 1_000));
    f.attempts.findOne.mockReturnValue(observedQuery(value.attempt));
    f.jobs.findById.mockReturnValue(
      sessionLean({
        _id: value.jobId,
        status: 'processing',
        deletedAt: null,
        revision: 7,
        currentExecution: value.currentExecution,
        retryEligibility: { eligible: true, attemptsRemaining: 1 },
        admissionSnapshot: { maxInfrastructureAttempts: 3 },
      }),
    );
    f.attempts.updateOne.mockResolvedValue({ modifiedCount: 1 });
    f.jobs.updateOne.mockResolvedValue({ modifiedCount: 1 });
    f.slots.updateOne.mockResolvedValue({ modifiedCount: 1 });

    await expect(f.service.recoverOne(now)).resolves.toBe(true);
    expect(f.jobs.updateOne).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'failed',
          retryEligibility: {
            eligible: false,
            attemptsRemaining: 0,
            nextAttemptAt: null,
          },
        }),
      }),
      expect.any(Object),
    );
    expect(f.usage.settleJob).toHaveBeenCalledWith(
      expect.objectContaining({ _id: value.jobId, status: 'failed' }),
      f.transaction,
      now,
    );
    expect(f.attempts.updateOne).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({
          terminalCode: 'LEASE_EXPIRED',
          failureClass: 'infrastructure_terminal',
        }),
      }),
      expect.any(Object),
    );
  });
});

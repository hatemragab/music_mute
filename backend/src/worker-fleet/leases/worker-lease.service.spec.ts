import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { WorkerLeaseService } from './worker-lease.service.js';

const machineId = 'cb56441d-f2df-4b44-a320-6f37dfa81f7f';
const workerId = 'a69d3899-2214-4427-98cf-b9a4449aeae1';
const sessionId = 'df10b680-7663-49ee-a251-4c20721e9ca8';
const incarnation = 'e221c880-7196-4fa5-b1b8-ee504e87c04c';
const attemptId = '99f8016b-67f3-4f4b-beb4-205a7b87147e';

const sessionLean = (value: unknown) => ({
  session: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }),
});

function fixture() {
  const transaction = {
    withTransaction: vi.fn(async (operation: () => Promise<unknown>) =>
      operation(),
    ),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const machines = { findById: vi.fn() };
  const slots = { updateOne: vi.fn() };
  const attempts = { findOne: vi.fn(), updateOne: vi.fn() };
  const policies = { findById: vi.fn() };
  const jobs = { findById: vi.fn(), updateOne: vi.fn() };
  const service = new WorkerLeaseService(
    { startSession: vi.fn().mockResolvedValue(transaction) } as never,
    machines as never,
    slots as never,
    attempts as never,
    policies as never,
    jobs as never,
  );
  return { service, transaction, machines, slots, attempts, policies, jobs };
}

const principal = {
  kind: 'machine' as const,
  subjectId: machineId,
  credential: 'x'.repeat(43),
  machineStatus: 'active' as const,
};

const dto = (jobId: string) => ({
  requestId: '01ad6d5f-57cd-4bdc-9299-8c99e7391695',
  sessionId,
  incarnation,
  leases: [{ jobId, attemptId, workerId }],
});

describe('worker lease renewal', () => {
  it('renews an exact active ownership tuple and caps it at the deadline', async () => {
    const f = fixture();
    const jobId = new Types.ObjectId();
    const leaseExpiresAt = new Date(Date.now() + 30_000);
    const deadlineAt = new Date(Date.now() + 45_000);
    f.machines.findById.mockReturnValue(
      sessionLean({
        status: 'active',
        currentSession: { sessionId, incarnation },
      }),
    );
    f.policies.findById.mockReturnValue(sessionLean({ leaseSeconds: 60 }));
    f.attempts.findOne.mockReturnValue(
      sessionLean({
        _id: attemptId,
        jobId,
        machineId,
        workerId,
        sessionId,
        incarnation,
        state: 'claimed',
        leaseExpiresAt,
        deadlineAt,
        revision: 2,
      }),
    );
    f.jobs.findById.mockReturnValue(
      sessionLean({
        _id: jobId,
        status: 'processing',
        deletedAt: null,
        revision: 4,
        currentExecution: {
          attemptId,
          machineId,
          workerId,
          sessionId,
          incarnation,
          leaseExpiresAt,
        },
      }),
    );
    f.attempts.updateOne.mockResolvedValue({ modifiedCount: 1 });
    f.jobs.updateOne.mockResolvedValue({ modifiedCount: 1 });
    f.slots.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const result = await f.service.renew(principal, dto(jobId.toString()));

    expect(result.results[0]).toMatchObject({ disposition: 'accepted' });
    expect(
      new Date(result.results[0].leaseExpiresAt!).getTime(),
    ).toBeLessThanOrEqual(deadlineAt.getTime());
    expect(f.attempts.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: attemptId, revision: 2 }),
      expect.objectContaining({
        $set: expect.objectContaining({ state: 'running' }),
      }),
      expect.any(Object),
    );
    expect(f.transaction.endSession).toHaveBeenCalledOnce();
  });

  it('never revives an already expired attempt', async () => {
    const f = fixture();
    const jobId = new Types.ObjectId();
    const expiredAt = new Date(Date.now() - 1_000);
    f.machines.findById.mockReturnValue(
      sessionLean({
        status: 'active',
        currentSession: { sessionId, incarnation },
      }),
    );
    f.policies.findById.mockReturnValue(sessionLean({ leaseSeconds: 60 }));
    f.attempts.findOne.mockReturnValue(
      sessionLean({
        _id: attemptId,
        state: 'running',
        leaseExpiresAt: expiredAt,
        deadlineAt: new Date(Date.now() + 60_000),
      }),
    );
    f.jobs.findById.mockReturnValue(
      sessionLean({
        _id: jobId,
        status: 'processing',
        deletedAt: null,
        currentExecution: { attemptId, leaseExpiresAt: expiredAt },
      }),
    );

    const result = await f.service.renew(principal, dto(jobId.toString()));

    expect(result.results[0]).toMatchObject({
      disposition: 'expired',
      leaseExpiresAt: null,
    });
    expect(f.attempts.updateOne).not.toHaveBeenCalled();
    expect(f.jobs.updateOne).not.toHaveBeenCalled();
  });

  it.each([
    ['revoked', null, null],
    [
      'cancelled',
      { status: 'active', currentSession: { sessionId, incarnation } },
      { status: 'cancelled', deletedAt: null },
    ],
  ] as const)(
    'returns a per-item %s disposition',
    async (disposition, machine, job) => {
      const f = fixture();
      const jobId = new Types.ObjectId();
      f.machines.findById.mockReturnValue(sessionLean(machine));
      if (machine) {
        f.policies.findById.mockReturnValue(sessionLean({ leaseSeconds: 60 }));
        f.attempts.findOne.mockReturnValue(sessionLean(null));
        f.jobs.findById.mockReturnValue(sessionLean(job));
      }
      const result = await f.service.renew(principal, dto(jobId.toString()));
      expect(result.results[0].disposition).toBe(disposition);
    },
  );
});

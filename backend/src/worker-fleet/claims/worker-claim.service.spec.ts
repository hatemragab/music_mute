import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { WorkerClaimService } from './worker-claim.service.js';

const machineId = 'cb56441d-f2df-4b44-a320-6f37dfa81f7f';
const workerId = 'a69d3899-2214-4427-98cf-b9a4449aeae1';
const sessionId = 'df10b680-7663-49ee-a251-4c20721e9ca8';
const incarnation = 'e221c880-7196-4fa5-b1b8-ee504e87c04c';

const sessionLean = (value: unknown) => ({
  session: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }),
});
const maxLean = (value: unknown) => ({
  maxTimeMS: vi
    .fn()
    .mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }),
});
const updateLean = (value: unknown) => ({
  lean: vi.fn().mockResolvedValue(value),
});

function fixture() {
  const transaction = {
    withTransaction: vi.fn(async (operation: () => Promise<unknown>) =>
      operation(),
    ),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const machines = {
    findById: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
  };
  const slots = {
    findById: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
    updateMany: vi.fn(),
  };
  const attempts = {
    findOne: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
  };
  const policies = {
    findById: vi.fn(() =>
      sessionLean({
        revision: 0,
        acceptClaims: true,
        recipes: [
          {
            recipeId: 'kim-vocals-v2',
            enabled: true,
            maxSlotsPerMachine: 1,
          },
        ],
        leaseSeconds: 60,
        processingDeadlineSeconds: 7200,
      }),
    ),
  };
  const jobs = {
    findById: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
  };
  const admission = {
    claimProcessingSlot: vi.fn().mockResolvedValue(true),
  };
  const service = new WorkerClaimService(
    { startSession: vi.fn().mockResolvedValue(transaction) } as never,
    machines as never,
    slots as never,
    attempts as never,
    policies as never,
    jobs as never,
    admission as never,
  );
  return {
    service,
    transaction,
    machines,
    slots,
    attempts,
    policies,
    jobs,
    admission,
  };
}

const principal = {
  kind: 'machine' as const,
  subjectId: machineId,
  credential: 'x'.repeat(43),
  machineStatus: 'active' as const,
};

const activeMachine = {
  _id: machineId,
  status: 'active',
  revision: 3,
  policyRevision: 0,
  appliedRevision: 0,
  supervisorGeneration: 1,
  currentSession: {
    sessionId,
    incarnation,
    generation: 1,
    startedAt: new Date(),
    lastSeenAt: new Date(),
  },
  approvedCapabilities: [
    {
      platform: 'darwin-arm64',
      provider: 'mps',
      gpuId: 'gpu0',
      recipeIds: ['kim-vocals-v2'],
      maxSlots: 1,
    },
  ],
};

const claimDto = {
  requestId: '01ad6d5f-57cd-4bdc-9299-8c99e7391695',
  workerId,
  sessionId,
  incarnation,
  gpuId: 'gpu0',
  slotIndex: 0,
  appliedPolicyRevision: 0,
};

describe('worker atomic claims', () => {
  it('replays the same active attempt without reserving another job', async () => {
    const f = fixture();
    const jobId = new Types.ObjectId();
    const attemptId = '99f8016b-67f3-4f4b-beb4-205a7b87147e';
    const attempt = {
      _id: attemptId,
      jobId,
      machineId,
      workerId,
      gpuId: 'gpu0',
      sessionId,
      incarnation,
      claimRequestId: claimDto.requestId,
      attemptNumber: 1,
      state: 'claimed',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      deadlineAt: new Date(Date.now() + 120_000),
    };
    f.machines.findById.mockReturnValue(sessionLean(activeMachine));
    f.attempts.findOne.mockReturnValue(sessionLean(attempt));
    f.jobs.findById.mockReturnValue(
      sessionLean({
        _id: jobId,
        currentExecution: { attemptId },
        inputObject: { key: 'input', versionId: 'v1' },
        recipeSnapshot: { recipeId: 'kim-vocals-v2' },
      }),
    );
    const result = await f.service.claim(principal, claimDto);
    expect(result.claim).toMatchObject({ attemptId, replayed: true });
    expect(f.slots.updateOne).not.toHaveBeenCalled();
    expect(f.jobs.findOneAndUpdate).not.toHaveBeenCalled();
    expect(f.transaction.endSession).toHaveBeenCalledOnce();
  });

  it('returns an empty envelope without reserving a slot when no job matches', async () => {
    const f = fixture();
    f.machines.findById.mockReturnValue(sessionLean(activeMachine));
    f.attempts.findOne.mockReturnValue(sessionLean(null));
    f.slots.findOne.mockReturnValue(
      sessionLean({
        _id: workerId,
        machineId,
        gpuId: 'gpu0',
        slotIndex: 0,
        sessionId,
        incarnation,
        state: 'idle',
        currentAttemptId: null,
        allowedRecipeIds: ['kim-vocals-v2'],
        revision: 2,
      }),
    );
    f.jobs.findOne.mockReturnValue({
      sort: vi.fn().mockReturnValue(sessionLean(null)),
    });
    const result = await f.service.claim(principal, claimDto);
    expect(result.claim).toBeNull();
    expect(f.machines.updateOne).not.toHaveBeenCalled();
    expect(f.slots.updateOne).not.toHaveBeenCalled();
  });

  it('conditionally fences machine, slot and job before creating one attempt', async () => {
    const f = fixture();
    const jobId = new Types.ObjectId();
    const queued = {
      _id: jobId,
      userId: new Types.ObjectId(),
      status: 'queued',
      revision: 7,
      attemptNumber: 0,
      processingStartedAt: null,
      admissionSnapshot: { maxProcessingJobs: 1 },
      inputObject: {
        key: 'users/u/jobs/j/input.wav',
        versionId: 'v1',
        bytes: 10,
        sha256: 'sha',
        contentType: 'audio/wav',
      },
      recipeSnapshot: { recipeId: 'kim-vocals-v2' },
    };
    const slot = {
      _id: workerId,
      machineId,
      gpuId: 'gpu0',
      slotIndex: 0,
      sessionId,
      incarnation,
      state: 'idle',
      currentAttemptId: null,
      allowedRecipeIds: ['kim-vocals-v2'],
      revision: 2,
    };
    f.machines.findById.mockReturnValue(sessionLean(activeMachine));
    f.attempts.findOne.mockReturnValue(sessionLean(null));
    f.slots.findOne.mockReturnValue(sessionLean(slot));
    f.jobs.findOne.mockReturnValue({
      sort: vi.fn().mockReturnValue(sessionLean(queued)),
    });
    f.machines.updateOne.mockResolvedValue({ modifiedCount: 1 });
    f.slots.updateOne.mockResolvedValue({ modifiedCount: 1 });
    f.jobs.findOneAndUpdate.mockImplementation(
      (_filter: unknown, update: { $set: { currentExecution: object } }) =>
        updateLean({ ...queued, ...update.$set, attemptNumber: 1 }),
    );
    f.attempts.create.mockImplementation(async ([value]) => [
      { ...value, toObject: () => value },
    ]);
    const result = await f.service.claim(principal, claimDto);
    expect(result.claim).toMatchObject({
      jobId: jobId.toString(),
      attemptNumber: 1,
      replayed: false,
    });
    expect(f.machines.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', revision: 3 }),
      expect.objectContaining({ $inc: { revision: 1 } }),
      expect.any(Object),
    );
    expect(f.slots.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: workerId, state: 'idle' }),
      expect.objectContaining({
        $set: expect.objectContaining({ state: 'reserved' }),
      }),
      expect.any(Object),
    );
    expect(f.attempts.create).toHaveBeenCalledOnce();
    expect(f.admission.claimProcessingSlot).toHaveBeenCalledWith(
      expect.objectContaining({ _id: queued._id, userId: queued.userId }),
      f.transaction,
    );
  });

  it('aborts without an attempt when cancellation wins the job revision fence', async () => {
    const f = fixture();
    const queued = {
      _id: new Types.ObjectId(),
      userId: new Types.ObjectId(),
      status: 'queued',
      revision: 7,
      attemptNumber: 0,
      processingStartedAt: null,
      admissionSnapshot: { maxProcessingJobs: 1 },
      inputObject: { key: 'input', versionId: 'v1' },
      recipeSnapshot: { recipeId: 'kim-vocals-v2' },
    };
    const slot = {
      _id: workerId,
      machineId,
      gpuId: 'gpu0',
      slotIndex: 0,
      sessionId,
      incarnation,
      state: 'idle',
      currentAttemptId: null,
      allowedRecipeIds: ['kim-vocals-v2'],
      revision: 2,
    };
    f.machines.findById.mockReturnValue(sessionLean(activeMachine));
    f.attempts.findOne.mockReturnValue(sessionLean(null));
    f.slots.findOne.mockReturnValue(sessionLean(slot));
    f.jobs.findOne.mockReturnValue({
      sort: vi.fn().mockReturnValue(sessionLean(queued)),
    });
    f.machines.updateOne.mockResolvedValue({ modifiedCount: 1 });
    f.slots.updateOne.mockResolvedValue({ modifiedCount: 1 });
    f.jobs.findOneAndUpdate.mockReturnValue(updateLean(null));

    await expect(f.service.claim(principal, claimDto)).rejects.toThrow(
      'Worker resource changed',
    );
    expect(f.attempts.create).not.toHaveBeenCalled();
  });

  it('skips an older account without processing capacity', async () => {
    const f = fixture();
    const older = {
      _id: new Types.ObjectId(),
      userId: new Types.ObjectId(),
      queuedAt: new Date('2026-09-20T00:00:00.000Z'),
      status: 'queued',
      revision: 2,
      attemptNumber: 0,
      processingStartedAt: null,
      admissionSnapshot: { maxProcessingJobs: 1 },
      inputObject: {
        key: 'users/older/jobs/job/input.wav',
        versionId: 'older-v1',
        bytes: 10,
        sha256: 'older-sha',
        contentType: 'audio/wav',
      },
      recipeSnapshot: { recipeId: 'kim-vocals-v2' },
    };
    const eligible = {
      ...older,
      _id: new Types.ObjectId(),
      userId: new Types.ObjectId(),
      queuedAt: new Date('2026-09-20T00:01:00.000Z'),
      revision: 3,
      inputObject: {
        ...older.inputObject,
        key: 'users/eligible/jobs/job/input.wav',
        versionId: 'eligible-v1',
      },
    };
    const candidates = [older, eligible];
    const slot = {
      _id: workerId,
      machineId,
      gpuId: 'gpu0',
      slotIndex: 0,
      sessionId,
      incarnation,
      state: 'idle',
      currentAttemptId: null,
      allowedRecipeIds: ['kim-vocals-v2'],
      revision: 2,
    };
    f.machines.findById.mockReturnValue(sessionLean(activeMachine));
    f.attempts.findOne.mockReturnValue(sessionLean(null));
    f.slots.findOne.mockReturnValue(sessionLean(slot));
    f.jobs.findOne.mockImplementation(() => ({
      sort: vi.fn().mockReturnValue(sessionLean(candidates.shift() ?? null)),
    }));
    f.admission.claimProcessingSlot
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    f.machines.updateOne.mockResolvedValue({ modifiedCount: 1 });
    f.slots.updateOne.mockResolvedValue({ modifiedCount: 1 });
    f.jobs.findOneAndUpdate.mockImplementation(
      (_filter: unknown, update: { $set: { currentExecution: object } }) =>
        updateLean({ ...eligible, ...update.$set, attemptNumber: 1 }),
    );
    f.attempts.create.mockImplementation(async ([value]) => [
      { ...value, toObject: () => value },
    ]);

    const result = await f.service.claim(principal, claimDto);

    expect(result.claim?.jobId).toBe(eligible._id.toString());
    expect(f.jobs.findOne).toHaveBeenCalledTimes(2);
    expect(f.admission.claimProcessingSlot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ _id: older._id }),
      f.transaction,
    );
    expect(f.admission.claimProcessingSlot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ _id: eligible._id }),
      f.transaction,
    );
  });

  it('rejects claim replay from a different supervisor session', async () => {
    const f = fixture();
    f.machines.findById.mockReturnValue(sessionLean(activeMachine));
    f.attempts.findOne.mockReturnValue(
      sessionLean({
        state: 'claimed',
        workerId,
        gpuId: 'gpu0',
        sessionId: '184fd490-bafe-4795-a85d-35e774ed8507',
        incarnation,
      }),
    );
    await expect(f.service.claim(principal, claimDto)).rejects.toThrow(
      'Worker resource changed',
    );
  });

  it('replays an existing claim while the machine is paused without admitting new work', async () => {
    const f = fixture();
    const jobId = new Types.ObjectId();
    const attemptId = '99f8016b-67f3-4f4b-beb4-205a7b87147e';
    f.machines.findById.mockReturnValue(
      sessionLean({ ...activeMachine, status: 'paused' }),
    );
    f.attempts.findOne.mockReturnValue(
      sessionLean({
        _id: attemptId,
        jobId,
        machineId,
        workerId,
        gpuId: 'gpu0',
        sessionId,
        incarnation,
        state: 'claimed',
        attemptNumber: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        deadlineAt: new Date(Date.now() + 120_000),
      }),
    );
    f.jobs.findById.mockReturnValue(
      sessionLean({
        _id: jobId,
        currentExecution: { attemptId },
        inputObject: { key: 'input', versionId: 'v1' },
        recipeSnapshot: { recipeId: 'kim-vocals-v2' },
      }),
    );
    await expect(f.service.claim(principal, claimDto)).resolves.toMatchObject({
      claim: { attemptId, replayed: true },
    });
    expect(f.policies.findById).not.toHaveBeenCalled();
  });

  it('fails closed when the current fleet policy stops new claims', async () => {
    const f = fixture();
    f.machines.findById.mockReturnValue(sessionLean(activeMachine));
    f.attempts.findOne.mockReturnValue(sessionLean(null));
    f.policies.findById.mockReturnValue(
      sessionLean({
        revision: 0,
        acceptClaims: false,
        recipes: [],
        leaseSeconds: 60,
        processingDeadlineSeconds: 7200,
      }),
    );
    await expect(f.service.claim(principal, claimDto)).rejects.toThrow(
      'Worker operation is not allowed',
    );
    expect(f.slots.findOne).not.toHaveBeenCalled();
  });

  it('opens the same session idempotently without incrementing generation', async () => {
    const f = fixture();
    f.machines.findById.mockReturnValue(maxLean(activeMachine));
    const result = await f.service.openSession(principal, {
      sessionId,
      incarnation,
    });
    expect(result).toMatchObject({ replayed: true, policyRevision: 0 });
    expect(f.machines.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('expires ownership from a superseded supervisor session', async () => {
    const f = fixture();
    const nextSessionId = '9b03e310-4bde-4569-bef0-7f90f4c82670';
    const nextIncarnation = '036a9f59-07fa-41d9-be35-57f0b046bf2d';
    f.machines.findById.mockReturnValue(maxLean(activeMachine));
    f.machines.findOneAndUpdate.mockReturnValue(
      updateLean({
        ...activeMachine,
        revision: 4,
        currentSession: {
          sessionId: nextSessionId,
          incarnation: nextIncarnation,
          generation: 2,
        },
      }),
    );
    f.slots.updateMany.mockResolvedValue({ modifiedCount: 1 });
    await f.service.openSession(principal, {
      sessionId: nextSessionId,
      incarnation: nextIncarnation,
    });
    expect(f.attempts.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId,
        state: expect.anything(),
      }),
      expect.objectContaining({
        $set: { leaseExpiresAt: expect.any(Date) },
      }),
      expect.any(Object),
    );
    expect(f.jobs.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ 'currentExecution.machineId': machineId }),
      { $set: { 'currentExecution.leaseExpiresAt': expect.any(Date) } },
      expect.any(Object),
    );
  });
});

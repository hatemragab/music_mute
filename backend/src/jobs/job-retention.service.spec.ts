import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { JobRetentionService } from './job-retention.service.js';

const now = new Date('2026-09-30T12:00:00Z');
const cleanupAt = new Date('2026-08-30T12:00:00Z');
const query = (value: unknown): any =>
  Object.assign(Promise.resolve(value), {
    session: vi.fn(() => query(value)),
    lean: vi.fn(async () => value),
  });

function fixture() {
  const userId = new Types.ObjectId();
  const jobId = new Types.ObjectId();
  const key = `users/${userId}/jobs/${jobId}/input/source.mp3`;
  const orphanKey = `users/${userId}/jobs/${jobId}/attempts/orphan/vocals.mp3`;
  const job = {
    _id: jobId,
    userId,
    logicalAudioId: jobId,
    status: 'cancelled',
    revision: 3,
    requestId: '7d5ce9a1-cf27-4ca4-9b75-f88ba8c36e99',
    requestHash: 'b'.repeat(64),
    deletedAt: cleanupAt,
    cleanupCompletedAt: cleanupAt,
    retentionNextAt: new Date(now.getTime() + 3_600_000),
    cleanupToken: null,
    cleanupNextAt: null,
    currentExecution: null,
    inputReservation: { key },
    inputObject: null,
    outputObject: null,
  };
  const attempt = {
    _id: 'a51967dd-a677-49b6-ac5e-61052a5d727e',
    jobId,
    state: 'lost',
    finishedAt: cleanupAt,
    outputReservation: { key: orphanKey, grantExpiresAt: cleanupAt },
    outputObject: null,
  };
  const outbox = {
    _id: new Types.ObjectId(),
    jobId,
    state: 'completed',
    completedAt: cleanupAt,
    leaseId: null,
    leaseExpiresAt: null,
  };
  const attempts = {
    find: vi.fn(() => query([attempt])),
    exists: vi.fn(() => query(null)),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 1 }),
  };
  const slots = { exists: vi.fn(() => query(null)) };
  const cleanup = { exists: vi.fn(() => query(null)) };
  const reservations = { exists: vi.fn(() => query(null)) };
  const events = {
    find: vi.fn(() => query([outbox])),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 1 }),
  };
  const deliveries = {
    exists: vi.fn(() => query(null)),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 1 }),
  };
  const error = {
    _id: new Types.ObjectId(),
    jobId,
    retentionNextAt: job.retentionNextAt,
  };
  const errors = {
    findOneAndUpdate: vi.fn(() => query(error)),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ deletedCount: 1 }),
  };
  const receipts = {
    updateOne: vi.fn().mockResolvedValue({ upsertedCount: 1 }),
  };
  const models: Record<string, unknown> = {
    WorkerAttempt: attempts,
    WorkerSlot: slots,
    StorageCleanupTask: cleanup,
    ProcessingReservation: reservations,
    NotificationOutbox: events,
    NotificationDelivery: deliveries,
    JobError: errors,
    PurgedJobRequest: receipts,
  };
  const jobs = {
    findOneAndUpdate: vi.fn(() => query(job)),
    findOne: vi.fn(() => query(job)),
    findById: vi.fn(() => query(job)),
    exists: vi.fn(() => query(null)),
    deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    db: { model: vi.fn((name: string) => models[name]) },
  };
  const session = {};
  const transactions = {
    run: vi.fn((operation: (session: any) => Promise<unknown>) =>
      operation(session),
    ),
  };
  const storage = { deleteObject: vi.fn().mockResolvedValue(undefined) };
  const service = new JobRetentionService(
    jobs as never,
    transactions as never,
    storage as never,
  );
  return {
    service,
    job,
    attempt,
    outbox,
    error,
    jobs,
    attempts,
    slots,
    cleanup,
    reservations,
    events,
    deliveries,
    errors,
    receipts,
    storage,
  };
}

describe('coordinated deleted job retention', () => {
  it.each(['private', 'shared'] as const)(
    'purges shared job metadata while preserving shared assets and cleaning %s attempts',
    async (attemptStorage) => {
      const f = fixture();
      const prefix = `shared/url/${'a'.repeat(64)}/2f237a2e-031e-4b58-b9a7-9f9e7c0e31a9`;
      const privateAttemptKey = f.attempt.outputReservation.key;
      Object.assign(f.job, {
        inputReservation: { key: `${prefix}/input/source.mp3` },
        inputObject: { key: `${prefix}/input/source.mp3` },
        outputObject: { key: `${prefix}/output/vocals.mp3` },
      });
      Object.assign(f.attempt, {
        outputObject: { key: `${prefix}/output/vocals.mp3` },
      });
      if (attemptStorage === 'shared')
        f.attempt.outputReservation.key = `${prefix}/output/vocals.mp3`;

      await expect(f.service.purgeDue(now)).resolves.toBe(true);

      expect(f.storage.deleteObject.mock.calls.map(([key]) => key)).toEqual(
        attemptStorage === 'private' ? [privateAttemptKey] : [],
      );
      expect(f.jobs.deleteOne).toHaveBeenCalledOnce();
      expect(f.attempts.deleteMany).toHaveBeenCalledOnce();
      expect(f.receipts.updateOne).toHaveBeenCalledOnce();
    },
  );

  it('purges deleted jobs after30 days of confirmed cleanup and retains compact replay proof atomically', async () => {
    const f = fixture();
    await expect(f.service.purgeDue(now)).resolves.toBe(true);
    expect(f.jobs.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        deletedAt: expect.objectContaining({ $type: 'date' }),
        cleanupCompletedAt: expect.objectContaining({
          $type: 'date',
          $lte: new Date('2026-08-31T12:00:00Z'),
        }),
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(f.storage.deleteObject.mock.calls.map(([key]) => key)).toEqual([
      f.job.inputReservation.key,
      f.attempt.outputReservation.key,
    ]);
    expect(f.receipts.updateOne).toHaveBeenCalledWith(
      { accountId: f.job.userId, requestId: f.job.requestId },
      {
        $setOnInsert: expect.objectContaining({
          requestHash: f.job.requestHash,
          purgedAt: now,
        }),
      },
      expect.objectContaining({ session: expect.anything() }),
    );
    expect(f.receipts.updateOne.mock.invocationCallOrder[0]).toBeLessThan(
      f.jobs.deleteOne.mock.invocationCallOrder[0]!,
    );
    expect(f.jobs.deleteOne).toHaveBeenCalledOnce();
    expect(f.attempts.deleteMany).toHaveBeenCalledOnce();
    expect(f.errors.deleteMany).toHaveBeenCalledOnce();
    expect(f.events.deleteMany).toHaveBeenCalledOnce();
    expect(f.deliveries.deleteMany).toHaveBeenCalledOnce();
  });

  it.each([
    'jobExecution',
    'activeAttempt',
    'slot',
    'liveRoot',
    'sharedArtifact',
    'reservation',
    'cleanup',
    'outbox',
    'grant',
    'retainedBytes',
  ])(
    'retains the job and artifact references when %s remains',
    async (dependency) => {
      const f = fixture();
      if (dependency === 'jobExecution')
        Object.assign(f.job, {
          currentExecution: { attemptId: f.attempt._id },
        });
      if (dependency === 'activeAttempt') f.attempt.state = 'running';
      if (dependency === 'slot')
        f.slots.exists.mockReturnValue(query({ _id: 'busy-slot' }));
      if (dependency === 'liveRoot' || dependency === 'sharedArtifact')
        f.jobs.exists.mockReturnValue(query({ _id: new Types.ObjectId() }));
      if (dependency === 'reservation')
        f.reservations.exists.mockReturnValue(query({ _id: f.job._id }));
      if (dependency === 'cleanup')
        f.cleanup.exists.mockReturnValue(query({ _id: new Types.ObjectId() }));
      if (dependency === 'outbox') f.outbox.state = 'dispatching';
      if (dependency === 'grant')
        f.attempt.outputReservation.grantExpiresAt = new Date(
          now.getTime() + 60_000,
        );
      if (dependency === 'retainedBytes')
        Object.assign(f.job, {
          outputObject: { key: 'output' },
          retainedOutputAccountedAt: cleanupAt,
          retainedOutputReleasedAt: null,
        });
      await f.service.purgeDue(now);
      expect(f.storage.deleteObject).not.toHaveBeenCalled();
      expect(f.jobs.deleteOne).not.toHaveBeenCalled();
      expect(f.attempts.deleteMany).not.toHaveBeenCalled();
      expect(f.receipts.updateOne).not.toHaveBeenCalled();
    },
  );

  it('keeps all durable references when storage cleanup is incomplete', async () => {
    const f = fixture();
    f.storage.deleteObject.mockRejectedValue(new Error('Storage unavailable'));
    await f.service.purgeDue(now);
    expect(f.jobs.deleteOne).not.toHaveBeenCalled();
    expect(f.attempts.deleteMany).not.toHaveBeenCalled();
  });
  it('closes legacy pending children under already completed deleted-job events before purging', async () => {
    const f = fixture();
    let pending = true;
    f.deliveries.exists.mockImplementation(() =>
      query(pending ? { _id: new Types.ObjectId() } : null),
    );
    f.deliveries.updateMany.mockImplementation(async () => {
      pending = false;
      return { modifiedCount: 1 };
    });
    await f.service.purgeDue(now);
    expect(f.events.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'completed',
        leaseId: null,
        leaseExpiresAt: null,
      }),
      { $inc: { revision: 1 } },
      expect.objectContaining({ session: expect.anything() }),
    );
    expect(f.deliveries.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
      {
        $set: {
          status: 'ineligible',
          lastFailureKind: 'ineligible',
          failedAt: now,
        },
      },
      expect.objectContaining({ session: expect.anything() }),
    );
    expect(f.jobs.deleteOne).toHaveBeenCalledOnce();
  });
  it('rechecks references after object cleanup before removing durable ownership', async () => {
    const f = fixture();
    f.jobs.exists
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query({ _id: new Types.ObjectId() }));
    await f.service.purgeDue(now);
    expect(f.storage.deleteObject).toHaveBeenCalled();
    expect(f.jobs.deleteOne).not.toHaveBeenCalled();
  });
  it('has no purge work when only retained Library or recent deleted jobs exist', async () => {
    const f = fixture();
    f.jobs.findOneAndUpdate.mockReturnValue(query(null));
    await expect(f.service.purgeDue(now)).resolves.toBe(false);
    expect(f.storage.deleteObject).not.toHaveBeenCalled();
  });
});

describe('finalized job error retention', () => {
  it('arms90-day TTL only once a terminal job and its notification children have finished', async () => {
    const f = fixture();
    await f.service.finalizeErrorDue(now);
    expect(f.errors.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ finalizedAt: null }),
      {
        $set: {
          finalizedAt: now,
          purgeAt: new Date('2026-12-29T12:00:00Z'),
          retentionNextAt: null,
        },
      },
      expect.objectContaining({ session: expect.anything() }),
    );
  });
  it.each(['activeJob', 'execution', 'attempt', 'outbox', 'delivery'])(
    'does not arm TTL while %s is unfinished',
    async (dependency) => {
      const f = fixture();
      Object.assign(f.job, { deletedAt: null });
      if (dependency === 'activeJob') f.job.status = 'processing';
      if (dependency === 'execution')
        Object.assign(f.job, {
          currentExecution: { attemptId: f.attempt._id },
        });
      if (dependency === 'attempt')
        f.attempts.exists.mockReturnValue(query({ _id: f.attempt._id }));
      if (dependency === 'outbox') f.outbox.state = 'pending';
      if (dependency === 'delivery')
        f.deliveries.exists.mockReturnValue(
          query({ _id: new Types.ObjectId() }),
        );
      await f.service.finalizeErrorDue(now);
      expect(f.errors.updateOne).not.toHaveBeenCalled();
    },
  );
});

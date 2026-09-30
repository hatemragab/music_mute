import { Types, type Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type { Job } from '../jobs/job.schema.js';
import type { ProcessingTransactions } from './processing-transactions.js';
import type { StorageCleanupService } from '../storage/storage-cleanup.service.js';
import { ProcessingStorageCleanupService } from './processing-storage-cleanup.service.js';

const query = <T>(value: T) => ({
  sort() {
    return this;
  },
  lean: async () => value,
});

function fixture() {
  const jobs = {
    db: {
      model: () => ({
        findById: () => ({ session: async () => null }),
      }),
    },
    findOne: vi.fn(),
    updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
  };
  const cleanup = { schedule: vi.fn(async () => undefined) };
  const usage = { settleJob: vi.fn(async () => undefined) };
  const session = { fixture: true };
  const transactions = {
    run: <T>(action: (session: unknown) => Promise<T>) => action(session),
  };
  const service = new ProcessingStorageCleanupService(
    jobs as unknown as Model<Job>,
    transactions as unknown as ProcessingTransactions,
    cleanup as unknown as StorageCleanupService,
    usage as never,
  );
  return { service, jobs, cleanup, usage, session };
}

describe('ProcessingStorageCleanupService', () => {
  const now = new Date('2026-09-12T00:30:00.000Z');
  const owner = new Types.ObjectId('507f1f77bcf86cd799439011');
  const sharedKey = `shared/url/${'a'.repeat(64)}/2f237a2e-031e-4b58-b9a7-9f9e7c0e31a9/input/source.mp3`;

  it.each(['shared', 'private'] as const)(
    'releases a failed shared-input reference while cleaning only %s scratch reservations',
    async (reservationStorage) => {
      const { service, jobs, cleanup } = fixture();
      const reservationKey =
        reservationStorage === 'shared'
          ? sharedKey
          : `users/${owner}/jobs/failed/input/source.mp3`;
      const job = {
        _id: new Types.ObjectId(),
        userId: owner,
        revision: 5,
        status: 'failed',
        reservationCleanupScheduledAt: null,
        inputReservation: { key: reservationKey },
        inputObject: { key: sharedKey },
        admissionSnapshot: null,
      };
      jobs.findOne.mockReturnValue(query(job));

      await expect(service.scheduleDue(now)).resolves.toBe(true);

      expect(cleanup.schedule).toHaveBeenCalledTimes(
        reservationStorage === 'private' ? 1 : 0,
      );
      if (reservationStorage === 'private')
        expect(cleanup.schedule).toHaveBeenCalledWith(
          expect.objectContaining({ key: reservationKey }),
          expect.anything(),
        );
      expect(jobs.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: job._id, revision: job.revision }),
        { $set: { reservationCleanupScheduledAt: now } },
        expect.anything(),
      );
    },
  );

  it('settles an expired shared reservation without scheduling R2 deletion', async () => {
    const { service, jobs, cleanup, usage } = fixture();
    const job = {
      _id: new Types.ObjectId(),
      userId: owner,
      revision: 3,
      status: 'awaiting_upload',
      inputReservation: { key: sharedKey },
      admissionSnapshot: {
        reservationExpiresAt: new Date('2026-09-12T00:15:00.000Z'),
      },
    };
    jobs.findOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(job));

    await expect(service.scheduleDue(now)).resolves.toBe(true);

    expect(cleanup.schedule).not.toHaveBeenCalled();
    expect(usage.settleJob).toHaveBeenCalledWith(
      expect.objectContaining({ _id: job._id, status: 'failed' }),
      expect.anything(),
    );
  });

  it('schedules a cancelled unconfirmed upload after its last grant can settle', async () => {
    const { service, jobs, cleanup, session } = fixture();
    const job = {
      _id: new Types.ObjectId('507f1f77bcf86cd799439013'),
      userId: owner,
      revision: 4,
      status: 'cancelled',
      finishedAt: now,
      inputObject: null,
      reservationCleanupScheduledAt: null,
      inputReservation: {
        key: `users/${owner.toHexString()}/jobs/cancelled/input/file.mp3`,
      },
      admissionSnapshot: {
        reservationExpiresAt: new Date('2026-09-12T00:35:00.000Z'),
      },
    };
    jobs.findOne.mockReturnValue(query(job));

    await expect(service.scheduleDue(now)).resolves.toBe(true);

    expect(cleanup.schedule).toHaveBeenCalledWith(
      {
        key: job.inputReservation.key,
        ownerUserId: owner,
        reason: 'AUDIO_INPUT_TERMINAL',
        nextAt: new Date('2026-09-12T00:40:00.000Z'),
        settleUntil: new Date('2026-09-12T01:40:00.000Z'),
      },
      session,
    );
    expect(jobs.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: job._id,
        status: 'cancelled',
        reservationCleanupScheduledAt: null,
      }),
      { $set: { reservationCleanupScheduledAt: now } },
      expect.objectContaining({ session }),
    );
  });

  it('schedules a cancelled terminal input by its unique key after transfer settlement', async () => {
    const { service, jobs, cleanup, session } = fixture();
    const job = {
      _id: new Types.ObjectId('507f1f77bcf86cd799439014'),
      userId: owner,
      revision: 5,
      status: 'cancelled',
      finishedAt: now,
      reservationCleanupScheduledAt: null,
      inputReservation: {
        key: `users/${owner.toHexString()}/jobs/cancelled/input/file.mp3`,
      },
      inputObject: {
        key: `users/${owner.toHexString()}/jobs/cancelled/input/file.mp3`,
        etag: '"immutable-input-version"',
      },
      admissionSnapshot: null,
    };
    jobs.findOne.mockReturnValue(query(job));

    await expect(service.scheduleDue(now)).resolves.toBe(true);

    expect(cleanup.schedule).toHaveBeenCalledWith(
      {
        key: job.inputObject.key,
        ownerUserId: owner,
        reason: 'AUDIO_INPUT_TERMINAL',
        nextAt: new Date('2026-09-12T00:35:00.000Z'),
        settleUntil: new Date('2026-09-12T01:35:00.000Z'),
      },
      session,
    );
  });

  it('fails an expired unconfirmed input and schedules its exact key atomically', async () => {
    const { service, jobs, cleanup, session } = fixture();
    const job = {
      _id: new Types.ObjectId('507f1f77bcf86cd799439012'),
      userId: owner,
      revision: 3,
      status: 'awaiting_upload',
      inputReservation: {
        key: `users/${owner.toHexString()}/jobs/job/input/file.mp3`,
      },
      admissionSnapshot: {
        reservationExpiresAt: new Date('2026-09-12T00:15:00.000Z'),
      },
    };
    jobs.findOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query(job));
    await expect(service.scheduleDue(now)).resolves.toBe(true);
    expect(cleanup.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        key: job.inputReservation.key,
        ownerUserId: owner,
        reason: 'AUDIO_INPUT_EXPIRED',
        nextAt: new Date('2026-09-12T00:20:00.000Z'),
        settleUntil: new Date('2026-09-12T01:20:00.000Z'),
      }),
      session,
    );
    expect(jobs.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: job._id, status: 'awaiting_upload' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'failed',
          reservationCleanupScheduledAt: now,
          lastError: expect.objectContaining({ code: 'UPLOAD_EXPIRED' }),
        }),
      }),
      expect.objectContaining({ session }),
    );
  });

  it('excludes successful jobs from terminal input cleanup', async () => {
    const { service, jobs, cleanup } = fixture();
    jobs.findOne.mockReturnValue(query(null));
    await service.scheduleDue(now);
    expect(jobs.findOne.mock.calls[0][0].$or).toEqual([
      { status: 'cancelled' },
      {
        status: 'failed',
        'retryEligibility.eligible': expect.objectContaining({ $ne: true }),
      },
    ]);
    expect(cleanup.schedule).not.toHaveBeenCalled();
  });

  it('returns false when no input reservation has expired', async () => {
    const { service, jobs, cleanup } = fixture();
    jobs.findOne.mockReturnValue(query(null));
    await expect(service.scheduleDue(now)).resolves.toBe(false);
    expect(cleanup.schedule).not.toHaveBeenCalled();
    expect(jobs.updateOne).not.toHaveBeenCalled();
  });
});

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
    jobs.findOne.mockReturnValue(query(job));
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

  it('returns false when no input reservation has expired', async () => {
    const { service, jobs, cleanup } = fixture();
    jobs.findOne.mockReturnValue(query(null));
    await expect(service.scheduleDue(now)).resolves.toBe(false);
    expect(cleanup.schedule).not.toHaveBeenCalled();
    expect(jobs.updateOne).not.toHaveBeenCalled();
  });
});

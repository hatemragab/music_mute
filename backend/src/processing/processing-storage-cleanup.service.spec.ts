import { ConfigService } from '@nestjs/config';
import { Types, type Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type { JobAttempt } from '../jobs/job-attempt.schema.js';
import type { Job } from '../jobs/job.schema.js';
import type { ProcessingTransactions } from './processing-transactions.js';
import type { StorageCleanupService } from '../storage/storage-cleanup.service.js';
import { ProcessingStorageCleanupService } from './processing-storage-cleanup.service.js';

const query = <T>(value: T) => ({
  sort() {
    return this;
  },
  session() {
    return this;
  },
  lean: async () => value,
});

const referenceQuery = (value: { _id: Types.ObjectId } | null = null) => ({
  session: vi.fn(async (): Promise<{ _id: Types.ObjectId } | null> => value),
});

function fixture() {
  const jobs = {
    db: { model: () => ({ findById: () => ({ session: async () => null }) }) },
    findOne: vi.fn(),
    updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    exists: vi.fn(() => referenceQuery()),
  };
  const attempts = {
    findOne: vi.fn(),
    updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
  };
  const cleanup = { schedule: vi.fn(async () => undefined) };
  const session = { fixture: true };
  const transactions = {
    run: <T>(action: (session: unknown) => Promise<T>) => action(session),
  };
  const service = new ProcessingStorageCleanupService(
    jobs as unknown as Model<Job>,
    attempts as unknown as Model<JobAttempt>,
    transactions as unknown as ProcessingTransactions,
    cleanup as unknown as StorageCleanupService,
    new ConfigService({ PROCESSING_URL_SECONDS: 900 }),
  );
  return { service, jobs, attempts, cleanup, session };
}

describe('ProcessingStorageCleanupService', () => {
  const now = new Date('2026-09-12T00:30:00.000Z');
  const owner = new Types.ObjectId('507f1f77bcf86cd799439011');

  it('fails an expired unconfirmed input and schedules its exact key atomically', async () => {
    const { service, jobs, attempts, cleanup, session } = fixture();
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
    attempts.findOne.mockReturnValue(query(null));

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

  it('schedules terminal attempt output only when no confirmed object references it', async () => {
    const { service, jobs, attempts, cleanup, session } = fixture();
    jobs.findOne.mockReturnValue(query(null));
    const attempt = {
      _id: new Types.ObjectId('507f1f77bcf86cd799439013'),
      jobId: new Types.ObjectId('507f1f77bcf86cd799439012'),
      outcome: 'failed',
      endedAt: new Date('2026-09-12T00:10:00.000Z'),
      outputReservation: {
        key: `users/${owner.toHexString()}/jobs/job/output/attempt/vocals.mp3`,
      },
    };
    attempts.findOne.mockReturnValue(query(attempt));

    await expect(service.scheduleDue(now)).resolves.toBe(true);

    expect(jobs.exists).toHaveBeenCalledWith(
      expect.objectContaining({
        'outputObject.key': attempt.outputReservation.key,
      }),
    );
    expect(cleanup.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        key: attempt.outputReservation.key,
        ownerUserId: owner,
        reason: 'AUDIO_OUTPUT_ORPHANED',
      }),
      session,
    );
    expect(attempts.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: attempt._id, cleanupScheduledAt: null }),
      { $set: { cleanupScheduledAt: now } },
      { session },
    );
  });

  it('never schedules an output key already pinned by a job', async () => {
    const { service, jobs, attempts, cleanup } = fixture();
    jobs.findOne.mockReturnValue(query(null));
    jobs.exists.mockReturnValueOnce(
      referenceQuery({ _id: new Types.ObjectId() }),
    );
    attempts.findOne.mockReturnValue(
      query({
        _id: new Types.ObjectId('507f1f77bcf86cd799439013'),
        outcome: 'ready',
        endedAt: new Date('2026-09-12T00:10:00.000Z'),
        outputReservation: {
          key: `users/${owner.toHexString()}/jobs/job/output/attempt/vocals.mp3`,
        },
      }),
    );

    await expect(service.scheduleDue(now)).resolves.toBe(true);

    expect(cleanup.schedule).not.toHaveBeenCalled();
    expect(attempts.updateOne).toHaveBeenCalledOnce();
  });
});

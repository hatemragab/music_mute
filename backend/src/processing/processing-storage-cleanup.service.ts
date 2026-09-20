import { ProcessingUsageService } from '../processing-usage/processing-usage.service.js';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trusted, type Model } from 'mongoose';
import { safeJobMessage } from '../job-errors/safe-job-error.js';
import { Job } from '../jobs/job.schema.js';
import { StorageCleanupService } from '../storage/storage-cleanup.service.js';
import { ProcessingTransactions } from './processing-transactions.js';

const UPLOAD_EXPIRY_GRACE_MS = 300_000;
const VERSION_SETTLEMENT_MS = 3_600_000;

@Injectable()
export class ProcessingStorageCleanupService {
  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    private readonly transactions: ProcessingTransactions,
    private readonly cleanup: StorageCleanupService,
    private readonly usage: ProcessingUsageService,
  ) {}

  /** Schedules one expired reservation of each kind in bounded transactions. */
  async scheduleDue(now = new Date()): Promise<boolean> {
    return (
      (await this.scheduleTerminalInput(now)) ||
      (await this.scheduleExpiredInput(now))
    );
  }

  private async scheduleTerminalInput(now: Date): Promise<boolean> {
    const candidate = await this.jobs
      .findOne({
        $or: [
          { status: trusted({ $in: ['ready', 'cancelled'] }) },
          {
            status: 'failed',
            'retryEligibility.eligible': trusted({ $ne: true }),
          },
        ],
        reservationCleanupScheduledAt: null,
      })
      .sort({ finishedAt: 1, _id: 1 })
      .lean();
    if (!candidate) return false;
    return this.transactions.run(async (session) => {
      const known = candidate.inputObject;
      const reservationExpiry =
        candidate.admissionSnapshot?.reservationExpiresAt.getTime() ??
        now.getTime();
      const due = known
        ? now
        : new Date(
            Math.max(now.getTime(), reservationExpiry + UPLOAD_EXPIRY_GRACE_MS),
          );
      await this.cleanup.schedule(
        {
          key: known?.key ?? candidate.inputReservation.key,
          versionId: known?.versionId ?? null,
          ownerUserId: candidate.userId,
          reason: 'AUDIO_INPUT_TERMINAL',
          nextAt: due,
          settleUntil: known
            ? due
            : new Date(due.getTime() + VERSION_SETTLEMENT_MS),
        },
        session,
      );
      const changed = await this.jobs.updateOne(
        {
          _id: candidate._id,
          status: candidate.status,
          reservationCleanupScheduledAt: null,
          revision: candidate.revision,
        },
        { $set: { reservationCleanupScheduledAt: now } },
        { session, runValidators: true },
      );
      if (changed.modifiedCount !== 1)
        throw new Error('Terminal input changed while scheduling cleanup');
      return true;
    });
  }

  private async scheduleExpiredInput(now: Date): Promise<boolean> {
    const cutoff = new Date(now.getTime() - UPLOAD_EXPIRY_GRACE_MS);
    const candidate = await this.jobs
      .findOne({
        status: 'awaiting_upload',
        inputObject: null,
        reservationCleanupScheduledAt: null,
        'admissionSnapshot.reservationExpiresAt': trusted({ $lte: cutoff }),
      })
      .sort({ 'admissionSnapshot.reservationExpiresAt': 1, _id: 1 })
      .lean();
    if (!candidate?.admissionSnapshot) return false;
    return this.transactions.run(async (session) => {
      const due = new Date(
        candidate.admissionSnapshot!.reservationExpiresAt.getTime() +
          UPLOAD_EXPIRY_GRACE_MS,
      );
      await this.cleanup.schedule(
        {
          key: candidate.inputReservation.key,
          ownerUserId: candidate.userId,
          reason: 'AUDIO_INPUT_EXPIRED',
          nextAt: due,
          settleUntil: new Date(due.getTime() + VERSION_SETTLEMENT_MS),
        },
        session,
      );
      const changed = await this.jobs.updateOne(
        {
          _id: candidate._id,
          status: 'awaiting_upload',
          inputObject: null,
          reservationCleanupScheduledAt: null,
          revision: candidate.revision,
        },
        {
          $set: {
            status: 'failed',
            finishedAt: now,
            reservationCleanupScheduledAt: now,
            lastError: {
              code: 'UPLOAD_EXPIRED',
              message: safeJobMessage('UPLOAD_EXPIRED'),
              at: now,
            },
          },
          $inc: { revision: 1 },
        },
        { session, runValidators: true },
      );
      if (changed.modifiedCount !== 1)
        throw new Error('Expired upload changed while scheduling cleanup');
      await this.usage.settleJob({ ...candidate, status: 'failed' }, session);
      return true;
    });
  }
}

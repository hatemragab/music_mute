import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { trusted, Types, type Model } from 'mongoose';
import { safeJobMessage } from '../job-errors/safe-job-error.js';
import { JobAttempt } from '../jobs/job-attempt.schema.js';
import { Job } from '../jobs/job.schema.js';
import { StorageCleanupService } from '../storage/storage-cleanup.service.js';
import { ProcessingTransactions } from './processing-transactions.js';

const UPLOAD_EXPIRY_GRACE_MS = 300_000;
const VERSION_SETTLEMENT_MS = 3_600_000;

@Injectable()
export class ProcessingStorageCleanupService {
  private readonly outputGrantGraceMs: number;

  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    @InjectModel(JobAttempt.name)
    private readonly attempts: Model<JobAttempt>,
    private readonly transactions: ProcessingTransactions,
    private readonly cleanup: StorageCleanupService,
    config: ConfigService,
  ) {
    this.outputGrantGraceMs =
      config.getOrThrow<number>('PROCESSING_URL_SECONDS') * 1_000 +
      UPLOAD_EXPIRY_GRACE_MS;
  }

  /** Schedules one expired reservation of each kind in bounded transactions. */
  async scheduleDue(now = new Date()): Promise<boolean> {
    const input = await this.scheduleExpiredInput(now);
    const output = await this.scheduleOrphanedOutput(now);
    return input || output;
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
      return true;
    });
  }

  private async scheduleOrphanedOutput(now: Date): Promise<boolean> {
    const cutoff = new Date(now.getTime() - this.outputGrantGraceMs);
    const candidate = await this.attempts
      .findOne({
        cleanupScheduledAt: null,
        outcome: trusted({
          $in: ['ready', 'failed', 'cancelled', 'interrupted'],
        }),
        endedAt: trusted({ $ne: null, $lte: cutoff }),
        'outputReservation.key': trusted({ $exists: true }),
      })
      .sort({ endedAt: 1, _id: 1 })
      .lean();
    if (!candidate?.endedAt || !candidate.outputReservation) return false;
    return this.transactions.run(async (session) => {
      const key = candidate.outputReservation!.key;
      const reference = await this.jobs
        .exists({ 'outputObject.key': key })
        .session(session);
      if (!reference) {
        const ownerHex = /^users\/([a-f0-9]{24})\/jobs\//.exec(key)?.[1];
        if (!ownerHex) throw new Error('Invalid output artifact ownership');
        const due = new Date(
          candidate.endedAt!.getTime() + this.outputGrantGraceMs,
        );
        await this.cleanup.schedule(
          {
            key,
            ownerUserId: new Types.ObjectId(ownerHex),
            reason: 'AUDIO_OUTPUT_ORPHANED',
            nextAt: due,
            settleUntil: new Date(due.getTime() + VERSION_SETTLEMENT_MS),
          },
          session,
        );
      }
      const changed = await this.attempts.updateOne(
        { _id: candidate._id, cleanupScheduledAt: null },
        { $set: { cleanupScheduledAt: now } },
        { session },
      );
      if (changed.modifiedCount !== 1)
        throw new Error('Attempt changed while scheduling cleanup');
      return true;
    });
  }
}

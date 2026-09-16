import { ProcessingSettings } from '../admin-settings/processing-settings.schema.js';
import { effectiveAllowance } from './processing-allowance.js';
import { User } from '../users/user.schema.js';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trusted, type ClientSession, type Model, type Types } from 'mongoose';
import { ProcessingUsageLedger } from './processing-usage.schema.js';
import { summarizeUsage } from './usage-accounting.js';
import { jobError } from '../jobs/job-errors.js';
import { Job } from '../jobs/job.schema.js';
import { ACTIVE_ADMISSION_STATUSES } from '../jobs/job-state.js';

@Injectable()
export class ProcessingUsageService {
  constructor(
    @InjectModel(ProcessingUsageLedger.name)
    private readonly ledger: Model<ProcessingUsageLedger>,
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
  ) {}

  async readUsage(userId: Types.ObjectId, session?: ClientSession) {
    const now = new Date();
    const entries = await this.ledger
      .find({
        userId,
        $or: [
          { state: 'reserved' },
          { state: 'pending', expiresAt: null },
          { state: 'pending', expiresAt: trusted({ $gt: now }) },
          { state: 'used', expiresAt: trusted({ $gt: now }) },
        ],
      })
      .session(session ?? null)
      .maxTimeMS(5000)
      .lean();
    const user = await this.jobs.db
      .model<User>(User.name)
      .findById(userId)
      .session(session ?? null)
      .maxTimeMS(5000)
      .lean();
    if (!user) throw jobError('PROCESSING_UNAVAILABLE');
    const legacySettings = await this.jobs.db
      .model<ProcessingSettings>(ProcessingSettings.name)
      .findById('processing')
      .session(session ?? null)
      .maxTimeMS(5000)
      .lean();
    const allowanceAudioSeconds = effectiveAllowance(user, now);
    const summary = summarizeUsage(entries, allowanceAudioSeconds, now);
    const activeJobs = await this.jobs
      .countDocuments({
        userId,
        status: trusted({ $in: ACTIVE_ADMISSION_STATUSES }),
      })
      .session(session ?? null);
    return {
      policyRevision: legacySettings?.revision ?? 0,
      allowanceAudioSeconds,
      ...summary,
      activeJobs,
      maxActiveJobs: legacySettings?.maxActiveJobsPerUser ?? 1,
      nextReplenishmentAt: summary.replenishments[0]?.at ?? null,
      availability: 'paused' as const,
      checkedAt: now.toISOString(),
    };
  }

  /** Caller holds the existing owner and global admission fences in this transaction. */
  async reserveForJob(
    jobId: Types.ObjectId,
    userId: Types.ObjectId,
    duration: number,
    session: ClientSession,
  ) {
    if (!session.inTransaction())
      throw new Error('Usage admission requires a transaction');
    const audioSeconds = Math.ceil(duration);
    if (
      !Number.isSafeInteger(audioSeconds) ||
      audioSeconds < 1 ||
      audioSeconds > 1800
    )
      throw jobError('MEDIA_TOO_LONG');
    const existing = await this.ledger.findById(jobId).session(session).lean();
    if (existing) {
      if (
        !existing.userId.equals(userId) ||
        existing.audioSeconds !== audioSeconds
      )
        throw jobError('IDEMPOTENCY_CONFLICT');
      return;
    }
    const usage = await this.readUsage(userId, session);
    if (usage.remainingAudioSeconds < audioSeconds)
      throw jobError('PROCESSING_ALLOWANCE_EXHAUSTED', {
        nextReplenishmentAt: usage.nextReplenishmentAt,
      });
    await this.ledger.create(
      [
        {
          _id: jobId,
          userId,
          audioSeconds,
          allowanceAudioSeconds: usage.allowanceAudioSeconds,
          state: 'reserved',
          createdAt: new Date(),
        },
      ],
      { session },
    );
  }

  async reconcileMeasured(job: Job, duration: number, session: ClientSession) {
    const entry = await this.ledger.findById(job._id).session(session);
    if (!entry) return; // Accepted pre-ledger jobs keep their existing contract.
    const audioSeconds = Math.ceil(duration);
    if (
      !Number.isSafeInteger(audioSeconds) ||
      audioSeconds <= 0 ||
      audioSeconds > 1800
    )
      throw jobError('MEDIA_TOO_LONG');
    const usage = await this.readUsage(job.userId, session);
    if (
      audioSeconds - entry.audioSeconds >
      Math.max(
        0,
        entry.allowanceAudioSeconds -
          usage.reservedAudioSeconds -
          usage.usedAudioSeconds,
      )
    )
      throw jobError('PROCESSING_ALLOWANCE_EXHAUSTED', {
        nextReplenishmentAt: usage.nextReplenishmentAt,
      });
    entry.audioSeconds = audioSeconds;
    await entry.save({ session });
  }

  async settleJob(job: Job, session: ClientSession) {
    const entry = await this.ledger.findById(job._id).session(session);
    if (!entry || !['reserved', 'pending'].includes(entry.state)) return;
    if (
      job.status === 'ready' ||
      (job.status === 'cancelled' && job.uploadingResultAt)
    ) {
      if (!job.processingStartedAt || !job.measuredDurationSeconds) return;
      entry.state = 'used';
      entry.audioSeconds = Math.ceil(job.measuredDurationSeconds);
      entry.expiresAt = new Date(job.processingStartedAt.getTime() + 86400_000);
      entry.purgeAt = new Date(
        Math.max(Date.now(), entry.expiresAt.getTime()) + 86400_000,
      );
    } else if (
      job.status === 'failed' ||
      (job.status === 'cancelled' && !job.processingStartedAt)
    ) {
      entry.state = 'released';
      entry.purgeAt = new Date(Date.now() + 2 * 86400_000);
    } else if (job.status === 'cancelled') {
      entry.state = 'pending';
      entry.expiresAt ??= new Date(Date.now() + 86400_000);
      entry.purgeAt = new Date(entry.expiresAt.getTime() + 86400_000);
    } else return;
    await entry.save({ session });
  }
}

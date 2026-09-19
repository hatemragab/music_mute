import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { trusted, type ClientSession, type Model, type Types } from 'mongoose';
import { AccountPolicyService } from '../admin-settings/account-policy.service.js';
import { Job } from '../jobs/job.schema.js';
import { jobError } from '../jobs/job-errors.js';
import { ACTIVE_ADMISSION_STATUSES } from '../jobs/job-state.js';
import { User } from '../users/user.schema.js';
import {
  AccountUsagePeriod,
  ProcessingReservation,
} from './processing-usage.schema.js';
import {
  summarizeMonthlyProcessing,
  usagePeriodId,
  utcMonthPeriod,
} from './usage-accounting.js';

const emptyCounters = () => ({
  processingUsedSeconds: 0,
  processingReservedSeconds: 0,
  processingReservationCount: 0,
  processingReleasedSeconds: 0,
  uploadGrants: 0,
  confirmedUploadBytes: 0,
  downloadGrants: 0,
  estimatedDownloadBytes: 0,
  revision: 0,
});

@Injectable()
export class ProcessingUsageService {
  constructor(
    @InjectModel(AccountUsagePeriod.name)
    private readonly periods: Model<AccountUsagePeriod>,
    @InjectModel(ProcessingReservation.name)
    private readonly reservations: Model<ProcessingReservation>,
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly policies: AccountPolicyService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async readUsage(
    accountId: Types.ObjectId,
    session?: ClientSession,
    now = new Date(),
  ) {
    const userQuery = this.users.findById(accountId);
    if (session) userQuery.session(session);
    if (!(await userQuery.lean())) throw jobError('PROCESSING_UNAVAILABLE');

    const effective = await this.policies.effective(accountId, now, session);
    const period = utcMonthPeriod(now);
    let usageQuery = this.periods.findById(
      usagePeriodId(accountId, period.key),
    );
    if (session) usageQuery = usageQuery.session(session);
    const stored = await usageQuery.maxTimeMS(5000).lean();
    const counters = stored ?? emptyCounters();
    const processing = summarizeMonthlyProcessing(
      counters,
      effective.values.monthlyProcessingSeconds,
    );
    const activeJobs = await this.jobs
      .countDocuments({
        userId: accountId,
        deletedAt: null,
        status: trusted({ $in: ACTIVE_ADMISSION_STATUSES }),
      })
      .session(session ?? null);
    const processingEnabled =
      this.config?.get<boolean>('AUDIO_PROCESSING_ENABLED') ?? true;
    const availability =
      !processingEnabled || !effective.acceptNewJobs
        ? { status: 'blocked' as const, reason: 'paused' as const }
        : processing.remainingSeconds === 0
          ? {
              status: 'blocked' as const,
              reason: 'monthly_limit_reached' as const,
            }
          : activeJobs >= effective.values.maxProcessingJobs
            ? {
                status: 'blocked' as const,
                reason: 'active_job_limit' as const,
              }
            : { status: 'available' as const, reason: null };

    return {
      schemaVersion: 2 as const,
      plan: effective.plan,
      policyRevision: effective.globalRevision,
      overrideRevision: effective.overrideRevision,
      effectivePolicySource: effective.source,
      overrideExpiresAt: effective.overrideExpiresAt?.toISOString() ?? null,
      period: {
        key: period.key,
        start: period.start.toISOString(),
        end: period.end.toISOString(),
        nextResetAt: period.end.toISOString(),
      },
      processing: {
        limitSeconds: effective.values.monthlyProcessingSeconds,
        ...processing,
      },
      usageRevision: counters.revision,
      activeJobs,
      maxProcessingJobs: effective.values.maxProcessingJobs,
      availability,
      checkedAt: now.toISOString(),
    };
  }

  async reserveForJob(
    jobId: Types.ObjectId,
    accountId: Types.ObjectId,
    duration: number,
    session: ClientSession,
    now = new Date(),
  ) {
    this.assertTransaction(session);
    const processingSeconds = Math.ceil(duration);
    if (!Number.isSafeInteger(processingSeconds) || processingSeconds < 1)
      throw jobError('MEDIA_TOO_LONG');

    const existing = await this.reservations
      .findById(jobId)
      .session(session)
      .lean();
    if (existing) {
      if (
        !existing.accountId.equals(accountId) ||
        existing.processingSeconds !== processingSeconds
      )
        throw jobError('IDEMPOTENCY_CONFLICT');
      return existing;
    }

    const effective = await this.policies.effective(accountId, now, session);
    if (processingSeconds > effective.values.maxDurationSeconds)
      throw jobError('MEDIA_TOO_LONG');
    const period = utcMonthPeriod(now);
    const periodId = usagePeriodId(accountId, period.key);
    await this.ensurePeriod(accountId, periodId, period, session, now);
    const updated = await this.periods
      .findOneAndUpdate(
        {
          _id: periodId,
          $expr: {
            $lte: [
              {
                $add: [
                  '$processingUsedSeconds',
                  '$processingReservedSeconds',
                  processingSeconds,
                ],
              },
              effective.values.monthlyProcessingSeconds,
            ],
          },
        },
        {
          $inc: {
            processingReservedSeconds: processingSeconds,
            processingReservationCount: 1,
            revision: 1,
          },
          $set: { lastMutationAt: now, purgeAt: null },
        },
        { session, returnDocument: 'after', runValidators: true },
      )
      .lean();
    if (!updated)
      throw jobError('PROCESSING_ALLOWANCE_EXHAUSTED', {
        nextResetAt: period.end.toISOString(),
      });
    const [reservation] = await this.reservations.create(
      [
        {
          _id: jobId,
          accountId,
          periodKey: period.key,
          processingSeconds,
          state: 'reserved',
          globalPolicyRevision: effective.globalRevision,
          overrideRevision: effective.overrideRevision,
          acceptedLimitSeconds: effective.values.monthlyProcessingSeconds,
          createdAt: now,
          settledAt: null,
          purgeAt: null,
        },
      ],
      { session },
    );
    return reservation;
  }

  async reconcileMeasured(job: Job, duration: number, session: ClientSession) {
    this.assertTransaction(session);
    const reservation = await this.reservations
      .findById(job._id)
      .session(session);
    if (!reservation || reservation.state !== 'reserved') return;
    const processingSeconds = Math.ceil(duration);
    if (!Number.isSafeInteger(processingSeconds) || processingSeconds < 1)
      throw jobError('MEDIA_TOO_LONG');
    const delta = processingSeconds - reservation.processingSeconds;
    if (delta === 0) return;
    const periodId = usagePeriodId(job.userId, reservation.periodKey);
    const filter: Record<string, unknown> = { _id: periodId };
    if (delta > 0)
      filter.$expr = {
        $lte: [
          {
            $add: [
              '$processingUsedSeconds',
              '$processingReservedSeconds',
              delta,
            ],
          },
          reservation.acceptedLimitSeconds,
        ],
      };
    const updated = await this.periods.updateOne(
      filter,
      {
        $inc: { processingReservedSeconds: delta, revision: 1 },
        $set: { lastMutationAt: new Date() },
      },
      { session, runValidators: true },
    );
    if (updated.modifiedCount !== 1)
      throw jobError('PROCESSING_ALLOWANCE_EXHAUSTED');
    reservation.processingSeconds = processingSeconds;
    await reservation.save({ session });
  }

  async settleJob(job: Job, session: ClientSession, now = new Date()) {
    this.assertTransaction(session);
    const reservation = await this.reservations
      .findById(job._id)
      .session(session);
    if (!reservation || reservation.state !== 'reserved') return;
    if (!['ready', 'failed', 'cancelled'].includes(job.status)) return;
    const nextState = job.status === 'ready' ? 'used' : 'released';
    const period = this.periodForKey(reservation.periodKey);
    const changed = await this.reservations.updateOne(
      { _id: job._id, state: 'reserved' },
      {
        $set: {
          state: nextState,
          settledAt: now,
          purgeAt: period.purgeAt,
        },
      },
      { session, runValidators: true },
    );
    if (changed.modifiedCount !== 1) return;
    const counter =
      nextState === 'used'
        ? { processingUsedSeconds: reservation.processingSeconds }
        : { processingReleasedSeconds: reservation.processingSeconds };
    const usage = await this.periods
      .findOneAndUpdate(
        {
          _id: usagePeriodId(job.userId, reservation.periodKey),
          processingReservationCount: trusted({ $gt: 0 }),
        },
        {
          $inc: {
            processingReservedSeconds: -reservation.processingSeconds,
            processingReservationCount: -1,
            ...counter,
            revision: 1,
          },
          $set: { lastMutationAt: now },
        },
        { session, returnDocument: 'after', runValidators: true },
      )
      .lean();
    if (!usage) throw new Error('Processing reservation has no usage period');
    if (usage.processingReservationCount === 0)
      await this.periods.updateOne(
        {
          _id: usagePeriodId(job.userId, reservation.periodKey),
          processingReservationCount: 0,
        },
        { $set: { purgeAt: period.purgeAt } },
        { session, runValidators: true },
      );
  }

  private async ensurePeriod(
    accountId: Types.ObjectId,
    periodId: string,
    period: ReturnType<typeof utcMonthPeriod>,
    session: ClientSession,
    now: Date,
  ) {
    await this.periods.updateOne(
      { _id: periodId },
      {
        $setOnInsert: {
          _id: periodId,
          accountId,
          periodKey: period.key,
          periodStart: period.start,
          periodEnd: period.end,
          ...emptyCounters(),
          lastMutationAt: now,
          purgeAt: period.purgeAt,
        },
      },
      { upsert: true, session, setDefaultsOnInsert: true },
    );
  }

  private periodForKey(key: string) {
    const [yearText, monthText] = key.split('-');
    const year = Number(yearText);
    const month = Number(monthText) - 1;
    return utcMonthPeriod(new Date(Date.UTC(year, month, 1)));
  }

  private assertTransaction(session: ClientSession) {
    if (!session.inTransaction())
      throw new Error('Usage accounting requires a transaction');
  }
}

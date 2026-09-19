import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { isUUID } from 'class-validator';
import { trusted, type ClientSession, type Model, type Types } from 'mongoose';
import { AccountPolicyService } from '../admin-settings/account-policy.service.js';
import { Job } from '../jobs/job.schema.js';
import type { ObjectIdentity } from '../jobs/job.types.js';
import { jobError } from '../jobs/job-errors.js';
import { ACTIVE_ADMISSION_STATUSES } from '../jobs/job-state.js';
import { User } from '../users/user.schema.js';
import {
  AccountUsagePeriod,
  AccountDailyUsagePeriod,
  ProcessingReservation,
  UploadGrantReceipt,
  DownloadGrantReceipt,
  ServiceUsagePeriod,
  type DownloadGrantScope,
} from './processing-usage.schema.js';
import {
  summarizeMonthlyProcessing,
  uploadGrantReceiptId,
  usageDayId,
  usagePeriodId,
  utcDayPeriod,
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
    @InjectModel(AccountDailyUsagePeriod.name)
    private readonly dailyPeriods: Model<AccountDailyUsagePeriod>,
    @InjectModel(ProcessingReservation.name)
    private readonly reservations: Model<ProcessingReservation>,
    @InjectModel(UploadGrantReceipt.name)
    private readonly uploadGrants: Model<UploadGrantReceipt>,
    @InjectModel(DownloadGrantReceipt.name)
    private readonly downloadGrants: Model<DownloadGrantReceipt>,
    @InjectModel(ServiceUsagePeriod.name)
    private readonly servicePeriods: Model<ServiceUsagePeriod>,
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
    const user = await userQuery.lean();
    if (!user) throw jobError('PROCESSING_UNAVAILABLE');

    const effective = await this.policies.effective(accountId, now, session);
    const period = utcMonthPeriod(now);
    const day = utcDayPeriod(now);
    let usageQuery = this.periods.findById(
      usagePeriodId(accountId, period.key),
    );
    let dailyQuery = this.dailyPeriods.findById(usageDayId(accountId, day.key));
    if (session) usageQuery = usageQuery.session(session);
    if (session) dailyQuery = dailyQuery.session(session);
    const [stored, dailyStored] = await Promise.all([
      usageQuery.maxTimeMS(5000).lean(),
      dailyQuery.maxTimeMS(5000).lean(),
    ]);
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
    const retainedOutputBytes = user.retainedOutputBytes ?? 0;
    const availability =
      !processingEnabled || !effective.acceptNewJobs
        ? { status: 'blocked' as const, reason: 'paused' as const }
        : retainedOutputBytes >= effective.values.maxRetainedOutputBytes
          ? {
              status: 'blocked' as const,
              reason: 'storage_limit_reached' as const,
            }
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
      uploads: {
        dailyGrantLimit: effective.values.dailyUploadGrants,
        dailyGrants: dailyStored?.uploadGrants ?? 0,
        dailyRemainingGrants: Math.max(
          0,
          effective.values.dailyUploadGrants - (dailyStored?.uploadGrants ?? 0),
        ),
        dailyResetAt: day.end.toISOString(),
        monthlyGrantLimit: effective.values.monthlyUploadGrants,
        monthlyGrants: counters.uploadGrants,
        monthlyRemainingGrants: Math.max(
          0,
          effective.values.monthlyUploadGrants - counters.uploadGrants,
        ),
        monthlyByteLimit: effective.values.monthlyConfirmedUploadBytes,
        confirmedBytes: counters.confirmedUploadBytes,
        monthlyRemainingBytes: Math.max(
          0,
          effective.values.monthlyConfirmedUploadBytes -
            counters.confirmedUploadBytes,
        ),
        monthlyResetAt: period.end.toISOString(),
      },
      storage: {
        limitBytes: effective.values.maxRetainedOutputBytes,
        retainedBytes: retainedOutputBytes,
        remainingBytes: Math.max(
          0,
          effective.values.maxRetainedOutputBytes - retainedOutputBytes,
        ),
      },
      effectiveLimits: {
        maxDurationSeconds: effective.values.maxDurationSeconds,
        maxPreparedAudioBytes: effective.values.maxPreparedAudioBytes,
        maxClientInputAttempts: effective.values.maxClientInputAttempts,
        signedUrlTtlSeconds: effective.values.signedUrlTtlSeconds,
      },
      downloads: {
        monthlyGrantLimit: effective.values.monthlyDownloadGrants,
        monthlyGrants: counters.downloadGrants,
        monthlyRemainingGrants: Math.max(
          0,
          effective.values.monthlyDownloadGrants - counters.downloadGrants,
        ),
        monthlyByteLimit: effective.values.monthlyEstimatedDownloadBytes,
        estimatedBytes: counters.estimatedDownloadBytes,
        monthlyRemainingBytes: Math.max(
          0,
          effective.values.monthlyEstimatedDownloadBytes -
            counters.estimatedDownloadBytes,
        ),
        monthlyResetAt: period.end.toISOString(),
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

  async reserveUploadGrant(
    job: Pick<Job, '_id' | 'userId' | 'logicalAudioId' | 'admissionSnapshot'>,
    requestId: string,
    session: ClientSession,
    now = new Date(),
  ) {
    this.assertTransaction(session);
    if (!isUUID(requestId, '4')) throw jobError('IDEMPOTENCY_CONFLICT');
    requestId = requestId.toLowerCase();
    const receiptId = uploadGrantReceiptId(job.userId, requestId);
    const existing = await this.uploadGrants
      .findById(receiptId)
      .session(session)
      .lean();
    if (existing) {
      if (
        !existing.accountId.equals(job.userId) ||
        !existing.jobId.equals(job._id) ||
        !existing.logicalAudioId.equals(job.logicalAudioId)
      )
        throw jobError('IDEMPOTENCY_CONFLICT');
      if (existing.expiresAt.getTime() <= now.getTime())
        throw jobError('UPLOAD_RESERVATION_EXPIRED');
      return existing;
    }

    const snapshot = job.admissionSnapshot;
    if (!snapshot || snapshot.reservationExpiresAt.getTime() <= now.getTime())
      throw jobError('UPLOAD_RESERVATION_EXPIRED');
    const effective = await this.policies.effective(job.userId, now, session);
    const expiresAt = new Date(
      Math.min(
        snapshot.reservationExpiresAt.getTime(),
        now.getTime() + effective.values.signedUrlTtlSeconds * 1000,
      ),
    );
    if (expiresAt.getTime() <= now.getTime())
      throw jobError('UPLOAD_RESERVATION_EXPIRED');

    const attempt = await this.jobs
      .findOneAndUpdate(
        {
          _id: job.logicalAudioId,
          userId: job.userId,
          logicalAudioId: job.logicalAudioId,
          uploadAttemptCount: {
            $lt: effective.values.maxClientInputAttempts,
          },
        },
        { $inc: { uploadAttemptCount: 1 } },
        { session, returnDocument: 'after', runValidators: true },
      )
      .lean();
    if (!attempt) throw jobError('UPLOAD_ATTEMPT_LIMIT_REACHED');

    const day = utcDayPeriod(now);
    const month = utcMonthPeriod(now);
    const dayId = usageDayId(job.userId, day.key);
    const periodId = usagePeriodId(job.userId, month.key);
    await this.ensureDay(job.userId, dayId, day, session, now);
    await this.ensurePeriod(job.userId, periodId, month, session, now);
    const daily = await this.dailyPeriods.findOneAndUpdate(
      {
        _id: dayId,
        uploadGrants: { $lt: effective.values.dailyUploadGrants },
      },
      {
        $inc: { uploadGrants: 1, revision: 1 },
        $set: { lastMutationAt: now },
      },
      { session, returnDocument: 'after', runValidators: true },
    );
    if (!daily)
      throw jobError('UPLOAD_GRANT_LIMIT_REACHED', {
        nextResetAt: day.end.toISOString(),
      });
    const monthly = await this.periods.findOneAndUpdate(
      {
        _id: periodId,
        uploadGrants: { $lt: effective.values.monthlyUploadGrants },
      },
      {
        $inc: { uploadGrants: 1, revision: 1 },
        $set: { lastMutationAt: now, purgeAt: null },
      },
      { session, returnDocument: 'after', runValidators: true },
    );
    if (!monthly)
      throw jobError('UPLOAD_GRANT_LIMIT_REACHED', {
        nextResetAt: month.end.toISOString(),
      });
    const [receipt] = await this.uploadGrants.create(
      [
        {
          _id: receiptId,
          accountId: job.userId,
          jobId: job._id,
          logicalAudioId: job.logicalAudioId,
          requestId,
          dayKey: day.key,
          periodKey: month.key,
          attemptNumber: attempt.uploadAttemptCount,
          createdAt: now,
          expiresAt,
          purgeAt: month.purgeAt,
        },
      ],
      { session },
    );
    return receipt.toObject();
  }

  async confirmUploadBytes(
    job: Pick<Job, '_id' | 'userId' | 'inputObject'>,
    bytes: number,
    session: ClientSession,
    now = new Date(),
  ) {
    this.assertTransaction(session);
    if (job.inputObject) return;
    if (!Number.isSafeInteger(bytes) || bytes < 1)
      throw jobError('UPLOAD_NOT_READY');
    const period = utcMonthPeriod(now);
    const periodId = usagePeriodId(job.userId, period.key);
    const claimed = await this.jobs.updateOne(
      {
        _id: job._id,
        userId: job.userId,
        inputObject: null,
        confirmedUploadAccountedAt: null,
      },
      {
        $set: {
          confirmedUploadAccountedAt: now,
          confirmedUploadPeriodKey: period.key,
          confirmedUploadBytes: bytes,
        },
      },
      { session, runValidators: true },
    );
    if (claimed.modifiedCount !== 1) {
      const existing = await this.jobs
        .findById(job._id)
        .session(session)
        .lean();
      if (
        existing?.userId.equals(job.userId) &&
        existing.confirmedUploadBytes === bytes &&
        existing.confirmedUploadPeriodKey === period.key
      )
        return;
      throw jobError('JOB_STATE_CONFLICT');
    }
    const effective = await this.policies.effective(job.userId, now, session);
    await this.ensurePeriod(job.userId, periodId, period, session, now);
    const updated = await this.periods.updateOne(
      {
        _id: periodId,
        $expr: {
          $lte: [
            { $add: ['$confirmedUploadBytes', bytes] },
            effective.values.monthlyConfirmedUploadBytes,
          ],
        },
      },
      {
        $inc: { confirmedUploadBytes: bytes, revision: 1 },
        $set: { lastMutationAt: now, purgeAt: null },
      },
      { session, runValidators: true },
    );
    if (updated.modifiedCount !== 1)
      throw jobError('UPLOAD_BYTE_LIMIT_REACHED', {
        nextResetAt: period.end.toISOString(),
      });
  }

  async reserveDownloadGrant(
    input: {
      accountId: Types.ObjectId;
      jobId: Types.ObjectId;
      scope: DownloadGrantScope;
      requestId: string;
      attemptId?: string | null;
      object: Pick<ObjectIdentity, 'versionId' | 'bytes'>;
    },
    session: ClientSession,
    now = new Date(),
  ) {
    this.assertTransaction(session);
    if (!isUUID(input.requestId, '4')) throw jobError('IDEMPOTENCY_CONFLICT');
    const requestId = input.requestId.toLowerCase();
    const attemptId = input.attemptId ?? null;
    if (
      (input.scope === 'worker_input' && (!attemptId || !isUUID(attemptId))) ||
      (input.scope !== 'worker_input' && attemptId !== null) ||
      !input.object.versionId ||
      input.object.versionId === 'null' ||
      !Number.isSafeInteger(input.object.bytes) ||
      input.object.bytes < 1
    )
      throw jobError('IDEMPOTENCY_CONFLICT');
    const receiptId =
      input.scope === 'worker_input'
        ? `worker:${attemptId}:${requestId}`
        : `user:${input.accountId.toHexString()}:${requestId}`;
    const existing = await this.downloadGrants
      .findById(receiptId)
      .session(session)
      .lean();
    if (existing) {
      if (
        !existing.accountId.equals(input.accountId) ||
        !existing.jobId.equals(input.jobId) ||
        existing.scope !== input.scope ||
        existing.attemptId !== attemptId ||
        existing.requestId !== requestId ||
        existing.objectVersionId !== input.object.versionId ||
        existing.estimatedBytes !== input.object.bytes
      )
        throw jobError('IDEMPOTENCY_CONFLICT');
      if (existing.expiresAt.getTime() <= now.getTime())
        throw jobError('DOWNLOAD_RESERVATION_EXPIRED');
      return existing;
    }

    const effective = await this.policies.effective(
      input.accountId,
      now,
      session,
    );
    const period = utcMonthPeriod(now);
    const periodId = usagePeriodId(input.accountId, period.key);
    await this.ensurePeriod(input.accountId, periodId, period, session, now);
    await this.ensureServicePeriod(period, session, now);

    if (input.scope === 'user_result') {
      const account = await this.periods.updateOne(
        {
          _id: periodId,
          downloadGrants: { $lt: effective.values.monthlyDownloadGrants },
          $expr: {
            $lte: [
              { $add: ['$estimatedDownloadBytes', input.object.bytes] },
              effective.values.monthlyEstimatedDownloadBytes,
            ],
          },
        },
        {
          $inc: {
            downloadGrants: 1,
            estimatedDownloadBytes: input.object.bytes,
            revision: 1,
          },
          $set: { lastMutationAt: now, purgeAt: null },
        },
        { session, runValidators: true },
      );
      if (account.modifiedCount !== 1) {
        const current = await this.periods
          .findById(periodId)
          .session(session)
          .lean();
        throw jobError(
          (current?.downloadGrants ?? 0) >=
            effective.values.monthlyDownloadGrants
            ? 'DOWNLOAD_GRANT_LIMIT_REACHED'
            : 'DOWNLOAD_BYTE_LIMIT_REACHED',
          { nextResetAt: period.end.toISOString() },
        );
      }
    }

    const service = await this.servicePeriods.updateOne(
      {
        _id: period.key,
        $expr: {
          $lte: [
            { $add: ['$estimatedOutboundBytes', input.object.bytes] },
            effective.values.monthlyServiceOutboundBytes,
          ],
        },
      },
      {
        $inc: {
          estimatedOutboundBytes: input.object.bytes,
          revision: 1,
        },
        $set: { lastMutationAt: now },
      },
      { session, runValidators: true },
    );
    if (service.modifiedCount !== 1)
      throw jobError('SERVICE_BANDWIDTH_LIMIT_REACHED', {
        nextResetAt: period.end.toISOString(),
      });

    const expiresAt = new Date(
      now.getTime() + effective.values.signedUrlTtlSeconds * 1_000,
    );
    const [receipt] = await this.downloadGrants.create(
      [
        {
          _id: receiptId,
          accountId: input.accountId,
          jobId: input.jobId,
          scope: input.scope,
          attemptId,
          requestId,
          objectVersionId: input.object.versionId,
          estimatedBytes: input.object.bytes,
          periodKey: period.key,
          createdAt: now,
          expiresAt,
          purgeAt: period.purgeAt,
        },
      ],
      { session },
    );
    return receipt.toObject();
  }

  async assertRetainedCapacity(
    accountId: Types.ObjectId,
    limitBytes: number,
    session: ClientSession,
  ) {
    this.assertTransaction(session);
    const user = await this.users.findById(accountId).session(session).lean();
    if (!user) throw jobError('PROCESSING_UNAVAILABLE');
    if ((user.retainedOutputBytes ?? 0) >= limitBytes)
      throw jobError('RETAINED_STORAGE_LIMIT_REACHED');
  }

  async recordRetainedOutput(
    job: Pick<
      Job,
      | 'userId'
      | 'outputObject'
      | 'retainedOutputAccountedAt'
      | 'retainedOutputReleasedAt'
    >,
    bytes: number,
    session: ClientSession,
  ) {
    this.assertTransaction(session);
    if (
      job.outputObject ||
      job.retainedOutputAccountedAt ||
      job.retainedOutputReleasedAt
    )
      return;
    if (!Number.isSafeInteger(bytes) || bytes < 1)
      throw new Error('Invalid retained output size');
    const updated = await this.users.updateOne(
      { _id: job.userId },
      { $inc: { retainedOutputBytes: bytes } },
      { session, runValidators: true },
    );
    if (updated.modifiedCount !== 1) throw jobError('PROCESSING_UNAVAILABLE');
  }

  async releaseRetainedOutput(
    job: Pick<
      Job,
      | 'userId'
      | 'outputObject'
      | 'retainedOutputAccountedAt'
      | 'retainedOutputReleasedAt'
    >,
    session: ClientSession,
  ) {
    this.assertTransaction(session);
    if (
      !job.outputObject ||
      !job.retainedOutputAccountedAt ||
      job.retainedOutputReleasedAt
    )
      return;
    const updated = await this.users.updateOne(
      {
        _id: job.userId,
        retainedOutputBytes: trusted({ $gte: job.outputObject.bytes }),
      },
      { $inc: { retainedOutputBytes: -job.outputObject.bytes } },
      { session, runValidators: true },
    );
    if (updated.modifiedCount !== 1)
      throw new Error('Retained output accounting is inconsistent');
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

  private async ensureDay(
    accountId: Types.ObjectId,
    dayId: string,
    day: ReturnType<typeof utcDayPeriod>,
    session: ClientSession,
    now: Date,
  ) {
    await this.dailyPeriods.updateOne(
      { _id: dayId },
      {
        $setOnInsert: {
          _id: dayId,
          accountId,
          dayKey: day.key,
          dayStart: day.start,
          dayEnd: day.end,
          uploadGrants: 0,
          revision: 0,
          lastMutationAt: now,
          purgeAt: day.purgeAt,
        },
      },
      { upsert: true, session, setDefaultsOnInsert: true },
    );
  }

  private async ensureServicePeriod(
    period: ReturnType<typeof utcMonthPeriod>,
    session: ClientSession,
    now: Date,
  ) {
    await this.servicePeriods.updateOne(
      { _id: period.key },
      {
        $setOnInsert: {
          _id: period.key,
          periodKey: period.key,
          periodStart: period.start,
          periodEnd: period.end,
          estimatedOutboundBytes: 0,
          revision: 0,
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

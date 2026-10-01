import {
  MAX_AUDIO_DURATION_SECONDS,
  MAX_PREPARED_AUDIO_BYTES,
} from '../jobs/media-limits.js';
import { elapsedMs } from '../jobs/job-stage-timing.js';
import { Injectable, Optional } from '@nestjs/common';
import { SharedMediaService } from '../shared-media/shared-media.service.js';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Types, trusted, type Model, type ClientSession } from 'mongoose';
import { ProcessingAdmissionFence } from '../admin-settings/processing-settings.schema.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { ProcessingUsageService } from '../processing-usage/processing-usage.service.js';
import { AccountAccessService } from '../users/account-access.service.js';
import { AccountRestrictionsService } from '../abuse-protection/account-restrictions.service.js';
import { objectId } from '../jobs/job-request.js';
import { jobError } from '../jobs/job-errors.js';
import { importError } from './import-errors.js';
import { parseImportSource } from './import-source.js';
import { ACTIVE_IMPORT_STATES, MediaImport } from './media-import.schema.js';
import {
  acquisitionRetryDelay,
  importExecutionJobId,
  MAX_ACQUISITION_ATTEMPTS,
} from './import-retry.js';

export const IMPORT_QUEUE = 'musicmute-url-imports';

@Injectable()
export class ImportsService {
  constructor(
    @InjectModel(MediaImport.name) readonly records: Model<MediaImport>,
    @InjectModel(ProcessingAdmissionFence.name)
    private readonly fences: Model<ProcessingAdmissionFence>,
    private readonly transactions: ProcessingTransactions,
    private readonly access: AccountAccessService,
    private readonly usage: ProcessingUsageService,
    private readonly config: ConfigService,
    @InjectQueue(IMPORT_QUEUE) private readonly queue: Queue,
    private readonly restrictions: AccountRestrictionsService,
    @Optional() private readonly shared?: SharedMediaService,
  ) {}

  async initialize(): Promise<void> {
    await this.records.init();
    await this.shared?.initialize();
    await this.fences.updateOne(
      { _id: 'url-import-admission' },
      { $setOnInsert: { revision: 0 } },
      { upsert: true },
    );
  }

  async assertAccountAllowed(userId: Types.ObjectId, session?: ClientSession) {
    await this.access.assertActive(userId, session);
    await this.restrictions.assertAllowed(userId, 'job_create');
  }

  async assertEligible(
    userId: Types.ObjectId,
    session?: ClientSession,
    requireUpload = true,
  ) {
    await this.assertAccountAllowed(userId, session);
    const usage = await this.usage.readUsage(userId, session);
    if (usage.availability.status !== 'available')
      throw jobError(
        usage.availability.reason === 'monthly_limit_reached'
          ? 'PROCESSING_ALLOWANCE_EXHAUSTED'
          : 'PROCESSING_UNAVAILABLE',
      );
    if (
      requireUpload &&
      (usage.uploads.dailyRemainingGrants < 1 ||
        usage.uploads.monthlyRemainingGrants < 1 ||
        usage.uploads.monthlyRemainingBytes < 1)
    )
      throw jobError(
        usage.uploads.monthlyRemainingBytes < 1
          ? 'UPLOAD_BYTE_LIMIT_REACHED'
          : 'UPLOAD_GRANT_LIMIT_REACHED',
      );
    const maxDuration = Math.min(
      MAX_AUDIO_DURATION_SECONDS,
      usage.effectiveLimits.maxDurationSeconds,
    );
    return {
      maxBytes: Math.min(
        MAX_PREPARED_AUDIO_BYTES,
        usage.effectiveLimits.maxPreparedAudioBytes,
        ...(requireUpload ? [usage.uploads.monthlyRemainingBytes] : []),
      ),
      maxDuration,
    };
  }

  async reserveAcquisition(record: MediaImport) {
    return this.transactions.run(async (session) => {
      // Conflict with recovery before committing a hold or starting paid work.
      const active = await this.records.updateOne(
        {
          _id: record._id,
          executionId: record.executionId,
          status: 'downloading',
        },
        {
          $set: {
            acquisitionReservedAt: record.acquisitionReservedAt ?? new Date(),
          },
        },
        { session },
      );
      if (active.matchedCount !== 1)
        throw importError('IMPORT_DEPENDENCY_FAILED');
      if (record.acquisitionReservedAt) {
        // An authorized durable retry retains exactly one pre-provider hold.
        // Legacy or exhausted claims never turn reservation replay into paid work.
        await this.assertAccountAllowed(record.userId, session);
        const limits = record.acquisitionLimits;
        const usage = await this.usage.readUsage(record.userId, session);
        if (
          !this.config.get<boolean>('URL_IMPORT_ENABLED') ||
          usage.availability.reason === 'paused'
        )
          throw importError('IMPORT_DISABLED');
        if (
          (record.maxAcquisitionAttempts ?? 1) <= 1 ||
          record.acquisitionAttempt < 2 ||
          !limits ||
          !Number.isSafeInteger(limits.maxBytes) ||
          limits.maxBytes < 1 ||
          limits.maxBytes > MAX_PREPARED_AUDIO_BYTES ||
          !Number.isSafeInteger(limits.maxDuration) ||
          limits.maxDuration < 1 ||
          limits.maxDuration > MAX_AUDIO_DURATION_SECONDS ||
          !(await this.usage.hasReservedProcessing(
            record._id,
            record.userId,
            session,
          ))
        )
          throw jobError('IDEMPOTENCY_CONFLICT');
        return limits;
      }
      const limits = await this.assertEligible(record.userId, session);
      await this.usage.reserveForImport(
        record._id,
        record.userId,
        limits.maxDuration,
        session,
      );
      await this.records.updateOne(
        { _id: record._id, executionId: record.executionId },
        { $set: { acquisitionLimits: limits } },
        { session, runValidators: true },
      );
      return limits;
    });
  }

  async retryAcquisition(
    record: MediaImport,
    error: { code: string; message: string },
    now = new Date(),
  ): Promise<boolean> {
    const delay = acquisitionRetryDelay(record, error.code);
    if (delay === null) return false;
    await this.assertAccountAllowed(record.userId);
    if (!this.config.get<boolean>('URL_IMPORT_ENABLED'))
      throw importError('IMPORT_DISABLED');
    const changed = await this.records.updateOne(
      {
        _id: record._id,
        executionId: record.executionId,
        acquisitionAttempt: record.acquisitionAttempt,
        status: record.status,
        jobId: null,
        input: null,
      },
      {
        $set: {
          status: 'queued',
          queuedAt: now,
          nextAttemptAt: new Date(now.getTime() + delay),
          executionId: null,
          deadlineAt: null,
          error,
          finishedAt: null,
          expiresAt: null,
        },
      },
      { runValidators: true },
    );
    if (changed.matchedCount !== 1) return false;
    // Mongo is the outbox; Redis failure is repaired by normal server maintenance.
    void this.enqueue(record._id.toHexString()).catch(() => undefined);
    return true;
  }

  async failAcquisition(
    record: MediaImport,
    error: { code: string; message: string },
  ) {
    const finalized = await this.transactions.run(async (session) => {
      const changed = await this.records.updateOne(
        {
          _id: record._id,
          executionId: record.executionId ?? null,
          ...(record.acquisitionAttempt === undefined
            ? {}
            : { acquisitionAttempt: record.acquisitionAttempt }),
          status: trusted({ $in: ACTIVE_IMPORT_STATES }),
        },
        {
          $set: {
            status: 'failed',
            nextAttemptAt: null,
            finishedAt: new Date(),
            error,
            expiresAt: new Date(Date.now() + 7 * 86400_000),
          },
        },
        { session },
      );
      if (changed.matchedCount !== 1) return false;
      await this.usage.releaseImport(record._id, record.userId, session);
      return true;
    });
    if (finalized) await this.shared?.failImport(record);
  }

  async create(
    userId: string,
    url: string,
    requestId: string,
    trimEnabled = true,
  ) {
    const owner = objectId(userId);
    const source = parseImportSource(url);
    const existing = await this.records
      .findOne({ userId: owner, requestId })
      .lean();
    if (existing) {
      await this.access.assertActive(owner);
      if (
        existing.sourceUrl !== source.url ||
        (existing.trimEnabled ?? true) !== trimEnabled
      )
        throw importError('IMPORT_REQUEST_CONFLICT');
      return this.present(existing);
    }
    if (!this.config.get<boolean>('URL_IMPORT_ENABLED'))
      throw importError('IMPORT_DISABLED');
    await this.assertAccountAllowed(owner);
    const id = new Types.ObjectId();
    const jobRequestId = randomUUID();
    const record = await this.transactions.run(async (session) => {
      // Serialize all admissions, including simultaneous submissions on other replicas.
      await this.fences.updateOne(
        { _id: 'url-import-admission' },
        { $inc: { revision: 1 } },
        { upsert: true, session },
      );
      await this.access.assertActive(owner, session);
      const repeated = await this.records
        .findOne({ userId: owner, requestId })
        .session(session)
        .lean();
      if (repeated) {
        if (
          repeated.sourceUrl !== source.url ||
          (repeated.trimEnabled ?? true) !== trimEnabled
        )
          throw importError('IMPORT_REQUEST_CONFLICT');
        return repeated;
      }
      const count = await this.records
        .countDocuments({ status: trusted({ $in: ACTIVE_IMPORT_STATES }) })
        .session(session);
      if (count >= this.config.getOrThrow<number>('URL_IMPORT_MAX_OUTSTANDING'))
        throw importError('IMPORT_QUEUE_FULL');
      const shared = await this.shared?.claim(
        source.url,
        source.provider,
        id,
        trimEnabled,
        session,
      );
      if (!shared?.cached)
        await this.assertEligible(owner, session, !shared?.hasSource);
      const [created] = await this.records.create(
        [
          {
            _id: id,
            userId: owner,
            requestId,
            jobRequestId,
            trimEnabled,
            maxAcquisitionAttempts: MAX_ACQUISITION_ATTEMPTS,
            acquisitionAttempt: 0,
            queuedAt: new Date(),
            sourceUrl: source.url,
            provider: source.provider,
            sharedSourceKey: shared?.sourceKey ?? null,
            sharedResultKey: shared?.resultKey ?? null,
          },
        ],
        { session },
      );
      return created.toObject();
    });
    // The durable queued record is an outbox. Recovery retries enqueue after a Redis outage.
    void this.enqueue(record._id.toHexString()).catch(() => undefined);
    return this.present(record);
  }

  async enqueue(id: string): Promise<void> {
    const record = await this.records.findById(id).lean();
    if (!record || record.status !== 'queued') return;
    if (this.shared) {
      const state = await this.shared.inspect(record);
      if (state?.action === 'wait') return;
      if (state?.action === 'failed') {
        await this.failAcquisition(record, {
          code: 'IMPORT_DEPENDENCY_FAILED',
          message: 'Audio acquisition is temporarily unavailable',
        });
        return;
      }
    }
    await this.queue.add(
      'import',
      { importId: id, attempt: (record.acquisitionAttempt ?? 0) + 1 },
      {
        jobId: importExecutionJobId(record),
        delay: Math.max(0, (record.nextAttemptAt?.getTime() ?? 0) - Date.now()),
        attempts: 1,
        removeOnComplete: { age: 7 * 86400 },
        removeOnFail: { age: 7 * 86400 },
      },
    );
  }

  async get(userId: string, id: string) {
    await this.access.assertActive(userId);
    const record = await this.records
      .findOne({ _id: objectId(id), userId: objectId(userId) })
      .lean();
    if (!record) throw importError('IMPORT_NOT_FOUND');
    return this.present(record);
  }

  private present(record: MediaImport) {
    return {
      serverStageTimings:
        ['submitted', 'failed'].includes(record.status) && !record.finishedAt
          ? null
          : {
              totalMs: elapsedMs(
                record.createdAt,
                record.finishedAt ?? new Date(),
              ),
              totalComplete: record.finishedAt != null,
              stages: (record.stageTimings ?? []).map((s) => ({
                stage: s.stage,
                durationMs: s.durationMs,
                complete: s.complete,
              })),
              attempts: [],
            },
      importId: record._id.toHexString(),
      status: record.status,
      sourceTitle: record.sourceTitle ?? null,
      jobId: record.jobId?.toHexString() ?? null,
      error: record.error,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }
}

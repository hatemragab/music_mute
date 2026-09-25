import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Types, trusted, type Model } from 'mongoose';
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
  ) {}

  async initialize(): Promise<void> {
    await this.records.init();
    await this.fences.updateOne(
      { _id: 'url-import-admission' },
      { $setOnInsert: { revision: 0 } },
      { upsert: true },
    );
  }

  async assertAccountAllowed(userId: Types.ObjectId) {
    await this.access.assertActive(userId);
    await this.restrictions.assertAllowed(userId, 'job_create');
  }

  async assertEligible(userId: Types.ObjectId) {
    await this.assertAccountAllowed(userId);
    const usage = await this.usage.readUsage(userId);
    if (usage.availability.status !== 'available')
      throw jobError(
        usage.availability.reason === 'monthly_limit_reached'
          ? 'PROCESSING_ALLOWANCE_EXHAUSTED'
          : 'PROCESSING_UNAVAILABLE',
      );
    if (
      usage.uploads.dailyRemainingGrants < 1 ||
      usage.uploads.monthlyRemainingGrants < 1 ||
      usage.uploads.monthlyRemainingBytes < 1
    )
      throw jobError(
        usage.uploads.monthlyRemainingBytes < 1
          ? 'UPLOAD_BYTE_LIMIT_REACHED'
          : 'UPLOAD_GRANT_LIMIT_REACHED',
      );
    return {
      maxBytes: Math.min(
        50_000_000,
        usage.effectiveLimits.maxPreparedAudioBytes,
        usage.uploads.monthlyRemainingBytes,
      ),
      maxDuration: Math.min(1200, usage.effectiveLimits.maxDurationSeconds),
    };
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
    await this.assertEligible(owner);
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
      const [created] = await this.records.create(
        [
          {
            _id: id,
            userId: owner,
            requestId,
            jobRequestId,
            trimEnabled,
            sourceUrl: source.url,
            provider: source.provider,
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
    await this.queue.add(
      'import',
      { importId: id },
      {
        jobId: id,
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

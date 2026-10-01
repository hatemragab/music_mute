import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { trusted } from 'mongoose';
import { IMPORT_QUEUE, ImportsService } from './imports.service.js';
import { ImportProcessor } from './import-processor.js';
import { importError } from './import-errors.js';
import { SharedMediaService } from '../shared-media/shared-media.service.js';
import { Optional } from '@nestjs/common';
import { importExecutionJobId } from './import-retry.js';

@Injectable()
export class ImportRuntime
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(ImportRuntime.name);
  private timer?: NodeJS.Timeout;
  private maintenance?: Promise<void>;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly imports: ImportsService,
    private readonly processor: ImportProcessor,
    @InjectQueue(IMPORT_QUEUE) private readonly queue: Queue,
    @Optional() private readonly shared?: SharedMediaService,
  ) {}

  async onApplicationBootstrap() {
    this.queue.on('error', () =>
      this.logger.warn('URL import queue unavailable'),
    );
    this.processor.worker.on('error', () =>
      this.logger.warn('URL import processor unavailable'),
    );
    await this.imports.initialize();
    if (!this.config.get<boolean>('URL_IMPORT_PROCESSOR_ENABLED')) return;
    await this.processor.files.initialize();
    await this.processor.files.sweep();
    const concurrency = this.config.getOrThrow<number>(
      'URL_IMPORT_CONCURRENCY',
    );
    await this.queue.setGlobalConcurrency(concurrency);
    await this.queue.setGlobalRateLimit(
      this.config.getOrThrow<number>('URL_IMPORT_REQUESTS_PER_SECOND'),
      1_000,
    );
    this.processor.worker.concurrency = concurrency;
    this.running = true;
    void this.processor.worker
      .run()
      .catch(() => this.logger.error('URL import processor stopped'));
    this.tick();
    this.timer = setInterval(() => this.tick(), 30_000);
    this.timer.unref();
  }

  private tick() {
    if (this.maintenance || !this.running) return;
    this.maintenance = this.reconcile()
      .catch(() => this.logger.warn('URL import recovery or cleanup pending'))
      .finally(() => {
        this.maintenance = undefined;
      });
  }

  async reconcile(): Promise<void> {
    await this.shared?.reconcile();
    const pending = await this.imports.records
      .find({
        status: trusted({
          $in: ['queued', 'downloading', 'validating', 'uploading'],
        }),
      })
      .sort({ createdAt: 1 })
      .limit(this.config.getOrThrow<number>('URL_IMPORT_MAX_OUTSTANDING'))
      .lean();
    for (const record of pending) {
      const queued = await this.queue.getJob(importExecutionJobId(record));
      const queueState = queued ? await queued.getState() : 'unknown';
      if (
        record.status === 'queued' &&
        (record.maxAcquisitionAttempts ?? 1) > 1
      ) {
        // Retry generations are durable outbox entries. Ignore prior generations
        // and replace only a terminal, unclaimed entry for the current generation.
        if (queued && (queueState === 'failed' || queueState === 'completed'))
          await queued.remove();
        if (!queued || queueState === 'failed' || queueState === 'completed')
          await this.imports.enqueue(record._id.toHexString());
        continue;
      }
      if (queueState === 'failed' || queueState === 'completed') {
        // BullMQ has finished this execution, including a crash/stalled attempt.
        // Reconciliation preserves accepted jobs and uncertain uploads before
        // authorizing a bounded pre-upload retry generation for new imports.
        await this.processor.reconcileFailure(
          record,
          importError('IMPORT_DEPENDENCY_FAILED'),
        );
      } else if (record.status === 'queued') {
        if (!queued) await this.imports.enqueue(record._id.toHexString());
      } else if (
        record.deadlineAt &&
        record.deadlineAt.getTime() + 60_000 < Date.now()
      ) {
        // The transfer deadline and bounded DB transactions expire before this recovery window.
        await this.processor.reconcileFailure(
          record,
          importError('IMPORT_DEPENDENCY_FAILED'),
        );
      }
    }
    await this.processor.files.sweep();
  }

  async beforeApplicationShutdown() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.processor.shutdown.abort();
    await this.processor.worker.close();
    await this.maintenance;
  }
}

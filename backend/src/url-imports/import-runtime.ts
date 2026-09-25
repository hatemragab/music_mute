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
      if (record.status === 'queued') {
        const queued = await this.queue.getJob(record._id.toHexString());
        if (
          queued &&
          ['failed', 'completed'].includes(await queued.getState())
        ) {
          await this.processor.reconcileFailure(
            record,
            importError('IMPORT_DEPENDENCY_FAILED'),
          );
        } else if (!queued) {
          await this.imports.enqueue(record._id.toHexString());
        }
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

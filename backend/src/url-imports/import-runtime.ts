import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { trusted, type Types } from 'mongoose';
import { IMPORT_QUEUE, ImportsService } from './imports.service.js';
import { ImportProcessor } from './import-processor.js';
import { importError } from './import-errors.js';
import { SharedMediaService } from '../shared-media/shared-media.service.js';
import { Optional } from '@nestjs/common';
import { importExecutionJobId } from './import-retry.js';
import { RealtimeFeedService } from '../realtime/realtime-feed.service.js';
import type { MediaImport } from './media-import.schema.js';

@Injectable()
export class ImportRuntime
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(ImportRuntime.name);
  private timer?: NodeJS.Timeout;
  private maintenance?: Promise<void>;
  private wakeup?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private wakePending = false;
  private running = false;
  private recoveryCursor?: Types.ObjectId;
  private sharedCursor?: Types.ObjectId;

  constructor(
    private readonly config: ConfigService,
    private readonly imports: ImportsService,
    private readonly processor: ImportProcessor,
    @InjectQueue(IMPORT_QUEUE) private readonly queue: Queue,
    @Optional() private readonly shared?: SharedMediaService,
    @Optional() private readonly feed?: RealtimeFeedService,
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
    this.unsubscribe = this.feed?.subscribe((event) => {
      if (
        event.healthy &&
        (!event.collection ||
          event.collection === 'shared_media_sources' ||
          event.collection === 'shared_media_results')
      )
        this.wake();
    });
    void this.processor.worker
      .run()
      .catch(() => this.logger.error('URL import processor stopped'));
    this.tick();
    this.timer = setInterval(() => this.tick(), 30_000);
    this.timer.unref();
  }

  private tick(sharedChanges = false) {
    if (this.maintenance || !this.running) return;
    this.wakePending = false;
    if (this.wakeup) clearTimeout(this.wakeup);
    this.wakeup = undefined;
    this.maintenance = (
      sharedChanges ? this.enqueueSharedImports() : this.reconcile()
    )
      .catch(() => this.logger.warn('URL import recovery or cleanup pending'))
      .finally(() => {
        this.maintenance = undefined;
        if (this.wakePending) this.wake();
      });
  }

  private wake() {
    if (!this.running) return;
    this.wakePending = true;
    if (this.maintenance || this.wakeup) return;
    // Coalesce committed source/result transitions without losing a change that
    // arrives during reconciliation. Recovery still handles feed/Redis outages.
    this.wakeup = setTimeout(() => {
      this.wakeup = undefined;
      this.tick(true);
    }, 50);
    this.wakeup.unref();
  }

  /** Changes wake only queued shared imports; expensive recovery remains periodic. */
  async enqueueSharedImports(): Promise<void> {
    const pending = await this.pendingImports(true);
    for (const record of await this.deliverReadyImports(pending))
      await this.imports.enqueue(record._id.toHexString());
  }

  private async pendingImports(sharedOnly: boolean) {
    const filter: Record<string, unknown> = sharedOnly
      ? {
          status: 'queued',
          sharedSourceKey: trusted({ $ne: null }),
          sharedResultKey: trusted({ $ne: null }),
        }
      : {
          status: trusted({
            $in: ['queued', 'downloading', 'validating', 'uploading'],
          }),
        };
    const cursor = sharedOnly ? this.sharedCursor : this.recoveryCursor;
    if (cursor) filter._id = trusted({ $gt: cursor });
    const read = () =>
      this.imports.records
        .find(filter)
        .sort({ _id: 1 })
        .limit(this.config.getOrThrow<number>('URL_IMPORT_MAX_OUTSTANDING'))
        .lean();
    let pending = await read();
    if (!pending.length && cursor) {
      delete filter._id;
      pending = await read();
    }
    // Advance before external dependencies: one blocked batch cannot starve
    // later deliveries. Wrapping also revisits older interrupted imports.
    if (sharedOnly) this.sharedCursor = pending.at(-1)?._id;
    else this.recoveryCursor = pending.at(-1)?._id;
    return pending;
  }

  private async deliverReadyImports(pending: MediaImport[]) {
    const waiting: MediaImport[] = [];
    let failure: unknown;
    for (const record of pending) {
      if (
        record.status !== 'queued' ||
        record.handoffPending ||
        (await this.shared?.inspect(record))?.action !== 'result'
      ) {
        waiting.push(record);
        continue;
      }
      try {
        // Deliver every ready result before a cold import can wait on Redis.
        await this.imports.enqueue(record._id.toHexString());
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
    return waiting;
  }

  async reconcile(): Promise<void> {
    await this.shared?.reconcile();
    const pending = await this.pendingImports(false);
    for (const record of await this.deliverReadyImports(pending)) {
      const queued = await this.queue.getJob(importExecutionJobId(record));
      const queueState = queued ? await queued.getState() : 'unknown';
      if (
        record.status === 'queued' &&
        (record.handoffPending || (record.maxAcquisitionAttempts ?? 1) > 1)
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
    this.unsubscribe?.();
    if (this.wakeup) clearTimeout(this.wakeup);
    this.wakePending = false;
    if (this.timer) clearInterval(this.timer);
    this.processor.shutdown.abort();
    await this.processor.worker.close();
    await this.maintenance;
  }
}

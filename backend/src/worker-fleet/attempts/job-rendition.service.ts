import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { trusted, type ClientSession, type Model } from 'mongoose';
import { Job } from '../../jobs/job.schema.js';
import { validComparisonRanges } from '../../jobs/comparison-ranges.js';
import { withAttemptMeasurements } from '../../jobs/job-stage-timing.js';
import type { ObjectIdentity } from '../../jobs/job.types.js';
import { isWorkerRecipeSnapshot } from '../../jobs/worker-recipes.js';
import { NotificationOutbox } from '../../notifications/notification-outbox.schema.js';
import { ProcessingTransactions } from '../../processing/processing-transactions.js';
import { ProcessingUsageService } from '../../processing-usage/processing-usage.service.js';
import { SharedMediaService } from '../../shared-media/shared-media.service.js';
import { isSharedMediaObjectKey } from '../../shared-media/shared-media-key.js';
import { AccountAccessService } from '../../users/account-access.service.js';
import { workerError } from '../worker-errors.js';

const LEASE_MS = 240_000;

/** A completed model attempt never waits for, or retries, this backend rendition. */
@Injectable()
export class JobRenditionService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(JobRenditionService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    private readonly transactions: ProcessingTransactions,
    private readonly shared: SharedMediaService,
    private readonly access: AccountAccessService,
    private readonly usage: ProcessingUsageService,
  ) {}

  onApplicationBootstrap(): void {
    this.wake();
    this.timer = setInterval(() => this.wake(), 10_000);
    this.timer.unref();
  }

  /** Completion ACK must not await DSP; Mongo is the restart-safe outbox. */
  wake(): void {
    if (this.running || this.stopped) return;
    this.running = this.finalizeOne()
      .then(() => undefined)
      .catch(() => {
        this.logger.warn('Shared rendition recovery temporarily unavailable');
      })
      .finally(() => {
        this.running = undefined;
      });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  async finalizeOne(now = new Date()): Promise<boolean> {
    const observed = await this.jobs
      .findOne({
        status: 'uploading_result',
        deletedAt: null,
        currentExecution: null,
        outputObject: null,
        'renditionPending.nextAt': trusted({ $lte: now }),
        $or: [
          { 'renditionPending.leaseUntil': null },
          { 'renditionPending.leaseUntil': trusted({ $lte: now }) },
        ],
      })
      .sort({ 'renditionPending.nextAt': 1, _id: 1 })
      .maxTimeMS(2000)
      .lean();
    if (!observed?.renditionPending) return false;
    const token = randomUUID();
    const claimed = await this.jobs
      .findOneAndUpdate(
        {
          _id: observed._id,
          revision: observed.revision,
          status: 'uploading_result',
          deletedAt: null,
          currentExecution: null,
          outputObject: null,
          'renditionPending.leaseToken': observed.renditionPending.leaseToken,
          'renditionPending.leaseUntil': observed.renditionPending.leaseUntil,
        },
        {
          $set: {
            'renditionPending.leaseToken': token,
            'renditionPending.leaseUntil': new Date(now.getTime() + LEASE_MS),
          },
          $inc: { revision: 1, 'renditionPending.attempts': 1 },
        },
        { runValidators: true, returnDocument: 'after' },
      )
      .lean();
    if (!claimed?.renditionPending) return false;
    try {
      await this.access.assertActiveReadOnly(claimed.userId);
      const rendition = await this.shared.prepareRequestedOutput(
        claimed,
        claimed.renditionPending.full,
      );
      if (
        !rendition ||
        rendition.sourceKey !== claimed.sharedSourceKey ||
        !rendition.recipeSnapshot.trimEnabled ||
        !isWorkerRecipeSnapshot(rendition.recipeSnapshot) ||
        !isSharedMediaObjectKey(
          rendition.outputObject.key,
          rendition.resultKey,
          'output',
        ) ||
        !validComparisonRanges(rendition.comparisonRanges)
      )
        throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
      await this.transactions.run(async (session) => {
        const current = await this.jobs
          .findById(claimed._id)
          .session(session)
          .lean();
        if (
          !current ||
          current.status !== 'uploading_result' ||
          current.deletedAt ||
          current.currentExecution ||
          current.outputObject ||
          current.renditionPending?.leaseToken !== token ||
          !current.renditionPending.leaseUntil ||
          current.renditionPending.leaseUntil.getTime() <= Date.now() ||
          !sameObject(
            current.renditionPending.full,
            claimed.renditionPending!.full,
          )
        )
          return;
        await this.access.assertActive(current.userId, session);
        const readyAt = new Date();
        const attempt = current.stageTimingAttempts?.find(
          (item) => item.attemptId === current.renditionPending!.attemptId,
        );
        const completionMs = Math.min(
          Number.MAX_SAFE_INTEGER,
          (attempt?.stages.find((stage) => stage.stage === 'completion')
            ?.durationMs ?? 0) +
            Math.max(
              0,
              readyAt.getTime() - current.renditionPending.queuedAt.getTime(),
            ),
        );
        await this.usage.recordRetainedOutput(
          current,
          rendition.outputObject.bytes + (current.inputObject?.bytes ?? 0),
          session,
        );
        const ready = await this.jobs
          .findOneAndUpdate(
            {
              _id: current._id,
              revision: current.revision,
              status: 'uploading_result',
              deletedAt: null,
              currentExecution: null,
              outputObject: null,
              'renditionPending.leaseToken': token,
              'renditionPending.leaseUntil': trusted({ $gt: readyAt }),
            },
            {
              $set: {
                status: 'ready',
                outputObject: rendition.outputObject,
                outputRecipeSnapshot: rendition.recipeSnapshot,
                comparisonRanges: rendition.comparisonRanges,
                measuredOutputDurationSeconds:
                  rendition.comparisonRanges!.reduce(
                    (n, [start, end]) => n + end! - start!,
                    0,
                  ) / 44100,
                retainedOutputAccountedAt: readyAt,
                retainedInputBytes: current.inputObject?.bytes ?? 0,
                retainedOutputReleasedAt: null,
                finishedAt: readyAt,
                stageTimingAttempts: attempt
                  ? withAttemptMeasurements(
                      current,
                      attempt.attemptId,
                      attempt.attemptNumber,
                      [
                        ...attempt.stages.filter(
                          (stage) => stage.stage !== 'completion',
                        ),
                        {
                          stage: 'completion',
                          durationMs: completionMs,
                          complete: true,
                        },
                      ],
                    )
                  : (current.stageTimingAttempts ?? []),
                renditionPending: null,
                lastError: null,
                retryEligibility: {
                  eligible: false,
                  attemptsRemaining: 0,
                  nextAttemptAt: null,
                },
              },
              $inc: { revision: 1 },
            },
            { session, runValidators: true, returnDocument: 'after' },
          )
          .lean();
        if (!ready) throw workerError('WORKER_CONFLICT');
        await this.enqueueNotification(ready, readyAt, session);
      });
    } catch {
      const backoff = Math.min(
        300_000,
        5000 *
          2 ** Math.min(6, Math.max(0, claimed.renditionPending.attempts - 1)),
      );
      await this.jobs.updateOne(
        {
          _id: claimed._id,
          status: 'uploading_result',
          deletedAt: null,
          currentExecution: null,
          'renditionPending.leaseToken': token,
        },
        {
          $set: {
            'renditionPending.nextAt': new Date(Date.now() + backoff),
            'renditionPending.leaseToken': null,
            'renditionPending.leaseUntil': null,
          },
          $inc: { revision: 1 },
        },
        { runValidators: true },
      );
    }
    return true;
  }

  private async enqueueNotification(
    job: Job,
    now: Date,
    session: ClientSession,
  ) {
    await this.jobs.db
      .model<NotificationOutbox>(NotificationOutbox.name)
      .updateOne(
        { jobId: job._id, outcome: 'ready' },
        {
          $setOnInsert: {
            jobId: job._id,
            userId: job.userId,
            outcome: 'ready',
            state: 'pending',
            nextAttemptAt: now,
            leaseId: null,
            leaseExpiresAt: null,
            targetSnapshotAt: null,
            targetThroughId: null,
            targetCursor: null,
            targetsFrozenAt: null,
            completedAt: null,
            revision: 0,
          },
        },
        { session, upsert: true, setDefaultsOnInsert: false },
      );
  }
}

function sameObject(left: ObjectIdentity, right: ObjectIdentity) {
  return (
    left.key === right.key &&
    left.etag === right.etag &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256 &&
    left.contentType === right.contentType
  );
}

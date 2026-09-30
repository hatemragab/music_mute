import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { trusted, type ClientSession, type Model } from 'mongoose';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { ProcessingUsageService } from '../processing-usage/processing-usage.service.js';
import { StorageCleanupService } from '../storage/storage-cleanup.service.js';
import { StorageTransfersService } from '../storage/storage-transfers.service.js';
import { NotificationOutbox } from '../notifications/notification-outbox.schema.js';
import { NotificationDelivery } from '../notifications/notification-delivery.schema.js';
import { Job } from './job.schema.js';
import { objectId } from './job-request.js';
import { jobError } from './job-errors.js';
import type { WorkerExecutionOwnership } from './job.types.js';
import { WorkerAttempt } from '../worker-fleet/jobs/worker-attempt.schema.js';
import { WorkerSlot } from '../worker-fleet/machines/worker-slot.schema.js';

const CLEANUP_LEASE_MS = 60_000;

@Injectable()
export class JobDeletionService {
  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    @InjectModel(NotificationOutbox.name)
    private readonly outbox: Model<NotificationOutbox>,
    private readonly transactions: ProcessingTransactions,
    private readonly storage: StorageTransfersService,
    private readonly usage: ProcessingUsageService,
    private readonly config: ConfigService,
  ) {}

  async delete(userId: string, jobId: string): Promise<void> {
    const owner = objectId(userId);
    const id = objectId(jobId);
    await this.transactions.run(async (session) => {
      const job = await this.jobs
        .findOne({ _id: id, userId: owner })
        .session(session);
      if (!job) throw jobError('JOB_NOT_FOUND');
      if (job.deletedAt) return;
      if (!['ready', 'failed', 'cancelled'].includes(job.status))
        throw jobError('JOB_ACTIVE');
      const now = new Date();
      const execution = job.currentExecution;
      // Let upload grants expire and in-flight PUTs settle before exact deletion.
      const graceMs =
        (Math.min(
          600,
          this.config.getOrThrow<number>('PROCESSING_URL_SECONDS'),
        ) +
          3_900) *
        1_000;
      const changed = await this.jobs.updateOne(
        { _id: id, userId: owner, revision: job.revision, deletedAt: null },
        {
          $set: {
            deletedAt: now,
            sourceTitle: null,
            displayName: null,
            sourceUrl: null,
            cleanupNextAt: new Date(now.getTime() + graceMs),
            cleanupFirstDeletedAt: null,
            cleanupLeaseUntil: null,
            cleanupToken: null,
            cleanupAttempts: 0,
            currentExecution: null,
            retryEligibility: job.retryEligibility
              ? {
                  ...job.retryEligibility,
                  eligible: false,
                  attemptsRemaining: 0,
                  nextAttemptAt: null,
                }
              : null,
          },
          $inc: { revision: 1 },
        },
        { session, runValidators: true },
      );
      if (changed.modifiedCount !== 1) throw jobError('JOB_STATE_CONFLICT');
      await this.fenceAttempt(execution, now, session);
      await this.outbox.updateMany(
        { jobId: id, userId: owner },
        {
          $set: {
            state: 'completed',
            completedAt: now,
            leaseId: null,
            leaseExpiresAt: null,
          },
          $inc: { revision: 1 },
        },
        { session },
      );
      const events = await this.outbox
        .find({ jobId: id, userId: owner })
        .session(session)
        .lean();
      if (events.length) {
        await this.jobs.db
          .model<NotificationDelivery>(NotificationDelivery.name)
          .updateMany(
            {
              outboxId: trusted({ $in: events.map((event) => event._id) }),
              status: 'pending',
            },
            {
              $set: {
                status: 'ineligible',
                lastFailureKind: 'ineligible',
                failedAt: now,
              },
            },
            { session, runValidators: true },
          );
      }
    });
  }

  private async fenceAttempt(
    execution: WorkerExecutionOwnership | null,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    if (!execution) return;
    await this.jobs.db.model<WorkerAttempt>(WorkerAttempt.name).updateOne(
      {
        _id: execution.attemptId,
        state: trusted({ $in: ['claimed', 'running', 'uploading'] }),
      },
      {
        $set: {
          state: 'cancelled',
          terminalCode: 'CANCELLED',
          terminalSummary: 'Job was deleted',
          finishedAt: now,
          leaseExpiresAt: now,
        },
        $inc: { revision: 1 },
      },
      { session, runValidators: true },
    );
    await this.jobs.db.model<WorkerSlot>(WorkerSlot.name).updateOne(
      {
        _id: execution.workerId,
        machineId: execution.machineId,
        sessionId: execution.sessionId,
        incarnation: execution.incarnation,
        currentAttemptId: execution.attemptId,
      },
      {
        $set: { state: 'idle', currentAttemptId: null, lastSeenAt: now },
        $inc: { revision: 1 },
      },
      { session, runValidators: true },
    );
  }

  /** Claims one bounded cleanup batch. Safe to run in several API replicas. */
  async cleanupDue(now = new Date()): Promise<boolean> {
    const token = randomUUID();
    const job = await this.jobs
      .findOneAndUpdate(
        {
          deletedAt: trusted({ $ne: null }),
          cleanupCompletedAt: null,
          cleanupNextAt: trusted({ $lte: now, $ne: null }),
          $or: [
            { cleanupLeaseUntil: null },
            { cleanupLeaseUntil: trusted({ $lte: now }) },
          ],
        },
        {
          $set: {
            cleanupToken: token,
            cleanupLeaseUntil: new Date(now.getTime() + CLEANUP_LEASE_MS),
          },
        },
        { returnDocument: 'after', sort: { cleanupNextAt: 1, _id: 1 } },
      )
      .lean();
    if (!job) return false;
    try {
      if (
        job.cleanupFirstDeletedAt &&
        now.getTime() <
          job.cleanupFirstDeletedAt.getTime() +
            StorageCleanupService.LATE_UPLOAD_RECHECK_MS
      ) {
        await this.jobs.updateOne(
          { _id: job._id, cleanupToken: token },
          {
            $set: {
              cleanupNextAt: new Date(
                job.cleanupFirstDeletedAt.getTime() +
                  StorageCleanupService.LATE_UPLOAD_RECHECK_MS,
              ),
              cleanupToken: null,
              cleanupLeaseUntil: null,
            },
          },
        );
        return true;
      }
      const keys = new Set(
        [
          job.inputReservation.key,
          job.inputObject?.key,
          job.outputObject?.key,
        ].filter((key): key is string => Boolean(key)),
      );
      for (const key of keys) {
        if (!key.startsWith(`users/${job.userId.toHexString()}/jobs/`))
          throw new Error('Invalid artifact ownership');
        const lease = await this.jobs.updateOne(
          { _id: job._id, cleanupToken: token },
          {
            $set: {
              cleanupLeaseUntil: new Date(
                Math.max(Date.now(), now.getTime()) + CLEANUP_LEASE_MS,
              ),
            },
          },
        );
        if (lease.matchedCount !== 1) throw new Error('Cleanup lease lost');
        // Retry jobs share the exact pinned input. Keep it while ANY live job references it.
        const reference = await this.jobs.exists({
          userId: job.userId,
          deletedAt: null,
          $or: [
            { 'inputReservation.key': key },
            { 'inputObject.key': key },
            { 'outputObject.key': key },
          ],
        });
        if (reference) continue;
        await this.storage.deleteObject(key);
      }
      if (keys.size > 0 && !job.cleanupFirstDeletedAt) {
        await this.jobs.updateOne(
          { _id: job._id, cleanupToken: token },
          {
            $set: {
              cleanupFirstDeletedAt: now,
              cleanupNextAt: new Date(
                now.getTime() + StorageCleanupService.LATE_UPLOAD_RECHECK_MS,
              ),
              cleanupToken: null,
              cleanupLeaseUntil: null,
              cleanupAttempts: 0,
            },
          },
        );
      } else await this.completeCleanup(job._id, token, now);
    } catch {
      const failures = Math.min((job.cleanupAttempts ?? 0) + 1, 20);
      await this.jobs.updateOne(
        { _id: job._id, cleanupToken: token },
        {
          $set: {
            cleanupToken: null,
            cleanupLeaseUntil: null,
            cleanupAttempts: failures,
            cleanupNextAt: new Date(
              now.getTime() + Math.min(3_600_000, 30_000 * 2 ** (failures - 1)),
            ),
          },
        },
      );
    }
    return true;
  }

  private async completeCleanup(
    jobId: Job['_id'],
    token: string,
    now: Date,
  ): Promise<void> {
    await this.transactions.run(async (session) => {
      const current = await this.jobs
        .findOne({ _id: jobId, cleanupToken: token })
        .session(session)
        .lean();
      if (!current) throw new Error('Cleanup lease lost');
      await this.usage.releaseRetainedOutput(current, session);
      const releasesRetainedOutput = Boolean(
        current.outputObject &&
        current.retainedOutputAccountedAt &&
        !current.retainedOutputReleasedAt,
      );
      const updated = await this.jobs.updateOne(
        { _id: jobId, cleanupToken: token },
        {
          $set: {
            cleanupToken: null,
            cleanupLeaseUntil: null,
            cleanupAttempts: 0,
            cleanupNextAt: null,
            cleanupCompletedAt: now,
            ...(releasesRetainedOutput
              ? { retainedOutputReleasedAt: now }
              : {}),
          },
        },
        { session, runValidators: true },
      );
      if (updated.modifiedCount !== 1) throw new Error('Cleanup lease lost');
    });
  }
}

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trusted, type ClientSession, type Model } from 'mongoose';
import { JobError } from '../job-errors/job-error.schema.js';
import { NotificationDelivery } from '../notifications/notification-delivery.schema.js';
import { NotificationOutbox } from '../notifications/notification-outbox.schema.js';
import { ProcessingReservation } from '../processing-usage/processing-usage.schema.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { StorageCleanupTask } from '../storage/storage-cleanup-task.schema.js';
import { StorageTransfersService } from '../storage/storage-transfers.service.js';
import { WorkerAttempt } from '../worker-fleet/jobs/worker-attempt.schema.js';
import { WorkerSlot } from '../worker-fleet/machines/worker-slot.schema.js';
import { Job } from './job.schema.js';
import { PurgedJobRequest } from './purged-job-request.schema.js';
import { isSharedMediaKey } from '../shared-media/shared-media-key.js';

const DAY_MS = 86_400_000;
const DELETED_JOB_RETENTION_MS = 30 * DAY_MS;
const ERROR_RETENTION_MS = 90 * DAY_MS;
const RECHECK_MS = 3_600_000;
const TERMINAL_JOB_STATES = ['ready', 'failed', 'cancelled'];
const ACTIVE_ATTEMPT_STATES: WorkerAttempt['state'][] = [
  'claimed',
  'running',
  'uploading',
];

@Injectable()
export class JobRetentionService {
  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    private readonly transactions: ProcessingTransactions,
    private readonly storage: StorageTransfersService,
  ) {}

  /** One deleted job per call, bounded and deferred when a dependency still owns it. */
  async purgeDue(now = new Date()): Promise<boolean> {
    const cutoff = new Date(now.getTime() - DELETED_JOB_RETENTION_MS);
    const candidate = await this.jobs
      .findOneAndUpdate(
        {
          deletedAt: trusted({ $type: 'date' }),
          cleanupCompletedAt: trusted({ $type: 'date', $lte: cutoff }),
          $or: [
            { retentionNextAt: null },
            { retentionNextAt: trusted({ $lte: now }) },
          ],
        },
        { $set: { retentionNextAt: new Date(now.getTime() + RECHECK_MS) } },
        {
          returnDocument: 'after',
          sort: { retentionNextAt: 1, cleanupCompletedAt: 1, _id: 1 },
        },
      )
      .lean();
    if (!candidate) return false;

    const snapshot = await this.transactions.run((session) =>
      this.loadPurgeable(candidate, cutoff, now, session),
    );
    if (!snapshot) return true;
    // Reconcile every exact attempt key before discarding its last durable
    // reference. Completed cleanup is already beyond the upload settlement window.
    for (const key of snapshot.keys) {
      if (!key.startsWith(`users/${candidate.userId.toHexString()}/jobs/`))
        throw new Error('Invalid artifact ownership');
      try {
        await this.storage.deleteObject(key);
      } catch {
        return true;
      }
    }

    await this.transactions.run(async (session) => {
      const current = await this.loadPurgeable(candidate, cutoff, now, session);
      if (!current) return;
      const job = current.job;
      const receipts = this.model<PurgedJobRequest>(PurgedJobRequest.name);
      await receipts.updateOne(
        { accountId: job.userId, requestId: job.requestId },
        {
          $setOnInsert: {
            accountId: job.userId,
            requestId: job.requestId,
            requestHash: job.requestHash,
            jobId: job._id,
            purgedAt: now,
          },
        },
        { upsert: true, session, runValidators: true },
      );
      // The receipt and all dependent details are removed/retained atomically with
      // the job; a restart cannot expose an unprotected request ID.
      const deleted = await this.jobs.deleteOne(
        {
          _id: job._id,
          revision: job.revision,
          deletedAt: job.deletedAt,
          cleanupCompletedAt: job.cleanupCompletedAt,
          retentionNextAt: candidate.retentionNextAt,
          currentExecution: null,
        },
        { session },
      );
      if (deleted.deletedCount !== 1)
        throw new Error('Job retention ownership lost');
      await this.model<WorkerAttempt>(WorkerAttempt.name).deleteMany(
        { jobId: job._id },
        { session },
      );
      await this.model<JobError>(JobError.name).deleteMany(
        { jobId: job._id },
        { session },
      );
      await this.model<NotificationDelivery>(
        NotificationDelivery.name,
      ).deleteMany(
        { outboxId: trusted({ $in: current.outboxIds }) },
        { session },
      );
      await this.model<NotificationOutbox>(NotificationOutbox.name).deleteMany(
        { jobId: job._id },
        { session },
      );
    });
    return true;
  }

  /** Only finalized detail receives TTL; unfinished notification events retain dedupe. */
  async finalizeErrorDue(now = new Date()): Promise<boolean> {
    const errors = this.model<JobError>(JobError.name);
    const candidate = await errors
      .findOneAndUpdate(
        {
          finalizedAt: null,
          $or: [
            { retentionNextAt: null },
            { retentionNextAt: trusted({ $lte: now }) },
          ],
        },
        { $set: { retentionNextAt: new Date(now.getTime() + RECHECK_MS) } },
        { returnDocument: 'after', sort: { retentionNextAt: 1, _id: 1 } },
      )
      .lean();
    if (!candidate) return false;
    await this.transactions.run(async (session) => {
      const job = await this.jobs
        .findById(candidate.jobId)
        .session(session)
        .lean();
      if (
        !job ||
        !TERMINAL_JOB_STATES.includes(job.status) ||
        job.currentExecution
      )
        return;
      if (
        await this.model<WorkerAttempt>(WorkerAttempt.name)
          .exists({
            jobId: job._id,
            state: trusted({ $in: ACTIVE_ATTEMPT_STATES }),
          })
          .session(session)
      )
        return;
      if (job.deletedAt)
        await this.finalizeDeletedNotificationChildren(job._id, now, session);
      if (!(await this.notificationsFinished(job._id, session))) return;
      await errors.updateOne(
        {
          _id: candidate._id,
          finalizedAt: null,
          retentionNextAt: candidate.retentionNextAt,
        },
        {
          $set: {
            finalizedAt: now,
            purgeAt: new Date(now.getTime() + ERROR_RETENTION_MS),
            retentionNextAt: null,
          },
        },
        { session, runValidators: true },
      );
    });
    return true;
  }

  private async loadPurgeable(
    candidate: Job,
    cutoff: Date,
    now: Date,
    session: ClientSession,
  ) {
    const job = await this.jobs
      .findOne({
        _id: candidate._id,
        deletedAt: trusted({ $type: 'date' }),
        cleanupCompletedAt: trusted({ $type: 'date', $lte: cutoff }),
        retentionNextAt: candidate.retentionNextAt,
      })
      .session(session)
      .lean();
    if (
      !job ||
      !TERMINAL_JOB_STATES.includes(job.status) ||
      job.currentExecution ||
      job.cleanupToken ||
      job.cleanupNextAt
    )
      return null;
    if (
      job.outputObject &&
      job.retainedOutputAccountedAt &&
      !job.retainedOutputReleasedAt
    )
      return null;
    const attempts = await this.model<WorkerAttempt>(WorkerAttempt.name)
      .find({ jobId: job._id })
      .session(session)
      .lean();
    if (
      attempts.some(
        (attempt) =>
          ACTIVE_ATTEMPT_STATES.includes(attempt.state) ||
          !attempt.finishedAt ||
          (attempt.outputReservation &&
            attempt.outputReservation.grantExpiresAt > now),
      )
    )
      return null;
    if (
      attempts.length &&
      (await this.model<WorkerSlot>(WorkerSlot.name)
        .exists({
          currentAttemptId: trusted({
            $in: attempts.map((attempt) => attempt._id),
          }),
        })
        .session(session))
    )
      return null;
    const keys = [
      ...new Set(
        [
          job.inputReservation.key,
          job.inputObject?.key,
          job.outputObject?.key,
          ...attempts.flatMap((attempt) => [
            attempt.outputReservation?.key,
            attempt.outputObject?.key,
          ]),
        ].filter(
          (key): key is string =>
            typeof key === 'string' && key.length > 0 && !isSharedMediaKey(key),
        ),
      ),
    ];
    // Keep the logical root (used for transfer accounting) and shared pinned input
    // while any live descendant needs them, including a terminal Library result.
    if (
      await this.jobs
        .exists({
          _id: trusted({ $ne: job._id }),
          userId: job.userId,
          deletedAt: null,
          $or: [
            { logicalAudioId: job.logicalAudioId },
            { retryOfJobId: job._id },
            { 'inputReservation.key': trusted({ $in: keys }) },
            { 'inputObject.key': trusted({ $in: keys }) },
            { 'outputObject.key': trusted({ $in: keys }) },
          ],
        })
        .session(session)
    )
      return null;
    if (
      await this.model<ProcessingReservation>(ProcessingReservation.name)
        .exists({
          accountId: job.userId,
          state: 'reserved',
          _id: trusted({ $in: [job._id, job.logicalAudioId] }),
        })
        .session(session)
    )
      return null;
    if (
      await this.model<StorageCleanupTask>(StorageCleanupTask.name)
        .exists({
          key: trusted({ $in: keys }),
          completedAt: null,
        })
        .session(session)
    )
      return null;
    await this.finalizeDeletedNotificationChildren(job._id, now, session);
    const outboxIds = await this.notificationsFinished(job._id, session);
    if (!outboxIds) return null;
    return { job, keys, outboxIds };
  }

  private async finalizeDeletedNotificationChildren(
    jobId: Job['_id'],
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    const outbox = this.model<NotificationOutbox>(NotificationOutbox.name);
    const events = await outbox.find({ jobId }).session(session).lean();
    if (
      !events.length ||
      events.some(
        (event) =>
          event.state !== 'completed' ||
          !event.completedAt ||
          event.leaseId ||
          event.leaseExpiresAt,
      )
    )
      return;
    const deliveries = this.model<NotificationDelivery>(
      NotificationDelivery.name,
    );
    const pending = {
      outboxId: trusted({ $in: events.map((event) => event._id) }),
      status: 'pending' as const,
    };
    if (!(await deliveries.exists(pending).session(session))) return;
    // Older explicit deletions completed parents without closing their pending
    // children. Fence those parents again before finalizing the unreachable targets.
    await outbox.updateMany(
      {
        _id: trusted({ $in: events.map((event) => event._id) }),
        state: 'completed',
        leaseId: null,
        leaseExpiresAt: null,
      },
      { $inc: { revision: 1 } },
      { session },
    );
    await deliveries.updateMany(
      pending,
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

  private async notificationsFinished(
    jobId: Job['_id'],
    session: ClientSession,
  ) {
    const events = await this.model<NotificationOutbox>(NotificationOutbox.name)
      .find({ jobId })
      .session(session)
      .lean();
    if (
      events.some(
        (event) =>
          event.state !== 'completed' ||
          !event.completedAt ||
          event.leaseId ||
          event.leaseExpiresAt,
      )
    )
      return null;
    const ids = events.map((event) => event._id);
    if (
      ids.length &&
      (await this.model<NotificationDelivery>(NotificationDelivery.name)
        .exists({
          outboxId: trusted({ $in: ids }),
          status: 'pending',
        })
        .session(session))
    )
      return null;
    return ids;
  }

  private model<T>(name: string): Model<T> {
    return this.jobs.db.model<T>(name);
  }
}

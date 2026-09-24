import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Auth } from 'firebase-admin/auth';
import type { Document, Filter } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { trusted, type Connection, type Model, type Types } from 'mongoose';
import { FIREBASE_AUTH } from '../auth/firebase-identity.service.js';
import { JobActionsService } from '../jobs/job-actions.service.js';
import { JobDeletionService } from '../jobs/job-deletion.service.js';
import { Job } from '../jobs/job.schema.js';
import { StorageCleanupService } from '../storage/storage-cleanup.service.js';
import { UserIdentityFenceService } from './user-identity-fence.service.js';
import { User } from './user.schema.js';

const LEASE_MS = 60_000;
const PAGE_SIZE = 20;
const PROGRESS_RETRY_MS = 15_000;
const FAILURE_RETRY_MS = 60_000;

const ACTIVE_JOB_STATUSES = [
  'awaiting_upload',
  'queued',
  'validating',
  'processing',
  'uploading_result',
  'interrupted',
  'cancel_requested',
] as const;

const ACCOUNT_RECORD_COLLECTIONS = [
  ['audio_notification_outbox', 'userId'],
  ['user_devices', 'userId'],
  ['device_installation_owners', 'userId'],
  ['push_registrations', 'userId'],
  ['client_errors', 'userId'],
  ['account_recovery_requests', 'userId'],
  ['processing_usage_ledger', 'userId'],
  ['account_usage_periods', 'accountId'],
  ['account_daily_usage_periods', 'accountId'],
  ['upload_grant_receipts', 'accountId'],
  ['download_grant_receipts', 'accountId'],
  ['processing_reservations', 'accountId'],
  ['account_policy_overrides', 'accountId'],
  ['abuse_event_buckets', 'accountId'],
  ['abuse_monthly_summaries', 'accountId'],
  ['account_restrictions', 'accountId'],
] as const;

type PurgePhase = NonNullable<User['deletionPhase']>;
type OwnedPurge = {
  _id: Types.ObjectId;
  status: 'purging';
  deletionLeaseToken: string;
};

type AttemptArtifact = Document & {
  outputObject?: { key?: unknown; versionId?: unknown } | null;
  outputReservation?: { key?: unknown } | null;
};

type DeletionTombstoneDocument = Document & {
  _id: string;
  acceptedAt: Date;
  completedAt: Date;
  status: 'purged';
  schemaVersion: 1;
};

/** Durable intent stays on the fenced user until every provider has succeeded. */
@Injectable()
export class AccountDeletionCleanupService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    @InjectConnection() private readonly connection: Connection,
    private readonly actions: JobActionsService,
    private readonly deletion: JobDeletionService,
    private readonly storageCleanup: StorageCleanupService,
    @Inject(FIREBASE_AUTH) private readonly firebase: Auth,
    private readonly identities: UserIdentityFenceService,
  ) {}

  async advanceDeletion(now = new Date()): Promise<boolean> {
    const token = randomUUID();
    let user = await this.users
      .findOneAndUpdate(
        {
          status: trusted({ $in: ['deleting', 'purging'] }),
          $and: [
            {
              $or: [{ deletionNextAt: trusted({ $lte: now, $ne: null }) }],
            },
            {
              $or: [
                { deletionLeaseUntil: null },
                { deletionLeaseUntil: trusted({ $lte: now }) },
              ],
            },
          ],
        },
        {
          $set: {
            deletionLeaseToken: token,
            deletionLeaseUntil: new Date(now.getTime() + LEASE_MS),
          },
        },
        { returnDocument: 'after', sort: { deletionNextAt: 1, _id: 1 } },
      )
      .lean();
    if (!user) return false;

    if (user.status === 'deleting') {
      const recoverUntil = user.deletionRecoverUntil;
      if (!recoverUntil) throw new Error('Deletion deadline is missing');
      if (recoverUntil.getTime() > now.getTime()) {
        await this.fenceGraceWork(user, token, recoverUntil, now);
        return true;
      }
      user = await this.users
        .findOneAndUpdate(
          {
            _id: user._id,
            status: 'deleting',
            deletionLeaseToken: token,
          },
          {
            $set: {
              status: 'purging',
              deletionRecoverUntil: recoverUntil,
              deletionPurgeStartedAt: now,
              deletionPhase: 'identity',
              deletionCursor: null,
              deletionFailureCode: null,
            },
          },
          { returnDocument: 'after', runValidators: true },
        )
        .lean();
      if (!user) return true;
    }

    const owned: OwnedPurge = {
      _id: user._id,
      status: 'purging',
      deletionLeaseToken: token,
    };
    let retryMs = PROGRESS_RETRY_MS;
    let failed = false;
    try {
      await this.renew(owned);
      const phase = user.deletionPhase ?? 'identity';
      if (phase === 'identity') {
        await this.providerCall(() =>
          this.firebase.revokeRefreshTokens(user.firebaseUid),
        );
        await this.renew(owned);
        await this.providerCall(() =>
          this.firebase.updateUser(user.firebaseUid, { disabled: true }),
        );
        await this.transition(owned, 'jobs', null);
      } else if (phase === 'jobs') {
        if (!(await this.advanceJobs(user._id, owned, now)))
          await this.transition(
            owned,
            'records',
            ACCOUNT_RECORD_COLLECTIONS[0][0],
          );
      } else if (phase === 'records') {
        if (!(await this.advanceRecords(user._id, user.deletionCursor, owned)))
          await this.transition(owned, 'provider', null);
      } else if (phase === 'provider') {
        if (await this.storageCleanup.hasPendingForOwner(user._id)) return true;
        if (
          await this.purgeBatch('storage_cleanup_tasks', {
            ownerUserId: user._id,
          })
        )
          return true;
        await this.renew(owned);
        await this.providerCall(() =>
          this.firebase.deleteUser(user.firebaseUid),
        );
        await this.renew(owned);
        await this.identities.complete(user.firebaseUid, now);
        await this.transition(owned, 'profile', null);
      } else if (phase === 'profile') {
        await this.writeTombstone(user, now);
        await this.users.deleteOne(owned);
      }
    } catch {
      failed = true;
      retryMs = FAILURE_RETRY_MS;
    } finally {
      await this.users.updateOne(owned, {
        $set: {
          deletionLeaseToken: null,
          deletionLeaseUntil: null,
          deletionNextAt: new Date(now.getTime() + retryMs),
          deletionFailureCode: failed ? 'DEPENDENCY_RETRY' : null,
        },
      });
    }
    return true;
  }

  private async fenceGraceWork(
    user: User,
    token: string,
    recoverUntil: Date,
    now: Date,
  ): Promise<void> {
    let retryAt = recoverUntil;
    let failed = false;
    try {
      const active = await this.jobs
        .find({
          userId: user._id,
          deletedAt: null,
          status: trusted({ $in: ACTIVE_JOB_STATUSES }),
        })
        .sort({ _id: 1 })
        .limit(PAGE_SIZE)
        .lean();
      for (const job of active)
        await this.actions.cancelForAccountDeletion(
          user._id.toHexString(),
          job._id.toHexString(),
        );
      if (active.length) retryAt = new Date(now.getTime() + PROGRESS_RETRY_MS);
    } catch {
      failed = true;
      retryAt = new Date(now.getTime() + FAILURE_RETRY_MS);
    } finally {
      await this.users.updateOne(
        {
          _id: user._id,
          status: 'deleting',
          deletionLeaseToken: token,
        },
        {
          $set: {
            deletionRecoverUntil: recoverUntil,
            deletionNextAt: retryAt,
            deletionLeaseToken: null,
            deletionLeaseUntil: null,
            deletionPhase: 'grace_fence',
            deletionCursor: null,
            deletionFailureCode: failed ? 'DEPENDENCY_RETRY' : null,
          },
        },
      );
    }
  }

  private async advanceJobs(
    userId: Types.ObjectId,
    owned: OwnedPurge,
    now: Date,
  ): Promise<boolean> {
    const live = await this.jobs
      .find({ userId, deletedAt: null })
      .sort({ _id: 1 })
      .limit(PAGE_SIZE)
      .lean();
    for (const job of live) {
      await this.renew(owned);
      if (['ready', 'failed', 'cancelled'].includes(job.status))
        await this.deletion.delete(userId.toHexString(), job._id.toHexString());
      else
        await this.actions.cancelForAccountDeletion(
          userId.toHexString(),
          job._id.toHexString(),
        );
    }
    if (live.length) return true;
    if (await this.jobs.exists({ userId, cleanupCompletedAt: null }))
      return true;

    const jobs = await this.jobs
      .find({ userId })
      .sort({ _id: 1 })
      .limit(PAGE_SIZE)
      .lean();
    for (const job of jobs) {
      await this.renew(owned);
      if (await this.purgeAttempts(job._id, userId, now)) return true;
      for (const name of [
        'audio_job_errors',
        'upload_grant_receipts',
        'download_grant_receipts',
      ]) {
        if (await this.purgeBatch(name, { jobId: job._id })) return true;
      }
      if (await this.purgeOutbox({ jobId: job._id }, owned)) return true;
      await this.connection.collection('audio_jobs').deleteOne({
        _id: job._id,
        userId,
        cleanupCompletedAt: { $ne: null },
      });
    }
    return jobs.length > 0;
  }

  private async purgeAttempts(
    jobId: Types.ObjectId,
    userId: Types.ObjectId,
    now: Date,
  ): Promise<boolean> {
    const collection =
      this.connection.collection<AttemptArtifact>('worker_attempts');
    const attempts = await collection
      .find({ jobId })
      .project({ _id: 1, outputObject: 1, outputReservation: 1 })
      .limit(PAGE_SIZE)
      .toArray();
    if (!attempts.length) return false;
    for (const attempt of attempts) {
      const reservationKey =
        typeof attempt.outputReservation?.key === 'string'
          ? attempt.outputReservation.key
          : null;
      const outputKey =
        typeof attempt.outputObject?.key === 'string'
          ? attempt.outputObject.key
          : null;
      const versionId =
        typeof attempt.outputObject?.versionId === 'string'
          ? attempt.outputObject.versionId
          : null;
      if (reservationKey)
        await this.storageCleanup.schedule({
          key: reservationKey,
          ownerUserId: userId,
          reason: 'AUDIO_OUTPUT_ORPHANED',
          nextAt: now,
          settleUntil: now,
        });
      if (outputKey && outputKey !== reservationKey)
        await this.storageCleanup.schedule({
          key: outputKey,
          versionId,
          ownerUserId: userId,
          reason: 'AUDIO_OUTPUT_ORPHANED',
          nextAt: now,
          settleUntil: now,
        });
    }
    await collection.deleteMany({
      jobId,
      _id: { $in: attempts.map((attempt) => attempt._id) },
    });
    return true;
  }

  private async advanceRecords(
    userId: Types.ObjectId,
    cursor: string | null,
    owned: OwnedPurge,
  ): Promise<boolean> {
    const cursorIndex = ACCOUNT_RECORD_COLLECTIONS.findIndex(
      ([name]) => name === cursor,
    );
    const start = cursorIndex >= 0 ? cursorIndex : 0;
    for (
      let index = start;
      index < ACCOUNT_RECORD_COLLECTIONS.length;
      index++
    ) {
      const [name, field] = ACCOUNT_RECORD_COLLECTIONS[index];
      await this.renew(owned);
      if (
        name === 'audio_notification_outbox'
          ? await this.purgeOutbox({ userId }, owned)
          : await this.purgeBatch(name, { [field]: userId })
      )
        return true;
      const next = ACCOUNT_RECORD_COLLECTIONS[index + 1]?.[0] ?? null;
      await this.users.updateOne(owned, {
        $set: { deletionCursor: next, deletionFailureCode: null },
      });
    }
    return false;
  }

  private async transition(
    owned: OwnedPurge,
    phase: PurgePhase,
    cursor: string | null,
  ): Promise<void> {
    const result = await this.users.updateOne(owned, {
      $set: {
        deletionPhase: phase,
        deletionCursor: cursor,
        deletionFailureCode: null,
      },
    });
    if (result.matchedCount !== 1)
      throw new Error('Account cleanup lease lost');
  }

  private async renew(owned: OwnedPurge): Promise<void> {
    const result = await this.users.updateOne(owned, {
      $set: { deletionLeaseUntil: new Date(Date.now() + LEASE_MS) },
    });
    if (result.matchedCount !== 1)
      throw new Error('Account cleanup lease lost');
  }

  private async writeTombstone(user: User, now: Date): Promise<void> {
    if (!user.deletionRequestId || !user.deletionRequestedAt)
      throw new Error('Account deletion intent is incomplete');
    await this.connection
      .collection<DeletionTombstoneDocument>('account_deletion_tombstones')
      .updateOne(
        { _id: user.deletionRequestId },
        {
          $setOnInsert: {
            acceptedAt: user.deletionRequestedAt,
            completedAt: now,
            status: 'purged',
            schemaVersion: 1,
          },
        },
        { upsert: true },
      );
  }

  private async providerCall(operation: () => Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Identity cleanup timed out')),
            10_000,
          );
        }),
      ]);
    } catch (error) {
      if ((error as { code?: string }).code !== 'auth/user-not-found')
        throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async purgeBatch(
    name: string,
    filter: Filter<Document>,
  ): Promise<boolean> {
    const collection = this.connection.collection(name);
    const page = await collection
      .find(filter)
      .project({ _id: 1 })
      .limit(100)
      .toArray();
    if (!page.length) return false;
    await collection.deleteMany({
      ...filter,
      _id: { $in: page.map((item) => item._id) },
    });
    return true;
  }

  private async purgeOutbox(
    filter: Filter<Document>,
    owned: OwnedPurge,
  ): Promise<boolean> {
    const outbox = this.connection.collection('audio_notification_outbox');
    const page = await outbox
      .find(filter)
      .project({ _id: 1 })
      .limit(PAGE_SIZE)
      .toArray();
    for (const record of page) {
      await this.renew(owned);
      if (
        await this.purgeBatch('audio_notification_deliveries', {
          outboxId: record._id,
        })
      )
        return true;
      await outbox.deleteOne({ ...filter, _id: record._id });
    }
    return page.length > 0;
  }
}

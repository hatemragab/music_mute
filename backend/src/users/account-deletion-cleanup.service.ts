import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Auth } from 'firebase-admin/auth';
import { randomUUID } from 'node:crypto';
import { trusted, type Connection, type Model } from 'mongoose';
import type { Document, Filter } from 'mongodb';
import { FIREBASE_AUTH } from '../auth/firebase-identity.service.js';
import { JobActionsService } from '../jobs/job-actions.service.js';
import { JobDeletionService } from '../jobs/job-deletion.service.js';
import { Job } from '../jobs/job.schema.js';
import { UserIdentityFenceService } from './user-identity-fence.service.js';
import { User } from './user.schema.js';
import { accountRecoveryDeadline } from './account-recovery-policy.js';
import { StorageCleanupService } from '../storage/storage-cleanup.service.js';

const LEASE_MS = 60_000;
const PAGE_SIZE = 20;

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
              $or: [
                { deletionNextAt: trusted({ $lte: now, $ne: null }) },
                { status: 'deleting', deletionRecoverUntil: null },
                { status: 'deleting', deletionNextAt: null },
              ],
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
      const recoverUntil =
        user.deletionRecoverUntil ??
        accountRecoveryDeadline(user.deletionRequestedAt ?? now);
      const futureDeadline = recoverUntil.getTime() > now.getTime();
      const scheduleMissing =
        !user.deletionRecoverUntil ||
        !user.deletionNextAt ||
        user.deletionNextAt.getTime() !== recoverUntil.getTime();
      if (scheduleMissing || futureDeadline) {
        const normalized = await this.users
          .findOneAndUpdate(
            {
              _id: user._id,
              status: 'deleting',
              deletionLeaseToken: token,
            },
            {
              $set: {
                deletionRecoverUntil: recoverUntil,
                deletionNextAt: recoverUntil,
                ...(futureDeadline
                  ? {
                      deletionLeaseToken: null,
                      deletionLeaseUntil: null,
                    }
                  : {}),
              },
            },
            { returnDocument: 'after', runValidators: true },
          )
          .lean();
        if (!normalized) return true;
        user = normalized;
        if (futureDeadline) return true;
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
              deletionPurgeStartedAt: now,
            },
          },
          { returnDocument: 'after', runValidators: true },
        )
        .lean();
      if (!user) return true;
    }
    const owned = {
      _id: user._id,
      status: 'purging' as const,
      deletionLeaseToken: token,
    };
    const renew = async () => {
      const result = await this.users.updateOne(owned, {
        $set: { deletionLeaseUntil: new Date(Date.now() + LEASE_MS) },
      });
      if (result.matchedCount !== 1)
        throw new Error('Account cleanup lease lost');
    };
    let retryMs = 15_000;
    try {
      await renew();
      await this.providerCall(() =>
        this.firebase.revokeRefreshTokens(user.firebaseUid),
      );
      await renew();
      await this.providerCall(() =>
        this.firebase.updateUser(user.firebaseUid, { disabled: true }),
      );
      const live = await this.jobs
        .find({ userId: user._id, deletedAt: null })
        .sort({ _id: 1 })
        .limit(PAGE_SIZE)
        .lean();
      for (const job of live) {
        await renew();
        if (['ready', 'failed', 'cancelled'].includes(job.status)) {
          await this.deletion.delete(
            user._id.toHexString(),
            job._id.toHexString(),
          );
        } else {
          await this.actions.cancelForAccountDeletion(
            user._id.toHexString(),
            job._id.toHexString(),
          );
        }
      }
      if (live.length) return true;
      // A lost lease does not establish that the process or its copies stopped.
      const control = await this.connection
        .collection('audio_worker_control')
        .findOne({ activeJobId: { $ne: null } });
      if (
        control &&
        (await this.jobs.exists({ _id: control.activeJobId, userId: user._id }))
      )
        return true;
      if (
        await this.jobs.exists({ userId: user._id, cleanupCompletedAt: null })
      )
        return true;

      // Keep each parent until its bounded child purges finish, preserving lookup keys after a restart.
      const jobs = await this.jobs
        .find({ userId: user._id })
        .sort({ _id: 1 })
        .limit(PAGE_SIZE)
        .lean();
      for (const job of jobs) {
        await renew();
        if (
          await this.connection
            .collection('audio_job_attempts')
            .findOne({ jobId: job._id, localDataDeletedAt: null })
        )
          return true;
        for (const name of [
          'audio_job_attempts',
          'audio_job_receipts',
          'audio_job_errors',
        ]) {
          if (await this.purgeBatch(name, { jobId: job._id })) return true;
        }
        if (await this.purgeOutbox({ jobId: job._id }, renew)) return true;
        await this.connection.collection('audio_jobs').deleteOne({
          _id: job._id,
          userId: user._id,
          cleanupCompletedAt: { $ne: null },
        });
      }
      if (jobs.length) return true;
      if (await this.purgeOutbox({ userId: user._id }, renew)) return true;
      for (const name of [
        'user_devices',
        'device_installation_owners',
        'push_registrations',
        'client_errors',
        'account_recovery_requests',
        'processing_usage_ledger',
        'processing_execution_usage',
      ]) {
        await renew();
        if (await this.purgeBatch(name, { userId: user._id })) return true;
      }
      if (await this.storageCleanup.hasPendingForOwner(user._id)) return true;
      await renew();
      await this.providerCall(() => this.firebase.deleteUser(user.firebaseUid));
      await renew();
      await this.identities.complete(user.firebaseUid);
      await this.users.deleteOne(owned);
    } catch {
      // No provider details or account data are logged. Keep the durable fence for retry.
      retryMs = 60_000;
    } finally {
      await this.users.updateOne(owned, {
        $set: {
          deletionLeaseToken: null,
          deletionLeaseUntil: null,
          deletionNextAt: new Date(Date.now() + retryMs),
        },
      });
    }
    return true;
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
    // Recheck ownership so an installation transferred during cleanup survives.
    await collection.deleteMany({
      ...filter,
      _id: { $in: page.map((item) => item._id) },
    });
    return true;
  }

  private async purgeOutbox(
    filter: Filter<Document>,
    renew: () => Promise<void>,
  ): Promise<boolean> {
    const outbox = this.connection.collection('audio_notification_outbox');
    const page = await outbox
      .find(filter)
      .project({ _id: 1 })
      .limit(PAGE_SIZE)
      .toArray();
    for (const record of page) {
      await renew();
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

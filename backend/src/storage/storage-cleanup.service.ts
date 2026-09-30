import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { trusted, type ClientSession, type Model, type Types } from 'mongoose';
import {
  StorageCleanupTask,
  type StorageCleanupReason,
} from './storage-cleanup-task.schema.js';
import { StorageTransfersService } from './storage-transfers.service.js';
import { isSharedMediaKey } from '../shared-media/shared-media-key.js';

export interface ScheduleStorageCleanup {
  key: string;
  ownerUserId: Types.ObjectId | null;
  reason: StorageCleanupReason;
  nextAt: Date;
  settleUntil: Date;
}

@Injectable()
export class StorageCleanupService implements OnModuleInit {
  static readonly LEASE_MILLISECONDS = 60_000;
  static readonly LATE_UPLOAD_RECHECK_MS = 7_200_000;

  constructor(
    @InjectModel(StorageCleanupTask.name)
    private readonly tasks: Model<StorageCleanupTask>,
    private readonly transfers: StorageTransfersService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.tasks.init();
  }

  async schedule(
    task: ScheduleStorageCleanup,
    session?: ClientSession,
  ): Promise<void> {
    this.validate(task);
    await this.tasks.updateOne(
      { key: task.key },
      {
        $setOnInsert: {
          key: task.key,
          ownerUserId: task.ownerUserId,
          reason: task.reason,
          leaseUntil: null,
          leaseToken: null,
          attempts: 0,
          firstDeletedAt: null,
          completedAt: null,
        },
        $min: { nextAt: task.nextAt },
        $max: { settleUntil: task.settleUntil },
      },
      { upsert: true, session, setDefaultsOnInsert: false },
    );
  }

  async hasPendingForOwner(ownerUserId: Types.ObjectId): Promise<boolean> {
    return Boolean(await this.tasks.exists({ ownerUserId, completedAt: null }));
  }

  async cancelScheduled(key: string, session?: ClientSession): Promise<void> {
    await this.tasks.deleteOne({ key, leaseToken: null }, { session });
  }

  /** Claims and advances one bounded task. Safe across API replicas. */
  async cleanupDue(now = new Date()): Promise<boolean> {
    const token = randomUUID();
    const task = await this.tasks
      .findOneAndUpdate(
        {
          completedAt: null,
          nextAt: trusted({ $lte: now }),
          $or: [{ leaseUntil: null }, { leaseUntil: trusted({ $lte: now }) }],
        },
        {
          $set: {
            leaseToken: token,
            leaseUntil: new Date(
              now.getTime() + StorageCleanupService.LEASE_MILLISECONDS,
            ),
          },
        },
        { returnDocument: 'after', sort: { nextAt: 1, _id: 1 } },
      )
      .lean();
    if (!task) return false;
    try {
      if (isSharedMediaKey(task.key))
        throw new TypeError('Shared media is permanently retained');
      // Expiry blocks new requests, not a PUT already in flight. Two free exact
      // deletes cover the existing client transfer timeout without HEAD/list loops.
      const readyAt = Math.max(
        task.settleUntil.getTime(),
        task.firstDeletedAt
          ? task.firstDeletedAt.getTime() +
              StorageCleanupService.LATE_UPLOAD_RECHECK_MS
          : 0,
      );
      const settled = now.getTime() >= readyAt;
      const referenced =
        settled &&
        (await this.isReferenced(task.key, task.reason, task.ownerUserId));
      if (settled && !referenced) await this.transfers.deleteObject(task.key);
      const completed = settled && !referenced && task.firstDeletedAt != null;
      const firstDeletedAt =
        settled && !referenced
          ? (task.firstDeletedAt ?? now)
          : (task.firstDeletedAt ?? null);
      const update = await this.tasks.updateOne(
        {
          _id: task._id,
          leaseToken: token,
          settleUntil: task.settleUntil,
        },
        {
          $set: {
            leaseToken: null,
            leaseUntil: null,
            attempts: 0,
            firstDeletedAt,
            completedAt: completed ? now : null,
            nextAt: referenced
              ? new Date(now.getTime() + 3_600_000)
              : completed
                ? null
                : new Date(
                    Math.max(
                      task.settleUntil.getTime(),
                      firstDeletedAt
                        ? firstDeletedAt.getTime() +
                            StorageCleanupService.LATE_UPLOAD_RECHECK_MS
                        : readyAt,
                    ),
                  ),
          },
        },
      );
      if (update.matchedCount !== 1) await this.releaseLease(task._id, token);
    } catch {
      const failures = Math.min(task.attempts + 1, 20);
      const update = await this.tasks.updateOne(
        {
          _id: task._id,
          leaseToken: token,
          settleUntil: task.settleUntil,
        },
        {
          $set: {
            leaseToken: null,
            leaseUntil: null,
            attempts: failures,
            nextAt: new Date(
              now.getTime() + Math.min(3_600_000, 30_000 * 2 ** (failures - 1)),
            ),
          },
        },
      );
      if (update.matchedCount !== 1) await this.releaseLease(task._id, token);
    }
    return true;
  }

  private async isReferenced(
    key: string,
    reason: StorageCleanupReason,
    ownerUserId: Types.ObjectId | null,
  ): Promise<boolean> {
    if (reason === 'RELEASE_UPLOAD_ORPHANED')
      return Boolean(
        await this.tasks.db
          .collection('app_releases')
          .findOne(
            { 'artifact.key': key },
            { projection: { _id: 1 }, maxTimeMS: 5000 },
          ),
      );
    // A retry shares the immutable input key. Retained originals and completed
    // outputs stay protected until every owning job releases them.
    return Boolean(
      await this.tasks.db.collection('audio_jobs').findOne(
        {
          userId: ownerUserId,
          deletedAt: null,
          $or: [
            {
              'inputReservation.key': key,
              reservationCleanupScheduledAt: null,
            },
            { 'inputObject.key': key, reservationCleanupScheduledAt: null },
            { 'outputObject.key': key },
          ],
        },
        { projection: { _id: 1 }, maxTimeMS: 5000 },
      ),
    );
  }

  private async releaseLease(_id: Types.ObjectId, token: string) {
    await this.tasks.updateOne(
      { _id, leaseToken: token },
      { $set: { leaseToken: null, leaseUntil: null } },
    );
  }

  private validate(task: ScheduleStorageCleanup): void {
    if (
      task.key.length < 1 ||
      task.key.length > 1024 ||
      task.key.includes('..') ||
      task.key.includes('//') ||
      !/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(task.key) ||
      !Number.isFinite(task.nextAt.getTime()) ||
      !Number.isFinite(task.settleUntil.getTime()) ||
      task.settleUntil < task.nextAt
    )
      throw new TypeError('Invalid storage cleanup task');
    if (isSharedMediaKey(task.key))
      throw new TypeError('Shared media is permanently retained');
    const owner = /^users\/([a-f0-9]{24})\//.exec(task.key)?.[1];
    const audio = task.reason !== 'RELEASE_UPLOAD_ORPHANED';
    if (
      audio !== Boolean(owner) ||
      (owner !== undefined && task.ownerUserId?.toHexString() !== owner) ||
      (owner === undefined &&
        (task.ownerUserId !== null || !task.key.startsWith('app-releases/')))
    )
      throw new TypeError('Invalid storage cleanup ownership');
  }
}

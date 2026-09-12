import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { trusted, type ClientSession, type Model, type Types } from 'mongoose';
import {
  StorageCleanupTask,
  type StorageCleanupReason,
} from './storage-cleanup-task.schema.js';
import { StorageTransfersService } from './storage-transfers.service.js';

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
      const sweep = await this.transfers.sweepVersionsForKey(task.key);
      const settled = now.getTime() >= task.settleUntil.getTime();
      const completed = sweep.complete && settled && sweep.deleted === 0;
      const retrySoon = !sweep.complete || (settled && sweep.deleted > 0);
      await this.tasks.updateOne(
        { _id: task._id, leaseToken: token },
        {
          $set: {
            leaseToken: null,
            leaseUntil: null,
            attempts: 0,
            completedAt: completed ? now : null,
            nextAt: completed
              ? null
              : retrySoon
                ? new Date(now.getTime() + 1_000)
                : task.settleUntil,
          },
        },
      );
    } catch {
      const failures = Math.min(task.attempts + 1, 20);
      await this.tasks.updateOne(
        { _id: task._id, leaseToken: token },
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
    }
    return true;
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

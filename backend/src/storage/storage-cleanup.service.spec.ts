import { Types, type Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type { StorageTransfersService } from './storage-transfers.service.js';
import {
  StorageCleanupService,
  type ScheduleStorageCleanup,
} from './storage-cleanup.service.js';
import type { StorageCleanupTask } from './storage-cleanup-task.schema.js';
import { StorageCleanupTaskSchema } from './storage-cleanup-task.schema.js';

type TaskRecord = ScheduleStorageCleanup & {
  _id: Types.ObjectId;
  leaseToken: string | null;
  leaseUntil: Date | null;
  attempts: number;
  completedAt: Date | null;
  nextAt: Date | null;
};

class TasksFixture {
  records: TaskRecord[] = [];
  init = vi.fn(async () => this);

  async updateOne(
    filter: {
      key?: string;
      versionId?: string | null;
      _id?: Types.ObjectId;
      leaseToken?: string;
      settleUntil?: Date;
    },
    update: Record<string, Record<string, unknown>>,
    options: { upsert?: boolean } = {},
  ) {
    let item = this.records.find(
      (entry) =>
        (filter.key === undefined || entry.key === filter.key) &&
        (filter.versionId === undefined ||
          (entry.versionId ?? null) === filter.versionId) &&
        (filter._id === undefined || entry._id.equals(filter._id)) &&
        (filter.leaseToken === undefined ||
          entry.leaseToken === filter.leaseToken) &&
        (filter.settleUntil === undefined ||
          entry.settleUntil.getTime() === filter.settleUntil.getTime()),
    );
    if (!item && options.upsert) {
      item = {
        _id: new Types.ObjectId(),
        ...(update.$setOnInsert as unknown as ScheduleStorageCleanup),
      } as TaskRecord;
      this.records.push(item);
    }
    if (!item) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(item, update.$set ?? {});
    for (const [key, value] of Object.entries(update.$min ?? {})) {
      const next = value as Date;
      const current = item[key as keyof TaskRecord] as Date | null | undefined;
      if (current === undefined || (current !== null && current > next))
        (item as unknown as Record<string, unknown>)[key] = next;
    }
    for (const [key, value] of Object.entries(update.$max ?? {})) {
      const next = value as Date;
      const current = item[key as keyof TaskRecord] as Date | null | undefined;
      if (current === undefined || current === null || current < next)
        (item as unknown as Record<string, unknown>)[key] = next;
    }
    return { matchedCount: 1, modifiedCount: 1 };
  }

  findOneAndUpdate(
    _filter: unknown,
    update: { $set: Partial<TaskRecord> },
    _options: unknown,
  ) {
    const now =
      update.$set.leaseUntil!.getTime() -
      StorageCleanupService.LEASE_MILLISECONDS;
    const item = this.records.find(
      (entry) =>
        !entry.completedAt &&
        !!entry.nextAt &&
        entry.nextAt.getTime() <= now &&
        (!entry.leaseUntil || entry.leaseUntil.getTime() <= now),
    );
    if (item) Object.assign(item, update.$set);
    return { lean: async () => (item ? { ...item } : null) };
  }

  async exists(filter: { ownerUserId: Types.ObjectId; completedAt: null }) {
    return (
      this.records.find(
        (entry) =>
          entry.ownerUserId?.equals(filter.ownerUserId) && !entry.completedAt,
      ) ?? null
    );
  }

  async deleteOne(filter: { key: string; leaseToken: null }) {
    const index = this.records.findIndex(
      (entry) => entry.key === filter.key && entry.leaseToken === null,
    );
    if (index < 0) return { deletedCount: 0 };
    this.records.splice(index, 1);
    return { deletedCount: 1 };
  }
}

function setup(
  results: Array<{ complete: boolean; deleted: number } | Error> = [],
  exactResults: Array<undefined | Error> = [],
) {
  const tasks = new TasksFixture();
  const sweepVersionsForKey = vi.fn(async () => {
    const result = results.shift() ?? { complete: true, deleted: 0 };
    if (result instanceof Error) throw result;
    return result;
  });
  const deleteExactVersion = vi.fn(async () => {
    const result = exactResults.shift();
    if (result instanceof Error) throw result;
  });
  const service = new StorageCleanupService(
    tasks as unknown as Model<StorageCleanupTask>,
    {
      sweepVersionsForKey,
      deleteExactVersion,
    } as unknown as StorageTransfersService,
  );
  return { service, tasks, sweepVersionsForKey, deleteExactVersion };
}

describe('StorageCleanupService', () => {
  const owner = new Types.ObjectId('507f1f77bcf86cd799439011');
  const key = `users/${owner.toHexString()}/jobs/job/input/file.mp3`;
  const due = new Date('2026-09-12T00:00:00.000Z');

  it('waits for the replica-safety index before maintenance can start', async () => {
    const { service, tasks } = setup();

    await service.onModuleInit();

    expect(tasks.init).toHaveBeenCalledOnce();
  });

  it('cancels an unclaimed orphan cleanup after successful finalization', async () => {
    const { service, tasks } = setup();
    await service.schedule({
      key,
      ownerUserId: owner,
      reason: 'AUDIO_OUTPUT_ORPHANED',
      nextAt: due,
      settleUntil: due,
    });
    await service.cancelScheduled(key);
    expect(tasks.records).toHaveLength(0);
  });

  it('validates ownership and schedules each immutable key idempotently', async () => {
    expect(
      StorageCleanupTaskSchema.path('settleUntil').options.immutable,
    ).not.toBe(true);
    const { service, tasks } = setup();
    await expect(
      service.schedule({
        key: 'users/507f1f77bcf86cd799439012/jobs/x/input/file.mp3',
        ownerUserId: owner,
        reason: 'AUDIO_INPUT_EXPIRED',
        nextAt: due,
        settleUntil: due,
      }),
    ).rejects.toThrow('Invalid storage cleanup ownership');
    await service.schedule({
      key,
      ownerUserId: owner,
      reason: 'AUDIO_INPUT_EXPIRED',
      nextAt: new Date(due.getTime() + 10_000),
      settleUntil: new Date(due.getTime() + 20_000),
    });
    await service.schedule({
      key,
      ownerUserId: owner,
      reason: 'AUDIO_INPUT_EXPIRED',
      nextAt: due,
      settleUntil: new Date(due.getTime() + 40_000),
    });
    expect(tasks.records).toHaveLength(1);
    expect(tasks.records[0]).toMatchObject({
      key,
      versionId: null,
      attempts: 0,
      nextAt: due,
      settleUntil: new Date(due.getTime() + 40_000),
    });
  });

  it('leases and completes one exact immutable version without a key sweep', async () => {
    const { service, tasks, sweepVersionsForKey, deleteExactVersion } = setup();
    await service.schedule({
      key,
      versionId: 'version-1',
      ownerUserId: owner,
      reason: 'AUDIO_INPUT_EXPIRED',
      nextAt: due,
      settleUntil: due,
    });

    await expect(service.cleanupDue(due)).resolves.toBe(true);

    expect(deleteExactVersion).toHaveBeenCalledWith(key, 'version-1');
    expect(sweepVersionsForKey).not.toHaveBeenCalled();
    expect(tasks.records[0]).toMatchObject({
      completedAt: due,
      nextAt: null,
      leaseToken: null,
    });
  });

  it('waits through settlement and completes only after a final empty pass', async () => {
    const settleUntil = new Date(due.getTime() + 60_000);
    const { service, tasks, sweepVersionsForKey } = setup([
      { complete: true, deleted: 2 },
      { complete: true, deleted: 0 },
    ]);
    await service.schedule({
      key,
      ownerUserId: owner,
      reason: 'AUDIO_INPUT_EXPIRED',
      nextAt: due,
      settleUntil,
    });
    await expect(service.cleanupDue(due)).resolves.toBe(true);
    expect(tasks.records[0]?.nextAt).toEqual(settleUntil);
    expect(tasks.records[0]?.completedAt).toBeNull();
    await expect(service.cleanupDue(settleUntil)).resolves.toBe(true);
    expect(tasks.records[0]?.completedAt).toEqual(settleUntil);
    expect(tasks.records[0]?.nextAt).toBeNull();
    expect(sweepVersionsForKey).toHaveBeenCalledTimes(2);
  });

  it('keeps paginated/deleting work due until an empty sweep is proven', async () => {
    const { service, tasks } = setup([
      { complete: false, deleted: 100 },
      { complete: true, deleted: 1 },
      { complete: true, deleted: 0 },
    ]);
    await service.schedule({
      key,
      ownerUserId: owner,
      reason: 'AUDIO_OUTPUT_ORPHANED',
      nextAt: due,
      settleUntil: due,
    });
    await service.cleanupDue(due);
    await service.cleanupDue(new Date(due.getTime() + 1_000));
    await service.cleanupDue(new Date(due.getTime() + 2_000));
    expect(tasks.records[0]?.completedAt).toEqual(
      new Date(due.getTime() + 2_000),
    );
  });

  it('preserves a concurrent settlement extension while sweeping', async () => {
    const extendedSettleUntil = new Date(due.getTime() + 60_000);
    const { service, tasks, sweepVersionsForKey } = setup();
    await service.schedule({
      key,
      ownerUserId: owner,
      reason: 'AUDIO_INPUT_EXPIRED',
      nextAt: due,
      settleUntil: due,
    });
    sweepVersionsForKey.mockImplementationOnce(async () => {
      await service.schedule({
        key,
        ownerUserId: owner,
        reason: 'AUDIO_INPUT_EXPIRED',
        nextAt: due,
        settleUntil: extendedSettleUntil,
      });
      return { complete: true, deleted: 0 };
    });

    await expect(service.cleanupDue(due)).resolves.toBe(true);

    expect(tasks.records[0]).toMatchObject({
      completedAt: null,
      leaseToken: null,
      leaseUntil: null,
      nextAt: due,
      settleUntil: extendedSettleUntil,
    });
  });

  it('releases failed leases with bounded exponential retry', async () => {
    const { service, tasks } = setup([new Error('provider detail')]);
    await service.schedule({
      key,
      ownerUserId: owner,
      reason: 'AUDIO_INPUT_EXPIRED',
      nextAt: due,
      settleUntil: due,
    });
    await service.cleanupDue(due);
    expect(tasks.records[0]).toMatchObject({
      attempts: 1,
      leaseToken: null,
      leaseUntil: null,
      nextAt: new Date(due.getTime() + 30_000),
    });
    await expect(service.hasPendingForOwner(owner)).resolves.toBe(true);
  });

  it('keeps a permanent provider failure safely pending at bounded hourly retry', async () => {
    const { service, tasks } = setup([], [new Error('access denied')]);
    await service.schedule({
      key,
      versionId: 'version-1',
      ownerUserId: owner,
      reason: 'AUDIO_INPUT_EXPIRED',
      nextAt: due,
      settleUntil: due,
    });
    tasks.records[0].attempts = 19;

    await expect(service.cleanupDue(due)).resolves.toBe(true);

    expect(tasks.records[0]).toMatchObject({
      attempts: 20,
      completedAt: null,
      leaseToken: null,
      leaseUntil: null,
      nextAt: new Date(due.getTime() + 3_600_000),
    });
  });
});

import { isDeepStrictEqual } from 'node:util';
import { Types, type ClientSession } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../jobs/job.schema.js';
import { workerRecipeSnapshot } from '../../jobs/worker-recipes.js';
import { authError } from '../../auth/auth.errors.js';
import { derivedTrimRecipe } from '../../shared-media/shared-media-trim.js';
import { JobRenditionService } from './job-rendition.service.js';

const sourceKey = 'a'.repeat(64);
const resultKey = 'b'.repeat(64);
const derivativeKey = 'c'.repeat(64);
const uuid = 'ab4dba76-e83c-4881-bac9-9955e9b0d09b';
const recipe = workerRecipeSnapshot('kim-vocals-v2', false);
const object = (key: string, bytes: number) => ({
  key,
  bytes,
  sha256: Buffer.alloc(32, 1).toString('base64'),
  etag: '"immutable"',
  contentType: 'audio/mpeg',
});
function field(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (row, key) =>
        row && typeof row === 'object'
          ? (row as Record<string, unknown>)[key]
          : undefined,
      value,
    );
}
function matches(row: Job, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or')
      return (value as Record<string, unknown>[]).some((part) =>
        matches(row, part),
      );
    const actual = field(row, key);
    if (value && typeof value === 'object' && '$lte' in value)
      return (
        actual instanceof Date &&
        actual.getTime() <= (value.$lte as Date).getTime()
      );
    if (value && typeof value === 'object' && '$gt' in value)
      return (
        actual instanceof Date &&
        actual.getTime() > (value.$gt as Date).getTime()
      );
    return isDeepStrictEqual(actual, value);
  });
}
function set(row: Job, path: string, value: unknown) {
  const segments = path.split('.');
  let parent = row as unknown as Record<string, unknown>;
  for (const key of segments.slice(0, -1))
    parent = parent[key] as Record<string, unknown>;
  parent[segments.at(-1)!] = value;
}
function copy(row: Job) {
  return {
    ...row,
    renditionPending: row.renditionPending ? { ...row.renditionPending } : null,
  };
}
function fixture() {
  const row = {
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    revision: 1,
    status: 'uploading_result',
    deletedAt: null,
    currentExecution: null,
    outputObject: null,
    inputObject: object(
      `shared/url/${sourceKey}/${uuid}/input/source.mp3`,
      200,
    ),
    sharedSourceKey: sourceKey,
    sharedResultKey: resultKey,
    recipeSnapshot: recipe,
    requestedTrimEnabled: true,
    retainedOutputAccountedAt: null,
    retainedOutputReleasedAt: null,
    renditionPending: {
      full: object(`shared/url/${resultKey}/${uuid}/output/vocals.mp3`, 100),
      attemptId: uuid,
      queuedAt: new Date(Date.now() - 1),
      nextAt: new Date(Date.now() - 1),
      leaseToken: null,
      leaseUntil: null,
      attempts: 0,
    },
  } as Job;
  const query = (read: () => unknown) => ({
    session: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    maxTimeMS: vi.fn().mockReturnThis(),
    lean: vi.fn(async () => read()),
  });
  const mutate = (
    filter: Record<string, unknown>,
    update: { $set?: Record<string, unknown>; $inc?: Record<string, number> },
  ) => {
    if (!matches(row, filter)) return false;
    for (const [key, value] of Object.entries(update.$set ?? {}))
      set(row, key, value);
    for (const [key, value] of Object.entries(update.$inc ?? {}))
      set(row, key, Number(field(row, key)) + value);
    return true;
  };
  const notifications: unknown[] = [];
  let retainedBytes = 0;
  const outbox = {
    updateOne: vi.fn(async (_filter, update) => {
      notifications.push(update.$setOnInsert);
    }),
  };
  const jobs = {
    db: { model: () => outbox },
    findOne: vi.fn((filter) =>
      query(() => (matches(row, filter) ? copy(row) : null)),
    ),
    findById: vi.fn(() => query(() => copy(row))),
    findOneAndUpdate: vi.fn((filter, update) =>
      query(() => (mutate(filter, update) ? copy(row) : null)),
    ),
    updateOne: vi.fn(async (filter, update) => ({
      modifiedCount: mutate(filter, update) ? 1 : 0,
    })),
  };
  const session = {} as ClientSession;
  const transactions = {
    run: vi.fn(async (callback: (value: ClientSession) => Promise<unknown>) => {
      const before = copy(row);
      const retainedBefore = retainedBytes;
      const count = notifications.length;
      try {
        return await callback(session);
      } catch (error) {
        Object.assign(row, before);
        retainedBytes = retainedBefore;
        notifications.length = count;
        throw error;
      }
    }),
  };
  const rendition = {
    sourceKey,
    resultKey: derivativeKey,
    inputObject: row.inputObject,
    outputObject: object(
      `shared/url/${derivativeKey}/${uuid}/output/vocals.mp3`,
      80,
    ),
    recipeSnapshot: derivedTrimRecipe(recipe),
    comparisonRanges: [
      [0, 2205],
      [6615, 11025],
    ],
  };
  const shared = { prepareRequestedOutput: vi.fn(async () => rendition) };
  const access = {
    assertActiveReadOnly: vi.fn(async () => {}),
    assertActive: vi.fn(async () => {}),
  };
  const usage = {
    recordRetainedOutput: vi.fn(async (_job, bytes) => {
      retainedBytes += bytes;
    }),
    settleJob: vi.fn(),
  };
  const service = new JobRenditionService(
    jobs as never,
    transactions as never,
    shared as never,
    access as never,
    usage as never,
  );
  return {
    service,
    row,
    jobs,
    shared,
    access,
    usage,
    transactions,
    rendition,
    outbox,
    notifications,
    retained: () => retainedBytes,
  };
}
afterEach(() => vi.useRealTimers());

describe('durable owner rendition finalization', () => {
  it('finishes the pending attempt completion timing once including DSP and retry wait while preserving other stages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
    const f = fixture();
    f.row.renditionPending!.queuedAt = new Date(Date.now() - 12_000);
    f.row.stageTimingAttempts = [
      {
        attemptId: 'prior',
        attemptNumber: 1,
        stages: [{ stage: 'separation', durationMs: 1000, complete: true }],
      },
      {
        attemptId: uuid,
        attemptNumber: 2,
        stages: [
          { stage: 'separation', durationMs: 2000, complete: true },
          { stage: 'completion', durationMs: 300, complete: false },
        ],
      },
    ];
    expect(await f.service.finalizeOne()).toBe(true);
    expect(f.row.stageTimingAttempts).toEqual([
      {
        attemptId: 'prior',
        attemptNumber: 1,
        stages: [{ stage: 'separation', durationMs: 1000, complete: true }],
      },
      {
        attemptId: uuid,
        attemptNumber: 2,
        stages: [
          { stage: 'separation', durationMs: 2000, complete: true },
          { stage: 'completion', durationMs: 12_300, complete: true },
        ],
      },
    ]);
    expect(await f.service.finalizeOne()).toBe(false);
    expect(f.row.stageTimingAttempts[1]!.stages[1]!.durationMs).toBe(12_300);
  });

  it('publishes the ready rendition, retained receipt and notification once without model settlement', async () => {
    const f = fixture();
    expect(await f.service.finalizeOne()).toBe(true);
    expect(f.row.status).toBe('ready');
    expect(f.row.currentExecution).toBeNull();
    expect(f.row.renditionPending).toBeNull();
    expect(f.row.outputObject).toEqual(f.rendition.outputObject);
    expect(f.row.recipeSnapshot).toEqual(recipe);
    expect(f.row.outputRecipeSnapshot).toEqual(f.rendition.recipeSnapshot);
    expect(f.row.measuredOutputDurationSeconds).toBe(0.15);
    expect(f.retained()).toBe(280);
    expect(f.notifications).toHaveLength(1);
    expect(f.usage.settleJob).not.toHaveBeenCalled();
    expect(await f.service.finalizeOne()).toBe(false);
    expect(f.retained()).toBe(280);
    expect(f.shared.prepareRequestedOutput).toHaveBeenCalledTimes(1);
  });

  it('keeps slow DSP outside transactions and prevents another replica from claiming its live lease', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.shared.prepareRequestedOutput.mockImplementationOnce(async () => {
      await gate;
      return f.rendition;
    });
    const pending = f.service.finalizeOne();
    await vi.waitFor(() =>
      expect(f.shared.prepareRequestedOutput).toHaveBeenCalledTimes(1),
    );
    expect(f.transactions.run).not.toHaveBeenCalled();
    expect(f.row.status).toBe('uploading_result');
    expect(f.row.outputObject).toBeNull();
    expect(f.retained()).toBe(0);
    const restarted = new JobRenditionService(
      f.jobs as never,
      f.transactions as never,
      f.shared as never,
      f.access as never,
      f.usage as never,
    );
    expect(await restarted.finalizeOne()).toBe(false);
    release();
    await pending;
    expect(f.row.status).toBe('ready');
  });

  it('recovers the cached rendition after DSP outlives an owner lease without publishing or charging an expired claim', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
    const f = fixture();
    f.shared.prepareRequestedOutput.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(Date.now() + 241_000));
      return f.rendition;
    });
    expect(await f.service.finalizeOne()).toBe(true);
    expect(f.row.status).toBe('uploading_result');
    expect(f.row.outputObject).toBeNull();
    expect(f.retained()).toBe(0);
    expect(f.notifications).toHaveLength(0);
    expect(await f.service.finalizeOne()).toBe(true);
    expect(f.row.status).toBe('ready');
    expect(f.retained()).toBe(280);
    expect(f.notifications).toHaveLength(1);
    expect(f.usage.settleJob).not.toHaveBeenCalled();
    expect(await f.service.finalizeOne()).toBe(false);
  });

  it('resumes a crashed expired lease using the durable full object without requeueing inference', async () => {
    const f = fixture();
    f.row.renditionPending!.leaseToken = uuid;
    f.row.renditionPending!.leaseUntil = new Date(Date.now() - 1);
    await f.service.finalizeOne();
    expect(f.shared.prepareRequestedOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        currentExecution: null,
        status: 'uploading_result',
      }),
      f.row.outputObject
        ? object(`shared/url/${resultKey}/${uuid}/output/vocals.mp3`, 100)
        : null,
    );
    expect(f.row.status).toBe('ready');
    expect(f.retained()).toBe(280);
  });

  it('persists bounded retry backoff after a transient rendition failure and reuses the same full bytes', async () => {
    const f = fixture();
    const full = f.row.renditionPending!.full;
    f.shared.prepareRequestedOutput.mockRejectedValueOnce(
      new Error('temporary dependency failure'),
    );
    await f.service.finalizeOne();
    expect(f.row.status).toBe('uploading_result');
    expect(f.row.outputObject).toBeNull();
    expect(f.row.renditionPending).toMatchObject({
      full,
      attempts: 1,
      leaseToken: null,
      leaseUntil: null,
    });
    expect(f.row.renditionPending!.nextAt.getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(f.retained()).toBe(0);
    expect(f.notifications).toHaveLength(0);
    expect(await f.service.finalizeOne()).toBe(false);
    f.row.renditionPending!.nextAt = new Date(Date.now() - 1);
    await f.service.finalizeOne();
    expect(f.row.status).toBe('ready');
    expect(f.retained()).toBe(280);
    expect(f.usage.settleJob).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'deleted'])(
    'never delivers or charges after %s changes during DSP',
    async (change) => {
      const f = fixture();
      f.shared.prepareRequestedOutput.mockImplementationOnce(async () => {
        if (change === 'cancelled') f.row.status = 'cancelled';
        else f.row.deletedAt = new Date();
        f.row.revision++;
        return f.rendition;
      });
      await f.service.finalizeOne();
      expect(f.row.outputObject).toBeNull();
      expect(f.retained()).toBe(0);
      expect(f.notifications).toHaveLength(0);
    },
  );

  it('checks account authorization again in the final transaction after a revocation during DSP', async () => {
    const f = fixture();
    f.access.assertActive.mockRejectedValueOnce(authError('ACCOUNT_DISABLED'));
    await f.service.finalizeOne();
    expect(f.access.assertActiveReadOnly).toHaveBeenCalledOnce();
    expect(f.access.assertActive).toHaveBeenCalledOnce();
    expect(f.row.status).toBe('uploading_result');
    expect(f.row.outputObject).toBeNull();
    expect(f.retained()).toBe(0);
    expect(f.notifications).toHaveLength(0);
    expect(f.row.renditionPending!.leaseToken).toBeNull();
  });

  it('does no DSP for an already revoked account', async () => {
    const f = fixture();
    f.access.assertActiveReadOnly.mockRejectedValueOnce(
      authError('ACCOUNT_DISABLED'),
    );
    await f.service.finalizeOne();
    expect(f.shared.prepareRequestedOutput).not.toHaveBeenCalled();
    expect(f.retained()).toBe(0);
  });

  it('rolls back output and retained accounting if notification publication fails, then safely retries', async () => {
    const f = fixture();
    f.outbox.updateOne.mockRejectedValueOnce(
      new Error('notification write failed'),
    );
    await f.service.finalizeOne();
    expect(f.row.status).toBe('uploading_result');
    expect(f.row.outputObject).toBeNull();
    expect(f.retained()).toBe(0);
    f.row.renditionPending!.nextAt = new Date(Date.now() - 1);
    await f.service.finalizeOne();
    expect(f.row.status).toBe('ready');
    expect(f.retained()).toBe(280);
    expect(f.notifications).toHaveLength(1);
  });

  it('ignores a stale completion after another replica has acquired the token', async () => {
    const f = fixture();
    f.shared.prepareRequestedOutput.mockImplementationOnce(async () => {
      f.row.renditionPending!.leaseToken = 'replacement-lease';
      return f.rendition;
    });
    await f.service.finalizeOne();
    expect(f.row.outputObject).toBeNull();
    expect(f.retained()).toBe(0);
    expect(f.notifications).toHaveLength(0);
  });

  it('boots and wakes without waiting for DSP, including when model processing is disabled', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release!: () => void;
    f.shared.prepareRequestedOutput.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return f.rendition;
    });
    expect(f.service.onApplicationBootstrap()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.shared.prepareRequestedOutput).toHaveBeenCalledTimes(1);
    f.service.wake();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.shared.prepareRequestedOutput).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await f.service.onModuleDestroy();
    expect(f.row.status).toBe('ready');
  });
});

import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import type { Queue } from 'bullmq';
import { ImportRuntime } from './import-runtime.js';
import type { ImportsService } from './imports.service.js';
import type { ImportProcessor } from './import-processor.js';
import type { SharedMediaService } from '../shared-media/shared-media.service.js';
import type {
  RealtimeFeedEvent,
  RealtimeFeedService,
} from '../realtime/realtime-feed.service.js';

function fixture(
  status: string,
  queueState?: string,
  expired = false,
  sharedAction?: string,
) {
  const record = {
    _id: new Types.ObjectId(),
    status,
    deadlineAt: new Date(Date.now() + (expired ? -120_000 : 900_000)),
  };
  const enqueue = vi.fn();
  const reconcileFailure = vi.fn();
  const sweep = vi.fn();
  const getJob = vi.fn().mockResolvedValue(
    queueState === undefined
      ? undefined
      : {
          getState: vi.fn().mockResolvedValue(queueState),
          remove: vi.fn(),
        },
  );
  const find = vi.fn((_filter: Record<string, unknown>) => ({
    sort: () => ({ limit: () => ({ lean: async () => [record] }) }),
  }));
  const imports = {
    enqueue,
    records: {
      find,
    },
  } as unknown as ImportsService;
  const processor = {
    reconcileFailure,
    files: { sweep },
  } as unknown as ImportProcessor;
  const shared =
    sharedAction === undefined
      ? undefined
      : ({
          reconcile: vi.fn(),
          inspect: vi.fn().mockResolvedValue({ action: sharedAction }),
        } as unknown as SharedMediaService);
  const runtime = new ImportRuntime(
    new ConfigService({ URL_IMPORT_MAX_OUTSTANDING: 20 }),
    imports,
    processor,
    { getJob } as unknown as Queue,
    shared,
  );
  return {
    runtime,
    reconcileFailure,
    enqueue,
    sweep,
    getJob,
    record,
    find,
    shared,
  };
}

describe('import recovery', () => {
  it.each([undefined, 'failed', 'completed'])(
    'repairs missing or terminal handoff %s at exhausted acquisition four and legacy max one',
    async (state) => {
      const f = fixture('queued', state, false, 'result');
      Object.assign(f.record, {
        acquisitionAttempt: 4,
        maxAcquisitionAttempts: 1,
        handoffPending: true,
        handoffAttempt: 3,
        nextAttemptAt: new Date(Date.now() + 20_000),
      });
      await f.runtime.reconcile();
      expect(f.getJob).toHaveBeenCalledWith(`${f.record._id}-handoff-3`);
      expect(f.enqueue).toHaveBeenCalledOnce();
      expect(f.enqueue).toHaveBeenCalledWith(String(f.record._id));
      expect(f.reconcileFailure).not.toHaveBeenCalled();
      expect(f.shared!.inspect).not.toHaveBeenCalled();
      if (state)
        expect(
          (await f.getJob.mock.results[0]!.value).remove,
        ).toHaveBeenCalledOnce();
    },
  );
  it.each(['active', 'waiting', 'delayed'])(
    'keeps a live handoff %s generation without overlapping delivery',
    async (state) => {
      const f = fixture('queued', state, false, 'result');
      Object.assign(f.record, {
        handoffPending: true,
        handoffAttempt: 3,
        acquisitionAttempt: 4,
      });
      await f.runtime.reconcile();
      expect(f.getJob).toHaveBeenCalledWith(`${f.record._id}-handoff-3`);
      expect(f.enqueue).not.toHaveBeenCalled();
      expect(f.reconcileFailure).not.toHaveBeenCalled();
      expect(f.shared!.inspect).not.toHaveBeenCalled();
    },
  );
  it('reconciles a crashed active handoff using its saved generation', async () => {
    const f = fixture('uploading', 'failed');
    Object.assign(f.record, {
      handoffPending: true,
      handoffAttempt: 2,
      acquisitionAttempt: 4,
    });
    await f.runtime.reconcile();
    expect(f.getJob).toHaveBeenCalledWith(`${f.record._id}-handoff-2`);
    expect(f.reconcileFailure).toHaveBeenCalledWith(
      f.record,
      expect.anything(),
    );
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each(['reconcile', 'enqueueSharedImports'] as const)(
    'rotates a bounded %s scan past blocked cold imports and wraps for retry',
    async (method) => {
      const f = fixture('queued', undefined, false, 'source');
      const ready = { ...f.record, _id: new Types.ObjectId() };
      const filters: Record<string, unknown>[] = [];
      f.find.mockImplementation((filter) => {
        const snapshot = { ...filter };
        filters.push(snapshot);
        const cursor = (snapshot._id as { $gt?: Types.ObjectId } | undefined)
          ?.$gt;
        return {
          sort: () => ({
            limit: () => ({
              lean: async () =>
                [f.record, ready]
                  .filter(
                    (record) => !cursor || String(record._id) > String(cursor),
                  )
                  .slice(0, 1),
            }),
          }),
        };
      });
      vi.mocked(f.shared!.inspect).mockImplementation(async (record) => ({
        action: record._id.equals(ready._id) ? 'result' : 'source',
        source: null,
        result: null,
      }));
      f.getJob.mockRejectedValue(new Error('Redis unavailable'));
      f.enqueue.mockImplementation(async (id: string) => {
        if (id === String(f.record._id)) throw new Error('Redis unavailable');
      });
      await expect(f.runtime[method]()).rejects.toThrow('Redis unavailable');
      await f.runtime[method]();
      expect(f.enqueue).toHaveBeenCalledWith(String(ready._id));
      expect(filters[1]._id).toEqual(
        expect.objectContaining({ $gt: f.record._id }),
      );
      await expect(f.runtime[method]()).rejects.toThrow('Redis unavailable');
      expect(filters[2]._id).toEqual(
        expect.objectContaining({ $gt: ready._id }),
      );
      expect(filters[3]).not.toHaveProperty('_id');
    },
  );
  it('recovers ready deliveries without reading an unavailable acquisition queue', async () => {
    const f = fixture('queued', undefined, false, 'result');
    f.getJob.mockRejectedValue(new Error('acquisition queue unavailable'));
    await f.runtime.reconcile();
    expect(f.enqueue).toHaveBeenCalledWith(String(f.record._id));
    expect(f.getJob).not.toHaveBeenCalled();
    expect(f.reconcileFailure).not.toHaveBeenCalled();
    expect(f.sweep).toHaveBeenCalledOnce();
  });
  it.each(['reconcile', 'enqueueSharedImports'] as const)(
    'delivers ready followers before a cold Redis failure in %s',
    async (method) => {
      const f = fixture('queued', undefined, false, 'source');
      const ready = { ...f.record, _id: new Types.ObjectId() };
      f.find.mockImplementation(() => ({
        sort: () => ({
          limit: () => ({ lean: async () => [f.record, ready] }),
        }),
      }));
      vi.mocked(f.shared!.inspect).mockImplementation(async (record) => ({
        action: record._id.equals(ready._id) ? 'result' : 'source',
        source: null,
        result: null,
      }));
      f.getJob.mockRejectedValue(new Error('Redis unavailable'));
      f.enqueue.mockImplementation(async (id: string) => {
        if (id === String(f.record._id)) throw new Error('Redis unavailable');
      });
      await expect(f.runtime[method]()).rejects.toThrow('Redis unavailable');
      expect(f.enqueue.mock.calls[0]).toEqual([String(ready._id)]);
      expect(f.reconcileFailure).not.toHaveBeenCalled();
    },
  );
  it('continues other ready deliveries after one interrupted completion', async () => {
    const f = fixture('queued', undefined, false, 'result');
    const ready = { ...f.record, _id: new Types.ObjectId() };
    f.find.mockImplementation(() => ({
      sort: () => ({ limit: () => ({ lean: async () => [f.record, ready] }) }),
    }));
    f.enqueue.mockRejectedValueOnce(new Error('Write interrupted'));
    await expect(f.runtime.reconcile()).rejects.toThrow('Write interrupted');
    expect(f.enqueue.mock.calls).toEqual([
      [String(f.record._id)],
      [String(ready._id)],
    ]);
    expect(f.getJob).not.toHaveBeenCalled();
  });
  it('wakes only queued shared imports without queue recovery reads or a scratch sweep', async () => {
    const f = fixture('queued');
    await f.runtime.enqueueSharedImports();
    expect(f.find).toHaveBeenCalledWith({
      status: 'queued',
      sharedSourceKey: expect.objectContaining({ $ne: null }),
      sharedResultKey: expect.objectContaining({ $ne: null }),
    });
    expect(f.enqueue).toHaveBeenCalledWith(String(f.record._id));
    expect(f.getJob).not.toHaveBeenCalled();
    expect(f.reconcileFailure).not.toHaveBeenCalled();
    expect(f.sweep).not.toHaveBeenCalled();
  });
  it.each(['queued', 'downloading', 'validating', 'uploading'])(
    'recovers terminal execution in %s before its deadline',
    async (status) => {
      for (const state of ['failed', 'completed']) {
        const f = fixture(status, state);
        await f.runtime.reconcile();
        expect(f.reconcileFailure).toHaveBeenCalledWith(
          f.record,
          expect.anything(),
        );
        expect(f.enqueue).not.toHaveBeenCalled();
        expect(f.sweep).toHaveBeenCalledOnce();
      }
    },
  );
  it.each(['active', 'waiting', 'delayed', 'unknown', undefined])(
    'leaves unexpired execution alone when queue state is %s',
    async (state) => {
      const f = fixture('downloading', state);
      await f.runtime.reconcile();
      expect(f.reconcileFailure).not.toHaveBeenCalled();
      expect(f.enqueue).not.toHaveBeenCalled();
    },
  );
  it('retains deadline recovery and the unclaimed outbox', async () => {
    const expired = fixture('uploading', undefined, true);
    await expired.runtime.reconcile();
    expect(expired.reconcileFailure).toHaveBeenCalledOnce();
    const outbox = fixture('queued');
    await outbox.runtime.reconcile();
    expect(outbox.enqueue).toHaveBeenCalledWith(
      outbox.record._id.toHexString(),
    );
  });
  it('does not infer a failed execution during a Redis outage', async () => {
    const f = fixture('downloading');
    f.getJob.mockRejectedValue(new Error('unavailable'));
    await expect(f.runtime.reconcile()).rejects.toThrow('unavailable');
    expect(f.reconcileFailure).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it('recreates a missing delayed retry after restart, using only the next queue generation', async () => {
    const f = fixture('queued');
    Object.assign(f.record, {
      maxAcquisitionAttempts: 4,
      acquisitionAttempt: 1,
      nextAttemptAt: new Date(Date.now() + 20_000),
    });
    await f.runtime.reconcile();
    expect(f.getJob).toHaveBeenCalledWith(`${f.record._id}-2`);
    expect(f.enqueue).toHaveBeenCalledWith(String(f.record._id));
    expect(f.reconcileFailure).not.toHaveBeenCalled();
  });
  it('replaces a prematurely completed unclaimed retry entry without treating it as another failure', async () => {
    const f = fixture('queued', 'completed');
    Object.assign(f.record, {
      maxAcquisitionAttempts: 4,
      acquisitionAttempt: 2,
    });
    const job = await f.getJob();
    await f.runtime.reconcile();
    expect(job.remove).toHaveBeenCalledOnce();
    expect(f.enqueue).toHaveBeenCalledOnce();
    expect(f.reconcileFailure).not.toHaveBeenCalled();
  });
  it('recovers the crashed current attempt instead of inspecting a future generation', async () => {
    const f = fixture('downloading', 'failed');
    Object.assign(f.record, {
      maxAcquisitionAttempts: 4,
      acquisitionAttempt: 2,
    });
    await f.runtime.reconcile();
    expect(f.getJob).toHaveBeenCalledWith(`${f.record._id}-2`);
    expect(f.reconcileFailure).toHaveBeenCalledOnce();
  });
});

describe('shared media import wakeups', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function wakeFixture(enabled = true) {
    let listener: ((event: RealtimeFeedEvent) => void) | undefined;
    const unsubscribe = vi.fn(() => {
      listener = undefined;
    });
    const subscribe = vi.fn((callback: typeof listener) => {
      listener = callback;
      return unsubscribe;
    });
    const runtime = new ImportRuntime(
      new ConfigService({
        URL_IMPORT_PROCESSOR_ENABLED: enabled,
        URL_IMPORT_CONCURRENCY: 20,
        URL_IMPORT_REQUESTS_PER_SECOND: 5,
      }),
      {
        initialize: vi.fn().mockResolvedValue(undefined),
      } as unknown as ImportsService,
      {
        files: { initialize: vi.fn(), sweep: vi.fn() },
        worker: {
          on: vi.fn(),
          run: vi.fn().mockResolvedValue(undefined),
          close: vi.fn(),
        },
        shutdown: new AbortController(),
      } as unknown as ImportProcessor,
      {
        on: vi.fn(),
        setGlobalConcurrency: vi.fn(),
        setGlobalRateLimit: vi.fn(),
      } as unknown as Queue,
      undefined,
      { subscribe } as unknown as RealtimeFeedService,
    );
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const recover = vi
      .spyOn(runtime, 'reconcile')
      .mockImplementation(reconcile);
    const wake = vi
      .spyOn(runtime, 'enqueueSharedImports')
      .mockImplementation(reconcile);
    return {
      runtime,
      reconcile,
      recover,
      wake,
      subscribe,
      unsubscribe,
      emit: (event: RealtimeFeedEvent) => listener?.(event),
    };
  }

  it('wakes on committed shared changes without waiting for the recovery timer and coalesces a burst', async () => {
    const f = wakeFixture();
    await f.runtime.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.reconcile).toHaveBeenCalledOnce();
    for (let i = 0; i < 10; i++)
      f.emit({ healthy: true, collection: 'shared_media_results' });
    f.emit({ healthy: true, collection: 'shared_media_sources' });
    await vi.advanceTimersByTimeAsync(49);
    expect(f.reconcile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(f.recover).toHaveBeenCalledOnce();
    expect(f.wake).toHaveBeenCalledOnce();
    await f.runtime.beforeApplicationShutdown();
  });

  it('retains a change arriving during reconciliation and never overlaps maintenance', async () => {
    const f = wakeFixture();
    let release!: () => void;
    f.reconcile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await f.runtime.onApplicationBootstrap();
    f.emit({ healthy: true, collection: 'shared_media_results' });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.reconcile).toHaveBeenCalledOnce();
    release();
    await vi.advanceTimersByTimeAsync(50);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    await f.runtime.beforeApplicationShutdown();
  });

  it('retains changes when timed recovery starts during a pending wakeup', async () => {
    const f = wakeFixture();
    await f.runtime.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(29_990);
    let release!: () => void;
    f.reconcile.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    f.emit({ healthy: true, collection: 'shared_media_sources' });
    await vi.advanceTimersByTimeAsync(10);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    f.emit({ healthy: true, collection: 'shared_media_results' });
    await vi.advanceTimersByTimeAsync(40);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(50);
    expect(f.reconcile).toHaveBeenCalledTimes(3);
    await f.runtime.beforeApplicationShutdown();
  });

  it('ignores unrelated changes, recovers on feed reconnection, and detaches on shutdown', async () => {
    const f = wakeFixture();
    await f.runtime.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    f.emit({ healthy: false });
    f.emit({ healthy: true, collection: 'audio_jobs' });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.reconcile).toHaveBeenCalledOnce();
    f.emit({ healthy: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    f.emit({ healthy: true, collection: 'shared_media_results' });
    await f.runtime.beforeApplicationShutdown();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
  });

  it('keeps timed recovery when no change feed event is received', async () => {
    const f = wakeFixture();
    await f.runtime.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    await f.runtime.beforeApplicationShutdown();
  });

  it('does not subscribe or start maintenance when the processor is disabled', async () => {
    const f = wakeFixture(false);
    await f.runtime.onApplicationBootstrap();
    expect(f.subscribe).not.toHaveBeenCalled();
    expect(f.reconcile).not.toHaveBeenCalled();
    await f.runtime.beforeApplicationShutdown();
  });
});

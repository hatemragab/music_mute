import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import type { Queue } from 'bullmq';
import { ImportRuntime } from './import-runtime.js';
import type { ImportsService } from './imports.service.js';
import type { ImportProcessor } from './import-processor.js';

function fixture(status: string, queueState?: string, expired = false) {
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
  const imports = {
    enqueue,
    records: {
      find: () => ({
        sort: () => ({
          limit: () => ({ lean: async () => [record] }),
        }),
      }),
    },
  } as unknown as ImportsService;
  const processor = {
    reconcileFailure,
    files: { sweep },
  } as unknown as ImportProcessor;
  const runtime = new ImportRuntime(
    new ConfigService({ URL_IMPORT_MAX_OUTSTANDING: 20 }),
    imports,
    processor,
    { getJob } as unknown as Queue,
  );
  return { runtime, reconcileFailure, enqueue, sweep, getJob, record };
}

describe('import recovery', () => {
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

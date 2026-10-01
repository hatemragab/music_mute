import { Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { authError } from '../auth/auth.errors.js';
import { ImportsService } from './imports.service.js';
import { MediaImport } from './media-import.schema.js';
import { ImportProcessor } from './import-processor.js';
import { acquisitionRetryDelay, importExecutionJobId } from './import-retry.js';
import { safeImportError } from './import-errors.js';
import { jobError } from '../jobs/job-errors.js';

function record(values: Partial<MediaImport> = {}): MediaImport {
  return {
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    requestId: 'fixture',
    jobRequestId: 'job-fixture',
    sourceUrl: 'https://youtu.be/abcdefghijk',
    provider: 'youtube',
    trimEnabled: false,
    maxAcquisitionAttempts: 4,
    acquisitionAttempt: 1,
    status: 'downloading',
    executionId: 'execution-1',
    jobId: null,
    input: null,
    acquisitionReservedAt: null,
    acquisitionLimits: null,
    nextAttemptAt: null,
    stageTimings: [],
    createdAt: new Date(),
    queuedAt: new Date(),
    sharedSourceKey: null,
    sharedResultKey: null,
    ...values,
  } as MediaImport;
}

function fixture(values: Partial<MediaImport> = {}) {
  const stored = record(values);
  let reserved = false;
  const matches = (filter: Record<string, unknown>) =>
    Object.entries(filter).every(([key, expected]) => {
      const value = (stored as unknown as Record<string, unknown>)[key];
      if (expected && typeof expected === 'object' && '$in' in expected)
        return (expected.$in as unknown[]).includes(value);
      return String(value ?? '') === String(expected ?? '');
    });
  const records = {
    findOneAndUpdate: vi.fn(
      (
        _filter: Record<string, unknown>,
        update: {
          $set: Partial<MediaImport>;
          $inc: { acquisitionAttempt: number };
        },
      ) => ({
        lean: async () => {
          Object.assign(stored, update.$set);
          stored.acquisitionAttempt += update.$inc.acquisitionAttempt;
          return { ...stored };
        },
      }),
    ),
    findById: vi.fn(() => ({ lean: async () => ({ ...stored }) })),
    updateOne: vi.fn(
      async (
        filter: Record<string, unknown>,
        update: { $set: Partial<MediaImport> },
      ) => {
        if (!matches(filter)) return { matchedCount: 0, modifiedCount: 0 };
        Object.assign(stored, update.$set);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    ),
  };
  const usage = {
    readUsage: vi.fn().mockResolvedValue({
      availability: { status: 'available', reason: null },
      uploads: {
        dailyRemainingGrants: 10,
        monthlyRemainingGrants: 10,
        monthlyRemainingBytes: 10_000,
      },
      effectiveLimits: { maxPreparedAudioBytes: 5_000, maxDurationSeconds: 60 },
    }),
    reserveForImport: vi.fn(async () => {
      reserved = true;
    }),
    hasReservedProcessing: vi.fn(async () => reserved),
    releaseImport: vi.fn(async () => {
      reserved = false;
    }),
  };
  const access = { assertActive: vi.fn() };
  const shared = {
    inspect: vi.fn().mockResolvedValue(null),
    failImport: vi.fn(),
    recoverSource: vi.fn(),
  };
  const queue = { add: vi.fn().mockResolvedValue({}) };
  const config = new ConfigService({
    URL_IMPORT_ENABLED: true,
    URL_IMPORT_TEMP_ROOT: '/tmp/synthetic-import-retry',
    URL_IMPORT_MIN_FREE_BYTES: 0,
  });
  const imports = new ImportsService(
    records as never,
    {} as never,
    {
      run: async (fn: (session: unknown) => Promise<unknown>) => fn({}),
    } as never,
    access as never,
    usage as never,
    config,
    queue as never,
    { assertAllowed: vi.fn() } as never,
    shared as never,
  );
  const actions = { cancelPendingUpload: vi.fn() };
  const jobRecords = { findOne: vi.fn(() => ({ lean: async () => null })) };
  const downloader = { download: vi.fn() };
  const processor = new ImportProcessor(
    imports,
    downloader as never,
    {} as never,
    actions as never,
    config,
    jobRecords as never,
    shared as never,
  );
  return {
    stored,
    records,
    usage,
    access,
    shared,
    queue,
    imports,
    processor,
    actions,
    jobRecords,
    downloader,
  };
}

describe('absolute acquisition execution deadline', () => {
  const startedAt = new Date('2026-10-01T00:00:00Z');
  const budget = 15 * 60_000;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);
    // Node's native AbortSignal timeout is independent of Vitest's clock.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const deadline = new AbortController();
      setTimeout(() => deadline.abort(), milliseconds);
      return deadline.signal;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it('does not reserve or acquire after a deferred shared read expires the persisted deadline', async () => {
    const f = fixture({ status: 'queued', acquisitionAttempt: 0 });
    let release!: () => void;
    const inspection = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    f.shared.inspect.mockReturnValueOnce(inspection);
    const reserve = vi.spyOn(f.imports, 'reserveAcquisition');
    const transfer = vi.spyOn(f.processor.files, 'withFile');
    const operation = f.processor.process({
      data: { importId: String(f.stored._id), attempt: 1 },
    } as never);
    await vi.waitFor(() => expect(f.shared.inspect).toHaveBeenCalledOnce());
    expect(f.stored.deadlineAt?.getTime()).toBe(startedAt.getTime() + budget);
    await vi.advanceTimersByTimeAsync(budget + 1);
    release();
    await operation;
    expect(reserve).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
    expect(f.downloader.download).not.toHaveBeenCalled();
    expect(f.stored.status).toBe('queued');
    expect(f.stored.acquisitionAttempt).toBe(1);
  });
  it('checks expiry after a delayed reservation before entering scratch or paid transfer', async () => {
    const f = fixture({ status: 'queued', acquisitionAttempt: 0 });
    vi.spyOn(f.imports, 'reserveAcquisition').mockImplementationOnce(
      async () => {
        await vi.advanceTimersByTimeAsync(budget + 1);
        return { maxBytes: 500, maxDuration: 60 };
      },
    );
    const transfer = vi.spyOn(f.processor.files, 'withFile');
    await f.processor.process({
      data: { importId: String(f.stored._id), attempt: 1 },
    } as never);
    expect(transfer).not.toHaveBeenCalled();
    expect(f.downloader.download).not.toHaveBeenCalled();
    expect(f.stored.status).toBe('queued');
  });
  it('subtracts claim/read time and passes an absolute signal rather than a renewed transfer budget', async () => {
    const f = fixture({ status: 'queued', acquisitionAttempt: 0 });
    const claim = f.records.findOneAndUpdate.getMockImplementation()!;
    f.records.findOneAndUpdate.mockImplementationOnce((filter, update) => {
      const query = claim(filter, update);
      return {
        lean: async () => {
          const claimed = await query.lean();
          vi.setSystemTime(startedAt.getTime() + 4 * 60_000);
          return claimed;
        },
      };
    });
    vi.spyOn(f.imports, 'reserveAcquisition').mockResolvedValue({
      maxBytes: 500,
      maxDuration: 60,
    });
    let transferSignal: AbortSignal | undefined;
    vi.spyOn(f.processor.files, 'withFile').mockImplementation(
      async (_operation, signal) => {
        transferSignal = signal;
        return undefined as never;
      },
    );
    await f.processor.process({
      data: { importId: String(f.stored._id), attempt: 1 },
    } as never);
    expect(AbortSignal.timeout).toHaveBeenCalledWith(11 * 60_000);
    expect(transferSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(Date.now()).toBe(f.stored.deadlineAt?.getTime());
    expect(transferSignal?.aborted).toBe(true);
    expect(f.downloader.download).not.toHaveBeenCalled();
  });
});

describe('durable acquisition retry policy', () => {
  it('permits three additional attempts with increasing backoff and then stops', () => {
    for (const code of [
      'IMPORT_DEPENDENCY_FAILED',
      'IMPORT_UPSTREAM_REFUSED',
      'IMPORT_DISK_FULL',
    ]) {
      expect(
        [1, 2, 3, 4].map((acquisitionAttempt) =>
          acquisitionRetryDelay(record({ acquisitionAttempt }), code),
        ),
      ).toEqual([5_000, 10_000, 20_000, null]);
    }
  });
  it.each([
    'IMPORT_INVALID_URL',
    'IMPORT_TOO_LONG',
    'IMPORT_TOO_LARGE',
    'IMPORT_INVALID_AUDIO',
    'IMPORT_SOURCE_UNAVAILABLE',
    'IMPORT_UNSUPPORTED_AUDIO_SOURCE',
    'ACCOUNT_DISABLED',
    'PROCESSING_UNAVAILABLE',
    'PROCESSING_ALLOWANCE_EXHAUSTED',
    'IDEMPOTENCY_CONFLICT',
  ])('does not retry permanent or policy failure %s', (code) => {
    expect(acquisitionRetryDelay(record(), code)).toBeNull();
  });
  it('does not authorize historical imports, uploads or job reservations', () => {
    for (const values of [
      { maxAcquisitionAttempts: undefined },
      { status: 'uploading' as const },
      { jobId: new Types.ObjectId() },
      { input: {} as never },
      { acquisitionAttempt: 0 },
      { maxAcquisitionAttempts: 5 },
    ])
      expect(
        acquisitionRetryDelay(record(values), 'IMPORT_DEPENDENCY_FAILED'),
      ).toBeNull();
  });
  it('uses the current executing queue generation and the next queued generation', () => {
    const active = record({ acquisitionAttempt: 2 });
    expect(importExecutionJobId(active)).toBe(`${active._id}-2`);
    expect(importExecutionJobId({ ...active, status: 'queued' })).toBe(
      `${active._id}-3`,
    );
    const legacy = record({ ...active });
    Reflect.deleteProperty(legacy, 'maxAcquisitionAttempts');
    expect(importExecutionJobId(legacy)).toBe(String(active._id));
  });
});

describe('retry state, ownership and reservation fences', () => {
  it('keeps one usage hold, frozen limits, shared producer and queued outbox through retries', async () => {
    const f = fixture({
      sharedSourceKey: 'a'.repeat(64),
      sharedResultKey: 'b'.repeat(64),
    });
    f.shared.inspect.mockResolvedValue({ action: 'acquire' } as never);
    expect(await f.imports.reserveAcquisition({ ...f.stored })).toEqual({
      maxBytes: 5_000,
      maxDuration: 60,
    });
    const now = new Date('2026-10-01T00:00:00Z');
    for (const attempt of [1, 2, 3]) {
      Object.assign(f.stored, {
        acquisitionAttempt: attempt,
        status: 'downloading',
        executionId: `execution-${attempt}`,
      });
      if (attempt > 1) {
        f.usage.readUsage.mockResolvedValue({
          availability: { status: 'blocked', reason: 'monthly_limit_reached' },
        } as never);
        expect(await f.imports.reserveAcquisition({ ...f.stored })).toEqual({
          maxBytes: 5_000,
          maxDuration: 60,
        });
      }
      expect(
        await f.imports.retryAcquisition(
          { ...f.stored },
          { code: 'IMPORT_DEPENDENCY_FAILED', message: 'safe' },
          now,
        ),
      ).toBe(true);
      expect(f.stored.status).toBe('queued');
      expect(f.stored.executionId).toBeNull();
      expect(f.stored.nextAttemptAt?.getTime()).toBe(
        now.getTime() + 5_000 * 2 ** (attempt - 1),
      );
      expect(f.stored.trimEnabled).toBe(false);
      expect(f.stored.sharedSourceKey).toBe('a'.repeat(64));
      expect(f.stored.sharedResultKey).toBe('b'.repeat(64));
    }
    expect(f.usage.reserveForImport).toHaveBeenCalledOnce();
    expect(f.usage.releaseImport).not.toHaveBeenCalled();
    expect(f.shared.failImport).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.queue.add).toHaveBeenCalledTimes(3));
    Object.assign(f.stored, {
      acquisitionAttempt: 4,
      status: 'downloading',
      executionId: 'execution-4',
    });
    expect(
      await f.imports.retryAcquisition(
        { ...f.stored },
        { code: 'IMPORT_DEPENDENCY_FAILED', message: 'safe' },
      ),
    ).toBe(false);
    const last = { ...f.stored };
    await f.imports.failAcquisition(last, {
      code: 'IMPORT_DEPENDENCY_FAILED',
      message: 'safe',
    });
    await f.imports.failAcquisition(last, {
      code: 'IMPORT_DEPENDENCY_FAILED',
      message: 'safe',
    });
    expect(f.stored.status).toBe('failed');
    expect(f.usage.releaseImport).toHaveBeenCalledOnce();
    expect(f.shared.failImport).toHaveBeenCalledOnce();
  });
  it('blocks an old execution from retrying, settling or failing a newer execution', async () => {
    const f = fixture();
    const old = { ...f.stored };
    Object.assign(f.stored, {
      executionId: 'new-execution',
      acquisitionAttempt: 2,
    });
    expect(
      await f.imports.retryAcquisition(old, {
        code: 'IMPORT_DEPENDENCY_FAILED',
        message: 'safe',
      }),
    ).toBe(false);
    await f.imports.failAcquisition(old, {
      code: 'IMPORT_DEPENDENCY_FAILED',
      message: 'safe',
    });
    await f.processor.reconcileFailure(old, new Error('synthetic'));
    expect(f.stored.status).toBe('downloading');
    expect(f.queue.add).not.toHaveBeenCalled();
    expect(f.usage.releaseImport).not.toHaveBeenCalled();
    expect(f.actions.cancelPendingUpload).not.toHaveBeenCalled();
  });
  it('rechecks account access before scheduling another paid attempt', async () => {
    const f = fixture();
    f.access.assertActive.mockRejectedValue(authError('ACCOUNT_DISABLED'));
    await f.processor.reconcileFailure({ ...f.stored }, new Error('synthetic'));
    expect(f.stored.status).toBe('failed');
    expect(f.stored.error?.code).toBe('ACCOUNT_DISABLED');
    expect(f.queue.add).not.toHaveBeenCalled();
  });
  it('does not reuse a released or legacy reservation', async () => {
    for (const maximum of [1, 4]) {
      const f = fixture({
        acquisitionAttempt: 2,
        maxAcquisitionAttempts: maximum,
        acquisitionReservedAt: new Date(),
        acquisitionLimits: { maxBytes: 500, maxDuration: 60 },
      });
      await expect(
        f.imports.reserveAcquisition({ ...f.stored }),
      ).rejects.toMatchObject({ status: 409 });
      expect(f.usage.reserveForImport).not.toHaveBeenCalled();
    }
  });
  it('ends a released retry reservation without requeueing or claiming another generation', async () => {
    const f = fixture({
      acquisitionAttempt: 2,
      acquisitionReservedAt: new Date(),
      acquisitionLimits: { maxBytes: 500, maxDuration: 60 },
    });
    const attempt = { ...f.stored };
    const conflict = await f.imports
      .reserveAcquisition(attempt)
      .catch((error: unknown) => error);
    expect(safeImportError(conflict)).toEqual(
      safeImportError(jobError('IDEMPOTENCY_CONFLICT')),
    );
    await f.processor.reconcileFailure(attempt, conflict);
    expect(f.stored.status).toBe('failed');
    expect(f.stored.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(f.stored.acquisitionAttempt).toBe(2);
    expect(f.stored.nextAttemptAt).toBeNull();
    expect(f.queue.add).not.toHaveBeenCalled();
    expect(f.usage.reserveForImport).not.toHaveBeenCalled();
    expect(f.shared.failImport).toHaveBeenCalledOnce();
  });
  it('does not reacquire after a recorded shared PUT or accepted job', async () => {
    const upload = fixture({ sharedSourceKey: 'a'.repeat(64) });
    upload.shared.inspect.mockResolvedValue({
      action: 'acquire',
      source: { inputKey: 'recorded-upload' },
    } as never);
    const retry = vi.spyOn(upload.imports, 'retryAcquisition');
    await upload.processor.reconcileFailure(
      { ...upload.stored },
      new Error('synthetic upload response'),
    );
    expect(upload.shared.recoverSource).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(upload.stored.status).toBe('failed');
    const accepted = fixture();
    accepted.jobRecords.findOne.mockReturnValue({
      lean: async () => ({ _id: new Types.ObjectId(), inputObject: {} }),
    } as never);
    await accepted.processor.reconcileFailure(
      { ...accepted.stored },
      new Error('lost confirmation'),
    );
    expect(accepted.stored.status).toBe('submitted');
    expect(accepted.queue.add).not.toHaveBeenCalled();
    expect(accepted.usage.releaseImport).not.toHaveBeenCalled();
  });
});

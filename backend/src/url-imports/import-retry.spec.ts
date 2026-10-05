import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { authError } from '../auth/auth.errors.js';
import { ImportsService } from './imports.service.js';
import { MediaImport } from './media-import.schema.js';
import { ImportProcessor } from './import-processor.js';
import {
  acquisitionRetryDelay,
  handoffRetryDelay,
  importExecutionJobId,
} from './import-retry.js';
import { importError, safeImportError } from './import-errors.js';
import { jobError } from '../jobs/job-errors.js';
import { workerRecipeSnapshot } from '../jobs/worker-recipes.js';

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
    handoffPending: false,
    handoffAttempt: 0,
    acquisitionStartedAt: null,
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
  const matches = (filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([key, expected]) => {
      if (key === '$or')
        return (expected as Record<string, unknown>[]).some(matches);
      if (key === '$and')
        return (expected as Record<string, unknown>[]).every(matches);
      if (key === '$expr')
        return (
          (stored.acquisitionAttempt ?? 0) <
          (stored.maxAcquisitionAttempts ?? 1)
        );
      const value = (stored as unknown as Record<string, unknown>)[key];
      if (expected && typeof expected === 'object') {
        if ('$in' in expected)
          return (expected.$in as unknown[]).includes(value);
        if ('$ne' in expected) return value !== expected.$ne;
        if ('$exists' in expected)
          return (value !== undefined) === expected.$exists;
        if ('$lte' in expected)
          return value instanceof Date && value <= (expected.$lte as Date);
      }
      return String(value ?? '') === String(expected ?? '');
    });
  const records = {
    findOneAndUpdate: vi.fn(
      (
        filter: Record<string, unknown>,
        update: { $set: Record<string, unknown> }[],
      ) => ({
        lean: async () => {
          if (!matches(filter)) return null;
          const { acquisitionStartedAt, ...values } = update[0]!.$set;
          Object.assign(stored, values);
          if (
            acquisitionStartedAt &&
            typeof acquisitionStartedAt === 'object' &&
            '$ifNull' in acquisitionStartedAt
          )
            stored.acquisitionStartedAt ??= (
              acquisitionStartedAt.$ifNull as [string, Date]
            )[1];
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
    associateJob: vi.fn(),
  };
  const queue = { add: vi.fn().mockResolvedValue({}) };
  const config = new ConfigService({
    URL_IMPORT_ENABLED: true,
    URL_IMPORT_TEMP_ROOT: '/tmp/synthetic-import-retry',
    URL_IMPORT_MIN_FREE_BYTES: 0,
  });
  const jobs = {
    createForSharedInput: vi.fn().mockResolvedValue({
      jobId: new Types.ObjectId().toHexString(),
    }),
    createFromCache: vi.fn(),
  };
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
    jobs as never,
  );
  const actions = { cancelPendingUpload: vi.fn() };
  const jobRecords = {
    findOne: vi.fn(() => ({ lean: async () => null })),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    base: { Types },
  };
  const downloader = { download: vi.fn() };
  const processor = new ImportProcessor(
    imports,
    downloader as never,
    jobs as never,
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
    jobs,
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

describe('import-wide acquisition attempt context', () => {
  const startedAt = new Date('2026-10-03T00:00:00Z');
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it('starts at the first active claim and survives retry backoff and a second claim', async () => {
    const f = fixture({
      status: 'queued',
      acquisitionAttempt: 0,
      createdAt: new Date(startedAt.getTime() - 60_000),
      queuedAt: new Date(startedAt.getTime() - 60_000),
    });
    vi.spyOn(f.imports, 'reserveAcquisition').mockResolvedValue({
      maxBytes: 500,
      maxDuration: 60,
    });
    vi.spyOn(f.processor.files, 'withFile').mockImplementation(
      async (operation, signal) => operation('/tmp/synthetic-audio', signal!),
    );
    f.downloader.download.mockRejectedValue(
      importError('IMPORT_DEPENDENCY_FAILED'),
    );
    for (const attempt of [1, 2]) {
      await f.processor.process({
        data: { importId: String(f.stored._id), attempt },
      } as never);
      expect(f.stored.acquisitionStartedAt).toEqual(startedAt);
      expect(f.stored.status).toBe('queued');
      expect(f.downloader.download).toHaveBeenLastCalledWith(
        f.stored.sourceUrl,
        f.processor.files,
        '/tmp/synthetic-audio',
        { maxBytes: 500, maxDuration: 60 },
        expect.any(AbortSignal),
        expect.any(String),
        { attempt, maxAttempts: 4, startedAt },
      );
      await vi.advanceTimersByTimeAsync(5_000 * 2 ** (attempt - 1));
    }
    expect(f.records.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      { returnDocument: 'after', updatePipeline: true },
    );
    expect(f.stored.deadlineAt).toBeNull();
  });
  it('initializes a legacy missing start on its next claim without expanding its saved budget', async () => {
    const f = fixture({
      status: 'queued',
      acquisitionAttempt: 0,
      maxAcquisitionAttempts: undefined,
    });
    Reflect.deleteProperty(f.stored, 'acquisitionStartedAt');
    vi.spyOn(f.imports, 'reserveAcquisition').mockResolvedValue({
      maxBytes: 500,
      maxDuration: 60,
    });
    vi.spyOn(f.processor.files, 'withFile').mockImplementation(
      async (operation, signal) => operation('/tmp/synthetic-audio', signal!),
    );
    f.downloader.download.mockRejectedValue(
      importError('IMPORT_DEPENDENCY_FAILED'),
    );
    await f.processor.process({
      data: { importId: String(f.stored._id), attempt: 1 },
    } as never);
    expect(f.stored.acquisitionStartedAt).toEqual(startedAt);
    expect(f.stored.acquisitionAttempt).toBe(1);
    expect(f.stored.status).toBe('failed');
    expect(f.downloader.download.mock.calls[0]?.[6]).toEqual({
      attempt: 1,
      maxAttempts: 1,
      startedAt,
    });
    expect(f.queue.add).not.toHaveBeenCalled();
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
    'IMPORT_ACQUISITION_EXHAUSTED',
    'ACCOUNT_DISABLED',
    'PROCESSING_UNAVAILABLE',
    'PROCESSING_ALLOWANCE_EXHAUSTED',
    'IDEMPOTENCY_CONFLICT',
  ])('does not retry permanent or policy failure %s', (code) => {
    expect(acquisitionRetryDelay(record(), code)).toBeNull();
  });
  it('accepts only bounded private retry hints while preserving default backoff', () => {
    for (const hint of [undefined, 0, -1, 21, 1.5, Number.NaN])
      expect(
        acquisitionRetryDelay(record(), 'IMPORT_DEPENDENCY_FAILED', hint),
      ).toBe(5_000);
    expect(acquisitionRetryDelay(record(), 'IMPORT_DEPENDENCY_FAILED', 1)).toBe(
      1_000,
    );
    expect(
      acquisitionRetryDelay(
        record({ acquisitionAttempt: 3 }),
        'IMPORT_UPSTREAM_REFUSED',
        1,
      ),
    ).toBe(1_000);
    expect(
      acquisitionRetryDelay(
        record({ acquisitionAttempt: 4 }),
        'IMPORT_DEPENDENCY_FAILED',
        1,
      ),
    ).toBeNull();
    expect(
      acquisitionRetryDelay(record(), 'IMPORT_ACQUISITION_EXHAUSTED', 1),
    ).toBeNull();
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
  it('uses a short trusted hint without persisting it in public import errors', async () => {
    const f = fixture({
      acquisitionStartedAt: new Date('2026-10-03T00:00:00Z'),
    });
    const now = new Date('2026-10-03T00:00:30Z');
    const error = safeImportError(
      importError('IMPORT_DEPENDENCY_FAILED', undefined, 1),
    );
    expect(error).toEqual({
      code: 'IMPORT_DEPENDENCY_FAILED',
      message: 'An import dependency is unavailable',
      retryAfterSeconds: 1,
    });
    expect(await f.imports.retryAcquisition({ ...f.stored }, error, now)).toBe(
      true,
    );
    expect(f.stored.nextAttemptAt).toEqual(new Date(now.getTime() + 1_000));
    expect(f.stored.acquisitionStartedAt).toEqual(
      new Date('2026-10-03T00:00:00Z'),
    );
    expect(f.stored.error).toEqual({
      code: error.code,
      message: error.message,
    });
  });
  it('ends exhausted acquisition without adding another retry or persisting provider details', async () => {
    const f = fixture();
    await f.processor.reconcileFailure(
      { ...f.stored },
      importError('IMPORT_ACQUISITION_EXHAUSTED'),
    );
    expect(f.stored.status).toBe('failed');
    expect(f.stored.error).toEqual({
      code: 'IMPORT_ACQUISITION_EXHAUSTED',
      message: 'The audio acquisition budget was exhausted',
    });
    expect(f.queue.add).not.toHaveBeenCalled();
    expect(f.usage.releaseImport).toHaveBeenCalledOnce();
  });
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
  it('recovers job submission with the confirmed source and records both attempts without reacquisition', async () => {
    const f = fixture({
      status: 'queued',
      acquisitionAttempt: 0,
      sharedSourceKey: 'a'.repeat(64),
      sharedResultKey: 'b'.repeat(64),
    });
    f.shared.inspect.mockResolvedValue({
      action: 'source',
      source: {
        _id: f.stored.sharedSourceKey,
        sourceTitle: 'Confirmed source',
        input: { bytes: 1_024, durationSeconds: 30 },
        inputObject: {},
      },
      result: {
        _id: f.stored.sharedResultKey,
        recipeSnapshot: workerRecipeSnapshot('kim-vocals-v2', false),
      },
    } as never);
    f.jobs.createForSharedInput.mockRejectedValueOnce(
      importError('IMPORT_DEPENDENCY_FAILED'),
    );
    await f.processor.process({
      data: { importId: String(f.stored._id), attempt: 1 },
    } as never);
    expect(f.stored.status).toBe('submitted');
    expect(f.stored.acquisitionAttempt).toBe(1);
    expect(f.jobs.createForSharedInput).toHaveBeenCalledTimes(2);
    expect(f.shared.recoverSource).toHaveBeenCalledOnce();
    expect(f.downloader.download).not.toHaveBeenCalled();
    expect(f.usage.reserveForImport).not.toHaveBeenCalled();
    expect(f.queue.add).not.toHaveBeenCalled();
    expect(f.actions.cancelPendingUpload).not.toHaveBeenCalled();
    expect(f.stored.stageTimings).toEqual([
      expect.objectContaining({ stage: 'import-queue', complete: true }),
      expect.objectContaining({ stage: 'job-submission', complete: true }),
    ]);
    const submission = f.stored.stageTimings[1]!;
    expect(Number.isSafeInteger(submission.durationMs)).toBe(true);
    expect(submission.durationMs).toBeGreaterThanOrEqual(0);
    expect(f.jobRecords.updateOne).toHaveBeenCalledWith(
      { _id: f.stored.jobId, userId: f.stored.userId },
      { $set: { importStageTimings: f.stored.stageTimings } },
      { runValidators: true },
    );
  });
});

describe('durable confirmed-source handoff', () => {
  afterEach(() => vi.restoreAllMocks());
  function confirmed(values: Partial<MediaImport> = {}) {
    const f = fixture({
      status: 'queued',
      acquisitionAttempt: 3,
      acquisitionStartedAt: new Date('2026-10-01T00:00:00Z'),
      acquisitionReservedAt: new Date('2026-10-01T00:00:00Z'),
      acquisitionLimits: { maxBytes: 5_000, maxDuration: 60 },
      sharedSourceKey: 'a'.repeat(64),
      sharedResultKey: 'b'.repeat(64),
      ...values,
    });
    f.shared.inspect.mockResolvedValue({
      action: 'source',
      source: {
        _id: f.stored.sharedSourceKey,
        sourceTitle: 'Confirmed source',
        input: { bytes: 1_024, durationSeconds: 30 },
        inputObject: { key: 'immutable-confirmed-input' },
      },
      result: {
        _id: f.stored.sharedResultKey,
        recipeSnapshot: workerRecipeSnapshot('kim-vocals-v2', false),
      },
    } as never);
    return f;
  }
  const dependency = () => importError('IMPORT_DEPENDENCY_FAILED');
  it('recovers a confirmed master through its ready trim rendition without reacquisition', async () => {
    const f = confirmed({
      handoffPending: true,
      handoffAttempt: 1,
      trimEnabled: true,
    });
    f.shared.inspect.mockResolvedValue({
      action: 'result',
      source: {
        _id: f.stored.sharedSourceKey,
        input: { bytes: 1024, durationSeconds: 30 },
        inputObject: { key: 'immutable-confirmed-input' },
      },
      result: {
        _id: 'c'.repeat(64),
        derivedFromResultKey: f.stored.sharedResultKey,
        outputObject: { key: 'immutable-derived-output' },
        recipeSnapshot: workerRecipeSnapshot('kim-vocals-v2', true),
      },
    } as never);
    const jobId = new Types.ObjectId().toHexString();
    f.jobs.createFromCache
      .mockRejectedValueOnce(dependency())
      .mockRejectedValueOnce(dependency())
      .mockResolvedValue({ jobId });
    await f.processor.process({
      data: { importId: String(f.stored._id), handoffAttempt: 1 },
    } as never);
    expect(f.stored.status).toBe('queued');
    expect(f.stored.handoffAttempt).toBe(2);
    expect(f.stored.sharedResultKey).toBe('b'.repeat(64));
    f.stored.nextAttemptAt = null;
    await f.processor.process({
      data: { importId: String(f.stored._id), handoffAttempt: 2 },
    } as never);
    expect(f.stored.status).toBe('submitted');
    expect(String(f.stored.jobId)).toBe(jobId);
    expect(f.jobs.createForSharedInput).not.toHaveBeenCalled();
    expect(f.downloader.download).not.toHaveBeenCalled();
    expect(f.usage.reserveForImport).not.toHaveBeenCalled();
  });
  it('caps handoff backoff independently of exhausted acquisition and legacy budgets', () => {
    for (const maxAcquisitionAttempts of [1, 4]) {
      const saved = record({
        maxAcquisitionAttempts,
        acquisitionAttempt: maxAcquisitionAttempts,
        status: 'uploading',
        sharedSourceKey: 'a'.repeat(64),
        sharedResultKey: 'b'.repeat(64),
      });
      expect(
        [0, 1, 2, 3, 50].map((handoffAttempt) =>
          handoffRetryDelay(
            { ...saved, handoffAttempt },
            'IMPORT_DEPENDENCY_FAILED',
          ),
        ),
      ).toEqual([5_000, 10_000, 20_000, 30_000, 30_000]);
      expect(
        acquisitionRetryDelay(
          { ...saved, handoffPending: true },
          'IMPORT_DEPENDENCY_FAILED',
        ),
      ).toBeNull();
      for (const code of [
        'ACCOUNT_DISABLED',
        'MEDIA_TOO_LONG',
        'PROCESSING_POLICY_INCOMPATIBLE',
        'PROCESSING_ALLOWANCE_EXHAUSTED',
      ])
        expect(handoffRetryDelay(saved, code)).toBeNull();
    }
  });
  it('keeps confirmed input, keys, original UUID and hold after repeated submission failure at acquisition four', async () => {
    const f = confirmed();
    const reserve = vi.spyOn(f.imports, 'reserveAcquisition');
    f.jobs.createForSharedInput
      .mockRejectedValueOnce(dependency())
      .mockRejectedValueOnce(dependency());
    await f.processor.process({
      data: { importId: String(f.stored._id), attempt: 4 },
    } as never);
    expect(f.stored).toMatchObject({
      status: 'queued',
      acquisitionAttempt: 4,
      handoffPending: true,
      handoffAttempt: 1,
      input: { bytes: 1_024, durationSeconds: 30 },
      sharedSourceKey: 'a'.repeat(64),
      sharedResultKey: 'b'.repeat(64),
      jobRequestId: 'job-fixture',
      acquisitionLimits: { maxBytes: 5_000, maxDuration: 60 },
      executionId: null,
      deadlineAt: null,
      error: null,
    });
    expect(f.stored.acquisitionReservedAt).toEqual(
      new Date('2026-10-01T00:00:00Z'),
    );
    await vi.waitFor(() => expect(f.queue.add).toHaveBeenCalledOnce());
    expect(f.queue.add).toHaveBeenCalledWith(
      'import',
      { importId: String(f.stored._id), handoffAttempt: 1 },
      expect.objectContaining({
        jobId: `${f.stored._id}-handoff-1`,
        attempts: 1,
      }),
    );
    expect(reserve).not.toHaveBeenCalled();
    expect(f.downloader.download).not.toHaveBeenCalled();
    expect(f.usage.releaseImport).not.toHaveBeenCalled();
    expect(f.shared.failImport).not.toHaveBeenCalled();
    expect(f.actions.cancelPendingUpload).not.toHaveBeenCalled();
    // A delayed BullMQ delivery cannot claim before its persisted due date.
    await f.processor.process({
      data: { importId: String(f.stored._id), handoffAttempt: 1 },
    } as never);
    expect(f.jobs.createForSharedInput).toHaveBeenCalledTimes(2);
    f.stored.nextAttemptAt = null;
    await f.processor.process({
      data: { importId: String(f.stored._id), handoffAttempt: 1 },
    } as never);
    expect(f.stored.status).toBe('submitted');
    expect(f.stored.acquisitionAttempt).toBe(4);
    expect(f.stored.handoffPending).toBe(false);
    expect(f.jobs.createForSharedInput).toHaveBeenCalledTimes(3);
    for (const call of f.jobs.createForSharedInput.mock.calls) {
      expect(call[2]).toBe('job-fixture');
      expect(call[10]).toEqual(f.stored._id);
    }
    expect(reserve).not.toHaveBeenCalled();
    expect(f.downloader.download).not.toHaveBeenCalled();
  });
  it('also recovers a confirmed source-only import without claiming an upload hold', async () => {
    const f = confirmed({ acquisitionAttempt: 0, acquisitionReservedAt: null });
    f.jobs.createForSharedInput.mockRejectedValue(dependency());
    await f.processor.process({
      data: { importId: String(f.stored._id), attempt: 1 },
    } as never);
    expect(f.stored.handoffPending).toBe(true);
    expect(f.stored.handoffAttempt).toBe(1);
    expect(f.jobs.createForSharedInput.mock.calls[0]![10]).toBeUndefined();
    expect(f.usage.reserveForImport).not.toHaveBeenCalled();
    expect(f.usage.releaseImport).not.toHaveBeenCalled();
  });
  it('retains Mongo outbox when Redis write is lost and recreates the same generation', async () => {
    const f = confirmed({ status: 'uploading', acquisitionAttempt: 4 });
    f.queue.add.mockRejectedValueOnce(new Error('Redis unavailable'));
    await expect(
      f.imports.retryHandoff({ ...f.stored }, safeImportError(dependency())),
    ).resolves.toBe(true);
    await vi.waitFor(() => expect(f.queue.add).toHaveBeenCalledOnce());
    expect(f.stored.handoffPending).toBe(true);
    await f.imports.enqueue(String(f.stored._id));
    expect(f.queue.add.mock.calls.map((call) => call[2].jobId)).toEqual([
      `${f.stored._id}-handoff-1`,
      `${f.stored._id}-handoff-1`,
    ]);
    expect(f.shared.inspect).toHaveBeenCalledOnce();
  });
  it('rejects stale or mixed queue generations and stale mutations without releasing the hold', async () => {
    const f = confirmed({
      handoffPending: true,
      handoffAttempt: 2,
      acquisitionAttempt: 4,
      executionId: null,
    });
    const old = { ...f.stored, handoffAttempt: 1 };
    for (const payload of [
      { handoffAttempt: 1 },
      { handoffAttempt: 2, attempt: 4 },
      { attempt: 4 },
    ])
      await f.processor.process({
        data: { importId: String(f.stored._id), ...payload },
      } as never);
    expect(
      await f.imports.retryHandoff(old, safeImportError(dependency())),
    ).toBe(false);
    await f.imports.failAcquisition(old, safeImportError(dependency()));
    await f.processor.reconcileFailure(old, dependency());
    expect(f.stored.status).toBe('queued');
    expect(f.stored.handoffAttempt).toBe(2);
    expect(f.jobs.createForSharedInput).not.toHaveBeenCalled();
    expect(f.usage.releaseImport).not.toHaveBeenCalled();
    expect(f.queue.add).not.toHaveBeenCalled();
  });
  it('recovers an already committed original job before source inspection or another submission', async () => {
    const f = confirmed({
      handoffPending: true,
      handoffAttempt: 1,
      acquisitionAttempt: 4,
    });
    const acceptedId = new Types.ObjectId();
    f.jobRecords.findOne.mockReturnValue({
      lean: async () => ({ _id: acceptedId, inputObject: {} }),
    } as never);
    await f.processor.process({
      data: { importId: String(f.stored._id), handoffAttempt: 1 },
    } as never);
    expect(f.jobRecords.findOne).toHaveBeenCalledWith({
      userId: f.stored.userId,
      requestId: 'job-fixture',
    });
    expect(f.stored.status).toBe('submitted');
    expect(String(f.stored.jobId)).toBe(String(acceptedId));
    expect(f.shared.inspect).not.toHaveBeenCalled();
    expect(f.jobs.createForSharedInput).not.toHaveBeenCalled();
    expect(f.downloader.download).not.toHaveBeenCalled();
    expect(f.usage.reserveForImport).not.toHaveBeenCalled();
    expect(f.usage.releaseImport).not.toHaveBeenCalled();
  });
  it('keeps dependency reads pending for runtime recovery without downloader replay', async () => {
    const f = confirmed({
      handoffPending: true,
      handoffAttempt: 1,
      acquisitionAttempt: 4,
    });
    f.shared.inspect.mockRejectedValue(new Error('DB read unavailable'));
    await expect(
      f.processor.process({
        data: { importId: String(f.stored._id), handoffAttempt: 1 },
      } as never),
    ).rejects.toThrow('DB read unavailable');
    expect(f.stored.status).toBe('uploading');
    expect(f.stored.handoffPending).toBe(true);
    expect(f.usage.releaseImport).not.toHaveBeenCalled();
    expect(f.downloader.download).not.toHaveBeenCalled();
  });
  it('keeps a temporary account dependency failure recoverable but fences permanent disablement', async () => {
    const f = confirmed({
      handoffPending: true,
      handoffAttempt: 1,
      acquisitionAttempt: 4,
    });
    f.access.assertActive.mockRejectedValue(
      new Error('account read unavailable'),
    );
    await expect(
      f.processor.process({
        data: { importId: String(f.stored._id), handoffAttempt: 1 },
      } as never),
    ).rejects.toThrow('account read unavailable');
    expect(f.stored.handoffPending).toBe(true);
    expect(f.stored.status).toBe('uploading');
    f.access.assertActive.mockRejectedValue(authError('ACCOUNT_DISABLED'));
    await f.processor.reconcileFailure({ ...f.stored }, dependency());
    expect(f.stored.status).toBe('failed');
    expect(f.stored.error?.code).toBe('ACCOUNT_DISABLED');
    expect(f.usage.releaseImport).toHaveBeenCalledOnce();
    expect(f.queue.add).not.toHaveBeenCalled();
    expect(f.downloader.download).not.toHaveBeenCalled();
  });
  it.each([
    'PROCESSING_ALLOWANCE_EXHAUSTED',
    'PROCESSING_POLICY_INCOMPATIBLE',
    'MEDIA_TOO_LONG',
    'JOB_STATE_CONFLICT',
  ] as const)(
    'makes permanent submission failure %s terminal',
    async (code) => {
      const f = confirmed({
        handoffPending: true,
        handoffAttempt: 2,
        acquisitionAttempt: 4,
      });
      f.jobs.createForSharedInput.mockRejectedValue(jobError(code));
      await f.processor.process({
        data: { importId: String(f.stored._id), handoffAttempt: 2 },
      } as never);
      expect(f.stored.status).toBe('failed');
      expect(f.stored.error?.code).toBe(code);
      expect(f.stored.handoffPending).toBe(false);
      expect(f.stored.handoffAttempt).toBe(2);
      expect(f.usage.releaseImport).toHaveBeenCalledOnce();
      expect(f.queue.add).not.toHaveBeenCalled();
      expect(f.downloader.download).not.toHaveBeenCalled();
    },
  );
  it.each(['acquire', 'failed', null])(
    'never reacquires after confirmed catalog becomes %s',
    async (action) => {
      const f = confirmed({
        handoffPending: true,
        handoffAttempt: 1,
        acquisitionAttempt: 4,
      });
      f.shared.inspect.mockResolvedValue(action ? ({ action } as never) : null);
      const reserve = vi.spyOn(f.imports, 'reserveAcquisition');
      await f.processor.process({
        data: { importId: String(f.stored._id), handoffAttempt: 1 },
      } as never);
      expect(f.stored.status).toBe('failed');
      expect(f.stored.error?.code).toBe('IMPORT_SOURCE_UNAVAILABLE');
      expect(reserve).not.toHaveBeenCalled();
      expect(f.downloader.download).not.toHaveBeenCalled();
    },
  );
  it('uses original reservation when processing completes elsewhere before its handoff generation', async () => {
    const f = confirmed({
      handoffPending: true,
      handoffAttempt: 1,
      acquisitionAttempt: 4,
    });
    const source = (await f.shared.inspect()) as unknown as {
      source: object;
      result: object;
    };
    f.shared.inspect.mockResolvedValue({
      ...source,
      result: { ...source.result, outputObject: {} },
      action: 'result',
    } as never);
    f.jobs.createFromCache.mockResolvedValue({
      jobId: new Types.ObjectId().toHexString(),
    });
    await f.processor.process({
      data: { importId: String(f.stored._id), handoffAttempt: 1 },
    } as never);
    expect(f.jobs.createFromCache.mock.calls[0]![4]).toEqual(f.stored._id);
    expect(f.stored.status).toBe('submitted');
    expect(f.shared.associateJob).not.toHaveBeenCalled();
    expect(f.downloader.download).not.toHaveBeenCalled();
    expect(f.usage.reserveForImport).not.toHaveBeenCalled();
  });
  it('does not let ready-cache delivery bypass persisted backoff', async () => {
    const f = confirmed({ nextAttemptAt: new Date(Date.now() + 60_000) });
    const source = (await f.shared.inspect()) as unknown as {
      source: object;
      result: object;
    };
    f.shared.inspect.mockResolvedValue({
      ...source,
      action: 'result',
    } as never);
    await f.imports.enqueue(String(f.stored._id));
    expect(f.jobs.createFromCache).not.toHaveBeenCalled();
    expect(f.queue.add).not.toHaveBeenCalled();
    expect(f.stored.status).toBe('queued');
  });
});

describe('malformed durable handoff catalogue', () => {
  it.each(['input', 'inputObject', 'sourceKey', 'resultKey', 'outputObject'])(
    'fails missing confirmed catalog %s without a retry or download',
    async (missing) => {
      const f = fixture({
        status: 'queued',
        handoffPending: true,
        handoffAttempt: 1,
        acquisitionAttempt: 4,
        sharedSourceKey: 'a'.repeat(64),
        sharedResultKey: 'b'.repeat(64),
      });
      const catalog = {
        action: missing === 'outputObject' ? 'result' : 'source',
        source: {
          _id: f.stored.sharedSourceKey,
          input: { bytes: 1_024, durationSeconds: 30 } as unknown,
          inputObject: {} as unknown,
        },
        result: { _id: f.stored.sharedResultKey, outputObject: {} as unknown },
      };
      if (missing === 'input' || missing === 'inputObject')
        catalog.source[missing] = null;
      if (missing === 'sourceKey') catalog.source._id = null;
      if (missing === 'resultKey') catalog.result._id = null;
      if (missing === 'outputObject') catalog.result.outputObject = null;
      f.shared.inspect.mockResolvedValue(catalog as never);
      await f.processor.process({
        data: { importId: String(f.stored._id), handoffAttempt: 1 },
      } as never);
      expect(f.stored.status).toBe('failed');
      expect(f.stored.error?.code).toBe('IMPORT_SOURCE_UNAVAILABLE');
      expect(f.stored.handoffPending).toBe(false);
      expect(f.jobs.createForSharedInput).not.toHaveBeenCalled();
      expect(f.jobs.createFromCache).not.toHaveBeenCalled();
      expect(f.queue.add).not.toHaveBeenCalled();
      expect(f.downloader.download).not.toHaveBeenCalled();
      expect(f.usage.releaseImport).toHaveBeenCalledOnce();
    },
  );
});

describe('handoff diagnostic persistence', () => {
  afterEach(() => vi.restoreAllMocks());
  function sourceFixture() {
    const f = fixture({
      status: 'queued',
      acquisitionAttempt: 0,
      sharedSourceKey: 'a'.repeat(64),
      sharedResultKey: 'b'.repeat(64),
    });
    f.shared.inspect.mockResolvedValue({
      action: 'source',
      source: {
        _id: f.stored.sharedSourceKey,
        sourceTitle: 'private title',
        input: { bytes: 1024, durationSeconds: 30 },
        inputObject: {},
      },
      result: {
        _id: f.stored.sharedResultKey,
        recipeSnapshot: workerRecipeSnapshot('kim-vocals-v2', false),
      },
    } as never);
    const update = f.records.updateOne.getMockImplementation()!;
    f.records.updateOne.mockImplementation(async (filter, values) => {
      if ('stageTimings' in values.$set)
        throw new Error('private observation error');
      return update(filter, values);
    });
    return f;
  }
  it('keeps the original transaction failure when timing writes also fail', async () => {
    const f = sourceFixture();
    const failure = Object.assign(new Error('private database URI'), {
      name: 'MongoOperationTimeoutError',
    });
    f.jobs.createForSharedInput.mockRejectedValueOnce(failure);
    const reconcile = vi
      .spyOn(f.processor, 'reconcileFailure')
      .mockResolvedValueOnce(undefined);
    const errors = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    await f.processor.process({
      data: { importId: String(f.stored._id), attempt: 1 },
    } as never);
    expect(reconcile).toHaveBeenCalledWith(expect.anything(), failure);
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'import-stage',
        stage: 'job-submission',
        state: 'failed',
        step: 'job-creation',
        source_confirmed: true,
        failure: expect.objectContaining({
          error_type: 'MongoOperationTimeoutError',
          reason: 'timeout',
        }),
      }),
    );
    const logs = JSON.stringify(errors.mock.calls);
    expect(logs).not.toContain('private database URI');
    expect(logs).not.toContain('private observation error');
    expect(logs).not.toContain('private title');
    expect(f.downloader.download).not.toHaveBeenCalled();
  });
  it('preserves an accepted job when only the timing ledger cannot be saved', async () => {
    const f = sourceFixture();
    const reconcile = vi.spyOn(f.processor, 'reconcileFailure');
    const errors = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    await f.processor.process({
      data: { importId: String(f.stored._id), attempt: 1 },
    } as never);
    expect(f.stored.status).toBe('submitted');
    expect(reconcile).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'import-observation-failure',
        operation: 'stage-timings',
      }),
    );
    expect(f.jobs.createForSharedInput).toHaveBeenCalledOnce();
    expect(f.queue.add).not.toHaveBeenCalled();
  });
});

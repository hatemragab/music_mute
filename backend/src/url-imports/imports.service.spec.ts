import { Types } from 'mongoose';
import { authError } from '../auth/auth.errors.js';
import { ImportsService } from './imports.service.js';
import type { MediaImport } from './media-import.schema.js';
import { importError } from './import-errors.js';
import { jobError } from '../jobs/job-errors.js';
import {
  DEFAULT_WORKER_RECIPE_ID,
  workerRecipeSnapshot,
} from '../jobs/worker-recipes.js';
import {
  sharedResultKey,
  sharedSourceKey,
} from '../shared-media/shared-media-key.js';

function fixture(values: Partial<MediaImport> = {}) {
  const owner = new Types.ObjectId();
  const record = {
    _id: new Types.ObjectId(),
    userId: owner,
    sourceUrl: 'https://youtu.be/abcdefghijk?list=fixture&index=2',
    trimEnabled: false,
    status: 'failed',
    jobId: null,
    error: { code: 'IMPORT_DEPENDENCY_FAILED', message: 'Try again later.' },
    createdAt: new Date('2026-10-04T09:24:33Z'),
    updatedAt: new Date('2026-10-04T09:26:46Z'),
    executionId: 'private-execution',
    jobRequestId: 'private-reservation',
    ...values,
  } as MediaImport;
  const records = {
    findOne: vi.fn(
      (filter: { _id: Types.ObjectId; userId: Types.ObjectId }) => ({
        lean: async () =>
          filter._id.equals(record._id) && filter.userId.equals(owner)
            ? record
            : null,
      }),
    ),
  };
  const access = { assertActive: vi.fn(), assertActiveReadOnly: vi.fn() };
  const service = new ImportsService(
    records as never,
    {} as never,
    {} as never,
    access as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { owner, record, records, access, service };
}

it('restores canonical owner retry context without internal reservation fields', async () => {
  const f = fixture();
  const result = await f.service.get(String(f.owner), String(f.record._id));
  expect(result).toMatchObject({
    importId: String(f.record._id),
    sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    trimEnabled: false,
    status: 'failed',
  });
  expect(result).not.toHaveProperty('executionId');
  expect(result).not.toHaveProperty('jobRequestId');
  expect(f.access.assertActiveReadOnly).toHaveBeenCalledTimes(2);
  expect(f.access.assertActiveReadOnly).toHaveBeenCalledWith(String(f.owner));
  expect(f.access.assertActive).not.toHaveBeenCalled();
});

it('does not expose another owner import or read a disabled account', async () => {
  const f = fixture();
  await expect(
    f.service.get(String(new Types.ObjectId()), String(f.record._id)),
  ).rejects.toMatchObject({ status: 404 });
  f.records.findOne.mockClear();
  f.access.assertActiveReadOnly.mockRejectedValueOnce(
    authError('ACCOUNT_DISABLED'),
  );
  await expect(
    f.service.get(String(f.owner), String(f.record._id)),
  ).rejects.toMatchObject({ response: { code: 'ACCOUNT_DISABLED' } });
  expect(f.records.findOne).not.toHaveBeenCalled();
});

it('withholds an import snapshot if its account is disabled during the lookup', async () => {
  const f = fixture();
  let finishLookup!: (record: MediaImport) => void;
  const lookup = new Promise<MediaImport>((resolve) => {
    finishLookup = resolve;
  });
  f.records.findOne.mockReturnValueOnce({ lean: () => lookup });
  const pending = f.service.get(String(f.owner), String(f.record._id));
  await vi.waitFor(() => expect(f.records.findOne).toHaveBeenCalledOnce());
  f.access.assertActiveReadOnly.mockRejectedValueOnce(
    authError('ACCOUNT_DISABLED'),
  );
  finishLookup(f.record);

  await expect(pending).rejects.toMatchObject({
    response: { code: 'ACCOUNT_DISABLED' },
  });
  expect(f.access.assertActiveReadOnly).toHaveBeenCalledTimes(2);
  expect(f.access.assertActive).not.toHaveBeenCalled();
});

it.each([
  'https://private:credential@www.youtube.com/watch?v=abcdefghijk',
  'http://localhost/media',
  'not a URL',
  undefined,
])(
  'withholds malformed historical retry URLs and defaults legacy trim',
  async (url) => {
    const f = fixture({ sourceUrl: url, trimEnabled: undefined });
    const result = await f.service.get(String(f.owner), String(f.record._id));
    expect(result.sourceUrl).toBeNull();
    expect(result.trimEnabled).toBe(true);
  },
);

function cachedFixture({ enabled = true, ready = true } = {}) {
  const owner = new Types.ObjectId();
  const url = 'https://www.youtube.com/watch?v=bZxrIoCPsOc';
  const recipe = workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID);
  const sourceKey = sharedSourceKey(url);
  const generation = '93664a10-01e9-49e1-9da2-12e7c68c3128';
  const resultKey = sharedResultKey(sourceKey, generation, recipe.recipeDigest);
  const input = {
    filename: 'source.mp3',
    extension: 'mp3',
    contentType: 'audio/mpeg',
    bytes: 2_048,
    sha256: Buffer.alloc(32, 2).toString('base64'),
    durationSeconds: 12,
  };
  const source = {
    _id: sourceKey,
    input,
    inputObject: {
      ...input,
      key: `shared/url/${sourceKey}/${generation}/input/source.mp3`,
      etag: '"original"',
    },
    sourceTitle: 'Shared song',
    extraData: null,
  };
  const result = {
    _id: resultKey,
    recipeSnapshot: recipe,
    comparisonRanges: null,
    outputObject: {
      ...source.inputObject,
      key: `shared/url/${resultKey}/${generation}/output/vocals.mp3`,
      etag: '"vocals"',
    },
  };
  const stored = new Map<string, MediaImport>();
  function query<T>(get: () => T) {
    const chain = {
      session: (_session: unknown) => chain,
      lean: async () => get(),
    };
    return chain;
  }
  const records = {
    findOne: vi.fn(
      (filter: {
        userId: Types.ObjectId;
        requestId: string;
        _id?: Types.ObjectId;
      }) =>
        query(
          () =>
            [...stored.values()].find(
              (record) =>
                record.userId.equals(filter.userId) &&
                (filter._id
                  ? record._id.equals(filter._id)
                  : record.requestId === filter.requestId),
            ) ?? null,
        ),
    ),
    findById: vi.fn((id: string) =>
      query(() => stored.get(String(id)) ?? null),
    ),
    countDocuments: vi.fn(() => ({ session: async () => 1 })),
    create: vi.fn(async ([values]: [Partial<MediaImport>]) => {
      const record = {
        status: 'queued',
        executionId: null,
        error: null,
        jobId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...values,
      } as MediaImport;
      stored.set(String(record._id), record);
      return [{ toObject: () => ({ ...record }) }];
    }),
    updateOne: vi.fn(
      async (
        filter: { _id: Types.ObjectId; status: string },
        update: { $set: Partial<MediaImport> },
      ) => {
        const record = stored.get(String(filter._id));
        if (
          !record ||
          (typeof filter.status === 'string' && record.status !== filter.status)
        )
          return { matchedCount: 0 };
        Object.assign(record, update.$set);
        return { matchedCount: 1 };
      },
    ),
  };
  const session = {};
  const fences = { updateOne: vi.fn() };
  const transactions = {
    run: vi.fn(async (operation: (session: unknown) => Promise<unknown>) =>
      operation(session),
    ),
  };
  const access = { assertActive: vi.fn(), assertActiveReadOnly: vi.fn() };
  const usage = {
    readUsage: vi.fn(),
    releaseImport: vi.fn(),
    reserveForImport: vi.fn(),
  };
  const config = {
    get: vi.fn(() => enabled),
    getOrThrow: vi.fn(() => 1),
  };
  const queue = { add: vi.fn() };
  const restrictions = { assertAllowed: vi.fn() };
  const shared = {
    claim: vi.fn(async () => ({
      sourceKey,
      resultKey,
      cached: ready,
      hasSource: ready,
    })),
    inspect: vi.fn(async () => ({
      action: ready ? 'result' : 'acquire',
      source,
      result,
    })),
    failImport: vi.fn(),
  };
  const jobId = new Types.ObjectId();
  const jobs = {
    createFromCache: vi.fn(async () => ({ jobId: String(jobId) })),
  };
  const service = new ImportsService(
    records as never,
    fences as never,
    transactions as never,
    access as never,
    usage as never,
    config as never,
    queue as never,
    restrictions as never,
    shared as never,
    jobs as never,
  );
  return {
    owner,
    url,
    stored,
    records,
    fences,
    usage,
    shared,
    jobs,
    jobId,
    queue,
    service,
    source,
    result,
  };
}

describe('immediate shared-result delivery', () => {
  it.each([true, false])(
    'returns a ready owned job without queue capacity or acquisition when enabled=%s',
    async (enabled) => {
      const f = cachedFixture({ enabled });
      const response = await f.service.create(
        String(f.owner),
        `${f.url}&list=RDbZxrIoCPsOc&start_radio=1`,
        'import-request',
      );

      expect(response).toMatchObject({
        status: 'submitted',
        sourceUrl: f.url,
        jobId: String(f.jobId),
        sourceTitle: 'Shared song',
      });
      expect(f.jobs.createFromCache).toHaveBeenCalledWith(
        String(f.owner),
        expect.any(String),
        expect.objectContaining({
          inputObject: f.source.inputObject,
          outputObject: f.result.outputObject,
          metadata: expect.objectContaining({
            sourceKind: 'url',
            source: 'youtube',
            sourceUrl: f.url,
          }),
        }),
      );
      expect(f.records.countDocuments).not.toHaveBeenCalled();
      expect(f.usage.readUsage).not.toHaveBeenCalled();
      expect(f.usage.reserveForImport).not.toHaveBeenCalled();
      expect(f.queue.add).not.toHaveBeenCalled();
      const [record] = f.stored.values();
      expect(record.acquisitionAttempt).toBe(0);
      expect(record.finishedAt).toBeInstanceOf(Date);
      expect(record.expiresAt!.getTime() - record.finishedAt!.getTime()).toBe(
        7 * 86400_000,
      );
    },
  );

  it('preserves normal queue admission and disabling for uncached sources', async () => {
    const full = cachedFixture({ ready: false });
    await expect(
      full.service.create(String(full.owner), full.url, 'new-request'),
    ).rejects.toMatchObject({ response: { code: 'IMPORT_QUEUE_FULL' } });
    const disabled = cachedFixture({ enabled: false, ready: false });
    await expect(
      disabled.service.create(
        String(disabled.owner),
        disabled.url,
        'new-request',
      ),
    ).rejects.toMatchObject({ response: { code: 'IMPORT_DISABLED' } });
    for (const f of [full, disabled]) {
      expect(f.records.create).not.toHaveBeenCalled();
      expect(f.jobs.createFromCache).not.toHaveBeenCalled();
      expect(f.queue.add).not.toHaveBeenCalled();
    }
  });

  it('does not create an import or enqueue acquisition on a cache-only miss', async () => {
    const f = cachedFixture({ ready: false });
    f.shared.claim.mockRejectedValueOnce(importError('IMPORT_CACHE_MISS'));
    await expect(
      f.service.create(String(f.owner), f.url, 'cache-request', true, true),
    ).rejects.toMatchObject({ response: { code: 'IMPORT_CACHE_MISS' } });
    expect(f.shared.claim).toHaveBeenCalledWith(
      f.url,
      'youtube',
      expect.any(Types.ObjectId),
      true,
      expect.any(Object),
      true,
    );
    expect(f.records.create).not.toHaveBeenCalled();
    expect(f.records.countDocuments).not.toHaveBeenCalled();
    expect(f.usage.readUsage).not.toHaveBeenCalled();
    expect(f.jobs.createFromCache).not.toHaveBeenCalled();
    expect(f.queue.add).not.toHaveBeenCalled();
  });

  it('recovers a transient delivery failure using the same job request without BullMQ', async () => {
    const f = cachedFixture();
    f.jobs.createFromCache.mockRejectedValueOnce(
      new Error('Temporary database error'),
    );
    const pending = await f.service.create(
      String(f.owner),
      f.url,
      'retry-request',
    );
    expect(pending.status).toBe('queued');
    const request = f.jobs.createFromCache.mock.calls[0];
    await f.service.enqueue(pending.importId);
    expect(f.jobs.createFromCache.mock.calls[1]).toEqual(request);
    expect(
      (await f.service.get(String(f.owner), pending.importId)).status,
    ).toBe('submitted');
    expect(f.queue.add).not.toHaveBeenCalled();
    expect(f.shared.failImport).not.toHaveBeenCalled();
  });

  it('recovers a lost final import write without changing the accepted job identity', async () => {
    const f = cachedFixture();
    f.records.updateOne.mockRejectedValueOnce(
      new Error('Lost completion write'),
    );
    const pending = await f.service.create(
      String(f.owner),
      f.url,
      'retry-request',
    );
    expect(pending.status).toBe('queued');
    const restored = await f.service.create(
      String(f.owner),
      'https://youtu.be/bZxrIoCPsOc?si=tracking',
      'retry-request',
    );
    expect(restored).toMatchObject({
      status: 'submitted',
      jobId: String(f.jobId),
      importId: pending.importId,
    });
    expect(f.jobs.createFromCache.mock.calls[1]).toEqual(
      f.jobs.createFromCache.mock.calls[0],
    );
    expect(f.records.create).toHaveBeenCalledTimes(1);
    expect(f.queue.add).not.toHaveBeenCalled();
  });

  it('does not replay an existing cold queued request through a cache-only request', async () => {
    const f = cachedFixture();
    f.jobs.createFromCache.mockRejectedValueOnce(
      new Error('Temporary failure'),
    );
    await f.service.create(String(f.owner), f.url, 'existing-request');
    f.shared.inspect.mockResolvedValue({
      action: 'acquire',
      source: f.source,
      result: f.result,
    });
    f.jobs.createFromCache.mockClear();
    f.records.updateOne.mockClear();
    f.fences.updateOne.mockClear();
    await expect(
      f.service.create(String(f.owner), f.url, 'existing-request', true, true),
    ).rejects.toMatchObject({ response: { code: 'IMPORT_CACHE_MISS' } });
    expect(f.records.updateOne).not.toHaveBeenCalled();
    expect(f.fences.updateOne).not.toHaveBeenCalled();
    expect(f.jobs.createFromCache).not.toHaveBeenCalled();
    expect(f.queue.add).not.toHaveBeenCalled();
  });

  it('records safe terminal cached admission failures instead of retrying forever', async () => {
    const f = cachedFixture();
    f.jobs.createFromCache.mockRejectedValueOnce(
      jobError('RETAINED_STORAGE_LIMIT_REACHED'),
    );
    const failed = await f.service.create(
      String(f.owner),
      f.url,
      'denied-request',
    );
    expect(failed).toMatchObject({
      status: 'failed',
      jobId: null,
      error: { code: 'RETAINED_STORAGE_LIMIT_REACHED' },
    });
    expect(f.queue.add).not.toHaveBeenCalled();
    await f.service.enqueue(failed.importId);
    expect(f.jobs.createFromCache).toHaveBeenCalledTimes(1);
  });
});

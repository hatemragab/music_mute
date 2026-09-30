import { isDeepStrictEqual } from 'node:util';
import { Types } from 'mongoose';
import type { Job } from '../jobs/job.schema.js';
import type { ObjectIdentity } from '../jobs/job.types.js';
import {
  DEFAULT_WORKER_RECIPE_ID,
  workerRecipeSnapshot,
} from '../jobs/worker-recipes.js';
import type { MediaImport } from '../url-imports/media-import.schema.js';
import type { SharedMediaResult } from './shared-media.schema.js';
import { SharedMediaService } from './shared-media.service.js';

const sourceKey = 'a'.repeat(64);
const resultKey = 'b'.repeat(64);
const generation = '93664a10-01e9-49e1-9da2-12e7c68c3128';
const importId = new Types.ObjectId('64b000000000000000000001');
const jobId = new Types.ObjectId('64b000000000000000000002');
const userId = new Types.ObjectId('64b000000000000000000003');
const recipe = workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID);
const session = { inTransaction: () => true };
const output: ObjectIdentity = {
  key: `users/${userId}/jobs/${jobId}/attempts/output/vocals.mp3`,
  etag: '"private-output"',
  bytes: 1_024,
  sha256: Buffer.alloc(32, 1).toString('base64'),
  contentType: 'audio/mpeg',
};
const job = {
  _id: jobId,
  userId,
  sharedSourceKey: sourceKey,
  sharedResultKey: resultKey,
  recipeSnapshot: recipe,
} as Job;
const record = {
  _id: importId,
  userId,
  sharedSourceKey: sourceKey,
  sharedResultKey: resultKey,
} as MediaImport;

function query<T>(value: T | (() => T)) {
  const chain = {
    session: vi.fn(() => chain),
    sort: vi.fn(() => chain),
    limit: vi.fn((_count?: number) => chain),
    lean: vi.fn(async () =>
      typeof value === 'function' ? (value as () => T)() : value,
    ),
  };
  return chain;
}

function field(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

/** Apply the fences to mutable fixture documents, including concurrent updates. */
function matches(value: unknown, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or')
      return (expected as Record<string, unknown>[]).some((item) =>
        matches(value, item),
      );
    if (key === '$and')
      return (expected as Record<string, unknown>[]).every((item) =>
        matches(value, item),
      );
    const actual = field(value, key);
    if (expected && typeof expected === 'object') {
      if ('$lte' in expected)
        return (
          actual instanceof Date &&
          actual.getTime() <= (expected.$lte as Date).getTime()
        );
      if ('$gt' in expected)
        return typeof actual === 'string' && actual > String(expected.$gt);
    }
    return isDeepStrictEqual(actual, expected);
  });
}

function fixture() {
  const result: SharedMediaResult = {
    _id: resultKey,
    sourceKey,
    sourceGeneration: generation,
    state: 'processing',
    producerImportId: importId,
    producerJobId: jobId,
    recipeSnapshot: recipe,
    outputKey: null,
    pendingOutput: null,
    outputObject: null,
    publicationToken: null,
    publicationLeaseUntil: null,
    comparisonRanges: null,
    completedAt: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  };
  const rows = new Map([[result._id, result]]);
  const results = {
    findById: vi.fn((id: string) =>
      query(() => {
        const row = rows.get(id);
        return row ? { ...row } : null;
      }),
    ),
    find: vi.fn((filter: Record<string, unknown>) => {
      let limit = Number.POSITIVE_INFINITY;
      const chain = query(() =>
        [...rows.values()]
          .filter((row) => matches(row, filter))
          .sort((left, right) => left._id.localeCompare(right._id))
          .slice(0, limit)
          .map((row) => ({ ...row })),
      );
      chain.limit.mockImplementation((count?: number) => {
        limit = count ?? Number.POSITIVE_INFINITY;
        return chain;
      });
      return chain;
    }),
    findOneAndUpdate: vi.fn(
      (filter: Record<string, unknown>, update: { $set: object }) =>
        query(() => {
          const row = rows.get(String(filter._id));
          if (!row || !matches(row, filter)) return null;
          Object.assign(row, update.$set);
          return { ...row };
        }),
    ),
    updateOne: vi.fn(
      async (filter: Record<string, unknown>, update: { $set: object }) => {
        const row = rows.get(String(filter._id));
        if (!row || !matches(row, filter)) return { matchedCount: 0 };
        Object.assign(row, update.$set);
        return { matchedCount: 1 };
      },
    ),
  };
  const sources = {
    findById: vi.fn(),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
  };
  const imports = {
    findById: vi.fn(() => query({ ...record, status: 'submitted' })),
  };
  const jobs = {
    findById: vi.fn((_id: Types.ObjectId) =>
      query({ ...job, status: 'queued', deletedAt: null }),
    ),
    findOne: vi.fn(() => query<unknown>(null)),
  };
  const storage = {
    copyObject: vi.fn(async (object: ObjectIdentity, key: string) => ({
      ...object,
      key,
      etag: '"shared-output"',
    })),
    findUploadedObject: vi.fn().mockResolvedValue(null),
  };
  const transactions = {
    run: vi.fn(async (operation: (value: unknown) => Promise<void>) =>
      operation(session),
    ),
  };
  const artifacts = {
    init: vi.fn().mockResolvedValue(undefined),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    create: vi.fn().mockResolvedValue([]),
  };
  const service = new SharedMediaService(
    sources as never,
    results as never,
    imports as never,
    jobs as never,
    storage as never,
    transactions as never,
    artifacts as never,
  );
  return {
    service,
    result,
    rows,
    results,
    sources,
    imports,
    jobs,
    storage,
    transactions,
    artifacts,
  };
}

describe('shared-media publication recovery', () => {
  it('recovers a completed copy whose response was lost without copying it again', async () => {
    const f = fixture();
    let copied: ObjectIdentity | undefined;
    const responseLost = new Error('Copy response lost');
    f.storage.copyObject.mockImplementationOnce(async (object, key) => {
      copied = { ...object, key, etag: '"completed-shared-copy"' };
      throw responseLost;
    });

    await expect(f.service.publishOutput(job, output)).rejects.toBe(
      responseLost,
    );
    expect(f.result.outputKey).toBe(copied?.key);
    expect(f.result.pendingOutput).toEqual(output);
    expect(f.result.publicationLeaseUntil).toBeNull();
    f.storage.findUploadedObject.mockResolvedValue(copied);

    await expect(f.service.publishOutput(job, output)).resolves.toEqual(copied);
    expect(f.storage.findUploadedObject).toHaveBeenCalledWith({
      ...output,
      key: copied?.key,
    });
    expect(f.storage.copyObject).toHaveBeenCalledTimes(1);
    expect(f.result.outputObject).toEqual(copied);
    expect(f.artifacts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: copied?.key,
        assetKey: resultKey,
        kind: 'output',
        reservation: { ...output, key: copied?.key },
      }),
    );
    expect(f.artifacts.updateOne).toHaveBeenCalledWith(
      { _id: copied?.key },
      { $set: { object: copied } },
    );
    expect(f.artifacts.create.mock.invocationCallOrder[0]).toBeLessThan(
      f.storage.copyObject.mock.invocationCallOrder[0]!,
    );
  });

  it('retains both permanent intents when an uncertain destination cannot be confirmed', async () => {
    const f = fixture();
    const responseLost = new Error('Copy response lost');
    f.storage.copyObject.mockRejectedValueOnce(responseLost);

    await expect(f.service.publishOutput(job, output)).rejects.toBe(
      responseLost,
    );
    const uncertainKey = f.result.outputKey;
    const confirmed = await f.service.publishOutput(job, output);

    expect(confirmed.key).not.toBe(uncertainKey);
    expect(f.artifacts.create).toHaveBeenCalledTimes(2);
    expect(f.artifacts.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ _id: uncertainKey, kind: 'output' }),
    );
    expect(f.artifacts.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ _id: confirmed.key, kind: 'output' }),
    );
    expect(f.artifacts.updateOne).toHaveBeenCalledWith(
      { _id: confirmed.key },
      { $set: { object: confirmed } },
    );
  });

  it('does not start an untracked copy when the durable artifact reservation fails', async () => {
    const f = fixture();
    const catalogUnavailable = new Error('Artifact catalog unavailable');
    f.artifacts.create.mockRejectedValueOnce(catalogUnavailable);

    await expect(f.service.publishOutput(job, output)).rejects.toBe(
      catalogUnavailable,
    );

    expect(f.storage.copyObject).not.toHaveBeenCalled();
    expect(f.result.pendingOutput).toEqual(output);
    expect(f.result.publicationToken).toBeNull();
    expect(f.result.publicationLeaseUntil).toBeNull();
  });

  it('rejects a different private output instead of reusing an already published object', async () => {
    const f = fixture();
    f.result.pendingOutput = output;
    f.result.outputObject = {
      ...output,
      key: `shared/url/${resultKey}/${generation}/output/vocals.mp3`,
    };

    await expect(
      f.service.publishOutput(job, { ...output, etag: '"different-output"' }),
    ).rejects.toMatchObject({
      response: { code: 'IMPORT_DEPENDENCY_FAILED' },
    });
    expect(f.storage.copyObject).not.toHaveBeenCalled();
    expect(f.storage.findUploadedObject).not.toHaveBeenCalled();
  });

  it('rejects duplicate publication while another completion owns the lease', async () => {
    const f = fixture();
    f.result.pendingOutput = output;
    f.result.outputKey = `shared/url/${resultKey}/${generation}/output/vocals.mp3`;
    f.result.publicationToken = generation;
    f.result.publicationLeaseUntil = new Date(Date.now() + 60_000);

    await expect(f.service.publishOutput(job, output)).rejects.toMatchObject({
      response: { code: 'IMPORT_DEPENDENCY_FAILED' },
    });
    expect(f.storage.copyObject).not.toHaveBeenCalled();
    expect(f.storage.findUploadedObject).not.toHaveBeenCalled();
    expect(f.result.publicationToken).toBe(generation);
  });

  it('makes the confirmed result ready in the caller transaction with its comparison mapping', async () => {
    const f = fixture();
    const published = await f.service.publishOutput(job, output);
    const ranges = [
      [0, 1],
      [2, 3],
    ];

    await f.service.completeResult(job, published, ranges, session as never);

    expect(f.result.state).toBe('ready');
    expect(f.result.pendingOutput).toBeNull();
    expect(f.result.comparisonRanges).toEqual(ranges);
    expect(f.results.updateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({
        _id: resultKey,
        sourceKey,
        producerJobId: jobId,
        'outputObject.key': published.key,
        'outputObject.etag': published.etag,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'ready',
          comparisonRanges: ranges,
        }),
      }),
      { session, runValidators: true },
    );
  });
});

describe('shared-source recovery', () => {
  it('confirms an already uploaded reserved original with one HEAD', async () => {
    const f = fixture();
    const input = {
      filename: 'source.mp3',
      extension: 'mp3',
      contentType: 'audio/mpeg',
      bytes: 2_048,
      sha256: Buffer.alloc(32, 2).toString('base64'),
      durationSeconds: 12,
    };
    const key = `shared/url/${sourceKey}/${generation}/input/source.mp3`;
    const original = { ...input, key, etag: '"uploaded-original"' };
    f.sources.findById.mockReturnValue(
      query({
        _id: sourceKey,
        state: 'acquiring',
        producerImportId: importId,
        inputKey: key,
        input,
        sourceTitle: 'Recovered source',
        extraData: null,
      }),
    );
    f.storage.findUploadedObject.mockResolvedValue(original);

    await f.service.recoverSource(record);

    expect(f.storage.findUploadedObject).toHaveBeenCalledTimes(1);
    expect(f.storage.findUploadedObject).toHaveBeenCalledWith({
      ...input,
      key,
    });
    expect(f.sources.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: sourceKey,
        state: 'acquiring',
        producerImportId: importId,
        inputKey: key,
      }),
      {
        $set: expect.objectContaining({
          state: 'ready',
          inputObject: original,
          sourceTitle: 'Recovered source',
        }),
      },
      { runValidators: true },
    );
    expect(f.storage.copyObject).not.toHaveBeenCalled();
  });

  it('does not inspect or confirm another producer original', async () => {
    const f = fixture();
    f.sources.findById.mockReturnValue(
      query({
        _id: sourceKey,
        state: 'acquiring',
        producerImportId: new Types.ObjectId(),
        inputKey: `shared/url/${sourceKey}/${generation}/input/source.mp3`,
        input: { ...output, extension: 'mp3' },
      }),
    );

    await f.service.recoverSource(record);

    expect(f.storage.findUploadedObject).not.toHaveBeenCalled();
    expect(f.sources.updateOne).not.toHaveBeenCalled();
  });
});

describe('shared-media reconciliation', () => {
  it.each([
    ['state', 'failed'],
    ['producerImportId', new Types.ObjectId()],
    ['sourceGeneration', '36d39e96-29ae-4a19-9cf1-949d141bc025'],
    ['updatedAt', new Date('2026-10-01T00:01:00Z')],
  ])(
    'does not associate a stale producer job when %s changes during lookup',
    async (key, replacement) => {
      const f = fixture();
      f.result.producerJobId = null;
      f.jobs.findOne.mockReturnValue(
        query(() => {
          Object.assign(f.result, { [key]: replacement });
          return { ...job, status: 'queued', deletedAt: null };
        }),
      );

      await f.service.reconcile();

      expect(f.result.producerJobId).toBeNull();
      expect(f.sources.updateOne).not.toHaveBeenCalled();
      expect(f.results.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: resultKey,
          state: 'processing',
          producerJobId: null,
          producerImportId: importId,
          sourceGeneration: generation,
          updatedAt: new Date('2026-10-01T00:00:00Z'),
        }),
        { $set: { producerJobId: jobId } },
      );
    },
  );

  it.each([
    ['producerImportId', new Types.ObjectId()],
    ['producerJobId', new Types.ObjectId()],
    ['sourceGeneration', '36d39e96-29ae-4a19-9cf1-949d141bc025'],
    ['updatedAt', new Date('2026-10-01T00:01:00Z')],
  ])(
    'preserves a concurrently replaced result when %s changes',
    async (key, replacement) => {
      const f = fixture();
      f.jobs.findById.mockReturnValue(
        query(() => {
          Object.assign(f.result, { [key]: replacement });
          return { ...job, status: 'failed', deletedAt: null };
        }),
      );

      await f.service.reconcile();

      expect(f.result.state).toBe('processing');
      expect(f.sources.updateOne).not.toHaveBeenCalled();
      expect(f.results.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'processing',
          producerImportId: importId,
          producerJobId: jobId,
          sourceGeneration: generation,
          updatedAt: new Date('2026-10-01T00:00:00Z'),
        }),
        { $set: { state: 'failed' } },
        { session },
      );
    },
  );

  it('fails an abandoned acquisition only after matching its result and source generation', async () => {
    const f = fixture();
    f.imports.findById.mockReturnValue(query({ ...record, status: 'failed' }));
    f.jobs.findById.mockReturnValue(
      query({ ...job, status: 'failed', deletedAt: null }),
    );

    await f.service.reconcile();

    expect(f.result.state).toBe('failed');
    expect(f.sources.updateOne).toHaveBeenCalledWith(
      {
        _id: sourceKey,
        state: 'acquiring',
        producerImportId: importId,
        generation,
      },
      { $set: { state: 'failed' } },
      { session },
    );
  });

  it('continues beyond a full page of active producers and then wraps the cursor', async () => {
    const f = fixture();
    f.rows.clear();
    for (let index = 0; index < 101; index++) {
      const key = index.toString(16).padStart(64, '0');
      f.rows.set(key, { ...f.result, _id: key });
    }
    const abandoned = f.rows.get((100).toString(16).padStart(64, '0'))!;
    abandoned.producerJobId = new Types.ObjectId();
    f.jobs.findById.mockImplementation((id) =>
      query({
        ...job,
        status: id.equals(abandoned.producerJobId) ? 'failed' : 'queued',
        deletedAt: null,
      }),
    );

    await f.service.reconcile();
    expect(abandoned.state).toBe('processing');
    expect(f.jobs.findById).toHaveBeenCalledTimes(100);
    await f.service.reconcile();

    expect(abandoned.state).toBe('failed');
    expect(f.results.find).toHaveBeenNthCalledWith(2, {
      state: 'processing',
      _id: expect.objectContaining({
        $gt: (99).toString(16).padStart(64, '0'),
      }),
    });
    await f.service.reconcile();
    expect(f.results.find).toHaveBeenNthCalledWith(3, { state: 'processing' });
  });
});

describe('shared-media producer association', () => {
  it('preserves the retry producer when an older import finishes association late', async () => {
    const f = fixture();
    const retryJobId = new Types.ObjectId();
    f.result.producerJobId = retryJobId;

    await f.service.associateJob(record, jobId);

    expect(f.result.producerJobId).toEqual(retryJobId);
    expect(f.results.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: resultKey,
        producerImportId: importId,
        state: 'processing',
        $or: [{ producerJobId: null }, { producerJobId: jobId }],
      }),
      { $set: { producerJobId: jobId } },
    );
  });

  it('permits initial association and an idempotent repeat for the same producer job', async () => {
    const f = fixture();
    f.result.producerJobId = null;

    await f.service.associateJob(record, jobId);
    expect(f.result.producerJobId).toEqual(jobId);
    await f.service.associateJob(record, jobId);
    expect(f.result.producerJobId).toEqual(jobId);
  });
});

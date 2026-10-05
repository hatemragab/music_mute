import { describe, expect, it, vi } from 'vitest';
import { Types, type ClientSession, type Model } from 'mongoose';
import type { InputDeclaration, ObjectIdentity } from '../jobs/job.types.js';
import { workerRecipeSnapshot } from '../jobs/worker-recipes.js';
import { SharedMediaCatalogService } from './shared-media-catalog.service.js';
import { SharedMediaDerivationService } from './shared-media-derivation.service.js';
import {
  SharedMediaArtifact,
  SharedMediaResult,
  SharedMediaSource,
} from './shared-media.schema.js';
import {
  communitySourceKey,
  sharedResultKey,
  sharedSourceKey,
} from './shared-media-key.js';
import { derivedTrimRecipe } from './shared-media-trim.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { StorageTransfersService } from '../storage/storage-transfers.service.js';

const url =
  'https://www.youtube.com/watch?v=bZxrIoCPsOc&list=RDbZxrIoCPsOc&start_radio=1';
const alias = 'https://youtu.be/bZxrIoCPsOc?si=RLbbOevlM4lBmXHi';
const session = {} as ClientSession;
const input: InputDeclaration = {
  extension: 'mp3',
  contentType: 'audio/mpeg',
  bytes: 10,
  durationSeconds: 2.5,
  sha256: Buffer.alloc(32, 1).toString('base64'),
};
const uuid = 'd98f5730-e5c0-4875-8b9d-ab76f1e2a355';

function objects(id: Types.ObjectId) {
  return {
    input,
    inputObject: {
      key: `quarantine/youtube/${id}/input/original.mp3`,
      etag: '"original"',
      bytes: input.bytes,
      sha256: input.sha256,
      contentType: input.contentType,
    },
    outputObject: {
      key: `quarantine/youtube/${id}/output/vocals.mp3`,
      etag: '"vocal"',
      bytes: 12,
      sha256: Buffer.alloc(32, 2).toString('base64'),
      contentType: 'audio/mpeg',
    },
    sourceTitle: ' Fixture\nTitle ',
  };
}
function matches(
  row: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or')
      return (value as Record<string, unknown>[]).some((part) =>
        matches(row, part),
      );
    if (value && typeof value === 'object' && '$lte' in value)
      return (row[key] as Date)?.getTime() <= (value.$lte as Date).getTime();
    if (value instanceof Types.ObjectId)
      return (row[key] as Types.ObjectId)?.equals(value);
    return row[key] === value;
  });
}
function model<T extends { _id: string }>(rows: Map<string, T>) {
  const query = (value: T | T[] | null) => ({
    session: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: async () =>
      Array.isArray(value)
        ? value.map((row) => ({ ...row }))
        : value
          ? { ...value }
          : null,
  });
  const update = (
    filter: Record<string, unknown>,
    changes: {
      $set?: Record<string, unknown>;
      $setOnInsert?: Record<string, unknown>;
    },
    options?: { upsert?: boolean },
  ) => {
    let row = rows.get(filter._id as string);
    if (!row && options?.upsert) {
      row = { _id: filter._id, ...changes.$setOnInsert } as T;
      rows.set(row._id, row);
    }
    if (!row || !matches(row, filter)) return null;
    Object.assign(row, changes.$set);
    return row;
  };
  return {
    findById: vi.fn((key: string) => query(rows.get(key) ?? null)),
    find: vi.fn((filter: Record<string, unknown>) =>
      query([...rows.values()].filter((row) => matches(row, filter))),
    ),
    findOneAndUpdate: vi.fn((...args: Parameters<typeof update>) =>
      query(update(...args)),
    ),
    updateOne: vi.fn(async (...args: Parameters<typeof update>) => ({
      matchedCount: update(...args) ? 1 : 0,
    })),
  };
}
function fixture() {
  const sources = new Map<string, SharedMediaSource>();
  const results = new Map<string, SharedMediaResult>();
  const artifacts = new Map<string, SharedMediaArtifact>();
  const stored = new Map<string, ObjectIdentity>();
  const sourceModel = model(sources);
  const resultModel = model(results);
  const artifactModel = model(artifacts);
  const storage = {
    findUploadedObject: vi.fn(
      async (reservation: ObjectIdentity) =>
        stored.get(reservation.key) ?? null,
    ),
    copyObject: vi.fn(async (original: ObjectIdentity, key: string) => {
      const object = { ...original, key, etag: '"accepted"' };
      stored.set(key, object);
      return object;
    }),
  };
  const transactions = {
    run: vi.fn(async (work: (value: ClientSession) => Promise<unknown>) =>
      work(session),
    ),
  };
  const derivation = {
    derive: vi.fn(
      async (
        _full: ObjectIdentity,
        _duration: number,
        publish: (file: unknown) => Promise<unknown>,
      ) =>
        publish({
          path: '/fixture/trimmed.mp3',
          bytes: 8,
          sha256: Buffer.alloc(32, 3).toString('base64'),
          comparisonRanges: [
            [0, 35280],
            [79380, 110250],
          ],
        }),
    ),
    upload: vi.fn(
      async (file: { bytes: number; sha256: string }, key: string) => {
        stored.set(key, {
          key,
          bytes: file.bytes,
          sha256: file.sha256,
          contentType: 'audio/mpeg',
          etag: '"derived"',
        });
      },
    ),
  };
  const service = new SharedMediaCatalogService(
    sourceModel as unknown as Model<SharedMediaSource>,
    resultModel as unknown as Model<SharedMediaResult>,
    artifactModel as unknown as Model<SharedMediaArtifact>,
    storage as unknown as StorageTransfersService,
    transactions as unknown as ProcessingTransactions,
    derivation as unknown as SharedMediaDerivationService,
  );
  return {
    service,
    sources,
    results,
    artifacts,
    stored,
    storage,
    derivation,
    sourceModel,
    resultModel,
  };
}
async function contribute(f: ReturnType<typeof fixture>) {
  const id = new Types.ObjectId();
  await f.service.reserveCommunity(id, url, session);
  const ready = await f.service.publishCommunity(id, alias, objects(id));
  return { id, ready };
}
function trustedReady(f: ReturnType<typeof fixture>) {
  const key = sharedSourceKey(url);
  const recipe = workerRecipeSnapshot('kim-vocals-v2', false);
  const resultKey = sharedResultKey(key, uuid, recipe.recipeDigest);
  const source = {
    _id: key,
    sourceUrl: 'https://www.youtube.com/watch?v=bZxrIoCPsOc',
    provider: 'youtube',
    generation: uuid,
    state: 'ready',
    producerImportId: new Types.ObjectId(),
    input,
    inputKey: `shared/url/${key}/${uuid}/input/source.mp3`,
    inputObject: {
      ...objects(new Types.ObjectId()).inputObject,
      key: `shared/url/${key}/${uuid}/input/source.mp3`,
    },
    sourceTitle: 'trusted',
    extraData: null,
    acquiredAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as SharedMediaSource;
  const result = {
    _id: resultKey,
    sourceKey: key,
    sourceGeneration: uuid,
    state: 'ready',
    producerImportId: source.producerImportId,
    producerJobId: null,
    recipeSnapshot: recipe,
    outputKey: `shared/url/${resultKey}/${uuid}/output/vocals.mp3`,
    outputObject: {
      ...objects(new Types.ObjectId()).outputObject,
      key: `shared/url/${resultKey}/${uuid}/output/vocals.mp3`,
    },
    pendingOutput: null,
    publicationToken: null,
    publicationLeaseUntil: null,
    comparisonRanges: null,
    completedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as SharedMediaResult;
  f.sources.set(key, source);
  f.results.set(resultKey, result);
  return { source, result };
}

describe('shared community catalog', () => {
  it('reserves before acquisition and lets another producer wait without copies or model work', async () => {
    const f = fixture();
    const id = new Types.ObjectId();
    const first = await f.service.reserveCommunity(id, url, session);
    expect(first).toMatchObject({
      state: 'reserved',
      sourceKey: communitySourceKey(alias),
    });
    expect(first.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(
      await f.service.reserveCommunity(new Types.ObjectId(), alias, session),
    ).toMatchObject({
      state: 'waiting',
      sourceKey: first.sourceKey,
      resultKey: first.resultKey,
    });
    expect(await f.service.pending(alias, true, session)).toMatchObject({
      sourceKey: first.sourceKey,
      resultKey: first.resultKey,
      waitingForCommunity: true,
    });
    expect(f.sources.get(first.sourceKey)?.producerImportId).toBeNull();
    expect(f.storage.copyObject).not.toHaveBeenCalled();
    expect(f.derivation.derive).not.toHaveBeenCalled();
  });

  it('publishes both aliases into independent immutable shared objects once', async () => {
    const f = fixture();
    const { id, ready } = await contribute(f);
    expect(ready).toMatchObject({
      sourceKey: communitySourceKey(url),
      provenance: 'community_contributed',
      sourceIdentityVerified: false,
      sourceTitle: 'FixtureTitle',
    });
    expect(ready.sourceKey).not.toBe(sharedSourceKey(url));
    expect(await f.service.lookupReady(url)).toEqual(
      await f.service.lookupReady(alias),
    );
    expect(f.storage.copyObject).toHaveBeenCalledTimes(2);
    expect(f.artifacts.size).toBe(2);
    expect([...f.artifacts.values()].every((row) => row.object)).toBe(true);
    expect(await f.service.publishCommunity(id, url, objects(id))).toEqual(
      ready,
    );
    const other = new Types.ObjectId();
    expect(
      await f.service.publishCommunity(other, alias, objects(other)),
    ).toEqual(ready);
    expect(f.storage.copyObject).toHaveBeenCalledTimes(2);
    expect(f.sources.has(sharedSourceKey(url))).toBe(false);
  });

  it('recovers an uncertain copy and resumes the recorded keys', async () => {
    const f = fixture();
    const id = new Types.ObjectId();
    await f.service.reserveCommunity(id, url, session);
    const copy = f.storage.copyObject.getMockImplementation()!;
    f.storage.copyObject
      .mockImplementationOnce(copy)
      .mockImplementationOnce(async (...args) => {
        await copy(...args);
        throw new Error('response lost');
      });
    await expect(
      f.service.publishCommunity(id, url, objects(id)),
    ).rejects.toThrow('response lost');
    const keys = [...f.artifacts.keys()];
    expect(await f.service.lookupReady(url)).toBeNull();
    const ready = await f.service.publishCommunity(id, alias, objects(id));
    expect(ready.outputObject.key).toBe(keys[1]);
    expect(f.storage.copyObject).toHaveBeenCalledTimes(2);
  });

  it('prefers a later ready trusted result and never prevents trusted production', async () => {
    const f = fixture();
    await contribute(f);
    const trusted = trustedReady(f);
    expect(await f.service.lookupReady(alias)).toMatchObject({
      sourceKey: trusted.source._id,
      provenance: 'trusted',
      sourceIdentityVerified: true,
    });
    expect(f.sources.size).toBe(2);
  });

  it('keeps read-only trim replay bound to its recorded community master after a trusted rendition becomes ready', async () => {
    const f = fixture();
    const { ready: community } = await contribute(f);
    trustedReady(f);
    const trustedTrim = (await f.service.ensureReadyTrimmed(url))!;
    expect(await f.service.lookupReady(alias, true)).toEqual(trustedTrim);
    expect(await f.service.lookupTrimmedForFull(community)).toBeNull();
    expect(f.derivation.derive).toHaveBeenCalledTimes(1);
    const ownTrim = (await f.service.ensureTrimmedFromFull(community))!;
    expect(await f.service.lookupTrimmedForFull(community)).toEqual(ownTrim);
    expect(ownTrim.sourceKey).toBe(community.sourceKey);
    expect(ownTrim.sourceKey).not.toBe(trustedTrim.sourceKey);
    const master = f.results.get(community.resultKey)!;
    master.state = 'processing';
    expect(await f.service.lookupTrimmedForFull(community)).toBeNull();
    expect(f.derivation.derive).toHaveBeenCalledTimes(2);
  });

  it('joins a trusted in-flight acquisition without reserving a guest producer', async () => {
    const f = fixture();
    const { source, result } = trustedReady(f);
    source.state = 'acquiring';
    result.state = 'processing';
    expect(
      await f.service.reserveCommunity(new Types.ObjectId(), alias, session),
    ).toMatchObject({ state: 'waiting', sourceKey: source._id });
    expect(f.sources.has(communitySourceKey(url))).toBe(false);
    expect(f.storage.copyObject).not.toHaveBeenCalled();
  });

  it('refreshes only the producer lease and releases failed/expired preparation safely', async () => {
    const f = fixture();
    const id = new Types.ObjectId();
    const reservation = await f.service.reserveCommunity(id, url, session);
    const expires = new Date(Date.now() + 23 * 60 * 60 * 1000);
    await f.service.refreshCommunityLease(id, alias, expires, session);
    expect(await f.service.inspectCommunity(url)).toMatchObject({
      state: 'preparing',
      expiresAt: expires,
    });
    await f.service.failCommunity(new Types.ObjectId(), url, session);
    expect(f.sources.get(reservation.sourceKey)?.state).toBe('acquiring');
    await f.service.failCommunity(id, url, session);
    expect(await f.service.inspectCommunity(url)).toMatchObject({
      state: 'missing',
    });
    const next = await f.service.reserveCommunity(
      new Types.ObjectId(),
      alias,
      session,
    );
    expect(next.resultKey).not.toBe(reservation.resultKey);
    expect(f.results.get(reservation.resultKey)?.state).toBe('failed');
  });

  it('rejects a staged object from another contribution before database/copy writes', async () => {
    const f = fixture();
    await expect(
      f.service.publishCommunity(
        new Types.ObjectId(),
        url,
        objects(new Types.ObjectId()),
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(f.sourceModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(f.storage.copyObject).not.toHaveBeenCalled();
  });

  it('caches one distinct trimmed rendition while keeping full timeline unchanged', async () => {
    const f = fixture();
    const { ready } = await contribute(f);
    const trimmed = await f.service.ensureReadyTrimmed(alias);
    expect(trimmed).toMatchObject({
      sourceKey: ready.sourceKey,
      provenance: 'community_contributed',
      comparisonRanges: [
        [0, 35280],
        [79380, 110250],
      ],
    });
    expect(trimmed!.resultKey).not.toBe(ready.resultKey);
    expect(trimmed!.recipeSnapshot).toEqual(
      derivedTrimRecipe(ready.recipeSnapshot),
    );
    expect(await f.service.ensureReadyTrimmed(url)).toEqual(trimmed);
    expect(await f.service.lookupReady(alias, false)).toEqual(ready);
    expect(f.derivation.derive).toHaveBeenCalledTimes(1);
    expect(f.derivation.upload).toHaveBeenCalledTimes(1);
    expect(f.storage.copyObject).toHaveBeenCalledTimes(2);
    expect(f.artifacts.size).toBe(3);
  });

  it('makes concurrent trim requests wait on the same derivative lease', async () => {
    const f = fixture();
    const { ready } = await contribute(f);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const derive = f.derivation.derive.getMockImplementation()!;
    f.derivation.derive.mockImplementationOnce(async (...args) => {
      await gate;
      return derive(...args);
    });
    const pending = f.service.ensureReadyTrimmed(url);
    await vi.waitFor(() =>
      expect(f.derivation.derive).toHaveBeenCalledTimes(1),
    );
    expect(await f.service.ensureReadyTrimmed(alias)).toBeNull();
    expect(await f.service.pending(alias, true, session)).toMatchObject({
      sourceKey: ready.sourceKey,
      waitingForDerivation: true,
    });
    release();
    await pending;
    expect(f.derivation.derive).toHaveBeenCalledTimes(1);
  });

  it('recovers an uncertain derivative PUT without re-encoding', async () => {
    const f = fixture();
    await contribute(f);
    const upload = f.derivation.upload.getMockImplementation()!;
    f.derivation.upload.mockImplementationOnce(async (...args) => {
      await upload(...args);
      throw new Error('PUT response lost');
    });
    await expect(f.service.ensureReadyTrimmed(url)).rejects.toThrow(
      'PUT response lost',
    );
    expect(await f.service.lookupReady(url, true)).toBeNull();
    expect(await f.service.ensureReadyTrimmed(alias)).toMatchObject({
      comparisonRanges: [
        [0, 35280],
        [79380, 110250],
      ],
    });
    expect(f.derivation.derive).toHaveBeenCalledTimes(1);
    expect(f.derivation.upload).toHaveBeenCalledTimes(1);
  });

  it('hides a derivative of a master whose worker completion has not committed', async () => {
    const f = fixture();
    trustedReady(f);
    const full = (await f.service.lookupReady(url))!;
    f.results.get(full.resultKey)!.state = 'processing';
    const derived = await f.service.ensureTrimmedFromFull(full);
    expect(derived).not.toBeNull();
    expect(await f.service.lookupReady(url, true)).toBeNull();
    f.results.get(full.resultKey)!.state = 'ready';
    expect(await f.service.lookupReady(alias, true)).toEqual(derived);
  });

  it('never reuses an old rendition after a failed master is replaced by new immutable output', async () => {
    const f = fixture();
    const { result } = trustedReady(f);
    const full = (await f.service.lookupReady(url))!;
    const old = (await f.service.ensureReadyTrimmed(url))!;
    result.outputObject = {
      ...result.outputObject!,
      key: result.outputObject!.key.replace(
        uuid,
        '9a0ddd9e-18ea-4ea0-a9c2-49e6fce23760',
      ),
      etag: '"new-master"',
      sha256: Buffer.alloc(32, 4).toString('base64'),
    };
    result.outputKey = result.outputObject.key;
    expect(await f.service.lookupReady(alias, true)).toBeNull();
    await expect(f.service.ensureTrimmedFromFull(full)).rejects.toMatchObject({
      status: 503,
    });
    const replacement = (await f.service.ensureReadyTrimmed(alias))!;
    expect(replacement.resultKey).not.toBe(old.resultKey);
    expect(replacement.outputObject.key).not.toBe(old.outputObject.key);
    expect(f.results.get(old.resultKey)!.outputObject).toEqual(
      old.outputObject,
    );
    expect(f.derivation.derive).toHaveBeenCalledTimes(2);
    expect(await f.service.lookupReady(url, true)).toEqual(replacement);
  });

  it('fails closed for an accepted source with a missing current recipe instead of waiting indefinitely', async () => {
    const f = fixture();
    const { ready } = await contribute(f);
    f.results.delete(ready.resultKey);
    await expect(
      f.service.reserveCommunity(new Types.ObjectId(), alias, session),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.sources.get(ready.sourceKey)!.state).toBe('ready');
    expect(f.storage.copyObject).toHaveBeenCalledTimes(2);
  });
});

it('reuses only a ready trusted source even without any vocal rendition', async () => {
  const f = fixture();
  const { source } = trustedReady(f);
  f.results.clear();
  expect(await f.service.lookupSource(alias)).toEqual({
    input: source.input,
    inputObject: source.inputObject,
  });
  source.provenance = 'community_contributed';
  expect(await f.service.lookupSource(alias)).toBeNull();
  source.provenance = 'trusted';
  source.state = 'acquiring';
  expect(await f.service.lookupSource(alias)).toBeNull();
  source.state = 'ready';
  source.inputObject = {
    ...source.inputObject!,
    key: 'private/foreign/input.mp3',
  };
  expect(await f.service.lookupSource(alias)).toBeNull();
});

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { responseValue } from '../dist/http/snake-case-wire.js';
import { decodeExtraData } from '../dist/jobs/job-extra-data.js';
import { JobSchema } from '../dist/jobs/job.schema.js';
import { presentJob } from '../dist/jobs/jobs.presenter.js';
import {
  DEFAULT_WORKER_RECIPE_ID,
  workerRecipeSnapshot,
} from '../dist/jobs/worker-recipes.js';
import {
  sharedResultKey,
  sharedSourceKey,
} from '../dist/shared-media/shared-media-key.js';
import {
  SharedMediaResultSchema,
  SharedMediaSourceSchema,
} from '../dist/shared-media/shared-media.schema.js';
import { SharedMediaService } from '../dist/shared-media/shared-media.service.js';
import { IsolatedServices } from './helpers/isolated-services.mjs';

const sourceUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const originalThumbnail =
  'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?sqp=-oaymwEmCOADEOgC8quKqQMa8AEB-AG-AoAC8AGKAgwIABABGFUgWShlMA8=&rs=AOn4CLA9eLBatYv9WbkD4BbZ2Im-biSPTw';
const input = {
  extension: 'mp3',
  contentType: 'audio/mpeg',
  bytes: 1024,
  durationSeconds: 19,
  sha256: Buffer.alloc(32, 7).toString('base64'),
};

test('Library thumbnail URLs persist and remain nullable without fetching images or backfilling old rows', async (t) => {
  const services = await IsolatedServices.create();
  let connection;
  t.after(async () => {
    await connection?.close();
    await services.stop();
  });
  const { mongoUri } = await services.startDatabases();
  connection = await createConnection(mongoUri, {
    bufferCommands: false,
  }).asPromise();
  const jobs = connection.model('Job', JobSchema);
  const sources = connection.model(
    'SharedMediaSource',
    SharedMediaSourceSchema,
  );
  const results = connection.model(
    'SharedMediaResult',
    SharedMediaResultSchema,
  );
  await Promise.all([jobs.init(), sources.init(), results.init()]);

  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Thumbnail persistence must not fetch images or metadata');
  });
  const owners = [new Types.ObjectId(), new Types.ObjectId()];
  const sourceKey = sharedSourceKey(sourceUrl);
  const generation = randomUUID();
  const recipeSnapshot = workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID, false);
  const resultKey = sharedResultKey(
    sourceKey,
    generation,
    recipeSnapshot.recipeDigest,
  );
  const inputObject = {
    key: `shared/url/${sourceKey}/${generation}/input/source.mp3`,
    contentType: input.contentType,
    bytes: input.bytes,
    sha256: input.sha256,
    etag: '"fixture-original-audio"',
  };
  const outputObject = {
    ...inputObject,
    key: `shared/url/${resultKey}/${generation}/output/vocals.mp3`,
    etag: '"fixture-vocal-audio"',
  };
  const createJob = (owner, extraData, overrides = {}) =>
    jobs.create({
      userId: owner,
      requestId: randomUUID(),
      requestHash: 'a'.repeat(64),
      sourceKind: 'url',
      sourceUrl,
      sourceTitle: 'Synthetic video audio',
      inputReservation: { ...input, key: inputObject.key },
      inputObject,
      outputObject,
      sharedSourceKey: sourceKey,
      sharedResultKey: resultKey,
      recipeSnapshot,
      status: 'ready',
      finishedAt: new Date(),
      extra_data: extraData,
      ...overrides,
    });

  await t.test(
    'the original adapter URL survives source/job storage and cross-account shared-cache reuse unchanged',
    async () => {
      const metadata = decodeExtraData(
        Buffer.from(
          JSON.stringify({
            schema_version: 1,
            provider: 'yt-dlp',
            site: 'youtube',
            thumbnail_url: originalThumbnail,
            provider_download_url: 'https://example.invalid/private-audio',
          }),
        ).toString('base64'),
      );
      assert.equal(metadata.thumbnail_url, originalThumbnail);
      assert.equal(Object.hasOwn(metadata, 'provider_download_url'), false);
      await sources.create({
        _id: sourceKey,
        sourceUrl,
        provider: 'youtube',
        generation,
        state: 'ready',
        inputKey: inputObject.key,
        input,
        inputObject,
        sourceTitle: 'Synthetic video audio',
        extraData: metadata,
        acquiredAt: new Date(),
      });
      await results.create({
        _id: resultKey,
        sourceKey,
        sourceGeneration: generation,
        state: 'ready',
        recipeSnapshot,
        outputObject,
        completedAt: new Date(),
      });
      const first = await createJob(owners[0], metadata);
      const savedSource = await sources.findById(sourceKey).lean();
      const savedFirst = await jobs.findById(first._id).lean();
      assert.equal(savedSource.extraData.thumbnail_url, originalThumbnail);
      assert.equal(savedFirst.extra_data.thumbnail_url, originalThumbnail);

      const shared = new SharedMediaService(sources, results);
      const cached = await shared.inspect({
        _id: new Types.ObjectId(),
        sharedSourceKey: sourceKey,
        sharedResultKey: resultKey,
        trimEnabled: false,
      });
      assert.equal(cached.action, 'result');
      assert.equal(cached.source.extraData.thumbnail_url, originalThumbnail);
      const second = await createJob(owners[1], cached.source.extraData);
      const savedSecond = await jobs.findById(second._id).lean();
      assert.notEqual(
        savedFirst.userId.toHexString(),
        savedSecond.userId.toHexString(),
      );
      assert.equal(savedSecond.sharedSourceKey, savedFirst.sharedSourceKey);
      assert.deepEqual(savedSecond.extra_data, savedFirst.extra_data);
      assert.equal(await sources.countDocuments(), 1);

      for (const saved of [savedFirst, savedSecond]) {
        const publicJob = presentJob(saved);
        // HTTP and raw WebSocket snapshots share this presenter and serializer.
        const http = JSON.parse(JSON.stringify(responseValue(publicJob)));
        const socket = JSON.parse(
          JSON.stringify({ type: 'snapshot', data: responseValue(publicJob) }),
        );
        assert.equal(http.thumbnail_url, originalThumbnail);
        assert.equal(socket.data.thumbnail_url, originalThumbnail);
        assert.equal(Object.hasOwn(http, 'extra_data'), false);
        assert.equal(Object.hasOwn(http, 'thumbnailUrl'), false);
      }
    },
  );

  await t.test(
    'missing, null, and rejected thumbnail metadata survive Mongo re-reads as a null public field',
    async () => {
      for (const extraData of [
        null,
        { schema_version: 1, provider: 'yt-dlp' },
        { schema_version: 1, provider: 'yt-dlp', thumbnail_url: null },
        {
          schema_version: 1,
          provider: 'yt-dlp',
          thumbnail_url: 'http://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg',
        },
        {
          schema_version: 1,
          provider: 'yt-dlp',
          thumbnail_url: 'https://example.invalid/private-image.jpg',
        },
      ]) {
        const created = await createJob(owners[0], extraData);
        const saved = await jobs.findById(created._id).lean();
        assert.equal(saved.extra_data?.thumbnail_url ?? null, null);
        assert.equal(responseValue(presentJob(saved)).thumbnail_url, null);
        if (extraData === null) assert.equal(saved.extra_data, null);
      }
      const local = await createJob(owners[0], null, {
        sourceKind: 'file',
        sourceUrl: null,
        sharedSourceKey: null,
        sharedResultKey: null,
      });
      assert.equal(
        presentJob(await jobs.findById(local._id).lean()).thumbnailUrl,
        null,
      );
    },
  );

  await t.test(
    'reading legacy omitted or unsafe stored fields performs no rewrite or metadata backfill',
    async () => {
      const legacy = await createJob(owners[0], null);
      // Owned fixture updates emulate historical BSON rather than bypassing schema validation for new jobs.
      await jobs.collection.updateOne(
        { _id: legacy._id },
        { $unset: { extra_data: '' } },
      );
      const before = await jobs.collection.findOne({ _id: legacy._id });
      assert.equal(Object.hasOwn(before, 'extra_data'), false);
      assert.equal(
        responseValue(presentJob(await jobs.findById(legacy._id).lean()))
          .thumbnail_url,
        null,
      );
      assert.deepEqual(
        await jobs.collection.findOne({ _id: legacy._id }),
        before,
      );

      await jobs.collection.updateOne(
        { _id: legacy._id },
        {
          $set: {
            extra_data: {
              schema_version: 1,
              thumbnail_url: 'https://example.invalid/private-image.jpg',
            },
          },
        },
      );
      const unsafeBefore = await jobs.collection.findOne({ _id: legacy._id });
      assert.equal(
        responseValue(presentJob(await jobs.findById(legacy._id).lean()))
          .thumbnail_url,
        null,
      );
      assert.deepEqual(
        await jobs.collection.findOne({ _id: legacy._id }),
        unsafeBefore,
      );
    },
  );
  assert.equal(fetch.mock.callCount(), 0);
});

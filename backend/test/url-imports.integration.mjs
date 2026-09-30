import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue, Worker } from 'bullmq';
import { IsolatedServices, until } from './helpers/isolated-services.mjs';
import {
  MediaImport,
  MediaImportSchema,
} from '../dist/url-imports/media-import.schema.js';
import {
  ImportsService,
  IMPORT_QUEUE,
} from '../dist/url-imports/imports.service.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { AudioAcquisitionClient } from '../dist/url-imports/audio-acquisition-client.js';
import { ImportProcessor } from '../dist/url-imports/import-processor.js';
import { ImportRuntime } from '../dist/url-imports/import-runtime.js';
import { ImportsController } from '../dist/url-imports/imports.controller.js';
import { configureHttp } from '../dist/http/configure-http.js';
import {
  ProcessingAdmissionFence,
  ProcessingAdmissionFenceSchema,
} from '../dist/admin-settings/processing-settings.schema.js';

let services, connection, queue, records, imports, redis;
const owner = new Types.ObjectId();
const usage = {
  reserveForImport: async () => {},
  releaseImport: async () => {},
  readUsage: async () => ({
    availability: { status: 'available' },
    uploads: {
      dailyRemainingGrants: 100,
      monthlyRemainingGrants: 100,
      monthlyRemainingBytes: 500000000,
    },
    effectiveLimits: {
      maxPreparedAudioBytes: 50000000,
      maxDurationSeconds: 1200,
    },
    processing: { remainingSeconds: 10000 },
  }),
};
before(async () => {
  services = await IsolatedServices.create();
  const databases = await services.startDatabases({ replicaSet: true });
  redis = { host: '127.0.0.1', port: databases.redisPort };
  connection = await createConnection(databases.mongoUri).asPromise();
  records = connection.model(MediaImport.name, MediaImportSchema);
  const fences = connection.model(
    ProcessingAdmissionFence.name,
    ProcessingAdmissionFenceSchema,
  );
  await fences.init();
  queue = new Queue(IMPORT_QUEUE, {
    connection: redis,
    prefix: 'isolated-imports',
  });
  imports = new ImportsService(
    records,
    fences,
    new ProcessingTransactions(connection),
    { assertActive: async () => {} },
    usage,
    new ConfigService({
      URL_IMPORT_ENABLED: true,
      URL_IMPORT_MAX_OUTSTANDING: 100,
    }),
    queue,
    { assertAllowed: async () => {} },
  );
  await imports.initialize();
});
after(async () => {
  await queue?.close();
  await connection?.close();
  await services?.stop();
});

test('native acquisition cleans upload/finalization failures and preserves committed confirmation', async (context) => {
  const fixture = join(services.directory, 'source.mp3');
  await promisify(execFile)(process.env.FFMPEG_BINARY || 'ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=0.25',
    '-codec:a',
    'libmp3lame',
    fixture,
  ]);
  const audio = await readFile(fixture);
  const checksum = createHash('sha256').update(audio).digest('base64');
  let failureMode = 'none',
    uploadBytes = 0,
    uploadChecksum = null,
    acquisitionRequests = 0,
    submissions = 0,
    cancellations = 0,
    reservation;
  let origin;
  let deliveryGate = Promise.resolve();
  const server = createServer(async (req, res) => {
    if (req.method === 'POST') {
      acquisitionRequests++;
      for await (const _chunk of req) {
        /* consume only fixture request */
      }
      assert.equal(req.url, '/audio-imports');
      assert.equal(req.headers.authorization, 'Bearer fixture-key');
      await deliveryGate;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(audio.length));
      res.setHeader(
        'X-Import-Extra-Data-Base64',
        Buffer.from(
          JSON.stringify({
            schema_version: 1,
            provider: 'fixture',
            audio_codec: 'mp3',
            title: 'عنوان المصدر 🎵',
            download_url: 'https://secret.invalid',
          }),
        ).toString('base64'),
      );
      res.end(audio);
    } else if (req.method === 'PUT') {
      uploadBytes = 0;
      const hash = createHash('sha256');
      for await (const chunk of req) {
        uploadBytes += chunk.length;
        hash.update(chunk);
      }
      uploadChecksum = hash.digest('base64');
      if (req.headers['content-length'] !== String(audio.length)) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(failureMode === 'upload' ? 503 : 200);
      res.end();
    } else {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.end(audio);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const config = new ConfigService({
    APP_ENV: 'test',
    BODY_LIMIT_BYTES: 65536,
    CORS_ORIGINS: '',
    TRUST_PROXY: '0',
    AUDIO_ACQUISITION_API_URL: `${origin}/`,
    AUDIO_ACQUISITION_API_KEY: 'fixture-key',
    URL_IMPORT_TEMP_ROOT: join(services.directory, 'import-audio'),
    URL_IMPORT_MIN_FREE_BYTES: 0,
    URL_IMPORT_FFPROBE_PATH: process.env.FFPROBE_BINARY || 'ffprobe',
  });
  let expectedTrim = false;
  const jobs = {
    create: async (
      _owner,
      input,
      _requestId,
      _metadata,
      trimEnabled,
      serverTiming,
      extraData,
    ) => {
      assert.ok(serverTiming.startedAt instanceof Date);
      assert.ok(
        serverTiming.stages.some(
          (stage) =>
            stage.stage === 'source-download' &&
            stage.complete &&
            Number.isSafeInteger(stage.durationMs),
        ),
      );
      assert.equal(trimEnabled, expectedTrim);
      assert.equal(_metadata.sourceTitle, 'عنوان المصدر 🎵');
      assert.equal(input.sourceTitle, undefined);
      assert.equal(input.extraData, undefined);
      assert.equal(extraData.provider, 'fixture');
      assert.equal(extraData.title, 'عنوان المصدر 🎵');
      assert.equal(extraData.download_url, undefined);
      assert.equal(extraData.duration_seconds, input.durationSeconds);
      assert.equal(extraData.file_bytes, audio.length);
      assert.equal(input.extension, 'mp3');
      assert.equal(input.bytes, audio.length);
      assert.equal(input.sha256, checksum);
      assert.ok(input.durationSeconds > 0 && input.durationSeconds < 1);
      reservation = { _id: new Types.ObjectId(), inputObject: null };
      return {
        id: reservation._id.toHexString(),
        upload: {
          url: `${origin}/s3-input`,
          headers: {
            'Content-Type': input.contentType,
          },
        },
      };
    },
    confirmUpload: async () => {
      assert.equal(uploadBytes, audio.length);
      assert.equal(uploadChecksum, checksum);
      if (failureMode === 'confirmation')
        throw new Error('fixture confirmation failed');
      submissions++;
      reservation.inputObject = { fixture: true };
      if (failureMode === 'lost-response')
        throw new Error('fixture response lost after commit');
    },
  };
  const processor = new ImportProcessor(
    imports,
    new AudioAcquisitionClient(config),
    jobs,
    {
      cancelPendingUpload: async () => {
        cancellations++;
      },
    },
    config,
    {
      findOne: () => ({ lean: async () => reservation }),
      updateOne: async (_filter, update) => {
        assert.ok(reservation);
        reservation.importStageTimings = structuredClone(
          update.$set.importStageTimings,
        );
        return { matchedCount: 1 };
      },
    },
  );
  try {
    for (const mode of ['none', 'upload', 'confirmation', 'lost-response']) {
      failureMode = mode;
      reservation = null;
      const record = await records.create({
        userId: owner,
        requestId: randomUUID(),
        jobRequestId: randomUUID(),
        sourceUrl: 'https://soundcloud.com/artist/track',
        provider: 'soundcloud',
        trimEnabled: false,
      });
      await processor.process({ data: { importId: record._id.toHexString() } });
      const result = await records.findById(record._id).lean();
      assert.equal(result.sourceTitle, 'عنوان المصدر 🎵');
      assert.equal(
        (await imports.get(owner.toHexString(), record._id.toHexString()))
          .sourceTitle,
        'عنوان المصدر 🎵',
      );
      const accepted = mode === 'none' || mode === 'lost-response';
      assert.equal(result.status, accepted ? 'submitted' : 'failed');
      assert.ok(result.finishedAt instanceof Date);
      assert.ok(
        result.stageTimings.every(
          (stage) =>
            Number.isSafeInteger(stage.durationMs) && stage.durationMs >= 0,
        ),
      );
      assert.ok(
        result.stageTimings.some(
          (stage) => stage.stage === 'source-download' && stage.complete,
        ),
      );
      if (mode === 'none')
        assert.ok(
          reservation.importStageTimings.some(
            (stage) => stage.stage === 'upload-confirmation' && stage.complete,
          ),
        );
      if (mode === 'confirmation')
        assert.ok(
          result.stageTimings.some(
            (stage) => stage.stage === 'upload-confirmation' && !stage.complete,
          ),
        );
      if (accepted)
        assert.equal(result.jobId.toHexString(), reservation._id.toHexString());
      assert.deepEqual(await readdir(config.get('URL_IMPORT_TEMP_ROOT')), []);
      await processor.process({ data: { importId: record._id.toHexString() } });
    }
    assert.equal(submissions, 2);
    assert.equal(cancellations, 2);
    await context.test(
      'HTTP admission runs one queued acquisition and returns persisted validated timing',
      async () => {
        failureMode = 'none';
        reservation = null;
        expectedTrim = true;
        const initialAcquisitions = acquisitionRequests;
        class FixtureImportsModule {}
        Module({
          controllers: [ImportsController],
          providers: [
            { provide: ImportsService, useValue: imports },
            { provide: ConfigService, useValue: config },
          ],
        })(FixtureImportsModule);
        const app = await NestFactory.create(FixtureImportsModule, {
          bodyParser: false,
          logger: false,
          abortOnError: false,
        });
        let worker;
        let releaseDelivery;
        try {
          // Fixture identity only; production authentication has separate HTTP tests.
          app.use((req, res, next) => {
            if (req.headers.authorization !== 'Bearer fixture-owner-token') {
              res.sendStatus(401);
              return;
            }
            req.user = { _id: owner };
            next();
          });
          configureHttp(app);
          await app.listen(0, '127.0.0.1');
          const api = await app.getUrl();
          const body = {
            url: 'https://artist.tumblr.com/post/12345/title',
            request_id: randomUUID(),
          };
          // Admission must return while acquisition is still awaiting audio bytes.
          deliveryGate = new Promise((resolve) => {
            releaseDelivery = resolve;
          });
          worker = new Worker(IMPORT_QUEUE, (job) => processor.process(job), {
            connection: redis,
            prefix: 'isolated-imports',
            concurrency: 1,
          });
          const submit = () =>
            fetch(`${api}/media-imports`, {
              method: 'POST',
              headers: {
                Authorization: 'Bearer fixture-owner-token',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(5000),
            });
          const response = await submit();
          assert.equal(response.status, 202);
          const admitted = await response.json();
          assert.equal(admitted.status, 'queued');
          assert.equal(admitted.job_id, null);
          assert.equal(
            response.headers.get('location'),
            `/media-imports/${admitted.import_id}`,
          );
          assert.equal(response.headers.get('cache-control'), 'no-store');
          const replay = await submit();
          assert.equal(replay.status, 202);
          assert.equal((await replay.json()).import_id, admitted.import_id);
          releaseDelivery();
          await until(
            async () =>
              (await records.findById(admitted.import_id).lean())?.status ===
              'submitted',
            'HTTP import submission',
          );
          // Drain the worker before inspecting scratch; finish precedes finally cleanup.
          await worker.close();
          worker = undefined;
          const extended = await records.findById(admitted.import_id).lean();
          assert.equal(extended.provider, 'artist.tumblr.com');
          assert.equal(extended.sourceUrl, body.url);
          assert.equal(extended.input.bytes, audio.length);
          assert.equal(extended.input.sha256, checksum);
          assert.equal(extended.input.extension, 'mp3');
          assert.ok(extended.input.durationSeconds > 0);
          assert.equal(acquisitionRequests - initialAcquisitions, 1);
          assert.equal(submissions, 3);
          assert.deepEqual(
            await readdir(config.get('URL_IMPORT_TEMP_ROOT')),
            [],
          );
          const status = await fetch(
            `${api}${response.headers.get('location')}`,
            {
              headers: { Authorization: 'Bearer fixture-owner-token' },
              signal: AbortSignal.timeout(5000),
            },
          );
          assert.equal(status.status, 200);
          const presented = await status.json();
          assert.equal(presented.status, 'submitted');
          assert.equal(presented.job_id, reservation._id.toHexString());
          assert.equal(presented.server_stage_timings.total_complete, true);
          assert.ok(presented.server_stage_timings.total_ms >= 0);
          assert.deepEqual(
            presented.server_stage_timings.stages.map((stage) => stage.stage),
            [
              'import-queue',
              'source-download',
              'source-validation',
              'source-upload',
              'upload-confirmation',
            ],
          );
          assert.deepEqual(
            presented.server_stage_timings.stages,
            extended.stageTimings.map(({ stage, durationMs, complete }) => ({
              stage,
              duration_ms: durationMs,
              complete,
            })),
          );
          assert.ok(
            presented.server_stage_timings.stages.every(
              (stage) =>
                stage.complete &&
                Number.isSafeInteger(stage.duration_ms) &&
                stage.duration_ms >= 0,
            ),
          );
        } finally {
          releaseDelivery?.();
          await worker?.close();
          await app.close();
        }
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('simultaneous admissions allow a waiting backlog while enforcing owner isolation and the total boundary', async () => {
  const running = await records.create({
    userId: owner,
    requestId: randomUUID(),
    jobRequestId: randomUUID(),
    provider: 'youtube',
    sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    status: 'downloading',
    executionId: randomUUID(),
  });
  const requests = Array.from({ length: 109 }, () => randomUUID());
  const settled = await Promise.allSettled(
    requests.map((id) =>
      imports.create(owner.toHexString(), 'https://youtu.be/abcdefghijk', id),
    ),
  );
  assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 99);
  const failures = settled.filter((r) => r.status === 'rejected');
  assert.equal(failures.length, 10);
  assert.ok(
    failures.every((r) => r.reason.getResponse().code === 'IMPORT_QUEUE_FULL'),
  );
  assert.equal(await records.countDocuments({ status: 'queued' }), 99);
  assert.equal((await records.findById(running._id)).status, 'downloading');
  const first = await records.findOne({ status: 'queued' }).lean();
  const replay = await imports.create(
    owner.toHexString(),
    first.sourceUrl,
    first.requestId,
  );
  assert.equal(replay.importId, first._id.toHexString());
  await assert.rejects(
    imports.create(
      owner.toHexString(),
      'https://youtu.be/zyxwvutsrqp',
      first.requestId,
    ),
    (e) => e.getResponse().code === 'IMPORT_REQUEST_CONFLICT',
  );
  await assert.rejects(
    imports.get(new Types.ObjectId().toHexString(), first._id.toHexString()),
    (e) => e.getResponse().code === 'IMPORT_NOT_FOUND',
  );
  await records.updateOne({ _id: first._id }, { $set: { status: 'failed' } });
  await imports.create(owner.toHexString(), first.sourceUrl, randomUUID());
  assert.equal(await records.countDocuments({ status: 'queued' }), 99);
});

test('BullMQ starts at most five imports per second across replicas, runs twenty concurrently and releases queued work', async () => {
  const name = 'global-concurrency-fixture';
  const q = new Queue(name, { connection: redis, prefix: 'isolated-imports' });
  await q.setGlobalConcurrency(20);
  await q.setGlobalRateLimit(5, 1000);
  let active = 0,
    maximum = 0,
    started = 0;
  const releases = [];
  const starts = [];
  const process = async () => {
    active++;
    started++;
    starts.push(performance.now());
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => releases.push(resolve));
    active--;
  };
  const workers = [
    new Worker(name, process, {
      connection: redis,
      prefix: 'isolated-imports',
      concurrency: 20,
    }),
    new Worker(name, process, {
      connection: redis,
      prefix: 'isolated-imports',
      concurrency: 20,
    }),
  ];
  try {
    await q.addBulk(
      Array.from({ length: 25 }, (_, i) => ({ name: 'fixture', data: { i } })),
    );
    await until(() => started === 5, 'first five global starts');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(started, 5);
    await until(() => started === 20, 'twenty global slots');
    assert.equal(maximum, 20);
    assert.equal(await q.getWaitingCount(), 5);
    // Every group of five is paced by Redis, even with two independent workers.
    for (let i = 5; i < starts.length; i++)
      assert.ok(starts[i] - starts[i - 5] >= 950);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(started, 20);
    releases.shift()();
    await until(
      () => started === 21,
      'next ready import starts when a slot opens',
    );
    assert.equal(active, 20);
    while (started < 25 || active > 0) {
      const before = started;
      for (const release of releases.splice(0)) release();
      await until(
        () => started > before || active === 0,
        'release import slots',
      );
    }
    await until(async () => (await q.getCompletedCount()) === 25, 'completion');
    assert.equal(maximum, 20);
    assert.equal(await q.getDelayedCount(), 0);
  } finally {
    for (const release of releases) release();
    await Promise.all(workers.map((w) => w.close()));
    await q.close();
  }
});

test('recovery enqueues a durable outbox record and terminates an expired interrupted attempt', async () => {
  await records.updateMany(
    { status: 'queued' },
    { $set: { status: 'failed' } },
  );
  const base = {
    userId: owner,
    sourceUrl: 'https://soundcloud.com/artist/track',
    provider: 'soundcloud',
  };
  const pending = await records.create({
    ...base,
    requestId: randomUUID(),
    jobRequestId: randomUUID(),
  });
  const expired = await records.create({
    ...base,
    requestId: randomUUID(),
    jobRequestId: randomUUID(),
    status: 'downloading',
    executionId: randomUUID(),
    deadlineAt: new Date(Date.now() - 120000),
  });
  const active = await records.create({
    ...base,
    requestId: randomUUID(),
    jobRequestId: randomUUID(),
    status: 'downloading',
    executionId: randomUUID(),
    deadlineAt: new Date(Date.now() + 60000),
  });
  let releases = 0;
  const config = new ConfigService({
    URL_IMPORT_TEMP_ROOT: join(services.directory, 'recovery-audio'),
    URL_IMPORT_MIN_FREE_BYTES: 0,
    URL_IMPORT_MAX_OUTSTANDING: 20,
  });
  const processor = new ImportProcessor(
    imports,
    {},
    {},
    {
      cancelPendingUpload: async () => {
        releases++;
      },
    },
    config,
    { findOne: () => ({ lean: async () => null }) },
  );
  const runtime = new ImportRuntime(config, imports, processor, queue);
  await runtime.reconcile();
  assert.ok(await queue.getJob(pending._id.toHexString()));
  assert.equal((await records.findById(expired._id)).status, 'failed');
  assert.equal((await records.findById(active._id)).status, 'downloading');
  assert.equal(releases, 1);
  await runtime.reconcile();
  assert.equal(releases, 1);
});

test('stalled executions recover before deadline and preserve confirmed jobs without reacquisition', async () => {
  const prefix = `isolated-recovery-${randomUUID()}`;
  const recoveryQueue = new Queue(IMPORT_QUEUE, { connection: redis, prefix });
  const crashed = new Worker(IMPORT_QUEUE, async () => {}, {
    connection: redis,
    prefix,
    autorun: false,
    lockDuration: 1000,
  });
  let replacement;
  const interrupted = [];
  const confirmedId = new Types.ObjectId();
  let executions = 0,
    cancellations = 0;
  try {
    for (const status of [
      'downloading',
      'validating',
      'uploading',
      'uploading',
    ]) {
      const record = await records.create({
        userId: owner,
        requestId: randomUUID(),
        jobRequestId: randomUUID(),
        sourceUrl: 'https://youtu.be/aqz-KE-bpKQ',
        provider: 'youtube',
        status,
        executionId: randomUUID(),
        deadlineAt: new Date(Date.now() + 900000),
      });
      interrupted.push(record);
      await recoveryQueue.add(
        'import',
        { importId: record._id.toHexString() },
        {
          jobId: record._id.toHexString(),
          attempts: 1,
        },
      );
      assert.ok(await crashed.getNextJob(randomUUID()));
    }
    await crashed.close(true); // Simulate loss of the worker and its lock renewals.
    replacement = new Worker(
      IMPORT_QUEUE,
      async () => {
        executions++;
      },
      {
        connection: redis,
        prefix,
        stalledInterval: 1000,
        maxStalledCount: 0,
      },
    );
    await until(
      async () => (await recoveryQueue.getFailedCount()) === 4,
      'stalled import failures',
      15000,
    );
    const config = new ConfigService({
      URL_IMPORT_TEMP_ROOT: join(services.directory, 'terminal-recovery-audio'),
      URL_IMPORT_MIN_FREE_BYTES: 0,
      URL_IMPORT_MAX_OUTSTANDING: 100,
    });
    const processor = new ImportProcessor(
      imports,
      {},
      {},
      {
        cancelPendingUpload: async () => {
          cancellations++;
        },
      },
      config,
      {
        findOne: (filter) => ({
          lean: async () =>
            filter.requestId === interrupted[3].jobRequestId
              ? {
                  _id: confirmedId,
                  inputObject: { key: 'synthetic-confirmed-input' },
                }
              : null,
        }),
      },
    );
    // Limit the recovery read to this test's records, retaining real Mongo writes.
    const scoped = Object.create(imports);
    scoped.records = {
      find: () =>
        records.find({
          _id: { $in: interrupted.map((r) => r._id) },
          status: { $in: ['downloading', 'validating', 'uploading'] },
        }),
    };
    const runtime = new ImportRuntime(config, scoped, processor, recoveryQueue);
    await runtime.reconcile();
    for (const record of interrupted.slice(0, 3)) {
      const result = await records.findById(record._id).lean();
      assert.equal(result.status, 'failed');
      assert.equal(result.error.code, 'IMPORT_DEPENDENCY_FAILED');
      assert.ok(result.finishedAt < result.deadlineAt);
    }
    const confirmed = await records.findById(interrupted[3]._id).lean();
    assert.equal(confirmed.status, 'submitted');
    assert.equal(confirmed.jobId.toHexString(), confirmedId.toHexString());
    assert.equal(cancellations, 3);
    assert.equal(executions, 0);
    await runtime.reconcile();
    assert.equal(cancellations, 3);
  } finally {
    await crashed.close(true);
    await replacement?.close();
    await recoveryQueue.close();
  }
});

test('trim choice persists and participates in import idempotency', async () => {
  const requestId = randomUUID();
  const url = 'https://youtu.be/UXqq0ZvbOnk';
  const result = await imports.create(
    owner.toHexString(),
    url,
    requestId,
    false,
  );
  const stored = await records.findById(result.importId).lean();
  assert.equal(stored.trimEnabled, false);
  assert.equal(
    (await imports.create(owner.toHexString(), url, requestId, false)).importId,
    result.importId,
  );
  await assert.rejects(
    imports.create(owner.toHexString(), url, requestId, true),
    (error) => error.getResponse().code === 'IMPORT_REQUEST_CONFLICT',
  );
});

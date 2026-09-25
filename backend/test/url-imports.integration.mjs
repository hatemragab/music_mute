import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
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
import { YtdlpClient } from '../dist/url-imports/ytdlp-client.js';
import { ImportProcessor } from '../dist/url-imports/import-processor.js';
import { ImportRuntime } from '../dist/url-imports/import-runtime.js';
import {
  ProcessingAdmissionFence,
  ProcessingAdmissionFenceSchema,
} from '../dist/admin-settings/processing-settings.schema.js';

let services, connection, queue, records, imports, redis;
const owner = new Types.ObjectId();
const usage = {
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
      URL_IMPORT_MAX_OUTSTANDING: 20,
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

test('native acquisition cleans upload/finalization failures and preserves committed confirmation', async () => {
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
  let failureMode = 'none',
    uploadBytes = 0,
    submissions = 0,
    cancellations = 0,
    reservation;
  let origin;
  const server = createServer(async (req, res) => {
    if (req.method === 'POST') {
      for await (const _chunk of req) {
        /* consume only fixture request */
      }
      assert.equal(req.url, '/audio-imports');
      assert.equal(req.headers.authorization, 'Bearer fixture-key');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(audio.length));
      res.setHeader(
        'X-Import-Title-Base64',
        Buffer.from('عنوان المصدر 🎵').toString('base64'),
      );
      res.end(audio);
    } else if (req.method === 'PUT') {
      uploadBytes = 0;
      for await (const chunk of req) uploadBytes += chunk.length;
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
    YTDLP_API_URL: `${origin}/`,
    YTDLP_API_KEY: 'fixture-key',
    URL_IMPORT_TEMP_ROOT: join(services.directory, 'import-audio'),
    URL_IMPORT_MIN_FREE_BYTES: 0,
    URL_IMPORT_FFPROBE_PATH: process.env.FFPROBE_BINARY || 'ffprobe',
  });
  let expectedTrim = false;
  const jobs = {
    create: async (_owner, input, _requestId, _metadata, trimEnabled) => {
      assert.equal(trimEnabled, expectedTrim);
      assert.equal(_metadata.sourceTitle, 'عنوان المصدر 🎵');
      assert.equal(input.sourceTitle, undefined);
      assert.equal(input.extension, 'mp3');
      assert.equal(input.bytes, audio.length);
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
    new YtdlpClient(config),
    jobs,
    {
      cancelPendingUpload: async () => {
        cancellations++;
      },
    },
    config,
    { findOne: () => ({ lean: async () => reservation }) },
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
      if (accepted)
        assert.equal(result.jobId.toHexString(), reservation._id.toHexString());
      assert.deepEqual(await readdir(config.get('URL_IMPORT_TEMP_ROOT')), []);
      await processor.process({ data: { importId: record._id.toHexString() } });
    }
    assert.equal(submissions, 2);
    assert.equal(cancellations, 2);
    failureMode = 'none';
    reservation = null;
    expectedTrim = true;
    const admitted = await imports.create(
      owner.toHexString(),
      'https://artist.tumblr.com/post/12345/title',
      randomUUID(),
    );
    await processor.process({ data: { importId: admitted.importId } });
    const extended = await records.findById(admitted.importId).lean();
    assert.equal(extended.provider, 'artist.tumblr.com');
    assert.equal(
      extended.sourceUrl,
      'https://artist.tumblr.com/post/12345/title',
    );
    assert.equal(extended.status, 'submitted');
    assert.equal(submissions, 3);
    assert.deepEqual(await readdir(config.get('URL_IMPORT_TEMP_ROOT')), []);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('simultaneous admissions enforce the global outstanding boundary and owner isolation', async () => {
  const requests = Array.from({ length: 30 }, () => randomUUID());
  const settled = await Promise.allSettled(
    requests.map((id) =>
      imports.create(owner.toHexString(), 'https://youtu.be/abcdefghijk', id),
    ),
  );
  assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 20);
  const failures = settled.filter((r) => r.status === 'rejected');
  assert.equal(failures.length, 10);
  assert.ok(
    failures.every((r) => r.reason.getResponse().code === 'IMPORT_QUEUE_FULL'),
  );
  assert.equal(await records.countDocuments({ status: 'queued' }), 20);
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
  assert.equal(await records.countDocuments({ status: 'queued' }), 20);
});

test('BullMQ enforces global concurrency across two processors without job delays', async () => {
  const name = 'global-concurrency-fixture';
  const q = new Queue(name, { connection: redis, prefix: 'isolated-imports' });
  await q.setGlobalConcurrency(2);
  let active = 0,
    maximum = 0,
    started = 0;
  const releases = [];
  const process = async () => {
    active++;
    started++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => releases.push(resolve));
    active--;
  };
  const workers = [
    new Worker(name, process, {
      connection: redis,
      prefix: 'isolated-imports',
      concurrency: 4,
    }),
    new Worker(name, process, {
      connection: redis,
      prefix: 'isolated-imports',
      concurrency: 4,
    }),
  ];
  try {
    await q.addBulk(
      Array.from({ length: 5 }, (_, i) => ({ name: 'fixture', data: { i } })),
    );
    await until(() => started === 2, 'two global slots');
    assert.equal(maximum, 2);
    releases.shift()();
    await until(() => started === 3, 'next ready import starts immediately');
    assert.equal(active, 2);
    while (started < 5 || active > 0) {
      const before = started;
      for (const release of releases.splice(0)) release();
      await until(
        () => started > before || active === 0,
        'release import slots',
      );
    }
    await until(async () => (await q.getCompletedCount()) === 5, 'completion');
    assert.equal(maximum, 2);
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

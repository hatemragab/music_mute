import 'reflect-metadata';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { createConnection, mongo, Types } from 'mongoose';
import {
  AccountPolicy,
  AccountPolicySchema,
  AccountPolicyOverride,
  AccountPolicyOverrideSchema,
  DEFAULT_ACCOUNT_POLICY_VALUES,
  STANDARD_ACCOUNT_POLICY_ID,
} from '../dist/admin-settings/account-policy.schema.js';
import { AccountPolicyService } from '../dist/admin-settings/account-policy.service.js';
import { ProcessingAdmissionService } from '../dist/admin-settings/processing-admission.service.js';
import { JobActionsService } from '../dist/jobs/job-actions.service.js';
import { JobDeletionService } from '../dist/jobs/job-deletion.service.js';
import { JobsService } from '../dist/jobs/jobs.service.js';
import {
  DEFAULT_WORKER_RECIPE_ID,
  workerRecipeSnapshot,
} from '../dist/jobs/worker-recipes.js';
import { ProcessingUsageService } from '../dist/processing-usage/processing-usage.service.js';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { safeProcessingFailure } from '../dist/processing/processing-diagnostics.js';
import {
  communitySourceKey,
  sharedResultKey,
  sharedSourceKey,
} from '../dist/shared-media/shared-media-key.js';
import { SharedMediaService } from '../dist/shared-media/shared-media.service.js';
import { SharedMediaCatalogService } from '../dist/shared-media/shared-media-catalog.service.js';
import { validComparisonRanges } from '../dist/jobs/comparison-ranges.js';
import { JobRenditionService } from '../dist/worker-fleet/attempts/job-rendition.service.js';
import { WorkerAttemptService } from '../dist/worker-fleet/attempts/worker-attempt.service.js';
import { WorkerAttemptSchema } from '../dist/worker-fleet/jobs/worker-attempt.schema.js';
import { WorkerSlotSchema } from '../dist/worker-fleet/machines/worker-slot.schema.js';
import { WorkerRecoveryService } from '../dist/worker-fleet/leases/worker-recovery.service.js';
import { StorageCleanupTaskSchema } from '../dist/storage/storage-cleanup-task.schema.js';
import { StorageCleanupService } from '../dist/storage/storage-cleanup.service.js';
import { AccountDeletionCleanupService } from '../dist/users/account-deletion-cleanup.service.js';
import { ImportProcessor } from '../dist/url-imports/import-processor.js';
import { ImportRuntime } from '../dist/url-imports/import-runtime.js';
import { importError } from '../dist/url-imports/import-errors.js';
import { importExecutionJobId } from '../dist/url-imports/import-retry.js';
import {
  IMPORT_QUEUE,
  ImportsService,
} from '../dist/url-imports/imports.service.js';
import {
  ACTIVE_IMPORT_STATES,
  MediaImportSchema,
} from '../dist/url-imports/media-import.schema.js';
import { accountFixture } from './helpers/account-fixture.mjs';
import { IsolatedServices } from './helpers/isolated-services.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('base64');
const videoUrls = [
  'https://www.youtube.com/watch?v=bZxrIoCPsOc&list=RDbZxrIoCPsOc&start_radio=1',
  'https://youtu.be/bZxrIoCPsOc?si=RLbbOevlM4lBmXHi',
  'https://m.youtube.com/shorts/bZxrIoCPsOc?t=30&feature=share',
];

test('shared URL media deduplicates acquisition, processing and retained objects across accounts', async (t) => {
  const native = await IsolatedServices.create();
  let connection, queue, uploadServer;
  t.after(async () => {
    if (uploadServer) {
      uploadServer.closeAllConnections();
      await new Promise((resolve) => uploadServer.close(resolve));
    }
    await queue?.close();
    await connection?.close();
    await native.stop();
  });
  const { mongoUri, redisPort } = await native.startDatabases({
    replicaSet: true,
  });
  connection = await createConnection(mongoUri).asPromise();
  for (const { name, schema } of PROCESSING_MODELS)
    connection.model(name, schema);
  connection.model('WorkerAttempt', WorkerAttemptSchema);
  connection.model('WorkerSlot', WorkerSlotSchema);
  const records = connection.model('MediaImport', MediaImportSchema);
  const cleanupTasks = connection.model(
    'StorageCleanupTask',
    StorageCleanupTaskSchema,
  );
  const owners = Array.from({ length: 5 }, () => new Types.ObjectId());
  const cacheOwners = Array.from({ length: 3 }, () => new Types.ObjectId());
  const accounts = await accountFixture(
    connection,
    [...owners, ...cacheOwners].map(String),
  );
  await Promise.all(
    Object.values(connection.models).map((model) => model.init()),
  );
  const model = (name) => connection.model(name);
  const jobRecords = model('Job');
  const transactions = new ProcessingTransactions(connection);
  const policies = {
    effective: async () => ({
      values: DEFAULT_ACCOUNT_POLICY_VALUES,
      acceptNewJobs: true,
      globalRevision: 1,
      overrideRevision: null,
    }),
    touchGlobalFence: async () => {},
  };
  const config = new ConfigService({
    AUDIO_PROCESSING_ENABLED: true,
    PROCESSING_URL_SECONDS: 900,
    URL_IMPORT_ENABLED: true,
    URL_IMPORT_MAX_OUTSTANDING: 20,
    URL_IMPORT_MIN_FREE_BYTES: 0,
    URL_IMPORT_TEMP_ROOT: join(native.directory, 'imports'),
    URL_IMPORT_FFPROBE_PATH: process.env.FFPROBE_BINARY || 'ffprobe',
  });
  const usage = new ProcessingUsageService(
    model('AccountUsagePeriod'),
    model('AccountDailyUsagePeriod'),
    model('ProcessingReservation'),
    model('UploadGrantReceipt'),
    model('DownloadGrantReceipt'),
    model('ServiceUsagePeriod'),
    jobRecords,
    accounts.users,
    policies,
    config,
  );
  const admission = new ProcessingAdmissionService(
    model('ProcessingAdmissionFence'),
    accounts.users,
    jobRecords,
    policies,
    usage,
    config,
  );

  // Synthetic local MP3, mock provider, and a loopback R2 transfer fixture only.
  const mp3Path = join(native.directory, 'source.mp3');
  await promisify(execFile)(process.env.FFMPEG_BINARY || 'ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=0.25',
    '-codec:a',
    'libmp3lame',
    mp3Path,
  ]);
  const audio = await readFile(mp3Path);
  const objects = new Map();
  const uploadReservations = new Map();
  const copies = [];
  const deletes = [];
  let providerCalls = 0;
  let acquisitionFailureCode = null;
  const acquisitionExecutions = [];
  let sourceUploads = 0;
  let localUploadGrants = 0;
  let recoveryHeads = 0;
  let loseNextUploadResponse = false;
  uploadServer = createServer(async (request, response) => {
    try {
      const reservation = uploadReservations.get(request.url);
      assert.equal(request.method, 'PUT');
      assert.ok(reservation);
      const intent = await model('SharedMediaArtifact')
        .findById(reservation.key)
        .lean();
      assert.ok(intent, 'the durable artifact intent precedes its PUT');
      assert.deepEqual(intent.reservation, reservation);
      assert.equal(intent.object, null);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      assert.equal(bytes.length, reservation.bytes);
      assert.equal(digest(bytes), reservation.sha256);
      assert.equal(request.headers['content-type'], reservation.contentType);
      sourceUploads++;
      objects.set(reservation.key, {
        key: reservation.key,
        bytes: bytes.length,
        contentType: reservation.contentType,
        sha256: digest(bytes),
        etag: `"source-${sourceUploads}"`,
      });
      if (loseNextUploadResponse) {
        loseNextUploadResponse = false;
        request.socket.destroy();
        return;
      }
      response.writeHead(200).end();
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise((resolve) => uploadServer.listen(0, '127.0.0.1', resolve));
  const storage = {
    createWorkerOutputGrant: async (reservation) => {
      const path = `/upload/${randomUUID()}`;
      uploadReservations.set(path, reservation);
      return {
        url: `http://127.0.0.1:${uploadServer.address().port}${path}`,
        headers: { 'Content-Type': reservation.contentType },
      };
    },
    verifyInput: async (job) => {
      const identity = objects.get(job.inputReservation.key);
      assert.ok(identity);
      assert.equal(identity.bytes, job.inputReservation.bytes);
      assert.equal(identity.sha256, job.inputReservation.sha256);
      return identity;
    },
    findUploadedObject: async (reservation) => {
      recoveryHeads++;
      const identity = objects.get(reservation.key);
      if (!identity) return null;
      assert.equal(identity.bytes, reservation.bytes);
      assert.equal(identity.sha256, reservation.sha256);
      assert.equal(identity.contentType, reservation.contentType);
      return identity;
    },
    verifyUploadedObject: async (reservation, etag) => {
      const identity = objects.get(reservation.key);
      assert.ok(identity);
      assert.equal(identity.etag, etag);
      assert.equal(identity.bytes, reservation.bytes);
      assert.equal(identity.sha256, reservation.sha256);
      return identity;
    },
    copyObject: async (source, key) => {
      assert.deepEqual(objects.get(source.key), source);
      const intent = await model('SharedMediaArtifact').findById(key).lean();
      assert.ok(intent, 'the durable artifact intent precedes its COPY');
      assert.equal(intent.kind, key.includes('/input/') ? 'input' : 'output');
      assert.equal(intent.object, null);
      assert.equal(
        objects.has(key),
        false,
        'publication uses a fresh immutable key',
      );
      copies.push({ source, key });
      const copied = { ...source, key, etag: `"copy-${copies.length}"` };
      objects.set(key, copied);
      return copied;
    },
    deleteObject: async (key) => {
      deletes.push(key);
      objects.delete(key);
    },
    createInputGrant: async (job) => {
      localUploadGrants++;
      assert.match(job.inputReservation.key, /^users\/[a-f0-9]{24}\/jobs\//);
      return { url: 'http://127.0.0.1/fixture-private-upload', headers: {} };
    },
  };
  const cleanup = new StorageCleanupService(cleanupTasks, storage);
  const shared = new SharedMediaService(
    model('SharedMediaSource'),
    model('SharedMediaResult'),
    records,
    jobRecords,
    storage,
    transactions,
    model('SharedMediaArtifact'),
  );
  const jobs = new JobsService(
    jobRecords,
    storage,
    transactions,
    accounts.access,
    admission,
    usage,
    cleanup,
  );
  const actions = new JobActionsService(
    jobRecords,
    transactions,
    accounts.access,
    admission,
    usage,
  );
  queue = new Queue(IMPORT_QUEUE, {
    connection: { host: '127.0.0.1', port: redisPort },
    prefix: `shared-media-${randomUUID()}`,
  });
  const imports = new ImportsService(
    records,
    model('ProcessingAdmissionFence'),
    transactions,
    accounts.access,
    usage,
    config,
    queue,
    { assertAllowed: async () => {} },
    shared,
    jobs,
  );
  await imports.initialize();
  const processor = new ImportProcessor(
    imports,
    {
      download: async (url, _files, path, _limits, _signal, executionId) => {
        if (providerCalls === 0)
          assert.equal(url, 'https://www.youtube.com/watch?v=bZxrIoCPsOc');
        providerCalls++;
        acquisitionExecutions.push(executionId);
        if (acquisitionFailureCode) throw importError(acquisitionFailureCode);
        await writeFile(path, audio);
        return {
          bytes: audio.length,
          sha256: digest(audio),
          extension: 'mp3',
          contentType: 'audio/mpeg',
          sourceTitle: 'Synthetic shared source',
          extraData: null,
        };
      },
    },
    jobs,
    actions,
    config,
    jobRecords,
    shared,
  );
  await processor.files.initialize();
  const runtime = new ImportRuntime(config, imports, processor, queue, shared);
  const processImport = (record) =>
    processor.process({
      data: {
        importId: String(record._id),
        attempt: (record.acquisitionAttempt ?? 0) + 1,
      },
    });
  let producer, waiter, producerJob, cachedJob, source, result, sharedOutput;

  const cacheSideEffects = async () => ({
    persisted: Object.fromEntries(
      await Promise.all(
        Object.entries(connection.models)
          // Active-account checks intentionally advance the User access fence.
          .filter(([name]) => name !== 'User')
          .map(async ([name, registered]) => [
            name,
            await registered.find().sort({ _id: 1 }).lean(),
          ]),
      ),
    ),
    queued: await queue.getJobCounts(),
    providerCalls,
    sourceUploads,
    localUploadGrants,
    recoveryHeads,
    copies: [...copies],
    deletes: [...deletes],
    objects: new Map(objects),
    uploadReservations: new Map(uploadReservations),
  });

  await t.test(
    'a cache-only miss creates no import, catalog, usage, queue or media work',
    async () => {
      const before = await cacheSideEffects();
      await assert.rejects(
        imports.create(
          String(cacheOwners[0]),
          videoUrls[0],
          randomUUID(),
          true,
          true,
        ),
        (error) =>
          error.getStatus?.() === 404 &&
          error.getResponse?.().code === 'IMPORT_CACHE_MISS',
      );
      assert.deepEqual(await cacheSideEffects(), before);
    },
  );

  await t.test(
    'canonical URLs and concurrent accounts have one acquisition and one producer',
    async () => {
      assert.equal(new Set(videoUrls.map(sharedSourceKey)).size, 1);
      const submitted = await Promise.all(
        owners
          .slice(0, 2)
          .map((owner, index) =>
            imports.create(String(owner), videoUrls[index], randomUUID()),
          ),
      );
      assert.equal(await model('SharedMediaSource').countDocuments(), 1);
      assert.equal(await model('SharedMediaResult').countDocuments(), 1);
      source = await model('SharedMediaSource').findOne().lean();
      producer = await records.findById(source.producerImportId).lean();
      waiter = await records
        .findOne({
          _id: {
            $in: submitted.map((item) => new Types.ObjectId(item.importId)),
            $ne: producer._id,
          },
        })
        .lean();
      assert.equal(producer.sharedSourceKey, waiter.sharedSourceKey);
      assert.equal(producer.sharedResultKey, waiter.sharedResultKey);
      assert.equal(
        producer.sourceUrl,
        'https://www.youtube.com/watch?v=bZxrIoCPsOc',
      );
      assert.equal(waiter.sourceUrl, producer.sourceUrl);
      await imports.enqueue(String(producer._id));
      await imports.enqueue(String(waiter._id));
      assert.ok(await queue.getJob(importExecutionJobId(producer)));
      assert.equal(await queue.getJob(importExecutionJobId(waiter)), undefined);
      assert.equal((await shared.inspect(waiter)).action, 'wait');

      await processImport(producer);
      producer = await records.findById(producer._id).lean();
      assert.equal(producer.status, 'submitted');
      producerJob = await jobRecords.findById(producer.jobId).lean();
      assert.equal(producerJob.status, 'queued');
      assert.equal(providerCalls, 1);
      assert.equal(sourceUploads, 1);
      assert.equal(localUploadGrants, 0);
      source = await model('SharedMediaSource')
        .findById(producer.sharedSourceKey)
        .lean();
      assert.equal(source.state, 'ready');
      assert.deepEqual(producerJob.inputObject, source.inputObject);
      assert.equal((await shared.inspect(waiter)).action, 'wait');
      await runtime.enqueueSharedImports();
      assert.equal(
        await queue.getJob(importExecutionJobId(waiter)),
        undefined,
        'original audio alone does not unblock the same-recipe waiter',
      );
    },
  );

  await t.test(
    'output publication copies once and completion commits with the owning job',
    async () => {
      const workerBytes = Buffer.alloc(2048, 7);
      const workerOutput = {
        key: `users/${producerJob.userId}/jobs/${producerJob._id}/attempts/${randomUUID()}/vocals.mp3`,
        bytes: workerBytes.length,
        sha256: digest(workerBytes),
        contentType: 'audio/mpeg',
        etag: '"worker-output"',
      };
      objects.set(workerOutput.key, workerOutput);
      sharedOutput = await shared.publishOutput(producerJob, workerOutput);
      assert.deepEqual(
        await shared.publishOutput(producerJob, workerOutput),
        sharedOutput,
      );
      assert.equal(copies.length, 1);
      assert.notEqual(sharedOutput.key, workerOutput.key);

      const ranges = [[0, Math.floor(source.input.durationSeconds * 44100)]];
      await assert.rejects(
        transactions.run(async (session) => {
          await shared.completeResult(
            producerJob,
            sharedOutput,
            ranges,
            session,
          );
          await jobRecords.updateOne(
            { _id: producerJob._id },
            { $set: { status: 'ready', outputObject: sharedOutput } },
            { session },
          );
          throw new Error('intentional completion abort');
        }),
        /intentional completion abort/,
      );
      assert.equal(
        (await model('SharedMediaResult').findById(producer.sharedResultKey))
          .state,
        'processing',
      );
      assert.equal(
        (await jobRecords.findById(producerJob._id)).status,
        'queued',
      );

      await transactions.run(async (session) => {
        await shared.completeResult(producerJob, sharedOutput, ranges, session);
        await usage.recordRetainedOutput(
          producerJob,
          sharedOutput.bytes + source.inputObject.bytes,
          session,
        );
        await jobRecords.updateOne(
          { _id: producerJob._id, status: 'queued' },
          {
            $set: {
              status: 'ready',
              outputObject: sharedOutput,
              comparisonRanges: ranges,
              retainedOutputAccountedAt: new Date(),
              retainedInputBytes: source.inputObject.bytes,
              finishedAt: new Date(),
              retryEligibility: {
                eligible: false,
                attemptsRemaining: 0,
                nextAttemptAt: null,
              },
            },
            $inc: { revision: 1 },
          },
          { session, runValidators: true },
        );
        await usage.settleJob({ ...producerJob, status: 'ready' }, session);
      });
      producerJob = await jobRecords.findById(producerJob._id).lean();
      result = await model('SharedMediaResult')
        .findById(producer.sharedResultKey)
        .lean();
      assert.equal(result.state, 'ready');
      assert.deepEqual(result.outputObject, producerJob.outputObject);
      assert.equal((await shared.inspect(waiter)).action, 'result');
    },
  );

  await t.test(
    'cached jobs share exact identities with no processing reservation, upload or duplicate replay charge',
    async () => {
      await runtime.enqueueSharedImports();
      assert.equal(await queue.getJob(importExecutionJobId(waiter)), undefined);
      await processImport(waiter);
      waiter = await records.findById(waiter._id).lean();
      assert.equal(waiter.status, 'submitted');
      cachedJob = await jobRecords.findById(waiter.jobId).lean();
      assert.equal(cachedJob.status, 'ready');
      assert.notEqual(String(cachedJob._id), String(producerJob._id));
      assert.deepEqual(cachedJob.inputObject, producerJob.inputObject);
      assert.deepEqual(cachedJob.outputObject, producerJob.outputObject);
      assert.deepEqual(
        cachedJob.comparisonRanges,
        producerJob.comparisonRanges,
      );
      assert.equal(
        await model('ProcessingReservation').countDocuments({
          accountId: waiter.userId,
        }),
        0,
      );
      assert.equal(
        await model('UploadGrantReceipt').countDocuments({
          accountId: waiter.userId,
        }),
        0,
      );
      const cachedUsage = await usage.readUsage(waiter.userId);
      assert.equal(cachedUsage.processing.usedSeconds, 0);
      assert.equal(cachedUsage.processing.reservedSeconds, 0);
      assert.equal(cachedUsage.uploads.monthlyGrants, 0);
      assert.equal(cachedUsage.uploads.confirmedBytes, 0);
      assert.equal(
        cachedUsage.storage.retainedBytes,
        source.inputObject.bytes + sharedOutput.bytes,
      );

      const replay = await imports.create(
        String(waiter.userId),
        videoUrls[2],
        waiter.requestId,
      );
      assert.equal(replay.importId, String(waiter._id));
      await processImport(waiter);
      const cachedInput = {
        input: source.input,
        inputObject: source.inputObject,
        outputObject: result.outputObject,
        recipeSnapshot: result.recipeSnapshot,
        comparisonRanges: result.comparisonRanges,
        sourceKey: source._id,
        resultKey: result._id,
        metadata: {
          policyVersion: 2,
          preparationProfileId: 'audio-cap-aac-lc-160-v1',
          source: 'youtube',
          sourceKind: 'url',
          sourceUrl: waiter.sourceUrl,
          sourceTitle: source.sourceTitle,
          extraData: source.extraData,
        },
      };
      const repeatedJobs = await Promise.all([
        jobs.createFromCache(
          String(waiter.userId),
          waiter.jobRequestId,
          cachedInput,
        ),
        jobs.createFromCache(
          String(waiter.userId),
          waiter.jobRequestId,
          cachedInput,
        ),
      ]);
      assert.ok(
        repeatedJobs.every((job) => job.jobId === String(cachedJob._id)),
      );
      assert.equal(
        await jobRecords.countDocuments({ userId: waiter.userId }),
        1,
      );
      assert.equal(
        (await usage.readUsage(waiter.userId)).storage.retainedBytes,
        cachedUsage.storage.retainedBytes,
      );

      // Recover the owned job when its durable import update was interrupted.
      await records.updateOne(
        { _id: waiter._id },
        { $set: { status: 'queued', jobId: null, finishedAt: null } },
      );
      await imports.enqueue(String(waiter._id));
      waiter = await records.findById(waiter._id).lean();
      assert.equal(waiter.status, 'submitted');
      assert.equal(String(waiter.jobId), String(cachedJob._id));
      assert.equal(await queue.getJob(importExecutionJobId(waiter)), undefined);
      assert.equal(
        await jobRecords.countDocuments({ userId: waiter.userId }),
        1,
      );
      assert.equal(
        (await usage.readUsage(waiter.userId)).storage.retainedBytes,
        cachedUsage.storage.retainedBytes,
      );
      assert.equal(providerCalls, 1);
      assert.equal(sourceUploads, 1);
      assert.equal(copies.length, 1);
    },
  );

  await t.test(
    'a cache-only recipe miss leaves the ready source and catalog untouched',
    async () => {
      const before = await cacheSideEffects();
      await assert.rejects(
        imports.create(
          String(cacheOwners[0]),
          videoUrls[1],
          randomUUID(),
          false,
          true,
        ),
        (error) =>
          error.getStatus?.() === 404 &&
          error.getResponse?.().code === 'IMPORT_CACHE_MISS',
      );
      assert.deepEqual(await cacheSideEffects(), before);
    },
  );

  await t.test(
    'ready aliases deliver immediately to other owners with imports disabled, a full queue and unavailable Redis enqueue',
    async (st) => {
      const blocker = await records.create({
        userId: cacheOwners[2],
        requestId: randomUUID(),
        jobRequestId: randomUUID(),
        provider: 'youtube',
        sourceUrl: 'https://www.youtube.com/watch?v=full-queue1',
        status: 'queued',
      });
      const maxOutstanding = config.get('URL_IMPORT_MAX_OUTSTANDING');
      const importEnabled = config.get('URL_IMPORT_ENABLED');
      const add = queue.add;
      let enqueueCalls = 0;
      st.after(async () => {
        config.set('URL_IMPORT_MAX_OUTSTANDING', maxOutstanding);
        config.set('URL_IMPORT_ENABLED', importEnabled);
        queue.add = add;
        await records.deleteOne({ _id: blocker._id });
      });
      const outstanding = await records.countDocuments({
        status: { $in: ACTIVE_IMPORT_STATES },
      });
      assert.ok(outstanding > 0);
      config.set('URL_IMPORT_MAX_OUTSTANDING', outstanding);
      config.set('URL_IMPORT_ENABLED', false);
      queue.add = async () => {
        enqueueCalls++;
        throw new Error('fixture Redis enqueue unavailable');
      };
      const before = await cacheSideEffects();
      const requests = [randomUUID(), randomUUID()];
      const delivered = await Promise.all(
        cacheOwners
          .slice(0, 2)
          .map((owner, index) =>
            imports.create(
              String(owner),
              videoUrls[index],
              requests[index],
              true,
              index === 1,
            ),
          ),
      );
      for (const [index, delivery] of delivered.entries()) {
        assert.equal(delivery.status, 'submitted');
        assert.equal(delivery.sourceUrl, source.sourceUrl);
        const imported = await records.findById(delivery.importId).lean();
        const ownedJob = await jobRecords.findById(delivery.jobId).lean();
        assert.equal(String(ownedJob.userId), String(cacheOwners[index]));
        assert.equal(ownedJob.status, 'ready');
        assert.deepEqual(ownedJob.inputObject, producerJob.inputObject);
        assert.deepEqual(ownedJob.outputObject, producerJob.outputObject);
        assert.equal(ownedJob.sharedSourceKey, source._id);
        assert.equal(ownedJob.sharedResultKey, result._id);
        assert.equal(imported.acquisitionAttempt, 0);
        assert.equal(imported.acquisitionStartedAt, null);
        assert.equal(ownedJob.attemptNumber, 0);
        assert.equal(ownedJob.currentExecution, null);
        assert.equal(
          await model('ProcessingReservation').countDocuments({
            accountId: cacheOwners[index],
          }),
          0,
        );
        assert.equal(
          await model('UploadGrantReceipt').countDocuments({
            accountId: cacheOwners[index],
          }),
          0,
        );
        const retained = await usage.readUsage(cacheOwners[index]);
        assert.equal(retained.processing.usedSeconds, 0);
        assert.equal(retained.processing.reservedSeconds, 0);
        assert.equal(retained.uploads.monthlyGrants, 0);
        assert.equal(retained.uploads.confirmedBytes, 0);
        assert.equal(
          retained.storage.retainedBytes,
          source.inputObject.bytes + sharedOutput.bytes,
        );
        const replay = await imports.create(
          String(cacheOwners[index]),
          videoUrls[1 - index],
          requests[index],
          true,
          true,
        );
        assert.equal(replay.importId, delivery.importId);
        assert.equal(replay.jobId, delivery.jobId);
        assert.equal(
          (await usage.readUsage(cacheOwners[index])).storage.retainedBytes,
          retained.storage.retainedBytes,
        );
      }
      assert.notEqual(delivered[0].jobId, delivered[1].jobId);
      assert.equal(enqueueCalls, 0);
      const after = await cacheSideEffects();
      assert.deepEqual(after.queued, before.queued);
      for (const key of [
        'providerCalls',
        'sourceUploads',
        'localUploadGrants',
        'recoveryHeads',
        'copies',
        'deletes',
        'objects',
        'uploadReservations',
      ])
        assert.deepEqual(after[key], before[key], key);
      for (const name of [
        'SharedMediaSource',
        'SharedMediaResult',
        'SharedMediaArtifact',
      ])
        assert.deepEqual(after.persisted[name], before.persisted[name], name);
    },
  );

  await t.test(
    'a different trim recipe processes the existing original without another paid acquisition',
    async () => {
      const submitted = await imports.create(
        String(owners[2]),
        videoUrls[1],
        randomUUID(),
        false,
      );
      const variant = await records.findById(submitted.importId).lean();
      assert.equal(variant.sharedSourceKey, producer.sharedSourceKey);
      assert.notEqual(variant.sharedResultKey, producer.sharedResultKey);
      assert.equal((await shared.inspect(variant)).action, 'source');
      await processImport(variant);
      const completedImport = await records.findById(variant._id).lean();
      assert.equal(completedImport.status, 'submitted');
      const variantJob = await jobRecords
        .findById(completedImport.jobId)
        .lean();
      assert.equal(variantJob.status, 'queued');
      assert.equal(variantJob.recipeSnapshot.trimEnabled, false);
      assert.notEqual(
        variantJob.recipeSnapshot.recipeDigest,
        producerJob.recipeSnapshot.recipeDigest,
      );
      assert.deepEqual(variantJob.inputObject, source.inputObject);
      assert.equal(providerCalls, 1);
      assert.equal(sourceUploads, 1);
      assert.equal(copies.length, 1);
      assert.equal(await model('SharedMediaSource').countDocuments(), 1);
      assert.equal(await model('SharedMediaResult').countDocuments(), 2);
    },
  );

  await t.test(
    'phone/file uploads remain private even when their bytes equal a shared original',
    async () => {
      const local = await jobs.create(
        String(owners[3]),
        source.input,
        randomUUID(),
        {
          policyVersion: 2,
          preparationProfileId: 'audio-cap-aac-lc-160-v1',
          source: 'audio_file',
          sourceKind: 'file',
        },
      );
      const localJob = await jobRecords.findById(local.id).lean();
      assert.equal(localJob.status, 'awaiting_upload');
      assert.match(
        localJob.inputReservation.key,
        new RegExp(`^users/${owners[3]}/jobs/`),
      );
      assert.equal(localJob.sharedSourceKey, null);
      assert.equal(localJob.sharedResultKey, null);
      assert.equal(localUploadGrants, 1);
      assert.equal(await model('SharedMediaSource').countDocuments(), 1);
    },
  );

  await t.test(
    'job deletion and account purge remove only user references, keeping permanent originals and results',
    async () => {
      const deletion = new JobDeletionService(
        jobRecords,
        model('NotificationOutbox'),
        transactions,
        storage,
        usage,
        config,
      );
      await deletion.delete(String(waiter.userId), String(cachedJob._id));
      const cleanupNow = new Date(Date.now() + 4_600_000);
      assert.equal(await deletion.cleanupDue(cleanupNow), true);
      assert.ok((await jobRecords.findById(cachedJob._id)).cleanupCompletedAt);
      assert.equal(
        (await usage.readUsage(waiter.userId)).storage.retainedBytes,
        0,
      );
      assert.equal(deletes.length, 0);
      assert.deepEqual(objects.get(source.inputObject.key), source.inputObject);
      assert.deepEqual(objects.get(sharedOutput.key), sharedOutput);

      await accounts.users.updateOne(
        { _id: waiter.userId },
        {
          $set: {
            status: 'purging',
            deletionRequestId: randomUUID(),
            deletionRequestedAt: new Date(0),
            deletionRecoverUntil: new Date(0),
            deletionNextAt: new Date(0),
            deletionPhase: 'jobs',
          },
        },
      );
      let identityDeletes = 0;
      const accountDeletion = new AccountDeletionCleanupService(
        accounts.users,
        jobRecords,
        connection,
        actions,
        deletion,
        cleanup,
        {
          revokeRefreshTokens: async () => {},
          updateUser: async () => {},
          deleteUser: async () => {
            identityDeletes++;
          },
        },
        accounts.identities,
      );
      for (
        let step = 0;
        step < 12 && (await accounts.users.exists({ _id: waiter.userId }));
        step++
      )
        await accountDeletion.advanceDeletion(
          new Date(cleanupNow.getTime() + step * 60_000),
        );
      assert.equal(await accounts.users.exists({ _id: waiter.userId }), null);
      assert.equal(
        await jobRecords.countDocuments({ userId: waiter.userId }),
        0,
      );
      assert.equal(await records.countDocuments({ userId: waiter.userId }), 0);
      assert.equal(identityDeletes, 1);
      assert.equal(deletes.length, 0);
      assert.equal(
        (await model('SharedMediaSource').findById(source._id)).state,
        'ready',
      );
      assert.equal(
        (await model('SharedMediaResult').findById(result._id)).state,
        'ready',
      );
      assert.deepEqual(objects.get(source.inputObject.key), source.inputObject);
      assert.deepEqual(objects.get(sharedOutput.key), sharedOutput);
      assert.deepEqual(
        (await jobRecords.findById(producerJob._id)).outputObject.toObject(),
        sharedOutput,
      );
      assert.deepEqual(
        (
          await model('SharedMediaArtifact').findById(source.inputObject.key)
        ).object.toObject(),
        source.inputObject,
      );
      assert.deepEqual(
        (
          await model('SharedMediaArtifact').findById(sharedOutput.key)
        ).object.toObject(),
        sharedOutput,
      );
      for (const name of [
        'SharedMediaSource',
        'SharedMediaResult',
        'SharedMediaArtifact',
      ])
        assert.ok(
          (await model(name).listIndexes()).every(
            (index) => index.expireAfterSeconds === undefined,
          ),
        );
    },
  );

  await t.test(
    'a lost successful PUT response recovers the source and settles its acquisition hold without paid resubmission',
    async () => {
      const owner = owners[4];
      const providersBefore = providerCalls;
      const uploadsBefore = sourceUploads;
      const headsBefore = recoveryHeads;
      const requestId = randomUUID();
      const created = await imports.create(
        String(owner),
        'https://www.youtube.com/watch?v=jNQXAC9IVRw',
        requestId,
      );
      let interrupted = await records.findById(created.importId).lean();
      assert.equal((await shared.inspect(interrupted)).action, 'acquire');
      loseNextUploadResponse = true;
      await processImport(interrupted);

      interrupted = await records.findById(interrupted._id).lean();
      assert.equal(loseNextUploadResponse, false);
      assert.equal(interrupted.status, 'submitted');
      assert.equal(interrupted.error, null);
      assert.ok(interrupted.acquisitionReservedAt);
      const recoveredSource = await model('SharedMediaSource')
        .findById(interrupted.sharedSourceKey)
        .lean();
      const recoveredJob = await jobRecords.findById(interrupted.jobId).lean();
      assert.equal(recoveredSource.state, 'ready');
      assert.equal(recoveredSource.sourceTitle, 'Synthetic shared source');
      assert.equal(recoveredJob.status, 'queued');
      assert.deepEqual(recoveredJob.inputObject, recoveredSource.inputObject);
      assert.deepEqual(
        objects.get(recoveredSource.inputObject.key),
        recoveredSource.inputObject,
      );
      assert.deepEqual(
        (
          await model('SharedMediaArtifact').findById(
            recoveredSource.inputObject.key,
          )
        ).object.toObject(),
        recoveredSource.inputObject,
      );
      assert.equal(
        String(
          (
            await model('SharedMediaResult').findById(
              interrupted.sharedResultKey,
            )
          ).producerJobId,
        ),
        String(recoveredJob._id),
      );
      const importHold = await model('ProcessingReservation')
        .findById(interrupted._id)
        .lean();
      const jobHold = await model('ProcessingReservation')
        .findById(recoveredJob._id)
        .lean();
      assert.equal(importHold.state, 'released');
      assert.equal(jobHold.state, 'reserved');
      const recoveredUsage = await usage.readUsage(owner);
      assert.equal(recoveredUsage.processing.usedSeconds, 0);
      assert.equal(
        recoveredUsage.processing.reservedSeconds,
        Math.ceil(recoveredSource.input.durationSeconds),
      );
      assert.equal(recoveredUsage.uploads.monthlyGrants, 1);
      assert.equal(recoveredUsage.uploads.confirmedBytes, audio.length);
      assert.equal(recoveredUsage.storage.retainedBytes, 0);
      assert.equal(providerCalls, providersBefore + 1);
      assert.equal(sourceUploads, uploadsBefore + 1);
      assert.equal(recoveryHeads, headsBefore + 1);

      await processor.reconcileFailure(
        interrupted,
        new Error('replayed lost response'),
      );
      await processImport(interrupted);
      assert.equal(await jobRecords.countDocuments({ userId: owner }), 1);
      const replayUsage = await usage.readUsage(owner);
      assert.deepEqual(replayUsage.processing, recoveredUsage.processing);
      assert.deepEqual(replayUsage.uploads, recoveredUsage.uploads);
      assert.equal(providerCalls, providersBefore + 1);
      assert.equal(sourceUploads, uploadsBefore + 1);
      assert.equal(recoveryHeads, headsBefore + 1);
      assert.equal(deletes.length, 0);
    },
  );

  const retryOwners = Array.from({ length: 6 }, () => new Types.ObjectId());
  await accountFixture(connection, retryOwners.map(String));
  const admitRetry = async (owner, videoId) => {
    const created = await imports.create(
      String(owner),
      `https://youtu.be/${videoId}`,
      randomUUID(),
      false,
    );
    return records.findById(created.importId).lean();
  };
  const makeDue = async (record) => {
    await records.updateOne(
      { _id: record._id, status: 'queued' },
      { $set: { nextAttemptAt: new Date(Date.now() - 1) } },
    );
    return records.findById(record._id).lean();
  };

  await t.test(
    'a delayed acquisition retry keeps one usage hold and shared waiter, then succeeds once',
    async (st) => {
      st.after(() => {
        acquisitionFailureCode = null;
      });
      const providersBefore = providerCalls;
      const uploadsBefore = sourceUploads;
      let retry = await admitRetry(retryOwners[0], 'retry-src01');
      assert.equal(retry.acquisitionStartedAt, null);
      const follower = await admitRetry(retryOwners[1], 'retry-src01');
      const sourceBefore = await model('SharedMediaSource')
        .findById(retry.sharedSourceKey)
        .lean();
      const resultBefore = await model('SharedMediaResult')
        .findById(retry.sharedResultKey)
        .lean();
      acquisitionFailureCode = 'IMPORT_DEPENDENCY_FAILED';
      await processImport(retry);
      retry = await records.findById(retry._id).lean();
      assert.equal(retry.status, 'queued');
      assert.equal(retry.acquisitionAttempt, 1);
      assert.ok(retry.acquisitionStartedAt instanceof Date);
      const acquisitionStartedAt = retry.acquisitionStartedAt.getTime();
      assert.equal(
        retry.nextAttemptAt.getTime() - retry.queuedAt.getTime(),
        5_000,
      );
      assert.equal(retry.trimEnabled, false);
      assert.equal((await shared.inspect(follower)).action, 'wait');
      assert.equal(
        (await model('ProcessingReservation').findById(retry._id)).state,
        'reserved',
      );
      assert.equal(
        await model('ProcessingReservation').countDocuments({
          accountId: retry.userId,
        }),
        1,
      );
      await processImport(retry);
      assert.equal(
        providerCalls,
        providersBefore + 1,
        'a premature queue entry cannot acquire before its durable due time',
      );
      await imports.enqueue(String(retry._id));
      const queuedRetry = await queue.getJob(importExecutionJobId(retry));
      assert.ok(queuedRetry);
      assert.equal(queuedRetry.opts.attempts, 1);
      assert.equal(await queuedRetry.getState(), 'delayed');
      acquisitionFailureCode = null;
      retry = await makeDue(retry);
      await processImport(retry);
      retry = await records.findById(retry._id).lean();
      const retryJob = await jobRecords.findById(retry.jobId).lean();
      assert.equal(retry.status, 'submitted');
      assert.equal(retry.acquisitionAttempt, 2);
      assert.equal(
        retry.acquisitionStartedAt.getTime(),
        acquisitionStartedAt,
        'eligible retries preserve the first active claim instead of renewing its budget',
      );
      assert.equal(retry.error, null);
      assert.equal(retry.nextAttemptAt, null);
      assert.equal(retryJob.recipeSnapshot.trimEnabled, false);
      assert.equal(retryJob.sharedSourceKey, sourceBefore._id);
      assert.equal(retryJob.sharedResultKey, resultBefore._id);
      const readySource = await model('SharedMediaSource')
        .findById(sourceBefore._id)
        .lean();
      const processingResult = await model('SharedMediaResult')
        .findById(resultBefore._id)
        .lean();
      assert.equal(readySource.generation, sourceBefore.generation);
      assert.equal(
        processingResult.sourceGeneration,
        resultBefore.sourceGeneration,
      );
      assert.equal(String(readySource.producerImportId), String(retry._id));
      assert.equal(
        String(processingResult.producerImportId),
        String(retry._id),
      );
      assert.equal((await shared.inspect(follower)).action, 'wait');
      assert.equal(providerCalls, providersBefore + 2);
      assert.equal(sourceUploads, uploadsBefore + 1);
      assert.equal(
        await jobRecords.countDocuments({ userId: retry.userId }),
        1,
      );
      assert.equal(
        (await model('ProcessingReservation').findById(retry._id)).state,
        'released',
      );
      assert.equal(
        (await model('ProcessingReservation').findById(retryJob._id)).state,
        'reserved',
      );
      const downloadTiming = retry.stageTimings.filter(
        (entry) => entry.stage === 'source-download',
      );
      assert.equal(downloadTiming.length, 1);
      assert.equal(downloadTiming[0].complete, true);
      assert.equal(new Set(acquisitionExecutions.slice(-2)).size, 2);
    },
  );

  await t.test(
    'three retries exhaust four opaque executions and release the single hold and shared followers once',
    async (st) => {
      st.after(() => {
        acquisitionFailureCode = null;
      });
      const providersBefore = providerCalls;
      const uploadsBefore = sourceUploads;
      let retry = await admitRetry(retryOwners[2], 'retry-src02');
      const follower = await admitRetry(retryOwners[3], 'retry-src02');
      acquisitionFailureCode = 'IMPORT_UPSTREAM_REFUSED';
      let stale;
      for (const attempt of [1, 2, 3, 4]) {
        await processImport(retry);
        retry = await records.findById(retry._id).lean();
        assert.equal(retry.acquisitionAttempt, attempt);
        assert.equal(retry.status, attempt < 4 ? 'queued' : 'failed');
        if (attempt < 4) {
          assert.equal(
            retry.nextAttemptAt.getTime() - retry.queuedAt.getTime(),
            5_000 * 2 ** (attempt - 1),
          );
          assert.equal((await shared.inspect(follower)).action, 'wait');
          assert.equal(
            (await model('ProcessingReservation').findById(retry._id)).state,
            'reserved',
          );
          stale ??= {
            ...retry,
            status: 'downloading',
            executionId: acquisitionExecutions.at(-1),
          };
          retry = await makeDue(retry);
        }
      }
      assert.equal(retry.error.code, 'IMPORT_UPSTREAM_REFUSED');
      assert.equal(retry.nextAttemptAt, null);
      assert.equal(retry.jobId, null);
      assert.equal(retry.input, null);
      assert.equal(providerCalls, providersBefore + 4);
      assert.equal(new Set(acquisitionExecutions.slice(-4)).size, 4);
      assert.ok(
        acquisitionExecutions
          .slice(-4)
          .every((value) =>
            /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
              value,
            ),
          ),
      );
      assert.equal(sourceUploads, uploadsBefore);
      assert.equal(
        await jobRecords.countDocuments({ userId: retry.userId }),
        0,
      );
      assert.equal(
        await model('ProcessingReservation').countDocuments({
          accountId: retry.userId,
        }),
        1,
      );
      assert.equal(
        (await model('ProcessingReservation').findById(retry._id)).state,
        'released',
      );
      assert.equal(
        (await model('SharedMediaSource').findById(retry.sharedSourceKey))
          .state,
        'failed',
      );
      assert.equal((await shared.inspect(follower)).action, 'failed');
      await imports.enqueue(String(follower._id));
      assert.equal((await records.findById(follower._id)).status, 'failed');
      await processor.reconcileFailure(
        stale,
        importError('IMPORT_DEPENDENCY_FAILED'),
      );
      await processImport(retry);
      assert.equal(providerCalls, providersBefore + 4);
      assert.equal(
        (await usage.readUsage(retry.userId)).processing.reservedSeconds,
        0,
      );
    },
  );

  await t.test(
    'permanent source refusal and disabled accounts terminate without another acquisition',
    async (st) => {
      st.after(() => {
        acquisitionFailureCode = null;
      });
      const providersBefore = providerCalls;
      let permanent = await admitRetry(retryOwners[4], 'retry-src03');
      acquisitionFailureCode = 'IMPORT_SOURCE_UNAVAILABLE';
      await processImport(permanent);
      permanent = await records.findById(permanent._id).lean();
      assert.equal(permanent.status, 'failed');
      assert.equal(permanent.acquisitionAttempt, 1);
      assert.equal(permanent.nextAttemptAt, null);
      assert.equal(
        (await model('ProcessingReservation').findById(permanent._id)).state,
        'released',
      );
      let disabled = await admitRetry(retryOwners[5], 'retry-src04');
      acquisitionFailureCode = 'IMPORT_DEPENDENCY_FAILED';
      await processImport(disabled);
      disabled = await records.findById(disabled._id).lean();
      assert.equal(disabled.status, 'queued');
      await accounts.users.updateOne(
        { _id: disabled.userId },
        { $set: { status: 'disabled' } },
      );
      disabled = await makeDue(disabled);
      await processImport(disabled);
      disabled = await records.findById(disabled._id).lean();
      assert.equal(disabled.status, 'failed');
      assert.equal(disabled.error.code, 'ACCOUNT_DISABLED');
      assert.equal(disabled.acquisitionAttempt, 2);
      assert.equal(
        (await model('ProcessingReservation').findById(disabled._id)).state,
        'released',
      );
      assert.equal(providerCalls, providersBefore + 2);
    },
  );

  const nativeOwners = Array.from({ length: 3 }, () => new Types.ObjectId());
  await accountFixture(connection, nativeOwners.map(String));
  const webmPath = join(native.directory, 'source.webm');
  await promisify(execFile)(process.env.FFMPEG_BINARY || 'ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=660:duration=0.25',
    '-vn',
    '-c:a',
    'libopus',
    '-b:a',
    '70k',
    webmPath,
  ]);
  const nativeAudio = await readFile(webmPath);
  const { stdout: nativeProbe } = await promisify(execFile)(
    process.env.FFPROBE_BINARY || 'ffprobe',
    ['-v', 'error', '-show_streams', '-of', 'json', webmPath],
  );
  const nativeStreams = JSON.parse(nativeProbe).streams;
  assert.equal(nativeStreams.length, 1);
  assert.equal(nativeStreams[0].codec_type, 'audio');
  assert.equal(nativeStreams[0].codec_name, 'opus');
  const nativeAcquisitions = new Map();
  const nativeProcessor = new ImportProcessor(
    imports,
    {
      download: async (url, _files, path) => {
        nativeAcquisitions.set(url, (nativeAcquisitions.get(url) ?? 0) + 1);
        await writeFile(path, nativeAudio);
        return {
          bytes: nativeAudio.length,
          sha256: digest(nativeAudio),
          extension: 'webm',
          contentType: 'audio/webm',
          sourceTitle: 'Synthetic native Opus source',
          extraData: null,
        };
      },
    },
    jobs,
    actions,
    config,
    jobRecords,
    shared,
  );
  await nativeProcessor.files.initialize();
  const processNativeImport = (record) =>
    nativeProcessor.process({
      data: {
        importId: String(record._id),
        attempt: (record.acquisitionAttempt ?? 0) + 1,
      },
    });
  let nativeSourceJob;

  const durableDownloader = {
    download: async (_url, _files, path) => {
      providerCalls++;
      await writeFile(path, nativeAudio);
      return {
        bytes: nativeAudio.length,
        sha256: digest(nativeAudio),
        extension: 'webm',
        contentType: 'audio/webm',
        sourceTitle: 'Synthetic durable handoff source',
        extraData: null,
      };
    },
  };
  const durableProcessor = (service = imports) =>
    new ImportProcessor(
      service,
      durableDownloader,
      jobs,
      actions,
      config,
      jobRecords,
      shared,
    );
  const processDurableImport = (record, selected) =>
    selected.process({
      data: record.handoffPending
        ? {
            importId: String(record._id),
            handoffAttempt: record.handoffAttempt,
          }
        : {
            importId: String(record._id),
            attempt: (record.acquisitionAttempt ?? 0) + 1,
          },
    });

  await t.test(
    'confirmed native audio survives repeated handoff timeouts and Redis loss at the acquisition ceiling',
    async (st) => {
      const owner = new Types.ObjectId();
      await accountFixture(connection, [String(owner)]);
      const providersBefore = providerCalls;
      const uploadsBefore = sourceUploads;
      const created = await imports.create(
        String(owner),
        'https://youtu.be/handoff0001',
        randomUUID(),
        false,
      );
      const acquisitionStartedAt = new Date(Date.now() - 1_000);
      await records.updateOne(
        { _id: created.importId },
        {
          $set: {
            acquisitionAttempt: 3,
            maxAcquisitionAttempts: 4,
            acquisitionStartedAt,
          },
        },
      );
      let pending = await records.findById(created.importId).lean();
      const selected = durableProcessor();
      await selected.files.initialize();
      const createSharedInput = jobs.createForSharedInput;
      const enqueue = queue.add;
      let submissionCalls = 0;
      let loseEnqueue = false;
      let staleExecution;
      jobs.createForSharedInput = async (...args) => {
        if (args[0] !== String(owner))
          return createSharedInput.apply(jobs, args);
        submissionCalls++;
        if (submissionCalls <= 8) {
          staleExecution ??= await records.findById(pending._id).lean();
          throw new mongo.MongoOperationTimeoutError(
            'Synthetic handoff timeout',
          );
        }
        return createSharedInput.apply(jobs, args);
      };
      queue.add = async (...args) => {
        if (
          loseEnqueue &&
          args[1].importId === created.importId &&
          args[1].handoffAttempt
        )
          throw new Error('Synthetic Redis publication loss');
        return enqueue.apply(queue, args);
      };
      st.after(() => {
        jobs.createForSharedInput = createSharedInput;
        queue.add = enqueue;
      });
      await processDurableImport(pending, selected);
      const importHold = await model('ProcessingReservation')
        .findById(pending._id)
        .lean();
      assert.equal(importHold?.state, 'reserved');
      let confirmed;
      for (const [index, delayMs] of [
        5_000, 10_000, 20_000, 30_000,
      ].entries()) {
        pending = await records.findById(pending._id).lean();
        assert.equal(pending.status, 'queued');
        assert.equal(pending.handoffPending, true);
        assert.equal(pending.handoffAttempt, index + 1);
        assert.equal(pending.acquisitionAttempt, 4);
        assert.equal(
          pending.acquisitionStartedAt.getTime(),
          acquisitionStartedAt.getTime(),
        );
        assert.equal(
          pending.nextAttemptAt.getTime() - pending.queuedAt.getTime(),
          delayMs,
        );
        assert.equal(pending.error, null);
        assert.equal(pending.jobId, null);
        assert.equal(pending.deadlineAt, null);
        const source = await model('SharedMediaSource')
          .findById(pending.sharedSourceKey)
          .lean();
        confirmed ??= source;
        assert.equal(source.state, 'ready');
        assert.deepEqual(source.inputObject, confirmed.inputObject);
        assert.deepEqual(
          objects.get(source.inputObject.key),
          source.inputObject,
        );
        assert.equal(source.inputObject.bytes, nativeAudio.length);
        assert.equal(source.inputObject.sha256, digest(nativeAudio));
        assert.equal(
          (await model('ProcessingReservation').findById(pending._id)).state,
          'reserved',
        );
        assert.equal(
          (await usage.readUsage(owner)).processing.reservedSeconds,
          importHold.processingSeconds,
        );
        assert.equal(await jobRecords.countDocuments({ userId: owner }), 0);
        assert.equal(providerCalls, providersBefore + 1);
        assert.equal(sourceUploads, uploadsBefore + 1);
        assert.equal(submissionCalls, (index + 1) * 2);
        await selected.reconcileFailure(
          staleExecution,
          new Error('Stale execution replay'),
        );
        await processDurableImport(pending, selected);
        assert.equal(
          submissionCalls,
          (index + 1) * 2,
          'premature and superseded entries do not submit',
        );
        assert.equal(
          (await records.findById(pending._id)).handoffAttempt,
          index + 1,
        );
        if (index === 3) {
          await assert.rejects(
            imports.enqueue(String(pending._id)),
            /Synthetic Redis publication loss/,
          );
          assert.equal(
            await queue.getJob(importExecutionJobId(pending)),
            undefined,
          );
          break;
        }
        await imports.enqueue(String(pending._id));
        const queued = await queue.getJob(importExecutionJobId(pending));
        assert.ok(queued);
        assert.equal(queued.id, `${pending._id}-handoff-${index + 1}`);
        assert.equal(queued.data.handoffAttempt, index + 1);
        assert.equal(queued.opts.attempts, 1);
        assert.equal(await queued.getState(), 'delayed');
        await queued.remove();
        if (index === 2) loseEnqueue = true;
        pending = await makeDue(pending);
        await processDurableImport(pending, selected);
      }

      const restartedQueue = new Queue(IMPORT_QUEUE, {
        connection: { host: '127.0.0.1', port: redisPort },
        prefix: queue.opts.prefix,
      });
      st.after(() => restartedQueue.close());
      const restartedImports = new ImportsService(
        records,
        model('ProcessingAdmissionFence'),
        transactions,
        accounts.access,
        usage,
        config,
        restartedQueue,
        { assertAllowed: async () => {} },
        shared,
        jobs,
      );
      await restartedImports.initialize();
      const restartedProcessor = durableProcessor(restartedImports);
      await restartedProcessor.files.initialize();
      const restartedRuntime = new ImportRuntime(
        config,
        restartedImports,
        restartedProcessor,
        restartedQueue,
        shared,
      );
      await restartedRuntime.reconcile();
      const repaired = await restartedQueue.getJob(
        importExecutionJobId(pending),
      );
      assert.ok(
        repaired,
        'restart repairs the durable handoff outbox without a paid acquisition',
      );
      assert.equal(repaired.data.handoffAttempt, 4);
      assert.equal(await repaired.getState(), 'delayed');
      pending = await makeDue(pending);
      await processDurableImport(pending, restartedProcessor);
      const submitted = await records.findById(pending._id).lean();
      const job = await jobRecords.findById(submitted.jobId).lean();
      assert.equal(submitted.status, 'submitted');
      assert.equal(submitted.handoffPending, false);
      assert.equal(submitted.handoffAttempt, 4);
      assert.equal(
        submitted.acquisitionAttempt,
        4,
        'handoff cannot create a fifth acquisition',
      );
      assert.equal(submitted.nextAttemptAt, null);
      assert.equal(job.status, 'queued');
      assert.deepEqual(job.inputObject, confirmed.inputObject);
      assert.equal(await jobRecords.countDocuments({ userId: owner }), 1);
      assert.equal(
        await model('SharedMediaSource').countDocuments({
          _id: pending.sharedSourceKey,
        }),
        1,
      );
      assert.equal(
        (await model('ProcessingReservation').findById(pending._id)).state,
        'released',
      );
      assert.equal(
        (await model('ProcessingReservation').findById(job._id)).state,
        'reserved',
      );
      assert.equal(
        await model('ProcessingReservation').countDocuments({
          accountId: owner,
        }),
        2,
      );
      assert.equal(
        await model('UploadGrantReceipt').countDocuments({ accountId: owner }),
        1,
      );
      const accepted = await usage.readUsage(owner);
      assert.equal(accepted.processing.reservedSeconds, 1);
      assert.equal(accepted.uploads.monthlyGrants, 1);
      assert.equal(accepted.uploads.confirmedBytes, nativeAudio.length);
      await processDurableImport(pending, restartedProcessor);
      assert.deepEqual(
        (await usage.readUsage(owner)).uploads,
        accepted.uploads,
      );
      assert.equal(await jobRecords.countDocuments({ userId: owner }), 1);
      assert.equal(submissionCalls, 9);
      assert.equal(providerCalls, providersBefore + 1);
      assert.equal(sourceUploads, uploadsBefore + 1);
    },
  );

  await t.test(
    'a matching ready result exchanges the original pending acquisition hold and receipts exactly once',
    async (st) => {
      const owner = new Types.ObjectId();
      await accountFixture(connection, [String(owner)]);
      const providersBefore = providerCalls;
      const uploadsBefore = sourceUploads;
      const created = await imports.create(
        String(owner),
        'https://youtu.be/handoff0002',
        randomUUID(),
        false,
      );
      let pending = await records.findById(created.importId).lean();
      const selected = durableProcessor();
      await selected.files.initialize();
      const createSharedInput = jobs.createForSharedInput;
      const createFromCache = jobs.createFromCache;
      let freshCalls = 0;
      let cachedCalls = 0;
      jobs.createForSharedInput = async (...args) => {
        if (args[0] !== String(owner))
          return createSharedInput.apply(jobs, args);
        freshCalls++;
        throw new mongo.MongoOperationTimeoutError(
          'Synthetic source handoff timeout',
        );
      };
      jobs.createFromCache = async (...args) => {
        if (args[0] !== String(owner)) return createFromCache.apply(jobs, args);
        cachedCalls++;
        if (cachedCalls <= 2)
          throw new mongo.MongoOperationTimeoutError(
            'Synthetic cached handoff timeout',
          );
        return createFromCache.apply(jobs, args);
      };
      st.after(() => {
        jobs.createForSharedInput = createSharedInput;
        jobs.createFromCache = createFromCache;
      });
      await processDurableImport(pending, selected);
      pending = await records.findById(pending._id).lean();
      assert.equal(pending.handoffAttempt, 1);
      assert.equal(freshCalls, 2);
      const confirmed = await model('SharedMediaSource')
        .findById(pending.sharedSourceKey)
        .lean();
      // Another producer's completed matching recipe can become available while
      // this owner's confirmed-source handoff is pending.
      const outputObject = {
        key: `shared/url/${pending.sharedResultKey}/${randomUUID()}/output/vocals.mp3`,
        bytes: audio.length,
        contentType: 'audio/mpeg',
        sha256: digest(audio),
        etag: '"fixture-durable-result"',
      };
      objects.set(outputObject.key, outputObject);
      const { etag: _etag, ...reservation } = outputObject;
      await model('SharedMediaArtifact').create({
        _id: outputObject.key,
        assetKey: pending.sharedResultKey,
        kind: 'output',
        reservation,
        object: outputObject,
      });
      await model('SharedMediaResult').updateOne(
        { _id: pending.sharedResultKey, state: 'processing' },
        {
          $set: {
            state: 'ready',
            outputObject,
            completedAt: new Date(),
            comparisonRanges: null,
          },
        },
        { runValidators: true },
      );
      pending = await makeDue(pending);
      await processDurableImport(pending, selected);
      pending = await records.findById(pending._id).lean();
      assert.equal(pending.status, 'queued');
      assert.equal(pending.handoffPending, true);
      assert.equal(pending.handoffAttempt, 2);
      assert.equal(pending.acquisitionAttempt, 1);
      assert.equal(cachedCalls, 2);
      assert.equal(
        (await model('ProcessingReservation').findById(pending._id)).state,
        'reserved',
      );
      assert.equal(
        await model('UploadGrantReceipt').countDocuments({ accountId: owner }),
        0,
      );
      pending = await makeDue(pending);
      await processDurableImport(pending, selected);
      const submitted = await records.findById(pending._id).lean();
      const job = await jobRecords.findById(submitted.jobId).lean();
      assert.equal(submitted.status, 'submitted');
      assert.equal(submitted.handoffPending, false);
      assert.equal(submitted.acquisitionAttempt, 1);
      assert.equal(job.status, 'ready');
      assert.deepEqual(job.inputObject, confirmed.inputObject);
      assert.deepEqual(job.outputObject, outputObject);
      assert.equal(job.confirmedUploadBytes, nativeAudio.length);
      assert.equal(job.retainedInputBytes, nativeAudio.length);
      assert.equal(
        (await model('ProcessingReservation').findById(pending._id)).state,
        'released',
      );
      assert.equal(
        await model('ProcessingReservation').countDocuments({
          accountId: owner,
        }),
        1,
      );
      assert.equal(
        await model('UploadGrantReceipt').countDocuments({ accountId: owner }),
        1,
      );
      const accepted = await usage.readUsage(owner);
      assert.equal(accepted.processing.reservedSeconds, 0);
      assert.equal(accepted.processing.usedSeconds, 0);
      assert.equal(accepted.uploads.monthlyGrants, 1);
      assert.equal(accepted.uploads.confirmedBytes, nativeAudio.length);
      assert.equal(
        accepted.storage.retainedBytes,
        nativeAudio.length + outputObject.bytes,
      );
      await processDurableImport(pending, selected);
      assert.deepEqual(
        (await usage.readUsage(owner)).uploads,
        accepted.uploads,
      );
      assert.equal(
        (await usage.readUsage(owner)).storage.retainedBytes,
        accepted.storage.retainedBytes,
      );
      assert.equal(await jobRecords.countDocuments({ userId: owner }), 1);
      assert.equal(freshCalls, 2);
      assert.equal(cachedCalls, 3);
      assert.equal(providerCalls, providersBefore + 1);
      assert.equal(sourceUploads, uploadsBefore + 1);
    },
  );

  for (const restriction of ['allowance', 'disabled'])
    await t.test(
      `a pending confirmed-source handoff terminates safely after ${restriction} changes`,
      async (st) => {
        const owner = new Types.ObjectId();
        await accountFixture(connection, [String(owner)]);
        const providersBefore = providerCalls;
        const uploadsBefore = sourceUploads;
        const effective = policies.effective;
        let limit = 2;
        policies.effective = async (accountId, ...args) => {
          const policy = await effective(accountId, ...args);
          return String(accountId) === String(owner)
            ? {
                ...policy,
                values: { ...policy.values, monthlyProcessingSeconds: limit },
              }
            : policy;
        };
        const createSharedInput = jobs.createForSharedInput;
        let calls = 0;
        jobs.createForSharedInput = async (...args) => {
          if (args[0] !== String(owner))
            return createSharedInput.apply(jobs, args);
          calls++;
          if (calls <= 2)
            throw new mongo.MongoOperationTimeoutError(
              'Synthetic pending handoff timeout',
            );
          return createSharedInput.apply(jobs, args);
        };
        st.after(() => {
          policies.effective = effective;
          jobs.createForSharedInput = createSharedInput;
        });
        await transactions.run((session) =>
          usage.reserveForJob(new Types.ObjectId(), owner, 1, session),
        );
        const created = await imports.create(
          String(owner),
          `https://youtu.be/${restriction === 'allowance' ? 'handoff0003' : 'handoff0004'}`,
          randomUUID(),
          false,
        );
        let pending = await records.findById(created.importId).lean();
        const selected = durableProcessor();
        await selected.files.initialize();
        await processDurableImport(pending, selected);
        pending = await records.findById(pending._id).lean();
        assert.equal(pending.status, 'queued');
        assert.equal(pending.handoffPending, true);
        assert.equal(pending.handoffAttempt, 1);
        assert.equal(
          (await model('ProcessingReservation').findById(pending._id)).state,
          'reserved',
        );
        if (restriction === 'allowance') limit = 1;
        else
          await accounts.users.updateOne(
            { _id: owner },
            { $set: { status: 'disabled' } },
          );
        pending = await makeDue(pending);
        await processDurableImport(pending, selected);
        const terminal = await records.findById(pending._id).lean();
        assert.equal(terminal.status, 'failed');
        assert.equal(terminal.handoffPending, false);
        assert.equal(terminal.nextAttemptAt, null);
        assert.equal(
          terminal.error.code,
          restriction === 'allowance'
            ? 'PROCESSING_ALLOWANCE_EXHAUSTED'
            : 'ACCOUNT_DISABLED',
        );
        assert.equal(terminal.acquisitionAttempt, 1);
        assert.equal(
          (await model('ProcessingReservation').findById(pending._id)).state,
          'released',
        );
        assert.equal(await jobRecords.countDocuments({ userId: owner }), 0);
        assert.equal(
          await model('UploadGrantReceipt').countDocuments({
            accountId: owner,
          }),
          0,
        );
        const released = await usage.readUsage(owner);
        assert.equal(released.processing.reservedSeconds, 1);
        assert.equal(released.uploads.monthlyGrants, 0);
        assert.equal(released.uploads.confirmedBytes, 0);
        assert.equal(
          (await model('SharedMediaSource').findById(pending.sharedSourceKey))
            .state,
          'ready',
        );
        await processDurableImport(pending, selected);
        assert.equal(providerCalls, providersBefore + 1);
        assert.equal(sourceUploads, uploadsBefore + 1);
      },
    );

  await t.test(
    'ten same-account native imports exchange holds concurrently and recover one confirmed-source handoff without duplicate acquisition',
    async (st) => {
      const owner = nativeOwners[0];
      const uploadsBefore = sourceUploads;
      const created = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          imports.create(
            String(owner),
            `https://youtu.be/same-src${String(index + 1).padStart(3, '0')}`,
            randomUUID(),
            false,
          ),
        ),
      );
      const pending = await records
        .find({ _id: { $in: created.map((item) => item.importId) } })
        .lean();
      assert.equal(pending.length, 10);
      const requestIds = new Set(pending.map((item) => item.jobRequestId));
      const handoffs = new Map();
      const createSharedInput = jobs.createForSharedInput;
      let release, rejectBarrier;
      const barrier = new Promise((resolve, reject) => {
        release = resolve;
        rejectBarrier = reject;
      });
      const timeout = setTimeout(
        () =>
          rejectBarrier(
            new Error('Ten confirmed sources did not reach handoff'),
          ),
        30000,
      );
      st.after(() => {
        clearTimeout(timeout);
        jobs.createForSharedInput = createSharedInput;
      });
      jobs.createForSharedInput = async (...args) => {
        const [userId, , requestId] = args;
        if (userId !== String(owner))
          return createSharedInput.apply(jobs, args);
        handoffs.set(requestId, (handoffs.get(requestId) ?? 0) + 1);
        if (handoffs.size === 10 && handoffs.get(requestId) === 1) {
          try {
            const confirmedSources = await model('SharedMediaSource')
              .find({
                _id: { $in: pending.map((item) => item.sharedSourceKey) },
              })
              .lean();
            assert.equal(confirmedSources.length, 10);
            assert.ok(confirmedSources.every((item) => item.state === 'ready'));
            const importHolds = await model('ProcessingReservation')
              .find({ _id: { $in: pending.map((item) => item._id) } })
              .lean();
            assert.equal(importHolds.length, 10);
            assert.ok(importHolds.every((item) => item.state === 'reserved'));
            assert.equal(
              (await usage.readUsage(owner)).processing.reservedSeconds,
              importHolds.reduce(
                (total, item) => total + item.processingSeconds,
                0,
              ),
            );
            release();
          } catch (error) {
            rejectBarrier(error);
          }
        }
        await barrier;
        if (
          requestId === pending[0].jobRequestId &&
          handoffs.get(requestId) === 1
        )
          throw importError('IMPORT_DEPENDENCY_FAILED');
        return createSharedInput.apply(jobs, args);
      };

      // Hold all ten jobs at the confirmed-source boundary before releasing
      // them together. The failed first handoff retries this same source inline.
      try {
        await Promise.all(pending.map(processNativeImport));
      } finally {
        clearTimeout(timeout);
      }

      const submitted = await records.find({ userId: owner }).lean();
      const queued = await jobRecords.find({ userId: owner }).lean();
      assert.equal(submitted.length, 10);
      assert.ok(
        submitted.every((item) => item.status === 'submitted' && !item.error),
      );
      assert.ok(submitted.every((item) => item.acquisitionAttempt === 1));
      assert.equal(
        new Set(submitted.map((item) => String(item.jobId))).size,
        10,
      );
      assert.equal(queued.length, 10);
      assert.deepEqual(
        new Set(queued.map((item) => item.requestId)),
        requestIds,
      );
      assert.equal(handoffs.get(pending[0].jobRequestId), 2);
      assert.equal(
        [...handoffs.values()].reduce((total, count) => total + count, 0),
        11,
      );
      for (const job of queued) {
        assert.equal(job.status, 'queued');
        const submissionTimings = job.importStageTimings.filter(
          (stage) => stage.stage === 'job-submission',
        );
        assert.equal(submissionTimings.length, 1);
        assert.equal(submissionTimings[0].complete, true);
        assert.ok(
          Number.isSafeInteger(submissionTimings[0].durationMs) &&
            submissionTimings[0].durationMs >= 0,
        );
        assert.ok(
          job.importStageTimings.some(
            (stage) =>
              stage.stage === 'shared-source-confirmation' && stage.complete,
          ),
        );
        assert.deepEqual(
          submitted.find((item) => String(item.jobId) === String(job._id))
            .stageTimings,
          job.importStageTimings,
        );
        assert.equal(job.inputReservation.extension, 'webm');
        assert.equal(job.inputObject.contentType, 'audio/webm');
        assert.equal(job.inputObject.bytes, nativeAudio.length);
        assert.equal(job.inputObject.sha256, digest(nativeAudio));
        assert.deepEqual(objects.get(job.inputObject.key), job.inputObject);
        assert.equal(
          (await model('ProcessingReservation').findById(job._id)).state,
          'reserved',
        );
      }
      for (const item of submitted)
        assert.equal(
          (await model('ProcessingReservation').findById(item._id)).state,
          'released',
        );
      const measuredSeconds = queued.reduce(
        (total, job) => total + Math.ceil(job.measuredDurationSeconds),
        0,
      );
      const acceptedUsage = await usage.readUsage(owner);
      assert.equal(acceptedUsage.processing.usedSeconds, 0);
      assert.equal(acceptedUsage.processing.reservedSeconds, measuredSeconds);
      assert.equal(acceptedUsage.uploads.monthlyGrants, 10);
      assert.equal(
        acceptedUsage.uploads.confirmedBytes,
        nativeAudio.length * 10,
      );
      assert.equal(acceptedUsage.storage.retainedBytes, 0);
      assert.equal(sourceUploads, uploadsBefore + 10);
      assert.equal(nativeAcquisitions.size, 10);
      assert.ok([...nativeAcquisitions.values()].every((count) => count === 1));
      assert.equal(
        await model('ProcessingReservation').countDocuments({
          accountId: owner,
        }),
        20,
      );
      assert.equal(
        await model('UploadGrantReceipt').countDocuments({ accountId: owner }),
        10,
      );

      await Promise.all(submitted.map(processNativeImport));
      const replayed = await Promise.all(
        submitted.map((item) =>
          imports.create(String(owner), item.sourceUrl, item.requestId, false),
        ),
      );
      assert.deepEqual(
        new Set(replayed.map((item) => item.importId)),
        new Set(submitted.map((item) => String(item._id))),
      );
      assert.equal(await jobRecords.countDocuments({ userId: owner }), 10);
      const replayUsage = await usage.readUsage(owner);
      assert.deepEqual(replayUsage.processing, acceptedUsage.processing);
      assert.deepEqual(replayUsage.uploads, acceptedUsage.uploads);
      assert.equal(sourceUploads, uploadsBefore + 10);
      assert.ok([...nativeAcquisitions.values()].every((count) => count === 1));
      nativeSourceJob = queued[0];
    },
  );

  await t.test(
    'a near-limit account releases its import hold before admitting the measured native source',
    async (st) => {
      const owner = nativeOwners[1];
      const effective = policies.effective;
      policies.effective = async (accountId, ...args) => {
        const policy = await effective(accountId, ...args);
        return String(accountId) === String(owner)
          ? {
              ...policy,
              values: { ...policy.values, monthlyProcessingSeconds: 2 },
            }
          : policy;
      };
      st.after(() => {
        policies.effective = effective;
      });
      await transactions.run((session) =>
        usage.reserveForJob(new Types.ObjectId(), owner, 1, session),
      );
      const created = await imports.create(
        String(owner),
        'https://youtu.be/quota-src01',
        randomUUID(),
        false,
      );
      const pending = await records.findById(created.importId).lean();
      await processNativeImport(pending);
      const submitted = await records.findById(pending._id).lean();
      assert.equal(submitted.status, 'submitted');
      assert.equal(submitted.error, null);
      const job = await jobRecords.findById(submitted.jobId).lean();
      const acceptedUsage = await usage.readUsage(owner);
      assert.equal(acceptedUsage.processing.reservedSeconds, 2);
      assert.equal(acceptedUsage.processing.remainingSeconds, 0);
      assert.equal(job.inputObject.sha256, digest(nativeAudio));
      const importHold = await model('ProcessingReservation')
        .findById(pending._id)
        .lean();
      assert.ok(importHold.processingSeconds > 2);
      assert.equal(importHold.state, 'released');
      assert.equal(
        (await model('ProcessingReservation').findById(job._id))
          .processingSeconds,
        1,
      );
      assert.equal(acceptedUsage.uploads.monthlyGrants, 1);
      assert.equal(acceptedUsage.uploads.confirmedBytes, nativeAudio.length);
      assert.equal(nativeAcquisitions.get(pending.sourceUrl), 1);
    },
  );

  await t.test(
    'denied shared-job admission rolls back the released import hold and all accounting',
    async (st) => {
      const owner = nativeOwners[2];
      const uploadsBefore = sourceUploads;
      const acquisitionsBefore = new Map(nativeAcquisitions);
      const pending = await records.create({
        userId: owner,
        requestId: randomUUID(),
        jobRequestId: randomUUID(),
        provider: 'youtube',
        sourceUrl: nativeSourceJob.sourceUrl,
        status: 'downloading',
        executionId: randomUUID(),
        deadlineAt: new Date(Date.now() + 900000),
      });
      await imports.reserveAcquisition(pending);
      const before = await usage.readUsage(owner);
      const hold = await model('ProcessingReservation')
        .findById(pending._id)
        .lean();
      const effective = policies.effective;
      const releaseImport = usage.releaseImport;
      let releaseCalls = 0;
      policies.effective = async (accountId, ...args) => {
        const policy = await effective(accountId, ...args);
        return String(accountId) === String(owner)
          ? { ...policy, acceptNewJobs: false }
          : policy;
      };
      usage.releaseImport = async (...args) => {
        if (String(args[1]) === String(owner)) releaseCalls++;
        return releaseImport.apply(usage, args);
      };
      st.after(() => {
        policies.effective = effective;
        usage.releaseImport = releaseImport;
      });
      await assert.rejects(
        jobs.createForSharedInput(
          String(owner),
          {
            bytes: nativeSourceJob.inputObject.bytes,
            durationSeconds: nativeSourceJob.measuredDurationSeconds,
            extension: 'webm',
            contentType: 'audio/webm',
            sha256: nativeSourceJob.inputObject.sha256,
          },
          pending.jobRequestId,
          {
            policyVersion: 2,
            preparationProfileId: 'audio-cap-aac-lc-160-v1',
            source: 'youtube',
            sourceKind: 'url',
            sourceUrl: pending.sourceUrl,
          },
          false,
          nativeSourceJob.inputObject,
          nativeSourceJob.sharedSourceKey,
          nativeSourceJob.sharedResultKey,
          undefined,
          null,
          pending._id,
          nativeSourceJob.recipeSnapshot,
        ),
        (error) => error.getResponse?.().code === 'PROCESSING_UNAVAILABLE',
      );
      assert.equal(releaseCalls, 1);
      assert.deepEqual(
        await model('ProcessingReservation').findById(pending._id).lean(),
        hold,
      );
      const after = await usage.readUsage(owner);
      assert.deepEqual(after.processing, before.processing);
      assert.deepEqual(after.uploads, before.uploads);
      assert.equal(await jobRecords.countDocuments({ userId: owner }), 0);
      assert.equal(
        await model('ProcessingReservation').countDocuments({
          accountId: owner,
        }),
        1,
      );
      assert.equal(
        await model('UploadGrantReceipt').countDocuments({ accountId: owner }),
        0,
      );
      assert.equal(sourceUploads, uploadsBefore);
      assert.deepEqual(nativeAcquisitions, acquisitionsBefore);
    },
  );

  await t.test(
    'a guest contribution becomes immediately reusable by authenticated aliases, with a single cached trim rendition',
    async (st) => {
      const guestOwners = Array.from({ length: 3 }, () => new Types.ObjectId());
      await accountFixture(connection, guestOwners.map(String));
      let derivations = 0;
      let renditionUploads = 0;
      const derivation = {
        derive: async (_full, _duration, publish) => {
          derivations++;
          return publish({
            path: 'fixture-only',
            bytes: 512,
            sha256: digest(Buffer.alloc(512, 9)),
            comparisonRanges: [
              [0, 2205],
              [6615, 11025],
            ],
          });
        },
        upload: async (file, key) => {
          const intent = await model('SharedMediaArtifact')
            .findById(key)
            .lean();
          assert.ok(
            intent,
            'the durable rendition declaration precedes its PUT',
          );
          assert.equal(intent.reservation.sha256, file.sha256);
          assert.equal(objects.has(key), false);
          renditionUploads++;
          objects.set(key, {
            key,
            bytes: file.bytes,
            sha256: file.sha256,
            contentType: 'audio/mpeg',
            etag: '"derived-fixture"',
          });
        },
      };
      const catalog = new SharedMediaCatalogService(
        model('SharedMediaSource'),
        model('SharedMediaResult'),
        model('SharedMediaArtifact'),
        storage,
        transactions,
        derivation,
      );
      const sharedGuest = new SharedMediaService(
        model('SharedMediaSource'),
        model('SharedMediaResult'),
        records,
        jobRecords,
        storage,
        transactions,
        model('SharedMediaArtifact'),
        catalog,
      );
      const guestImports = new ImportsService(
        records,
        model('ProcessingAdmissionFence'),
        transactions,
        accounts.access,
        usage,
        config,
        queue,
        { assertAllowed: async () => {} },
        sharedGuest,
        jobs,
      );
      const urls = [
        'https://www.youtube.com/watch?v=guestshare1&list=RDguestshare1&start_radio=1',
        'https://youtu.be/guestshare1?si=share_tracking',
      ];
      const contributionId = new Types.ObjectId();
      const reservation = await transactions.run(async (session) => {
        await model('ProcessingAdmissionFence').updateOne(
          { _id: 'url-import-admission' },
          { $inc: { revision: 1 } },
          { upsert: true, session },
        );
        return sharedGuest.reserveCommunity(contributionId, urls[0], session);
      });
      assert.equal(reservation.state, 'reserved');
      assert.equal(reservation.sourceKey, communitySourceKey(urls[1]));
      assert.notEqual(reservation.sourceKey, sharedSourceKey(urls[0]));
      assert.equal(
        await model('SharedMediaSource')
          .findById(sharedSourceKey(urls[0]))
          .lean(),
        null,
      );
      const enabled = config.get('URL_IMPORT_ENABLED');
      const outstanding = config.get('URL_IMPORT_MAX_OUTSTANDING');
      const add = queue.add;
      let queueAdds = 0;
      st.after(() => {
        config.set('URL_IMPORT_ENABLED', enabled);
        config.set('URL_IMPORT_MAX_OUTSTANDING', outstanding);
        queue.add = add;
      });
      config.set('URL_IMPORT_ENABLED', false);
      config.set('URL_IMPORT_MAX_OUTSTANDING', 0);
      queue.add = async () => {
        queueAdds++;
        throw new Error('fixture Redis unavailable');
      };
      const before = { providerCalls, sourceUploads, copies: copies.length };
      const waiting = await guestImports.create(
        String(guestOwners[0]),
        urls[1],
        randomUUID(),
        false,
      );
      const waitingRecord = await records.findById(waiting.importId).lean();
      assert.equal(waiting.status, 'queued');
      assert.equal((await sharedGuest.inspect(waitingRecord)).action, 'wait');
      assert.equal(waitingRecord.sharedResultKey, reservation.resultKey);
      assert.equal(waitingRecord.acquisitionAttempt, 0);
      assert.equal(queueAdds, 0);
      const original = {
        ...source.inputObject,
        key: `quarantine/youtube/${contributionId}/input/source.mp3`,
        etag: '"guest-original"',
      };
      const vocals = {
        key: `quarantine/youtube/${contributionId}/output/vocals.mp3`,
        etag: '"guest-vocals"',
        bytes: 1024,
        sha256: digest(Buffer.alloc(1024, 8)),
        contentType: 'audio/mpeg',
      };
      objects.set(original.key, original);
      objects.set(vocals.key, vocals);
      const ready = await sharedGuest.publishCommunity(
        contributionId,
        urls[0],
        {
          input: source.input,
          inputObject: original,
          outputObject: vocals,
          sourceTitle: 'Guest fixture',
        },
      );
      assert.equal(ready.provenance, 'community_contributed');
      assert.equal(ready.sourceIdentityVerified, false);
      assert.equal(ready.recipeSnapshot.trimEnabled, false);
      assert.equal(
        (await model('SharedMediaSource').findById(ready.sourceKey))
          .producerImportId,
        null,
      );
      assert.equal(
        (await model('SharedMediaResult').findById(ready.resultKey))
          .producerImportId,
        null,
      );
      assert.equal(copies.length, before.copies + 2);
      assert.deepEqual(
        await sharedGuest.publishCommunity(contributionId, urls[1], {
          input: source.input,
          inputObject: original,
          outputObject: vocals,
        }),
        ready,
      );
      await guestImports.enqueue(waiting.importId);
      const full = await guestImports.get(
        String(guestOwners[0]),
        waiting.importId,
      );
      const fullJob = await jobRecords.findById(full.jobId).lean();
      assert.equal(full.status, 'submitted');
      assert.equal(fullJob.status, 'ready');
      assert.deepEqual(fullJob.outputObject, ready.outputObject);
      const fullAlias = await guestImports.create(
        String(guestOwners[1]),
        urls[0],
        randomUUID(),
        false,
        true,
      );
      assert.equal(fullAlias.status, 'submitted');
      assert.deepEqual(
        (await jobRecords.findById(fullAlias.jobId).lean()).outputObject,
        ready.outputObject,
      );
      const snapshot = await cacheSideEffects();
      await assert.rejects(
        guestImports.create(
          String(guestOwners[2]),
          urls[1],
          randomUUID(),
          true,
          true,
        ),
        (error) => error.getResponse?.().code === 'IMPORT_CACHE_MISS',
      );
      assert.deepEqual(await cacheSideEffects(), snapshot);
      assert.equal(derivations, 0);
      assert.equal(renditionUploads, 0);
      const trimmed = await guestImports.create(
        String(guestOwners[2]),
        urls[1],
        randomUUID(),
        true,
      );
      assert.equal(trimmed.status, 'submitted');
      const trimmedJob = await jobRecords.findById(trimmed.jobId).lean();
      assert.equal(trimmedJob.status, 'ready');
      assert.equal(trimmedJob.recipeSnapshot.trimEnabled, true);
      assert.equal(
        trimmedJob.recipeSnapshot.trimProfileId,
        'trim-vocal-mp3-v1',
      );
      assert.deepEqual(trimmedJob.inputObject, ready.inputObject);
      assert.notDeepEqual(trimmedJob.outputObject, ready.outputObject);
      assert.ok(validComparisonRanges(trimmedJob.comparisonRanges));
      assert.equal(derivations, 1);
      assert.equal(renditionUploads, 1);
      const trimmedAgain = await guestImports.create(
        String(guestOwners[0]),
        urls[0],
        randomUUID(),
        true,
        true,
      );
      assert.equal(trimmedAgain.status, 'submitted');
      assert.deepEqual(
        (await jobRecords.findById(trimmedAgain.jobId).lean()).outputObject,
        trimmedJob.outputObject,
      );
      assert.equal(derivations, 1);
      assert.equal(renditionUploads, 1);
      assert.equal(queueAdds, 0);
      assert.equal(providerCalls, before.providerCalls);
      assert.equal(sourceUploads, before.sourceUploads);
      assert.equal(copies.length, before.copies + 2);
      for (const owner of guestOwners) {
        assert.equal(
          await model('ProcessingReservation').countDocuments({
            accountId: owner,
          }),
          0,
        );
        assert.equal(
          await model('UploadGrantReceipt').countDocuments({
            accountId: owner,
          }),
          0,
        );
        const used = await usage.readUsage(owner);
        assert.equal(used.processing.usedSeconds, 0);
        assert.equal(used.processing.reservedSeconds, 0);
        assert.equal(used.uploads.confirmedBytes, 0);
      }
      // Publishing a derivative before its full master's commit cannot expose it.
      const master = await model('SharedMediaResult')
        .findById(ready.resultKey)
        .lean();
      await model('SharedMediaResult').updateOne(
        { _id: master._id },
        { $set: { state: 'processing' } },
      );
      assert.equal(await sharedGuest.lookupReady(urls[0], true), null);
      assert.deepEqual(
        await sharedGuest.ensureTrimmedFromFull(ready),
        await sharedGuest.prepareRequestedOutput(
          {
            sharedSourceKey: ready.sourceKey,
            sharedResultKey: ready.resultKey,
            recipeSnapshot: ready.recipeSnapshot,
            requestedTrimEnabled: true,
          },
          ready.outputObject,
        ),
      );
      assert.equal(derivations, 1);
      await assert.rejects(
        transactions.run(async (session) => {
          await sharedGuest.completeResult(
            {
              sharedSourceKey: ready.sourceKey,
              sharedResultKey: ready.resultKey,
              _id: null,
            },
            ready.outputObject,
            null,
            session,
          );
          throw new Error('fixture master commit abort');
        }),
        /fixture master commit abort/,
      );
      assert.equal(await sharedGuest.lookupReady(urls[0], true), null);
      await transactions.run((session) =>
        sharedGuest.completeResult(
          {
            sharedSourceKey: ready.sourceKey,
            sharedResultKey: ready.resultKey,
            _id: null,
          },
          ready.outputObject,
          null,
          session,
        ),
      );
      assert.deepEqual(
        (await sharedGuest.lookupReady(urls[1], true)).outputObject,
        trimmedJob.outputObject,
      );
      assert.equal(derivations, 1);
      assert.equal(renditionUploads, 1);

      await st.test(
        'worker completion ACK and restart-safe slow rendition preserve one model attempt and one retained receipt',
        async () => {
          const owner = new Types.ObjectId();
          const cancelledOwner = new Types.ObjectId();
          await accountFixture(connection, [owner, cancelledOwner].map(String));
          const fullRecipe = workerRecipeSnapshot(
            DEFAULT_WORKER_RECIPE_ID,
            false,
          );
          const cloudUrl = 'https://www.youtube.com/watch?v=cloudshare1';
          const cloudSourceKey = sharedSourceKey(cloudUrl);
          const generation = randomUUID();
          const cloudResultKey = sharedResultKey(
            cloudSourceKey,
            generation,
            fullRecipe.recipeDigest,
          );
          const inputKey = `shared/url/${cloudSourceKey}/${randomUUID()}/input/source.mp3`;
          const { etag: _etag, ...originalReservation } = ready.inputObject;
          await model('SharedMediaArtifact').create({
            _id: inputKey,
            assetKey: cloudSourceKey,
            kind: 'input',
            reservation: { ...originalReservation, key: inputKey },
          });
          const cloudInput = await storage.copyObject(
            ready.inputObject,
            inputKey,
          );
          await model('SharedMediaArtifact').updateOne(
            { _id: inputKey },
            { $set: { object: cloudInput } },
          );
          const producerId = new Types.ObjectId();
          await model('SharedMediaSource').create({
            _id: cloudSourceKey,
            sourceUrl: cloudUrl,
            provider: 'youtube',
            generation,
            state: 'ready',
            producerImportId: producerId,
            input: ready.input,
            inputKey,
            inputObject: cloudInput,
            acquiredAt: new Date(),
          });
          await model('SharedMediaResult').create({
            _id: cloudResultKey,
            sourceKey: cloudSourceKey,
            sourceGeneration: generation,
            state: 'processing',
            producerImportId: producerId,
            recipeSnapshot: fullRecipe,
          });
          const metadata = {
            policyVersion: 2,
            preparationProfileId: 'audio-cap-aac-lc-160-v1',
            source: 'youtube',
            sourceKind: 'url',
            sourceUrl: cloudUrl,
          };
          const submitted = await jobs.createForSharedInput(
            String(owner),
            ready.input,
            randomUUID(),
            metadata,
            false,
            cloudInput,
            cloudSourceKey,
            cloudResultKey,
            undefined,
            null,
            undefined,
            fullRecipe,
            true,
          );
          const cloudJob = await jobRecords.findById(submitted.jobId).lean();
          assert.equal(cloudJob.recipeSnapshot.trimEnabled, false);
          assert.equal(cloudJob.requestedTrimEnabled, true);
          await model('SharedMediaResult').updateOne(
            { _id: cloudResultKey },
            { $set: { producerJobId: cloudJob._id } },
          );
          const attemptId = randomUUID(),
            machineId = randomUUID(),
            workerId = randomUUID(),
            sessionId = randomUUID(),
            incarnation = randomUUID();
          const leaseExpiresAt = new Date(Date.now() + 60_000);
          const deadlineAt = new Date(Date.now() + 300_000);
          const workerFull = {
            key: `users/${owner}/jobs/${cloudJob._id}/attempts/${attemptId}/vocals.mp3`,
            etag: '"cloud-worker-full"',
            bytes: 2048,
            sha256: digest(Buffer.alloc(2048, 5)),
            contentType: 'audio/mpeg',
          };
          objects.set(workerFull.key, workerFull);
          const outputReservation = {
            key: workerFull.key,
            bytes: workerFull.bytes,
            sha256: workerFull.sha256,
            contentType: 'audio/mpeg',
            measuredDurationSeconds: ready.input.durationSeconds,
            grantExpiresAt: deadlineAt,
          };
          await model('WorkerAttempt').create({
            _id: attemptId,
            jobId: cloudJob._id,
            machineId,
            workerId,
            gpuId: 'fixture',
            sessionId,
            incarnation,
            claimRequestId: randomUUID(),
            attemptNumber: 1,
            state: 'uploading',
            stage: 'finalizing',
            leaseExpiresAt,
            deadlineAt,
            outputReservation,
          });
          await model('WorkerSlot').create({
            _id: workerId,
            machineId,
            gpuId: 'fixture',
            slotIndex: 0,
            sessionId,
            incarnation,
            state: 'busy',
            allowedRecipeIds: [fullRecipe.recipeId],
            currentAttemptId: attemptId,
          });
          await jobRecords.updateOne(
            { _id: cloudJob._id },
            {
              $set: {
                status: 'uploading_result',
                attemptNumber: 1,
                currentExecution: {
                  attemptId,
                  machineId,
                  workerId,
                  sessionId,
                  incarnation,
                  leaseExpiresAt,
                  deadlineAt,
                },
              },
            },
            { runValidators: true },
          );
          let wakes = 0;
          const attempts = new WorkerAttemptService(
            connection,
            model('WorkerAttempt'),
            model('WorkerSlot'),
            jobRecords,
            storage,
            cleanup,
            accounts.access,
            usage,
            sharedGuest,
            {
              wake: () => {
                wakes++;
              },
            },
          );
          const dto = {
            workerId,
            sessionId,
            incarnation,
            requestId: randomUUID(),
            etag: workerFull.etag,
            recipeId: fullRecipe.recipeId,
            recipeRevision: fullRecipe.recipeRevision,
            recipeDigest: fullRecipe.recipeDigest,
            modelDigest: fullRecipe.modelDigest,
            trimEnabled: false,
            denoiseEnabled: false,
            outputFormat: 'mp3',
            outputBitrateKbps: 160,
            stageTimings: [{ stage: 'separation', durationMs: 1 }],
          };
          const principal = { kind: 'machine', subjectId: machineId };
          const beforeDsp = derivations;
          const ack = await attempts.complete(principal, attemptId, dto);
          assert.equal(ack.status, 'ready');
          assert.equal(wakes, 1);
          assert.equal(
            derivations,
            beforeDsp,
            'the installed worker ACK never waits for DSP',
          );
          assert.equal(
            (await model('WorkerAttempt').findById(attemptId)).state,
            'succeeded',
          );
          assert.equal(
            (await model('WorkerSlot').findById(workerId)).state,
            'idle',
          );
          assert.equal(
            (await model('WorkerSlot').findById(workerId)).currentAttemptId,
            null,
          );
          let pendingJob = await jobRecords.findById(cloudJob._id).lean();
          assert.equal(pendingJob.status, 'uploading_result');
          assert.equal(pendingJob.outputObject, null);
          assert.equal(pendingJob.currentExecution, null);
          assert.ok(pendingJob.renditionPending.full);
          assert.equal(
            (await usage.readUsage(owner)).processing.usedSeconds,
            1,
          );
          assert.equal((await usage.readUsage(owner)).storage.retainedBytes, 0);
          assert.equal(
            (await sharedGuest.lookupReady(cloudUrl, false)).recipeSnapshot
              .trimEnabled,
            false,
          );
          // Process death after ACK leaves a Mongo marker; a new service can reclaim it.
          await jobRecords.updateOne(
            { _id: cloudJob._id },
            {
              $set: {
                'renditionPending.leaseToken': randomUUID(),
                'renditionPending.leaseUntil': new Date(Date.now() - 1),
              },
            },
          );
          let release;
          const gate = new Promise((resolve) => {
            release = resolve;
          });
          const derive = derivation.derive;
          derivation.derive = async (...args) => {
            await gate;
            return derive(...args);
          };
          const restarted = new JobRenditionService(
            jobRecords,
            transactions,
            sharedGuest,
            accounts.access,
            usage,
          );
          const finalizing = restarted.finalizeOne();
          for (let index = 0; index < 100; index++) {
            const row = await jobRecords.findById(cloudJob._id).lean();
            if (row.renditionPending?.leaseUntil > new Date()) break;
            await delay(10);
          }
          const otherReplica = new JobRenditionService(
            jobRecords,
            transactions,
            sharedGuest,
            accounts.access,
            usage,
          );
          assert.equal(await otherReplica.finalizeOne(), false);
          const recovery = new WorkerRecoveryService(
            connection,
            model('WorkerAttempt'),
            model('WorkerSlot'),
            jobRecords,
            usage,
          );
          assert.equal(
            await recovery.recoverOne(new Date(Date.now() + 600_000)),
            false,
          );
          assert.equal(
            (await jobRecords.findById(cloudJob._id)).status,
            'uploading_result',
          );
          release();
          await finalizing;
          derivation.derive = derive;
          const delivered = await jobRecords.findById(cloudJob._id).lean();
          assert.equal(delivered.status, 'ready');
          assert.equal(delivered.renditionPending, null);
          assert.equal(delivered.recipeSnapshot.trimEnabled, false);
          assert.equal(delivered.outputRecipeSnapshot.trimEnabled, true);
          assert.ok(validComparisonRanges(delivered.comparisonRanges));
          assert.equal(derivations, beforeDsp + 1);
          assert.equal(
            (await model('WorkerAttempt').findById(attemptId)).attemptNumber,
            1,
          );
          assert.equal(
            await model('WorkerAttempt').countDocuments({
              jobId: cloudJob._id,
            }),
            1,
          );
          assert.equal(
            (await usage.readUsage(owner)).processing.usedSeconds,
            1,
          );
          const retained = (await usage.readUsage(owner)).storage.retainedBytes;
          assert.equal(
            retained,
            cloudInput.bytes + delivered.outputObject.bytes,
          );
          assert.equal(
            await model('NotificationOutbox').countDocuments({
              jobId: cloudJob._id,
              outcome: 'ready',
            }),
            1,
          );
          assert.equal(await restarted.finalizeOne(), false);
          assert.equal(
            (await attempts.complete(principal, attemptId, dto)).replayed,
            true,
          );
          assert.equal(
            (await usage.readUsage(owner)).storage.retainedBytes,
            retained,
          );
          assert.equal(derivations, beforeDsp + 1);
          // Cancellation racing a cached rendition cannot commit a private output or receipt.
          const cancellation = await jobs.createForSharedInput(
            String(cancelledOwner),
            ready.input,
            randomUUID(),
            metadata,
            false,
            cloudInput,
            cloudSourceKey,
            cloudResultKey,
            undefined,
            null,
            undefined,
            fullRecipe,
            true,
          );
          const cancelJob = await jobRecords
            .findById(cancellation.jobId)
            .lean();
          await transactions.run(async (session) => {
            await usage.settleJob({ ...cancelJob, status: 'ready' }, session);
            await jobRecords.updateOne(
              { _id: cancelJob._id },
              {
                $set: {
                  status: 'uploading_result',
                  renditionPending: {
                    full: pendingJob.renditionPending.full,
                    attemptId: randomUUID(),
                    queuedAt: new Date(),
                    nextAt: new Date(),
                    leaseUntil: null,
                    leaseToken: null,
                    attempts: 0,
                  },
                },
              },
              { session, runValidators: true },
            );
          });
          const prepare = sharedGuest.prepareRequestedOutput;
          sharedGuest.prepareRequestedOutput = async (...args) => {
            const output = await prepare.apply(sharedGuest, args);
            await jobRecords.updateOne(
              { _id: cancelJob._id },
              { $set: { status: 'cancelled' }, $inc: { revision: 1 } },
            );
            return output;
          };
          await restarted.finalizeOne();
          sharedGuest.prepareRequestedOutput = prepare;
          const cancelled = await jobRecords.findById(cancelJob._id).lean();
          assert.equal(cancelled.status, 'cancelled');
          assert.equal(cancelled.outputObject, null);
          assert.equal(
            (await usage.readUsage(cancelledOwner)).storage.retainedBytes,
            0,
          );
          assert.equal(
            await model('NotificationOutbox').countDocuments({
              jobId: cancelJob._id,
            }),
            0,
          );
          assert.equal(
            derivations,
            beforeDsp + 1,
            'cache/cancellation never repeats inference or DSP',
          );
        },
      );
    },
  );
});

test(
  'real-policy ten concurrent confirmed-source handoffs preserve accounting with a production-sized Mongo pool',
  { timeout: 90000 },
  async (t) => {
    const native = await IsolatedServices.create();
    let connection;
    const restorations = [];
    t.after(async () => {
      for (const restore of restorations.reverse()) restore();
      await connection?.close();
      await native.stop();
    });
    const { mongoUri } = await native.startDatabases({ replicaSet: true });
    connection = await createConnection(mongoUri, {
      maxPoolSize: 10,
    }).asPromise();
    assert.equal(connection.getClient().options.maxPoolSize, 10);
    for (const { name, schema } of PROCESSING_MODELS)
      connection.model(name, schema);
    const policyRecords = connection.model(
      AccountPolicy.name,
      AccountPolicySchema,
    );
    const overrides = connection.model(
      AccountPolicyOverride.name,
      AccountPolicyOverrideSchema,
    );
    const owner = new Types.ObjectId();
    const accounts = await accountFixture(connection, [String(owner)]);
    await Promise.all(
      Object.values(connection.models).map((model) => model.init()),
    );
    const model = (name) => connection.model(name);
    const config = new ConfigService({
      AUDIO_PROCESSING_ENABLED: true,
      PROCESSING_URL_SECONDS: 900,
    });
    await policyRecords.create({
      _id: STANDARD_ACCOUNT_POLICY_ID,
      ...DEFAULT_ACCOUNT_POLICY_VALUES,
      acceptNewJobs: true,
      maintenanceMessageEn: '',
      maintenanceMessageAr: null,
      revision: 1,
      updatedBy: 'fixture',
      updatedAt: new Date(),
    });
    const policies = new AccountPolicyService(
      policyRecords,
      overrides,
      model('ProcessingAdmissionFence'),
      accounts.users,
      {},
      config,
    );
    await policies.onModuleInit();
    const transactions = new ProcessingTransactions(connection);
    const usage = new ProcessingUsageService(
      model('AccountUsagePeriod'),
      model('AccountDailyUsagePeriod'),
      model('ProcessingReservation'),
      model('UploadGrantReceipt'),
      model('DownloadGrantReceipt'),
      model('ServiceUsagePeriod'),
      model('Job'),
      accounts.users,
      policies,
      config,
    );
    const admission = new ProcessingAdmissionService(
      model('ProcessingAdmissionFence'),
      accounts.users,
      model('Job'),
      policies,
      usage,
      config,
    );
    // No provider or storage client is installed: these inputs are already confirmed.
    const jobs = new JobsService(
      model('Job'),
      {},
      transactions,
      accounts.access,
      admission,
      usage,
      {},
    );
    const webmPath = join(native.directory, 'confirmed-source.webm');
    await promisify(execFile)(process.env.FFMPEG_BINARY || 'ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.25',
      '-vn',
      '-c:a',
      'libopus',
      '-b:a',
      '70k',
      webmPath,
    ]);
    const audio = await readFile(webmPath);
    const input = {
      bytes: audio.length,
      durationSeconds: 1,
      extension: 'webm',
      contentType: 'audio/webm',
      sha256: digest(audio),
    };
    const recipe = workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID, false);
    const pending = Array.from({ length: 10 }, (_, index) => {
      const importId = new Types.ObjectId();
      const generation = randomUUID();
      const sourceUrl = `https://www.youtube.com/watch?v=tx-batch${String(index + 1).padStart(3, '0')}`;
      const sourceKey = sharedSourceKey(sourceUrl);
      return {
        importId,
        sourceUrl,
        sourceKey,
        generation,
        resultKey: sharedResultKey(sourceKey, generation, recipe.recipeDigest),
        requestId: randomUUID(),
        acquisitionId: randomUUID(),
        inputObject: {
          key: `shared/url/${sourceKey}/${generation}/input/source.webm`,
          bytes: input.bytes,
          contentType: input.contentType,
          sha256: input.sha256,
          etag: '"fixture-confirmed-source"',
        },
      };
    });
    for (const item of pending) {
      await transactions.run(async (session) => {
        await accounts.access.assertActive(owner, session);
        await usage.reserveForImport(item.importId, owner, 1200, session);
      });
      await model('SharedMediaSource').create({
        _id: item.sourceKey,
        sourceUrl: item.sourceUrl,
        provider: 'youtube',
        generation: item.generation,
        state: 'ready',
        producerImportId: item.importId,
        inputKey: item.inputObject.key,
        input,
        inputObject: item.inputObject,
        sourceTitle: 'Synthetic confirmed native audio',
        acquiredAt: new Date(),
      });
    }
    await model('ProcessingAdmissionFence').create({
      _id: 'settings',
      revision: 0,
    });
    const before = await usage.readUsage(owner);
    assert.equal(before.processing.reservedSeconds, 12000);

    const events = [];
    const acquisitionIds = new Set(pending.map((item) => item.acquisitionId));
    for (const method of ['log', 'warn', 'error']) {
      const original = Logger.prototype[method];
      Logger.prototype[method] = function (entry, ...args) {
        if (
          entry?.event === 'processing-transaction' &&
          acquisitionIds.has(entry.acquisition_id)
        ) {
          events.push(entry);
          return;
        }
        return original.call(this, entry, ...args);
      };
      restorations.push(() => {
        Logger.prototype[method] = original;
      });
    }

    let delayedQueries = 0;
    let realPolicyReads = 0;
    let snapshotChecks = 0;
    let snapshotFenceWrites = 0;
    const snapshotScope = new AsyncLocalStorage();
    const queryDelayMs = 50;
    for (const registered of Object.values(connection.models)) {
      const queryPrototype = registered.Query.prototype;
      const original = queryPrototype.exec;
      queryPrototype.exec = async function (...args) {
        if (
          snapshotScope.getStore() === true &&
          registered.modelName === 'User' &&
          ['updateOne', 'updateMany', 'findOneAndUpdate'].includes(this.op) &&
          this.getUpdate()?.$inc?.accessRevision
        )
          snapshotFenceWrites++;
        if (this.getOptions().session) {
          delayedQueries += 1;
          if (
            [AccountPolicy.name, AccountPolicyOverride.name].includes(
              registered.modelName,
            )
          )
            realPolicyReads += 1;
          // Controlled command latency exposes retry starvation on loopback while
          // real policy reads, fence writes and driver transaction retries execute.
          await delay(queryDelayMs);
        }
        return original.apply(this, args);
      };
      restorations.push(() => {
        queryPrototype.exec = original;
      });
    }
    const create = (item) =>
      jobs.createForSharedInput(
        String(owner),
        input,
        item.requestId,
        {
          policyVersion: 2,
          preparationProfileId: 'audio-cap-aac-lc-160-v1',
          source: 'youtube',
          sourceKind: 'url',
          sourceUrl: item.sourceUrl,
        },
        false,
        item.inputObject,
        item.sourceKey,
        item.resultKey,
        {
          startedAt: new Date(),
          stages: [],
          acquisitionId: item.acquisitionId,
        },
        null,
        item.importId,
        recipe,
      );
    const started = performance.now();
    const snapshots = snapshotScope.run(true, async () => {
      for (let index = 0; index < 10; index++) {
        await accounts.access.assertActiveReadOnly(owner);
        await usage.readUsage(owner);
        snapshotChecks++;
        await delay(queryDelayMs);
      }
    });
    const [results] = await Promise.all([
      Promise.allSettled(pending.map(create)),
      snapshots,
    ]);
    const accepted = results.filter((result) => result.status === 'fulfilled');
    const failures = results.filter((result) => result.status === 'rejected');
    t.diagnostic(
      JSON.stringify({
        fixture: 'real-policy-handoff-contention',
        acquisitions: 10,
        max_pool_size: 10,
        query_delay_ms: queryDelayMs,
        delayed_queries: delayedQueries,
        real_policy_reads: realPolicyReads,
        concurrent_snapshot_checks: snapshotChecks,
        snapshot_access_revision_writes: snapshotFenceWrites,
        accepted: accepted.length,
        failed: failures.length,
        logged_callback_failures: events.filter(
          (entry) => entry.result === 'CALLBACK_FAILED',
        ).length,
        callback_attempts: events
          .filter((entry) => ['SUCCEEDED', 'FAILED'].includes(entry.result))
          .reduce((total, entry) => total + entry.callback_count, 0),
        suppressed_callback_failures: events
          .filter((entry) => ['SUCCEEDED', 'FAILED'].includes(entry.result))
          .reduce(
            (total, entry) => total + entry.suppressed_callback_failures,
            0,
          ),
        elapsed_ms: Math.round(performance.now() - started),
        failures: failures.map((result) =>
          safeProcessingFailure(result.reason),
        ),
      }),
    );
    assert.equal(snapshotChecks, 10);
    assert.equal(
      snapshotFenceWrites,
      0,
      'snapshot access checks must not write the admission fence',
    );
    assert.equal(
      realPolicyReads,
      20,
      'each handoff resolves one fenced policy and override snapshot',
    );
    assert.equal(
      accepted.length,
      10,
      'all ten globally fenced handoffs must finish',
    );
    assert.equal(
      new Set(accepted.map((result) => result.value.jobId)).size,
      10,
    );
    const queued = await model('Job').find({ userId: owner }).lean();
    assert.equal(queued.length, 10);
    for (const job of queued) {
      assert.equal(job.status, 'queued');
      assert.equal(job.inputObject.bytes, audio.length);
      assert.equal(job.inputObject.sha256, input.sha256);
      assert.equal(job.confirmedUploadBytes, audio.length);
      assert.equal(job.admissionSnapshot.settingsRevision, 1);
    }
    assert.equal(
      (await model('ProcessingAdmissionFence').findById('settings')).revision,
      10,
    );
    for (const item of pending)
      assert.equal(
        (await model('ProcessingReservation').findById(item.importId)).state,
        'released',
      );
    const after = await usage.readUsage(owner);
    assert.equal(after.processing.reservedSeconds, 10);
    assert.equal(after.processing.usedSeconds, 0);
    assert.equal(after.uploads.monthlyGrants, 10);
    assert.equal(after.uploads.confirmedBytes, audio.length * 10);
    assert.equal(
      await model('ProcessingReservation').countDocuments({ accountId: owner }),
      20,
    );
    assert.equal(
      await model('UploadGrantReceipt').countDocuments({ accountId: owner }),
      10,
    );
    const replayed = await Promise.all(pending.map(create));
    assert.deepEqual(
      new Set(replayed.map((item) => item.jobId)),
      new Set(queued.map((item) => String(item._id))),
    );
    const replayUsage = await usage.readUsage(owner);
    assert.deepEqual(replayUsage.processing, after.processing);
    assert.deepEqual(replayUsage.uploads, after.uploads);
    assert.equal(
      (await model('ProcessingAdmissionFence').findById('settings')).revision,
      10,
    );
    assert.equal(await model('Job').countDocuments({ userId: owner }), 10);
  },
);

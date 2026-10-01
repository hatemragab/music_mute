import 'reflect-metadata';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { createConnection, Types } from 'mongoose';
import { DEFAULT_ACCOUNT_POLICY_VALUES } from '../dist/admin-settings/account-policy.schema.js';
import { ProcessingAdmissionService } from '../dist/admin-settings/processing-admission.service.js';
import { JobActionsService } from '../dist/jobs/job-actions.service.js';
import { JobDeletionService } from '../dist/jobs/job-deletion.service.js';
import { JobsService } from '../dist/jobs/jobs.service.js';
import { ProcessingUsageService } from '../dist/processing-usage/processing-usage.service.js';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { sharedSourceKey } from '../dist/shared-media/shared-media-key.js';
import { SharedMediaService } from '../dist/shared-media/shared-media.service.js';
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
import { MediaImportSchema } from '../dist/url-imports/media-import.schema.js';
import { accountFixture } from './helpers/account-fixture.mjs';
import { IsolatedServices } from './helpers/isolated-services.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('base64');
const videoUrls = [
  'https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=30&feature=share',
  'https://youtu.be/aqz-KE-bpKQ?si=fixture',
  'https://www.youtube.com/shorts/aqz-KE-bpKQ',
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
  const records = connection.model('MediaImport', MediaImportSchema);
  const cleanupTasks = connection.model(
    'StorageCleanupTask',
    StorageCleanupTaskSchema,
  );
  const owners = Array.from({ length: 5 }, () => new Types.ObjectId());
  const accounts = await accountFixture(connection, owners.map(String));
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
    copyObject: async (source, key) => {
      assert.deepEqual(objects.get(source.key), source);
      const intent = await model('SharedMediaArtifact').findById(key).lean();
      assert.ok(intent, 'the durable artifact intent precedes its COPY');
      assert.equal(intent.kind, 'output');
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
  );
  await imports.initialize();
  const processor = new ImportProcessor(
    imports,
    {
      download: async (_url, _files, path, _limits, _signal, executionId) => {
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
      assert.ok(await queue.getJob(importExecutionJobId(waiter)));
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
      assert.equal(providerCalls, 1);
      assert.equal(sourceUploads, 1);
      assert.equal(copies.length, 1);
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
});

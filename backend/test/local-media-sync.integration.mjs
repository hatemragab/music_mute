import 'reflect-metadata';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { ConfigService } from '@nestjs/config';
import { createConnection, Types } from 'mongoose';
import { DEFAULT_ACCOUNT_POLICY_VALUES } from '../dist/admin-settings/account-policy.schema.js';
import { LocalMediaSyncsService } from '../dist/local-media-syncs/local-media-syncs.service.js';
import { LocalMediaValidationService } from '../dist/local-media-syncs/local-media-validation.service.js';
import { LOCAL_MEDIA_PROFILE_ID } from '../dist/local-media-syncs/local-media-sync.dto.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingUsageService } from '../dist/processing-usage/processing-usage.service.js';
import { StorageCleanupTaskSchema } from '../dist/storage/storage-cleanup-task.schema.js';
import { StorageCleanupService } from '../dist/storage/storage-cleanup.service.js';
import { presentJob } from '../dist/jobs/jobs.presenter.js';
import { accountFixture } from './helpers/account-fixture.mjs';
import { IsolatedServices } from './helpers/isolated-services.mjs';
const exec = promisify(execFile);
const digest = (bytes) => createHash('sha256').update(bytes).digest('base64');
const code = (value) => value?.getResponse?.().code;

test('local media pair publishes once, counts transfers/storage without cloud quota, and fences recovery', async (t) => {
  const native = await IsolatedServices.create();
  let connection;
  t.after(async () => {
    await connection?.close();
    await native.stop();
  });
  const { mongoUri } = await native.startDatabases({ replicaSet: true });
  connection = await createConnection(mongoUri).asPromise();
  for (const { name, schema } of PROCESSING_MODELS)
    connection.model(name, schema);
  const tasks = connection.model(
    'StorageCleanupTask',
    StorageCleanupTaskSchema,
  );
  const owners = Array.from({ length: 7 }, () => new Types.ObjectId());
  const accounts = await accountFixture(connection, owners.map(String));
  await Promise.all(
    Object.values(connection.models).map((model) => model.init()),
  );
  const model = (name) => connection.model(name);
  let values = { ...DEFAULT_ACCOUNT_POLICY_VALUES };
  const policies = {
    effective: async () => ({
      values,
      acceptNewJobs: false,
      globalRevision: 1,
    }),
    touchGlobalFence: async () => {},
  };
  const { stdout: found } = await exec('which', [
    process.env.FFPROBE_BINARY || 'ffprobe',
  ]);
  const ffprobe = found.trim();
  const ffmpeg = join(dirname(ffprobe), 'ffmpeg');
  const config = new ConfigService({
    AUDIO_PROCESSING_ENABLED: false,
    STORAGE_BUCKET: 'synthetic-local-sync',
    URL_IMPORT_FFPROBE_PATH: ffprobe,
  });
  const mp3Path = join(native.directory, 'stereo.mp3');
  await exec(ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-b:a',
    '160k',
    mp3Path,
  ]);
  const audio = await readFile(mp3Path);
  const { stdout: probe } = await exec(ffprobe, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    mp3Path,
  ]);
  const durationSeconds = Number(JSON.parse(probe).format.duration);
  const declaration = {
    extension: 'mp3',
    contentType: 'audio/mpeg',
    bytes: audio.length,
    durationSeconds,
    sha256: digest(audio),
  };
  const objects = new Map();
  let gets = 0;
  let granted = 0;
  const storage = {
    createWorkerOutputGrant: async (reservation, expiresAt) => {
      granted++;
      return {
        method: 'PUT',
        url: `https://fixture.invalid/${granted}`,
        headers: {
          'Content-Type': reservation.contentType,
          'If-None-Match': '*',
        },
        expiresAt: expiresAt.toISOString(),
      };
    },
    findUploadedObject: async (reservation) =>
      objects.get(reservation.key)?.identity ?? null,
    deleteObject: async (key) => {
      objects.delete(key);
    },
  };
  const rawStorage = {
    send: async (command) => {
      gets++;
      const item = objects.get(command.input.Key);
      assert.ok(item);
      assert.equal(command.input.IfMatch, item.identity.etag);
      return { Body: Readable.from([item.bytes]) };
    },
  };
  const validation = new LocalMediaValidationService(rawStorage, config);
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
  const cleanup = new StorageCleanupService(tasks, storage);
  let restricted = false;
  const restrictions = {
    current: async () => (restricted ? { status: 'active' } : null),
  };
  const service = new LocalMediaSyncsService(
    model('LocalMediaSync'),
    model('Job'),
    accounts.users,
    new ProcessingTransactions(connection),
    accounts.access,
    policies,
    usage,
    storage,
    cleanup,
    validation,
    restrictions,
    connection,
  );
  await service.onModuleInit();
  const dto = (requestId = randomUUID()) => ({
    requestId,
    profileId: LOCAL_MEDIA_PROFILE_ID,
    sourceKind: 'url',
    sourceTitle: 'Synthetic full timeline',
    sourceUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    original: declaration,
    vocals: declaration,
  });
  const upload = async (receipt, originalBytes = audio, vocalBytes = audio) => {
    const stored = await model('LocalMediaSync')
      .findById(receipt.syncId)
      .lean();
    for (const [artifact, bytes] of [
      [stored.original, originalBytes],
      [stored.vocals, vocalBytes],
    ])
      objects.set(artifact.key, {
        bytes,
        identity: {
          key: artifact.key,
          etag: `"${digest(bytes).slice(0, 20)}"`,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          contentType: artifact.contentType,
        },
      });
    return stored;
  };
  const reauthorize = async () => {};
  const owner = String(owners[0]);
  const request = dto();
  const receipt = await service.create(owner, request, 100);
  assert.equal(receipt.committed, false);
  assert.equal(receipt.status, 'awaiting_upload');
  assert.equal(await model('Job').countDocuments(), 0);
  assert.equal(await model('ProcessingReservation').countDocuments(), 0);
  assert.equal(await tasks.countDocuments({ ownerUserId: owners[0] }), 2);
  const repeated = await service.create(owner, request, 100);
  assert.equal(repeated.syncId, receipt.syncId);
  assert.equal((await usage.readUsage(owners[0])).uploads.dailyGrants, 2);
  await assert.rejects(
    service.create(owner, { ...request, sourceTitle: 'Changed' }, 100),
    (error) => code(error) === 'IDEMPOTENCY_CONFLICT',
  );
  await assert.rejects(
    service.get(String(owners[1]), receipt.syncId),
    (error) => code(error) === 'JOB_NOT_FOUND',
  );
  await assert.rejects(
    service.complete(owner, receipt.syncId, 100, reauthorize),
    (error) => code(error) === 'UPLOAD_NOT_READY',
  );
  const stored = await upload(receipt);
  const ready = await service.complete(owner, receipt.syncId, 100, reauthorize);
  assert.equal(ready.committed, true);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.uploadGrants, null);
  const job = await model('Job').findById(receipt.jobId).lean();
  assert.equal(job.processingOrigin, 'local_device');
  assert.equal(job.attemptNumber, 0);
  assert.equal(job.currentExecution, null);
  assert.equal(job.queuedAt, null);
  assert.equal(job.admissionSnapshot, null);
  assert.equal(job.sharedSourceKey, null);
  assert.equal(job.sharedResultKey, null);
  assert.equal(job.recipeSnapshot.trimEnabled, false);
  assert.equal(job.recipeSnapshot.denoiseEnabled, false);
  assert.equal(presentJob(job).canDownloadInput, true);
  assert.equal(presentJob(job).canDownloadOutput, true);
  assert.equal(presentJob(job).trimEnabled, false);
  assert.equal(
    presentJob(job).sourceUrl,
    'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  );
  assert.equal(presentJob(job).recipeDigest, job.recipeSnapshot.recipeDigest);
  assert.equal(presentJob(job).localProfileId, LOCAL_MEDIA_PROFILE_ID);
  assert.equal(presentJob(job).input.sha256, digest(audio));
  assert.equal(presentJob(job).output.sha256, digest(audio));
  assert.equal(presentJob(job).output.bytes, audio.length);
  assert.equal(presentJob(job).output.durationSeconds, durationSeconds);
  assert.equal(
    JSON.stringify(presentJob(job)).includes(stored.original.key),
    false,
  );
  assert.equal(
    JSON.stringify(presentJob(job)).includes(stored.vocals.key),
    false,
  );
  assert.equal(await tasks.countDocuments({ ownerUserId: owners[0] }), 0);
  assert.equal(
    await model('NotificationOutbox').countDocuments({ jobId: job._id }),
    1,
  );
  const checked = await usage.readUsage(owners[0]);
  assert.equal(checked.processing.usedSeconds, 0);
  assert.equal(checked.processing.reservedSeconds, 0);
  assert.equal(checked.uploads.confirmedBytes, audio.length * 2);
  assert.equal(checked.storage.retainedBytes, audio.length * 2);
  const getsAfterCommit = gets;
  await Promise.all([
    service.complete(owner, receipt.syncId, 100, reauthorize),
    service.complete(owner, receipt.syncId, 100, reauthorize),
  ]);
  assert.equal(gets, getsAfterCommit);
  assert.equal(await model('Job').countDocuments(), 1);
  assert.equal(
    (await usage.readUsage(owners[0])).uploads.confirmedBytes,
    audio.length * 2,
  );
  // Explicit renewal is idempotent and charges both grants once.
  const pending = await service.create(String(owners[1]), dto(), 100);
  const grantRequest = randomUUID();
  await service.grants(String(owners[1]), pending.syncId, grantRequest, 100);
  await service.grants(String(owners[1]), pending.syncId, grantRequest, 100);
  assert.equal((await usage.readUsage(owners[1])).uploads.dailyGrants, 4);
  // Real byte checksum validation catches a lying HEAD fixture before publication.
  const tampered = Buffer.from(audio);
  tampered[100] ^= 1;
  await upload(pending, audio, tampered);
  await assert.rejects(
    service.complete(String(owners[1]), pending.syncId, 100, reauthorize),
    (error) => code(error) === 'UPLOAD_NOT_READY',
  );
  assert.equal(await model('Job').countDocuments({ userId: owners[1] }), 0);
  assert.equal((await usage.readUsage(owners[1])).uploads.confirmedBytes, 0);
  // Account revocation during asynchronous validation is rechecked at publication.
  const revoking = await service.create(String(owners[2]), dto(), 100);
  await upload(revoking);
  await assert.rejects(
    service.complete(String(owners[2]), revoking.syncId, 100, async () => {
      await accounts.users.updateOne(
        { _id: owners[2] },
        { $set: { sessionsRevokedAfterSec: 100 } },
      );
    }),
    (error) => code(error) === 'UNAUTHENTICATED',
  );
  assert.equal(await model('Job').countDocuments({ userId: owners[2] }), 0);
  restricted = true;
  await assert.rejects(
    service.create(String(owners[3]), dto(), 100),
    (error) => code(error) === 'ACCOUNT_RESTRICTED',
  );
  restricted = false;
  // Limits rollback the whole reservation/commit transaction, retaining no phantom counters.
  values = { ...DEFAULT_ACCOUNT_POLICY_VALUES, dailyUploadGrants: 1 };
  await assert.rejects(
    service.create(String(owners[3]), dto(), 100),
    (error) => code(error) === 'UPLOAD_GRANT_LIMIT_REACHED',
  );
  assert.equal(
    await model('LocalMediaSync').countDocuments({ userId: owners[3] }),
    0,
  );
  values = { ...DEFAULT_ACCOUNT_POLICY_VALUES };
  const limited = await service.create(String(owners[3]), dto(), 100);
  await upload(limited);
  values = {
    ...DEFAULT_ACCOUNT_POLICY_VALUES,
    maxRetainedOutputBytes: audio.length * 2 - 1,
  };
  await assert.rejects(
    service.complete(String(owners[3]), limited.syncId, 100, reauthorize),
    (error) => code(error) === 'RETAINED_STORAGE_LIMIT_REACHED',
  );
  assert.equal(await model('Job').countDocuments({ userId: owners[3] }), 0);
  assert.equal((await usage.readUsage(owners[3])).uploads.confirmedBytes, 0);
  values = { ...DEFAULT_ACCOUNT_POLICY_VALUES };
  await model('LocalMediaSync').collection.updateOne(
    { _id: new Types.ObjectId(limited.syncId) },
    { $set: { expiresAt: new Date(0) } },
  );
  assert.equal(
    (await service.get(String(owners[3]), limited.syncId)).status,
    'expired',
  );
  await assert.rejects(
    service.complete(String(owners[3]), limited.syncId, 100, reauthorize),
    (error) => code(error) === 'UPLOAD_RESERVATION_EXPIRED',
  );
  assert.equal(await tasks.countDocuments({ ownerUserId: owners[3] }), 2);
  // Preserve WAV/FLAC originals byte-for-byte and validate them with real tools.
  for (const [extension, contentType, index] of [
    ['wav', 'audio/wav', 4],
    ['flac', 'audio/flac', 5],
  ]) {
    const path = join(native.directory, `original.${extension}`);
    await exec(ffmpeg, ['-v', 'error', '-i', mp3Path, path]);
    const bytes = await readFile(path);
    const { stdout } = await exec(ffprobe, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'json',
      path,
    ]);
    const originalDeclaration = {
      extension,
      contentType,
      bytes: bytes.length,
      durationSeconds: Number(JSON.parse(stdout).format.duration),
      sha256: digest(bytes),
    };
    const nextDto = {
      ...dto(),
      sourceKind: 'file',
      original: originalDeclaration,
    };
    delete nextDto.sourceUrl;
    const next = await service.create(String(owners[index]), nextDto, 100);
    await upload(next, bytes, audio);
    assert.equal(
      (
        await service.complete(
          String(owners[index]),
          next.syncId,
          100,
          reauthorize,
        )
      ).committed,
      true,
    );
    const saved = await model('Job').findById(next.jobId).lean();
    assert.equal(saved.inputReservation.extension, extension);
    assert.equal(saved.inputObject.sha256, digest(bytes));
    assert.equal(saved.inputObject.bytes, bytes.length);
    assert.equal(saved.inputObject.contentType, contentType);
  }
  // Deleted account-owned jobs cannot be resurrected using a committed sync receipt.
  await model('Job').updateOne(
    { _id: job._id },
    { $set: { deletedAt: new Date() } },
  );
  await assert.rejects(
    service.get(owner, receipt.syncId),
    (error) => code(error) === 'JOB_NOT_FOUND',
  );
  assert.equal(stored.original.key.startsWith(`users/${owner}/`), true);
});

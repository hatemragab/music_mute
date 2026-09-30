import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import {
  WorkerAttempt,
  WorkerAttemptSchema,
} from '../dist/worker-fleet/jobs/worker-attempt.schema.js';
import {
  WorkerSlot,
  WorkerSlotSchema,
} from '../dist/worker-fleet/machines/worker-slot.schema.js';
import {
  StorageCleanupTask,
  StorageCleanupTaskSchema,
} from '../dist/storage/storage-cleanup-task.schema.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { JobDeletionService } from '../dist/jobs/job-deletion.service.js';
import { JobRetentionService } from '../dist/jobs/job-retention.service.js';
import { JobsService } from '../dist/jobs/jobs.service.js';
import { JobActionsService } from '../dist/jobs/job-actions.service.js';
import { requestHash } from '../dist/jobs/job-request.js';
import { IsolatedServices } from './helpers/isolated-services.mjs';

const DAY_MS = 86_400_000;
const codeIs = (code) => (error) => error?.getResponse?.().code === code;

test('deleted job retention coordinates S3 cleanup, usage release, live references, and request replay', async (t) => {
  const services = await IsolatedServices.create();
  t.after(() => services.stop());
  const { mongoUri } = await services.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri, {
    bufferCommands: false,
    sanitizeFilter: true,
  }).asPromise();
  t.after(() => connection.close());
  const models = [
    ...PROCESSING_MODELS,
    { name: WorkerAttempt.name, schema: WorkerAttemptSchema },
    { name: WorkerSlot.name, schema: WorkerSlotSchema },
    { name: StorageCleanupTask.name, schema: StorageCleanupTaskSchema },
  ];
  for (const { name, schema } of models) connection.model(name, schema);
  await Promise.all(models.map(({ name }) => connection.model(name).init()));
  const jobs = connection.model('Job');
  const attempts = connection.model('WorkerAttempt');
  const slots = connection.model('WorkerSlot');
  const events = connection.model('NotificationOutbox');
  const deliveries = connection.model('NotificationDelivery');
  const errors = connection.model('JobError');
  const receipts = connection.model('PurgedJobRequest');
  const tasks = connection.model('StorageCleanupTask');
  const transactions = new ProcessingTransactions(connection);
  const swept = [];
  let releaseCount = 0;
  let storageComplete = true;
  const storage = {
    deleteVersionsForKey: async (key) => {
      swept.push(key);
      return storageComplete;
    },
  };
  const usage = {
    releaseRetainedOutput: async () => {
      releaseCount += 1;
    },
  };
  const deletion = new JobDeletionService(
    jobs,
    events,
    transactions,
    storage,
    usage,
    { getOrThrow: () => 10 },
  );
  const retention = new JobRetentionService(jobs, transactions, storage);
  const owner = new Types.ObjectId();
  const id = new Types.ObjectId();
  const started = new Date();
  const input = {
    extension: 'mp3',
    contentType: 'audio/mpeg',
    bytes: 4096,
    durationSeconds: 30,
    sha256: Buffer.alloc(32, 7).toString('base64'),
  };
  const inputKey = `users/${owner}/jobs/${id}/input/source.mp3`;
  const outputKey = `users/${owner}/jobs/${id}/attempts/ready/vocals.mp3`;
  const orphanKey = `users/${owner}/jobs/${id}/attempts/lost/vocals.mp3`;
  const metadata = {
    policyVersion: 2,
    preparationProfileId: 'audio-cap-aac-lc-160-v1',
    source: 'audio_file',
  };
  const job = await jobs.create({
    _id: id,
    userId: owner,
    requestId: randomUUID(),
    requestHash: requestHash({ operation: 'create', input, metadata }),
    status: 'ready',
    finishedAt: started,
    inputReservation: { ...input, key: inputKey },
    outputObject: {
      key: outputKey,
      versionId: 'output-v1',
      bytes: 512,
      sha256: input.sha256,
      contentType: input.contentType,
    },
    retainedOutputAccountedAt: started,
  });
  const attempt = await attempts.create({
    _id: randomUUID(),
    jobId: id,
    machineId: randomUUID(),
    workerId: randomUUID(),
    gpuId: 'fixture-gpu',
    sessionId: randomUUID(),
    incarnation: randomUUID(),
    claimRequestId: randomUUID(),
    attemptNumber: 1,
    state: 'lost',
    stage: 'uploading',
    leaseExpiresAt: started,
    deadlineAt: started,
    finishedAt: started,
    outputReservation: {
      key: orphanKey,
      bytes: 512,
      sha256: input.sha256,
      contentType: 'audio/mpeg',
      measuredDurationSeconds: 30,
      grantExpiresAt: started,
    },
  });
  const event = await events.create({
    jobId: id,
    userId: owner,
    outcome: 'ready',
    state: 'pending',
  });
  const delivery = await deliveries.create({
    outboxId: event._id,
    registrationId: new Types.ObjectId(),
    bindingRevision: 1,
    status: 'pending',
  });
  const error = await errors.create({
    jobId: id,
    eventId: 'processing-fixture',
    classification: 'processing',
    code: 'OUTPUT_UPLOAD_FAILED',
    message: 'Fixture failure',
    stage: 'uploading_result',
    createdAt: started,
  });

  // User deletion first completes coordinated storage/accounting; retention cannot bypass it.
  await deletion.delete(owner.toString(), id.toString());
  assert.equal(
    (await deliveries.findById(delivery._id).lean()).status,
    'ineligible',
    'deletion closes pending notification children',
  );
  const cleanupAt = new Date(started.getTime() + 600_000);
  storageComplete = false;
  await deletion.cleanupDue(cleanupAt);
  assert.equal((await jobs.findById(id).lean()).cleanupCompletedAt, null);
  assert.equal(releaseCount, 0);
  storageComplete = true;
  await deletion.cleanupDue(new Date(cleanupAt.getTime() + 2_000));
  const cleaned = await jobs.findById(id).lean();
  assert.ok(cleaned.cleanupCompletedAt instanceof Date);
  assert.ok(cleaned.retainedOutputReleasedAt instanceof Date);
  assert.equal(releaseCount, 1);
  await retention.purgeDue(
    new Date(cleaned.cleanupCompletedAt.getTime() + 29 * DAY_MS),
  );
  assert.ok(await jobs.findById(id));

  const purgeAt = new Date(cleaned.cleanupCompletedAt.getTime() + 31 * DAY_MS);
  const retry = await jobs.create({
    userId: owner,
    requestId: randomUUID(),
    requestHash: 'f'.repeat(64),
    status: 'ready',
    finishedAt: started,
    logicalAudioId: id,
    retryOfJobId: id,
    inputReservation: { ...input, key: inputKey },
  });
  const retryDue = async () => {
    await jobs.updateOne({ _id: id }, { $set: { retentionNextAt: null } });
    await retention.purgeDue(purgeAt);
  };
  swept.length = 0;
  await retryDue();
  assert.ok(await jobs.findById(id));
  assert.equal(
    swept.length,
    0,
    'live logical root and shared input must not be swept',
  );
  await jobs.updateOne(
    { _id: retry._id },
    { $set: { deletedAt: started, cleanupCompletedAt: purgeAt } },
  );

  const slot = await slots.create({
    _id: attempt.workerId,
    machineId: attempt.machineId,
    gpuId: 'fixture-gpu',
    slotIndex: 0,
    sessionId: attempt.sessionId,
    incarnation: attempt.incarnation,
    state: 'busy',
    allowedRecipeIds: ['kim-vocals-v2'],
    currentAttemptId: attempt._id,
  });
  await retryDue();
  assert.ok(
    await jobs.findById(id),
    'slot ownership prevents attempt deletion',
  );
  await slots.updateOne(
    { _id: slot._id },
    { $set: { currentAttemptId: null, state: 'idle' } },
  );
  await attempts.updateOne(
    { _id: attempt._id },
    { $set: { state: 'uploading' } },
  );
  await retryDue();
  assert.ok(await jobs.findById(id), 'active attempt remains');
  await attempts.updateOne({ _id: attempt._id }, { $set: { state: 'lost' } });
  const cleanup = await tasks.create({
    key: orphanKey,
    ownerUserId: owner,
    reason: 'AUDIO_OUTPUT_ORPHANED',
    nextAt: purgeAt,
    settleUntil: purgeAt,
  });
  await retryDue();
  assert.ok(await jobs.findById(id), 'unfinished storage cleanup remains');
  await tasks.updateOne(
    { _id: cleanup._id },
    { $set: { completedAt: purgeAt, nextAt: null } },
  );

  // Reproduce an older deletion that completed its parent but left a pending target.
  await deliveries.updateOne(
    { _id: delivery._id },
    { $set: { status: 'pending' } },
  );

  storageComplete = false;
  await retryDue();
  assert.ok(await jobs.findById(id));
  assert.ok(await attempts.findById(attempt._id));
  assert.equal(
    (await deliveries.findById(delivery._id).lean()).status,
    'ineligible',
    'legacy unreachable targets are finalized before retention',
  );
  storageComplete = true;
  swept.length = 0;
  await retryDue();
  assert.deepEqual(new Set(swept), new Set([inputKey, outputKey, orphanKey]));
  assert.equal(await jobs.findById(id), null);
  assert.equal(await attempts.findById(attempt._id), null);
  assert.equal(await errors.findById(error._id), null);
  assert.equal(await events.findById(event._id), null);
  assert.equal(await deliveries.findById(delivery._id), null);
  assert.equal(releaseCount, 1, 'retention never re-releases usage');
  const receipt = await receipts
    .findOne({ accountId: owner, requestId: job.requestId })
    .lean();
  assert.ok(receipt);
  assert.equal(receipt.requestHash, job.requestHash);
  assert.equal(
    'purgeAt' in receipt,
    false,
    'replay rejection survives for account lifetime',
  );

  let admissions = 0;
  const admission = {
    assertNewWork: async () => {
      admissions += 1;
      throw new Error('must not re-admit');
    },
  };
  const jobsService = new JobsService(
    jobs,
    storage,
    transactions,
    {},
    admission,
    {},
    {},
  );
  await assert.rejects(
    jobsService.create(owner.toString(), input, job.requestId, metadata),
    codeIs('JOB_NOT_FOUND'),
  );
  await assert.rejects(
    jobsService.create(
      owner.toString(),
      { ...input, bytes: 4097 },
      job.requestId,
      metadata,
    ),
    codeIs('IDEMPOTENCY_CONFLICT'),
  );
  const actions = new JobActionsService(
    jobs,
    transactions,
    { assertActive: async () => undefined },
    admission,
    {},
  );
  await assert.rejects(
    actions.retry(owner.toString(), retry._id.toString(), job.requestId),
    codeIs('IDEMPOTENCY_CONFLICT'),
  );
  assert.equal(admissions, 0);
  assert.ok(
    await jobs.findById(retry._id),
    'recently cleaned deleted descendants keep their retention window',
  );
});

test('job error TTL waits for terminal job and finalized notification details', async (t) => {
  const services = await IsolatedServices.create();
  t.after(() => services.stop());
  const { mongoUri } = await services.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri, {
    bufferCommands: false,
    sanitizeFilter: true,
  }).asPromise();
  t.after(() => connection.close());
  for (const { name, schema } of [
    ...PROCESSING_MODELS,
    { name: WorkerAttempt.name, schema: WorkerAttemptSchema },
  ])
    connection.model(name, schema);
  const jobs = connection.model('Job');
  const errors = connection.model('JobError');
  const events = connection.model('NotificationOutbox');
  const deliveries = connection.model('NotificationDelivery');
  const now = new Date();
  const owner = new Types.ObjectId();
  const id = new Types.ObjectId();
  const job = await jobs.create({
    _id: id,
    userId: owner,
    requestId: randomUUID(),
    requestHash: 'a'.repeat(64),
    status: 'processing',
    inputReservation: {
      key: `users/${owner}/jobs/${id}/input/source.mp3`,
      extension: 'mp3',
      contentType: 'audio/mpeg',
      bytes: 512,
      durationSeconds: 30,
      sha256: Buffer.alloc(32).toString('base64'),
    },
  });
  const event = await events.create({
    jobId: id,
    userId: owner,
    outcome: 'failed',
    state: 'pending',
  });
  const delivery = await deliveries.create({
    outboxId: event._id,
    registrationId: new Types.ObjectId(),
    bindingRevision: 1,
    status: 'pending',
  });
  const error = await errors.create({
    jobId: id,
    eventId: 'notification-fixture',
    classification: 'notification',
    code: 'NOTIFICATION_FAILED',
    message: 'Fixture notification failure',
    stage: 'notification',
    createdAt: now,
  });
  const service = new JobRetentionService(
    jobs,
    new ProcessingTransactions(connection),
    {},
  );
  const check = async () => {
    await errors.updateOne(
      { _id: error._id },
      { $set: { retentionNextAt: null } },
    );
    await service.finalizeErrorDue(now);
    return errors.findById(error._id).lean();
  };
  assert.equal((await check()).purgeAt, null);
  await jobs.updateOne(
    { _id: job._id },
    { $set: { status: 'failed', finishedAt: now } },
  );
  assert.equal((await check()).purgeAt, null);
  await events.updateOne(
    { _id: event._id },
    { $set: { state: 'completed', completedAt: now } },
  );
  assert.equal((await check()).purgeAt, null);
  await deliveries.updateOne(
    { _id: delivery._id },
    { $set: { status: 'failed', failedAt: now } },
  );
  const finalized = await check();
  assert.equal(finalized.finalizedAt.getTime(), now.getTime());
  assert.equal(finalized.purgeAt.getTime(), now.getTime() + 90 * DAY_MS);
  assert.equal(
    (await jobs.findById(id).lean()).deletedAt,
    null,
    'Library/history job is retained',
  );
});

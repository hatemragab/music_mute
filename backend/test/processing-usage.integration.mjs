import { WorkerRecoveryService } from '../dist/worker/worker-recovery.service.js';
import { WorkerCoordinatorService } from '../dist/worker/worker-coordinator.service.js';
import { WorkerTerminalService } from '../dist/worker/worker-terminal.service.js';
import { DEFAULT_QUEUE_POLICY } from '../dist/admin-settings/queue-policy.schema.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { accountFixture } from './helpers/account-fixture.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { ProcessingUsageService } from '../dist/processing-usage/processing-usage.service.js';
import { ProcessingAdmissionService } from '../dist/admin-settings/processing-admission.service.js';
import { ProcessingSettingsService } from '../dist/admin-settings/processing-settings.service.js';
import {
  ProcessingSettings,
  ProcessingSettingsSchema,
  ProcessingAdmissionFence,
} from '../dist/admin-settings/processing-settings.schema.js';
import { JobsService } from '../dist/jobs/jobs.service.js';
import { JobActionsService } from '../dist/jobs/job-actions.service.js';
import { EnqueueService } from '../dist/jobs/enqueue.service.js';

test('same-account admission is atomic, replay does not double reserve, and cancellation releases once', async (t) => {
  const native = await IsolatedServices.create();
  t.after(() => native.stop());
  const { mongoUri } = await native.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  for (const { name, schema } of [
    ...PROCESSING_MODELS,
    { name: ProcessingSettings.name, schema: ProcessingSettingsSchema },
  ])
    connection.model(name, schema);
  await Promise.all(Object.values(connection.models).map((m) => m.init()));
  const owner = new Types.ObjectId();
  const { users, access } = await accountFixture(connection, [
    owner.toString(),
  ]);
  const jobs = connection.model('Job');
  const transactions = new ProcessingTransactions(connection);
  const config = new ConfigService({
    AUDIO_PROCESSING_ENABLED: true,
    PROCESSING_URL_SECONDS: 900,
    PROCESSING_LEASE_SECONDS: 90,
  });
  const settings = new ProcessingSettingsService(
    connection.model(ProcessingSettings.name),
    connection.model(ProcessingAdmissionFence.name),
    {},
    config,
  );
  const admission = new ProcessingAdmissionService(
    connection.model(ProcessingAdmissionFence.name),
    users,
    jobs,
    settings,
    config,
  );
  const enqueue = new EnqueueService(connection.model('QueueCounter'));
  let grants = 0;
  const service = new JobsService(
    jobs,
    {
      createInputGrant: async () => {
        grants++;
        return {
          method: 'PUT',
          url: 'https://storage.invalid/upload',
          headers: {},
          expiresAt: new Date().toISOString(),
        };
      },
    },
    transactions,
    enqueue,
    access,
    admission,
  );
  const usage = new ProcessingUsageService(
    connection.model('ProcessingUsageLedger'),
    jobs,
  );
  const requestIds = [randomUUID(), randomUUID()];
  const input = {
    extension: 'mp3',
    contentType: 'audio/mpeg',
    bytes: 1024,
    durationSeconds: 599.5,
    sha256: Buffer.alloc(32).toString('base64'),
  };
  const createJobAsSameOwner = (requestId) =>
    service.create(owner.toString(), input, requestId);
  const results = await Promise.allSettled(
    requestIds.map(createJobAsSameOwner),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const winnerIndex = results.findIndex((r) => r.status === 'fulfilled');
  const winner = results[winnerIndex].value;
  assert.equal((await usage.readUsage(owner)).reservedAudioSeconds, 600);
  assert.equal(grants, 1);
  assert.equal(
    (await createJobAsSameOwner(requestIds[winnerIndex])).id,
    winner.id,
  );
  assert.equal((await usage.readUsage(owner)).reservedAudioSeconds, 600);
  const actions = new JobActionsService(
    jobs,
    transactions,
    enqueue,
    access,
    admission,
    connection.model('WorkerControl'),
  );
  await actions.cancel(owner.toString(), winner.id);
  await actions.cancel(owner.toString(), winner.id);
  assert.equal((await usage.readUsage(owner)).reservedAudioSeconds, 0);
  assert.equal(
    await connection.model('ProcessingUsageLedger').countDocuments(),
    1,
  );
  const next = await createJobAsSameOwner(randomUUID());
  await transactions.run(async (session) => {
    const job = await jobs.findById(next.id).session(session);
    await usage.reconcileMeasured(job, 599.9, session);
    job.status = 'ready';
    job.processingStartedAt = new Date();
    job.measuredDurationSeconds = 599.9;
    await job.save({ session });
    await usage.settleJob(job, session);
    await usage.settleJob(job, session);
  });
  assert.equal((await usage.readUsage(owner)).usedAudioSeconds, 600);
  await jobs.updateOne({ _id: next.id }, { $set: { deletedAt: new Date() } });
  assert.equal((await usage.readUsage(owner)).usedAudioSeconds, 600);
  const expanded = { ...input, bytes: 100_000_000, durationSeconds: 1800 };
  const metadata = {
    policyVersion: 2,
    preparationProfileId: 'preserve-or-aac-lc-256-v1',
    source: 'video_file',
  };
  await assert.rejects(
    service.create(owner.toString(), expanded, randomUUID(), metadata),
    (e) => e.getResponse().code === 'PROCESSING_CAPACITY_UNAVAILABLE',
  );
  const qualification = {
    evidenceReference: 'synthetic-integration-fixture-not-production',
    compatibilityRevision: 'fixture-v1',
    measuredAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    qualifiedWorkerIds: ['z440'],
    maxLocalSourceBytes: 1000000000,
    maxSourceDownloadBytes: 200000000,
    maxPreparationSeconds: 600,
    maxSourceDownloadSeconds: 600,
    maxOutputBytes: 100000000,
    probeTimeoutSeconds: 300,
    processingTimeoutSeconds: 7200,
    maxOutstandingEstimatedWorkerSeconds: 100000,
    costModelRevision: 'fixture-model-v1',
    referenceProcessingSecondsPerAudioSecond: 2,
    fixedJobOverheadSeconds: 10,
  };
  await connection.model('ProcessingQueuePolicy').create({
    _id: 'processing',
    ...DEFAULT_QUEUE_POLICY,
    acceptLongJobs: true,
    qualification,
    revision: 1,
    updatedAt: new Date(),
  });
  // Evidence alone does not claim worker compatibility.
  await assert.rejects(
    service.create(owner.toString(), expanded, randomUUID(), metadata),
    (e) => e.getResponse().code === 'PROCESSING_CAPACITY_UNAVAILABLE',
  );
  const coordinator = new WorkerCoordinatorService(
    jobs,
    connection.model('WorkerControl'),
    connection.model('JobAttempt'),
    transactions,
    config,
    {
      createDownloadGrant: async () => ({
        url: 'https://storage.invalid/input',
        expiresAt: new Date().toISOString(),
      }),
    },
    connection.model('JobReceipt'),
    access,
  );
  await coordinator.claim(randomUUID(), undefined, 2);
  await connection
    .model('ProcessingQueuePolicy')
    .updateOne({ _id: 'processing' }, { $set: { acceptLongJobs: false } });
  const boundary = await service.create(
    owner.toString(),
    { ...expanded, durationSeconds: 600 },
    randomUUID(),
    metadata,
  );
  await actions.cancel(owner.toString(), boundary.id);
  await assert.rejects(
    service.create(
      owner.toString(),
      { ...expanded, durationSeconds: 600.001 },
      randomUUID(),
      metadata,
    ),
    (e) => e.getResponse().code === 'MEDIA_TOO_LONG',
  );
  await connection
    .model('ProcessingQueuePolicy')
    .updateOne({ _id: 'processing' }, { $set: { acceptLongJobs: true } });
  const longResults = await Promise.allSettled([
    service.create(owner.toString(), expanded, randomUUID(), metadata),
    service.create(owner.toString(), expanded, randomUUID(), metadata),
  ]);
  assert.equal(longResults.filter((r) => r.status === 'fulfilled').length, 1);
  const long = longResults.find((r) => r.status === 'fulfilled').value;
  assert.equal((await usage.readUsage(owner)).reservedAudioSeconds, 1800);
  const longJob = await jobs.findById(long.id);
  await jobs.updateOne(
    { _id: long.id },
    {
      $set: {
        status: 'queued',
        queuedAt: new Date(),
        queueOrder: 1n,
        inputObject: {
          key: longJob.inputReservation.key,
          versionId: 'fixture-v1',
          bytes: expanded.bytes,
          sha256: expanded.sha256,
          contentType: expanded.contentType,
        },
      },
    },
  );
  assert.equal(
    await coordinator.claim(randomUUID()),
    null,
    'a legacy worker cannot claim expanded work',
  );
  const assigned = await coordinator.claim(randomUUID(), undefined, 2);
  assert.equal(assigned.processingLimits.maxDurationSeconds, 1800);
  assert.equal(assigned.processingLimits.maxInputBytes, 100000000);
  assert.equal(assigned.processingLimits.durationInclusive, true);
  const selector = {
    jobId: assigned.jobId,
    attemptId: assigned.attemptId,
    sessionId: assigned.sessionId,
    generation: assigned.generation,
  };
  await coordinator.stage(
    { ...selector, eventId: randomUUID() },
    {
      stage: 'processing',
      durationSeconds: 1800,
      decodable: true,
      hasAudio: true,
    },
  );
  await actions.cancel(owner.toString(), long.id);
  const startedAt = new Date(Date.now() - 60000);
  await connection
    .model('JobAttempt')
    .updateOne(
      { attemptId: assigned.attemptId },
      { $set: { startedAt, processingStartedAt: startedAt } },
    );
  const terminal = new WorkerTerminalService(
    coordinator,
    transactions,
    {},
    connection.model('JobAttempt'),
    connection.model('JobReceipt'),
    connection.model('JobError'),
    connection.model('WorkerControl'),
    connection.model('NotificationOutbox'),
    access,
  );
  const eventId = randomUUID();
  const stopped = {
    ...selector,
    eventId,
    stopped: true,
    executionEvidence: {
      eventId,
      separatorExecutionSeconds: 20,
      processingStartedAt: startedAt.toISOString(),
      measuredAudioSeconds: 1800,
      stoppedConfirmed: true,
    },
  };
  await terminal.stopped(stopped, 'cancelled');
  await terminal.stopped(stopped, 'cancelled');
  const finalUsage = await usage.readUsage(owner);
  assert.equal(finalUsage.reservedAudioSeconds, 0);
  assert.equal(
    finalUsage.usedAudioSeconds,
    610,
    '600 successful seconds plus 20 / 2 equivalent cancellation seconds',
  );
  assert.equal(
    (await connection.model('QueueExecutionUsage').findById(assigned.attemptId))
      .executionSeconds,
    20,
  );
  const ledger = connection.model('ProcessingUsageLedger');
  await ledger.updateOne(
    { _id: long.id },
    {
      $set: {
        state: 'reserved',
        audioSeconds: 1800,
        expiresAt: null,
        purgeAt: null,
      },
    },
  );
  await connection
    .model('JobAttempt')
    .updateOne(
      { attemptId: assigned.attemptId },
      { $set: { separationCompleted: true } },
    );
  await transactions.run(async (session) =>
    usage.settleJob(
      await jobs.findById(long.id).session(session).lean(),
      session,
    ),
  );
  assert.equal(
    (await ledger.findById(long.id)).audioSeconds,
    1800,
    'completed separation debits full duration even when later cancelled',
  );
  await ledger.updateOne(
    { _id: long.id },
    { $set: { state: 'reserved', expiresAt: null, purgeAt: null } },
  );
  await connection.model('JobAttempt').updateOne(
    { attemptId: assigned.attemptId },
    {
      $set: {
        separationCompleted: null,
        separatorStoppedConfirmed: false,
        separatorExecutionSeconds: null,
      },
    },
  );
  const observedAt = Date.now();
  await transactions.run(async (session) =>
    usage.settleJob(
      await jobs.findById(long.id).session(session).lean(),
      session,
    ),
  );
  const pending = await ledger.findById(long.id);
  assert.equal(pending.state, 'pending');
  assert.ok(pending.expiresAt.getTime() >= observedAt + 86400000);
  assert.ok(pending.purgeAt > pending.expiresAt);
  await ledger.updateOne(
    { _id: long.id },
    { $set: { expiresAt: new Date(Date.now() - 1) } },
  );
  assert.equal(
    (await usage.readUsage(owner)).reservedAudioSeconds,
    0,
    'expired terminal pending holds replenish',
  );
  const recovery = new WorkerRecoveryService(
    jobs,
    connection.model('JobAttempt'),
    connection.model('JobError'),
    connection.model('WorkerControl'),
    transactions,
    coordinator,
    terminal,
    {},
  );
  const lateId = randomUUID();
  const lateEvidence = {
    eventId: lateId,
    executionEvidence: {
      ...stopped.executionEvidence,
      eventId: lateId,
      separationCompleted: true,
    },
  };
  const recovered = await recovery.reconcileCurrent(
    assigned.sessionId,
    assigned.attemptId,
    true,
    undefined,
    lateEvidence,
  );
  assert.equal(recovered.status, 'cancelled');
  assert.equal(
    (await ledger.findById(long.id)).state,
    'used',
    'late terminal evidence immediately settles pending usage',
  );
  assert.equal((await ledger.findById(long.id)).audioSeconds, 1800);
  await recovery.reconcileCurrent(
    assigned.sessionId,
    assigned.attemptId,
    true,
    undefined,
    lateEvidence,
  );
  const other = new Types.ObjectId();
  await accountFixture(connection, [other.toString()]);
  await connection
    .model('ProcessingQueuePolicy')
    .updateOne({ _id: 'processing' }, { $set: { maxOutstandingJobs: 1 } });
  const globalRace = await Promise.allSettled([
    service.create(owner.toString(), input, randomUUID()),
    service.create(other.toString(), input, randomUUID()),
  ]);
  assert.equal(
    globalRace.filter((r) => r.status === 'fulfilled').length,
    1,
    'different accounts cannot exceed global capacity',
  );
  const rejected = globalRace.find((r) => r.status === 'rejected');
  assert.equal(rejected.reason.getResponse().code, 'PROCESSING_QUEUE_FULL');
});

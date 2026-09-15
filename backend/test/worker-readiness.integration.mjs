import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { accountFixture } from './helpers/account-fixture.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { WorkerCoordinatorService } from '../dist/worker/worker-coordinator.service.js';
import { WorkerRegistryService } from '../dist/worker/worker-registry.service.js';
import { WorkerRuntimeService } from '../dist/worker/worker-runtime.service.js';
import { WorkerReadinessService } from '../dist/worker/worker-readiness.service.js';
import { WorkerQualificationService } from '../dist/worker/worker-qualification.service.js';
import { WorkerRecoveryService } from '../dist/worker/worker-recovery.service.js';
import { WorkerRolloutsService } from '../dist/worker-releases/worker-rollouts.service.js';
import { WorkerTerminalService } from '../dist/worker/worker-terminal.service.js';
const hash = 'a'.repeat(64);

test('compiled admission fences, live media eligibility, owned lifecycle and two API instances', async (t) => {
  const native = await IsolatedServices.create();
  t.after(() => native.stop());
  const { mongoUri } = await native.startDatabases({ replicaSet: true });
  const db = await createConnection(mongoUri).asPromise();
  t.after(() => db.close());
  const db2 = await createConnection(mongoUri).asPromise();
  t.after(() => db2.close());
  for (const connection of [db, db2])
    for (const { name, schema } of PROCESSING_MODELS)
      connection.model(name, schema);
  await Promise.all(PROCESSING_MODELS.map(({ name }) => db.model(name).init()));
  const config = new ConfigService({
    PROCESSING_LEASE_SECONDS: 90,
  });
  const transactions = new ProcessingTransactions(db);
  const registry = new WorkerRegistryService(
    db.model('WorkerRegistration'),
    db.model('WorkerControl'),
    config,
  );
  const runtimeService = new WorkerRuntimeService(
    db.model('WorkerRuntime'),
    db.model('WorkerRegistration'),
    registry,
    transactions,
  );
  const readiness = new WorkerReadinessService(db);
  const identities = [];
  const releaseId = randomUUID();
  const approvedProfile = {
    evidenceSha256: hash,
    fixtureSha256: hash,
    fixtureDurationSeconds: 600,
    provider: 'CUDAExecutionProvider',
    serviceBindingSha256: hash,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    maxDurationSeconds: 600,
    maxPreparedAudioBytes: 1000000,
    maxWallMilliseconds: 60000,
  };
  const artifact = {
    releaseId,
    buildNumber: 100,
    profileId: 'linux-x64-cuda',
    modelSha256: hash,
    runtimeLockSha256: hash,
    os: 'linux',
    arch: 'x64',
    minimumLauncherBuild: 1,
    protocolMin: 3,
    protocolMax: 3,
    stateReadMin: 1,
    stateReadMax: 1,
    compatibleSources: [],
    approvedProfile,
  };
  await db.model('WorkerRelease').create({
    _id: releaseId,
    buildNumber: 100,
    state: 'published',
    metadata: { artifacts: [artifact] },
  });
  await db.model('ReleasePolicy').create({ _id: 'policy' });
  const reports = [];
  for (const workerId of ['worker-a', 'worker-b']) {
    const installationId = randomUUID();
    const identity = {
      workerId,
      keySha256: workerId === 'worker-a' ? hash : 'b'.repeat(64),
      installationId,
    };
    identities.push(identity);
    await db.model('WorkerRegistration').create({
      _id: workerId,
      keySha256: identity.keySha256,
      label: workerId,
      state: 'enabled',
      installationId,
    });
    await db.collection('worker_installations').insertOne({
      _id: installationId,
      assignedWorkerId: workerId,
      pairingState: 'approved',
      revoked: false,
    });
    await db
      .model('WorkerControl')
      .create({ _id: workerId, managementRevision: 7 });
    const report = {
      installationId,
      workerBuild: 100,
      launcherBuild: 100,
      protocolVersion: 3,
      profileId: artifact.profileId,
      modelSha256: hash,
      runtimeLockSha256: hash,
      os: 'linux',
      arch: 'x64',
      activity: 'ready',
      bootVerified: true,
    };
    reports.push(report);
    const qualification = await new WorkerQualificationService(db).store(
      installationId,
      report,
      {
        profileId: artifact.profileId,
        modelSha256: hash,
        fixtureSha256: hash,
        provider: 'CUDAExecutionProvider',
        acceleratorUsed: true,
        deviceLabel: 'synthetic isolated fixture',
        wallMilliseconds: 100,
        peakRamBytes: null,
        peakGpuMemoryBytes: null,
        outputValid: true,
        referenceCheckPassed: true,
        serviceContextPassed: true,
        reasonCodes: [],
      },
      hash,
    );
    const result = await runtimeService.installationReady(identity, {
      installationId,
      runtime: report,
      qualificationReportId: qualification.reportId,
      bootReport: {
        serviceBindingSha256: hash,
        profileId: artifact.profileId,
        installed: true,
        serviceContextPassed: true,
        unattendedRebootPassed: true,
        observedBootId: 'synthetic-boot',
        observedAt: new Date().toISOString(),
        reasonCodes: [],
      },
    });
    assert.equal(result.canClaim, true);
  }
  const storage = {
    createDownloadGrant: async () => ({
      url: 'https://fixture.invalid/input',
      expiresAt: new Date().toISOString(),
    }),
    verifyOutput: async () => ({
      key: 'result',
      versionId: 'v1',
      bytes: 100,
      sha256: Buffer.alloc(32).toString('base64'),
      contentType: 'audio/mpeg',
    }),
  };
  const account = { assertActive: async () => undefined };
  const coordinator = (connection) =>
    new WorkerCoordinatorService(
      connection.model('Job'),
      connection.model('WorkerControl'),
      connection.model('JobAttempt'),
      new ProcessingTransactions(connection),
      config,
      storage,
      connection.model('JobReceipt'),
      account,
    );
  const one = coordinator(db),
    two = coordinator(db2);
  async function enqueue(duration, order, userId = new Types.ObjectId()) {
    const input = {
      key: 'input',
      extension: 'mp3',
      contentType: 'audio/mpeg',
      bytes: 100,
      durationSeconds: duration,
      sha256: Buffer.alloc(32).toString('base64'),
    };
    const job = await db.model('Job').create({
      userId,
      requestId: randomUUID(),
      requestHash: hash,
      inputReservation: input,
      inputObject: {
        key: 'input',
        versionId: 'v1',
        bytes: 100,
        sha256: input.sha256,
        contentType: input.contentType,
      },
      status: 'queued',
      queueOrder: BigInt(order),
    });
    await accountFixture(db, [userId.toString()]);
    return job;
  }
  const long = await enqueue(601, 1);
  const short = await enqueue(10, 2);
  assert.equal(
    await registry.available(long),
    false,
    '601-second job has no qualified capacity',
  );
  const availabilityJob = (
    duration,
    bytes,
    measuredDurationSeconds = null,
  ) => ({
    workerId: null,
    attemptId: null,
    measuredDurationSeconds,
    inputReservation: { durationSeconds: duration, bytes },
  });
  assert.equal(
    await registry.available(availabilityJob(600, 1000000)),
    true,
    'exact duration and byte ceiling',
  );
  assert.equal(
    await registry.available(availabilityJob(600, 1000001)),
    false,
    'one byte above ceiling',
  );
  assert.equal(
    await registry.available(availabilityJob(601, 1000000)),
    false,
    'one second above ceiling',
  );
  assert.equal(
    await registry.available(availabilityJob(601, 1000000, 600)),
    true,
    'measured duration supersedes larger reservation',
  );
  assert.equal(
    await registry.available(availabilityJob(600, 1000000, 601)),
    false,
    'larger measured duration supersedes reservation',
  );
  // A delayed claim must observe activation authorized by the real update-status transaction.
  const rolloutId = randomUUID();
  await db.model('WorkerRollout').create({
    _id: rolloutId,
    releaseId,
    workerIds: ['worker-a'],
    groupRevisions: {},
    createdAt: new Date(),
  });
  await db.model('WorkerUpdatePolicy').create({
    _id: 'worker-a',
    revision: 1,
    rolloutId,
    target: artifact,
    minimumClaimBuild: 100,
    allowedFallbackReleaseIds: [],
    stage: 'validating',
  });
  const rollouts = new WorkerRolloutsService(
    db,
    undefined,
    transactions,
    undefined,
    config,
  );
  const delayedControls = db2.model('WorkerControl'),
    originalControlUpdate = delayedControls.updateOne.bind(delayedControls);
  let atControlFence,
    continueDelayedClaim,
    delayedOnce = false;
  const atControlPromise = new Promise((resolve) => (atControlFence = resolve));
  const continueDelayedPromise = new Promise(
    (resolve) => (continueDelayedClaim = resolve),
  );
  delayedControls.updateOne = function (...args) {
    if (!delayedOnce && args[1]?.$inc?.controlRevision) {
      delayedOnce = true;
      return (async () => {
        atControlFence();
        await continueDelayedPromise;
        return originalControlUpdate(...args);
      })();
    }
    return originalControlUpdate(...args);
  };
  const delayedClaim = two.claim(randomUUID(), identities[0], 2);
  try {
    await atControlPromise;
    assert.deepEqual(
      await rollouts.updateStatus(identities[0], {
        policyRevision: 1,
        stage: 'activating',
        observedBuild: 100,
        eventId: randomUUID(),
      }),
      { accepted: true },
    );
    assert.equal(
      (await db.model('WorkerUpdatePolicy').findById('worker-a')).stage,
      'activating',
    );
    continueDelayedClaim();
    await assert.rejects(delayedClaim, (error) =>
      error.getResponse().reasonCodes.includes('UPDATE_POLICY_HOLD'),
    );
    assert.equal(
      (await readiness.evaluateNewClaim('worker-a', undefined, true)).allowed,
      false,
    );
    assert.equal(
      (await db.model('WorkerControl').findById('worker-a')).activeJobId,
      null,
    );
  } finally {
    continueDelayedClaim();
    delayedControls.updateOne = originalControlUpdate;
  }
  await db.model('WorkerUpdatePolicy').deleteOne({ _id: 'worker-a' });
  await db.model('Job').updateOne(
    { _id: short._id },
    {
      $set: {
        admissionSnapshot: {
          policyVersion: 2,
          maxDurationSeconds: 1800,
          maxInputBytes: 1000000,
          qualification: { qualifiedWorkerIds: ['retired-worker'] },
          settingsRevision: 0,
          maxInputBytesExclusive: 1000000,
          maxDurationSecondsExclusive: 600,
          reservationExpiresAt: new Date(Date.now() + 3600000),
        },
      },
    },
  );
  const sessionId = randomUUID();
  const claims = await Promise.allSettled([
    one.claim(sessionId, identities[0], 2),
    two.claim(randomUUID(), identities[0], 2),
  ]);
  const wins = claims.filter((x) => x.status === 'fulfilled');
  assert.equal(wins.length, 1);
  let assignment = wins[0].value;
  assert.equal(assignment.jobId, short._id.toString());
  assert.equal((await db.model('Job').findById(long._id)).status, 'queued');
  // Raising a selected-worker floor must not strand this exact protocol-3 attempt.
  await transactions.run(async (session) => {
    await db
      .model('WorkerControl')
      .updateOne(
        { _id: 'worker-a' },
        { $inc: { controlRevision: 1 } },
        { session },
      );
    await db.model('WorkerUpdatePolicy').create(
      [
        {
          _id: 'worker-a',
          revision: 1,
          rolloutId: randomUUID(),
          target: { ...artifact, buildNumber: 101 },
          minimumClaimBuild: 101,
          allowedFallbackReleaseIds: [],
          stage: 'available',
        },
      ],
      { session },
    );
  });
  assert.equal(
    (await one.claim(assignment.sessionId, identities[0], 2)).attemptId,
    assignment.attemptId,
  );
  await one.heartbeat(assignment, identities[0]);
  await assert.rejects(
    one.stage(
      { ...assignment, eventId: randomUUID() },
      {
        stage: 'processing',
        durationSeconds: 601,
        decodable: true,
        hasAudio: true,
      },
      identities[0],
    ),
    (e) => e.getResponse().code === 'MEDIA_TOO_LONG',
  );
  assert.equal(
    (await db.model('JobAttempt').findOne({ attemptId: assignment.attemptId }))
      .admissionEvidence.maxDurationSeconds,
    600,
  );
  const terminal = new WorkerTerminalService(
    one,
    transactions,
    storage,
    db.model('JobAttempt'),
    db.model('JobReceipt'),
    db.model('JobError'),
    db.model('WorkerControl'),
    db.model('NotificationOutbox'),
    account,
  );
  const recovery = new WorkerRecoveryService(
    db.model('Job'),
    db.model('JobAttempt'),
    db.model('JobError'),
    db.model('WorkerControl'),
    transactions,
    one,
    terminal,
    storage,
  );
  await db
    .model('Job')
    .updateOne(
      { _id: short._id },
      { $set: { status: 'interrupted', leaseExpiresAt: new Date(0) } },
    );
  await db
    .model('WorkerControl')
    .updateOne({ _id: 'worker-a' }, { $set: { leaseExpiresAt: new Date(0) } });
  const previousAttemptId = assignment.attemptId;
  const recovered = await recovery.reconcile(
    randomUUID(),
    previousAttemptId,
    true,
    identities[0],
  );
  assignment = recovered.assignment ?? recovered;
  assert.equal(assignment.jobId, short._id.toString());
  assert.notEqual(assignment.attemptId, previousAttemptId);
  assert.equal(
    (await db.model('JobAttempt').findOne({ attemptId: assignment.attemptId }))
      .admissionEvidence.maxDurationSeconds,
    600,
  );
  await one.heartbeat(assignment, identities[0]);
  await db
    .model('Job')
    .updateOne({ _id: short._id }, { $set: { status: 'uploading_result' } });

  assert.equal(
    (
      await terminal.complete(
        { ...assignment, eventId: randomUUID() },
        identities[0],
      )
    ).status,
    'ready',
  );
  assert.equal(
    (
      await terminal.confirmLocalCleanup(
        { ...assignment, eventId: randomUUID(), localDataDeleted: true },
        identities[0],
      )
    ).status,
    'cleaned',
  );

  assert.equal(
    (
      await recovery.reconcile(
        assignment.sessionId,
        assignment.attemptId,
        true,
        identities[0],
      )
    ).status,
    'ready',
  );
  await assert.rejects(one.claim(randomUUID(), identities[0], 2), (e) =>
    e.getResponse().reasonCodes.includes('WORKER_BUILD_PROHIBITED'),
  );
  // Busy qualified capacity is distinct from a free claim slot.
  await enqueue(10, 3);
  const busy = await two.claim(randomUUID(), identities[1], 2);
  await runtimeService.store(identities[1], {
    ...reports[1],
    activity: 'busy',
  });
  assert.equal((await readiness.evaluateNewClaim('worker-b')).allowed, false);
  assert.equal(
    (await readiness.evaluateNewClaim('worker-b', undefined, true)).allowed,
    true,
  );
  assert.equal(
    (await db.model('WorkerControl').findById('worker-b')).managementRevision,
    7,
  );
  assert.equal(
    await registry.available(availabilityJob(600, 1000000)),
    true,
    'busy qualified worker remains queue capacity',
  );
  assert.equal(
    await registry.available(availabilityJob(601, 1000000)),
    false,
    'busy capacity respects duration',
  );
  assert.equal(
    await registry.available(availabilityJob(600, 1000001)),
    false,
    'busy capacity respects bytes',
  );
  assert.equal(
    await registry.available(await db.model('Job').findById(busy.jobId)),
    true,
    'owned heartbeat stays visible',
  );
  await db
    .model('Job')
    .updateOne({ _id: busy.jobId }, { $set: { status: 'uploading_result' } });
  await terminal.complete({ ...busy, eventId: randomUUID() }, identities[1]);
  await runtimeService.store(identities[1], reports[1]);
  // Commit a disqualification while a claim's snapshot is suspended before its runtime write fence.
  let reached, resume;
  const reachedPromise = new Promise((r) => (reached = r));
  const resumePromise = new Promise((r) => (resume = r));
  const runtimeModel = db2.model('WorkerRuntime');
  const original = runtimeModel.updateOne.bind(runtimeModel);
  let suspended = false;
  runtimeModel.updateOne = function (...args) {
    if (!suspended && args[1]?.$inc?.rolloutFence) {
      suspended = true;
      return (async () => {
        reached();
        await resumePromise;
        return original(...args);
      })();
    }
    return original(...args);
  };
  const pending = two.claim(randomUUID(), identities[1], 2);
  await reachedPromise;
  await runtimeService.store(identities[1], {
    ...reports[1],
    bootVerified: false,
  });
  resume();
  await assert.rejects(pending, (e) =>
    e.getResponse().reasonCodes.includes('BOOT_VERIFICATION_REQUIRED'),
  );
  runtimeModel.updateOne = original;
  assert.equal(
    (await db.model('WorkerControl').findById('worker-b')).activeJobId,
    null,
  );
  assert.equal(
    (await db.model('WorkerControl').findById('worker-b')).managementRevision,
    7,
  );
  async function raceChange(modelName, increment, mutate, reason) {
    await runtimeService.store(identities[1], reports[1]);
    let atFence, continueClaim;
    const atFencePromise = new Promise((resolve) => (atFence = resolve));
    const continuePromise = new Promise((resolve) => (continueClaim = resolve));
    const model = db2.model(modelName),
      originalUpdate = model.updateOne.bind(model);
    let blocked = false;
    model.updateOne = function (...args) {
      if (!blocked && args[1]?.$inc?.[increment]) {
        blocked = true;
        return (async () => {
          atFence();
          await continuePromise;
          return originalUpdate(...args);
        })();
      }
      return originalUpdate(...args);
    };
    const claiming = two.claim(randomUUID(), identities[1], 2);
    try {
      await atFencePromise;
      await mutate();
      continueClaim();
      await assert.rejects(claiming, (error) => reason(error));
    } finally {
      continueClaim();
      model.updateOne = originalUpdate;
    }
    assert.equal(
      (await db.model('WorkerControl').findById('worker-b')).activeJobId,
      null,
    );
  }
  await raceChange(
    'WorkerRuntime',
    'rolloutFence',
    () =>
      transactions.run(async (session) => {
        await db
          .model('ReleasePolicy')
          .updateOne(
            { _id: 'policy' },
            { $inc: { fence: 1, revision: 1 } },
            { session },
          );
        await db
          .model('WorkerRelease')
          .updateOne(
            { _id: releaseId },
            { $set: { state: 'withdrawn' } },
            { session },
          );
      }),
    (error) => error.getResponse().reasonCodes.includes('RELEASE_UNAVAILABLE'),
  );
  await db
    .model('WorkerRelease')
    .updateOne({ _id: releaseId }, { $set: { state: 'published' } });
  await raceChange(
    'WorkerControl',
    'controlRevision',
    () =>
      transactions.run(async (session) => {
        await db
          .model('WorkerControl')
          .updateOne(
            { _id: 'worker-b' },
            { $inc: { controlRevision: 1 } },
            { session },
          );
        await db.model('WorkerUpdatePolicy').create(
          [
            {
              _id: 'worker-b',
              revision: 1,
              rolloutId: randomUUID(),
              target: { ...artifact, buildNumber: 101 },
              minimumClaimBuild: 101,
              allowedFallbackReleaseIds: [],
              stage: 'available',
            },
          ],
          { session },
        );
      }),
    (error) =>
      error.getResponse().reasonCodes.includes('WORKER_BUILD_PROHIBITED'),
  );
  await db.model('WorkerUpdatePolicy').deleteOne({ _id: 'worker-b' });
  await raceChange(
    'WorkerControl',
    'controlRevision',
    () =>
      transactions.run(async (session) => {
        await db
          .model('WorkerControl')
          .updateOne(
            { _id: 'worker-b' },
            { $inc: { controlRevision: 1 } },
            { session },
          );
        await db
          .model('WorkerRegistration')
          .updateOne(
            { _id: 'worker-b' },
            { $set: { state: 'revoked' } },
            { session },
          );
      }),
    (error) => error.getStatus() === 401,
  );
});

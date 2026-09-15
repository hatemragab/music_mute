import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, sign, createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import supertest from 'supertest';
import { createConnection, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { WORKER_RELEASE_MODELS } from '../dist/worker-releases/worker-release.schema.js';
import { WorkerRolloutsService } from '../dist/worker-releases/worker-rollouts.service.js';
import {
  PublicationReceiptVerifier,
  receiptBytes,
} from '../dist/worker-releases/publication-receipt.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { AdminOperationsService } from '../dist/admin/admin-operations.service.js';
import { AdminAccessSchema } from '../dist/admin/admin-access.schema.js';
import { AdminOperationSchema } from '../dist/admin/admin-operation.schema.js';
import { AdminAuditEventSchema } from '../dist/admin/admin-audit.schema.js';
import { AdminAuditService } from '../dist/admin/admin-audit.service.js';
import { WorkerUpdateController } from '../dist/worker-releases/worker-releases.controller.js';
import { RateBudgetService } from '../dist/rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../dist/rate-limits/rate-limit-keys.js';
import { WorkerAuthGuard } from '../dist/worker/worker-auth.guard.js';
import { WorkerRegistryService } from '../dist/worker/worker-registry.service.js';
import { WorkerIdentityService } from '../dist/worker/worker-identity.service.js';

test('compiled releases freeze selection and fence concurrent policy changes', async (t) => {
  const native = await IsolatedServices.create();
  t.after(() => native.stop());
  const { mongoUri, redisPort } = await native.startDatabases({
    replicaSet: true,
  });
  const db = await createConnection(mongoUri).asPromise();
  t.after(() => db.close());
  const models = Object.fromEntries(
    [...PROCESSING_MODELS, ...WORKER_RELEASE_MODELS].map(({ name, schema }) => [
      name,
      db.model(name, schema),
    ]),
  );
  const access = db.model('AdminAccess', AdminAccessSchema),
    operations = db.model('AdminOperation', AdminOperationSchema),
    audit = db.model('AdminAudit', AdminAuditEventSchema);
  await Promise.all(
    [...Object.values(models), access, operations, audit].map((m) => m.init()),
  );
  await access.create({
    uid: 'operator',
    role: 'owner',
    active: true,
    revision: 1,
    verifiedEmail: 'operator@example.test',
  });
  const actor = { uid: 'operator', role: 'owner', accessRevision: 1 };
  const keys = generateKeyPairSync('ed25519');
  const config = new ConfigService({
    WORKER_PUBLICATION_KEY_ID: 'local',
    WORKER_PUBLICATION_PUBLIC_KEY: keys.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString(),
    WORKER_DISTRIBUTION_ORIGIN: 'https://updates.music-mute.com',
  });
  const service = new WorkerRolloutsService(
    db,
    new AdminOperationsService(
      db,
      access,
      operations,
      new AdminAuditService(audit),
    ),
    new ProcessingTransactions(db),
    new PublicationReceiptVerifier(config),
    config,
  );
  await service.onModuleInit();
  const receipt = (build) => {
    const releaseId = randomUUID();
    const payload = {
      protocol: 'musicmute-publication-v1',
      publicationId: randomUUID(),
      origin: 'https://updates.music-mute.com',
      releaseId,
      buildNumber: build,
      versionName: `${build}.0`,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      tufTargetsSha256: 'a'.repeat(64),
      artifacts: [
        {
          releaseId,
          buildNumber: build,
          profileId: 'linux-x64-cuda',
          artifactPath: `/releases/${releaseId}/linux-x64-cuda/${'b'.repeat(64)}/worker.tar.gz`,
          artifactBytes: 1024,
          artifactSha256: 'b'.repeat(64),
          runtimeLockSha256: 'c'.repeat(64),
          modelSha256: 'd'.repeat(64),
          minimumLauncherBuild: 1,
          protocolMin: 3,
          protocolMax: 3,
          stateReadMin: 1,
          stateReadMax: 1,
          os: 'linux',
          arch: 'x64',
          compatibleSources: [],
          approvedProfile: null,
        },
      ],
    };
    return {
      keyId: 'local',
      payload,
      signature: sign(null, receiptBytes(payload), keys.privateKey).toString(
        'base64url',
      ),
    };
  };
  const command = (fields = {}) => ({
    operationId: randomUUID(),
    expectedRevision: 0,
    ...fields,
  });
  const installationIds = new Map();
  for (const [i, id] of ['worker-a', 'worker-b', 'worker-c'].entries()) {
    const installationId = randomUUID();
    installationIds.set(id, installationId);
    await models.WorkerRegistration.create({
      _id: id,
      label: id,
      keySha256: String(i + 1).repeat(64),
      state: 'enabled',
      installationId,
    });
    await db.collection('worker_installations').insertOne({
      _id: installationId,
      assignedWorkerId: id,
      pairingState: 'approved',
      revoked: false,
    });
    await models.WorkerControl.create({ _id: id });
    await models.WorkerRuntime.create({
      _id: id,
      receivedAt: new Date(),
      report: {
        installationId,
        workerBuild: 1,
        launcherBuild: 1,
        protocolVersion: 3,
        profileId: 'linux-x64-cuda',
        modelSha256: 'd'.repeat(64),
        runtimeLockSha256: 'c'.repeat(64),
        os: 'linux',
        arch: 'x64',
        activity: 'ready',
        bootVerified: true,
      },
    });
  }
  const signed = receipt(2);
  await service.createRelease(actor, command({ publicationReceipt: signed }));
  await service.releaseAction(
    actor,
    signed.payload.releaseId,
    'publish',
    command({ publicationReceipt: signed }),
  );
  const groupCommand = command({
    label: 'Group',
    workerIds: ['worker-a', 'worker-b'],
  });
  const group = await service.saveGroup(actor, null, groupCommand);
  assert.equal(
    (await service.saveGroup(actor, null, groupCommand)).receipt.resourceId,
    group.receipt.resourceId,
  );
  const selection = {
    selectedWorkerIds: [],
    selectedGroupIds: [group.receipt.resourceId],
    releaseId: signed.payload.releaseId,
    minimumClaimBuild: 2,
    allowedFallbackReleaseIds: [],
  };
  const preview = await service.preview(selection);
  await service.saveGroup(
    actor,
    group.receipt.resourceId,
    command({
      expectedRevision: 1,
      label: 'Group',
      workerIds: ['worker-a', 'worker-b', 'worker-c'],
    }),
  );
  await assert.rejects(
    service.confirm(actor, command({ ...selection, ...preview.confirmation })),
    /Conflict|conflict/i,
  );
  await service.saveGroup(
    actor,
    group.receipt.resourceId,
    command({
      expectedRevision: 2,
      label: 'Group',
      workerIds: ['worker-a', 'worker-b'],
    }),
  );
  const staleWorker = await service.preview(selection);
  await models.WorkerControl.updateOne(
    { _id: 'worker-a' },
    { $inc: { managementRevision: 1 } },
  );
  await assert.rejects(
    service.confirm(
      actor,
      command({ ...selection, ...staleWorker.confirmation }),
    ),
  );
  const staleRuntime = await service.preview(selection);
  await models.WorkerRuntime.updateOne(
    { _id: 'worker-a' },
    { $set: { 'report.launcherBuild': 2 } },
  );
  await assert.rejects(
    service.confirm(
      actor,
      command({ ...selection, ...staleRuntime.confirmation }),
    ),
  );
  const fresh = await service.preview(selection);
  // Liveness and activity updates do not invalidate an otherwise unchanged preview.
  await models.WorkerControl.updateOne(
    { _id: 'worker-a' },
    { $inc: { controlRevision: 1 } },
  );
  await models.WorkerRuntime.updateOne(
    { _id: 'worker-a' },
    { $set: { receivedAt: new Date(), 'report.activity': 'busy' } },
  );
  const confirmed = await service.confirm(
    actor,
    command({ ...selection, ...fresh.confirmation }),
  );
  await service.saveGroup(
    actor,
    group.receipt.resourceId,
    command({
      expectedRevision: 3,
      label: 'Group',
      workerIds: ['worker-a', 'worker-b', 'worker-c'],
    }),
  );
  const clockStarted = Date.now();
  for (const workerId of ['worker-c', 'worker-a']) {
    const decision = await service.getUpdateDecision(workerId);
    const serverTime = Date.parse(decision.serverTime);
    assert.ok(serverTime >= clockStarted && serverTime <= Date.now());
    assert.equal(new Date(serverTime).toISOString(), decision.serverTime);
  }
  assert.equal((await service.getUpdateDecision('worker-c')).target, null);
  assert.equal(
    (await service.getUpdateDecision('worker-c')).minimumClaimBuild,
    0,
  );
  assert.equal(
    (await service.getUpdateDecision('worker-a')).target.releaseId,
    signed.payload.releaseId,
  );
  await service.releaseAction(
    actor,
    signed.payload.releaseId,
    'stable',
    command({ expectedRevision: 1 }),
  );
  assert.equal((await service.getUpdateDecision('worker-c')).target, null);
  assert.equal(
    (await service.stable('linux-x64-cuda')).target.releaseId,
    signed.payload.releaseId,
  );
  const racing = await service.preview({
    ...selection,
    selectedGroupIds: [],
    selectedWorkerIds: ['worker-c'],
  });
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      service.confirm(
        actor,
        command({
          ...selection,
          selectedGroupIds: [],
          selectedWorkerIds: ['worker-c'],
          ...racing.confirmation,
        }),
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  await assert.rejects(
    service.preview({
      ...selection,
      selectedWorkerIds: Array.from({ length: 1001 }, (_, i) => `worker-${i}`),
    }),
  );
  await service.rolloutAction(
    actor,
    confirmed.receipt.resourceId,
    'pause',
    command({ expectedRevision: 1 }),
  );
  assert.equal((await service.getUpdateDecision('worker-a')).action, 'hold');
  await assert.rejects(
    service.updateStatus(
      {
        workerId: 'worker-a',
        keySha256: '1'.repeat(64),
        installationId: installationIds.get('worker-a'),
      },
      {
        policyRevision: 1,
        stage: 'activating',
        observedBuild: 2,
        eventId: randomUUID(),
      },
    ),
  );
  await models.WorkerUpdatePolicy.updateOne(
    { _id: 'worker-a' },
    { $set: { receivedAt: new Date(Date.now() - 600000), observedBuild: 1 } },
  );
  await service.rolloutAction(
    actor,
    confirmed.receipt.resourceId,
    'retry',
    command({ expectedRevision: 2, workerIds: ['worker-a'] }),
  );
  assert.equal((await service.getUpdateDecision('worker-a')).action, 'prepare');
  assert.equal(
    (await models.WorkerUpdatePolicy.findById('worker-a')).receivedAt,
    null,
  );
  assert.equal(
    (await models.WorkerUpdatePolicy.findById('worker-a')).observedBuild,
    null,
  );
  assert.equal((await service.getUpdateDecision('worker-b')).action, 'hold');
  const oldReceipt = receipt(1);
  await assert.rejects(
    service.createRelease(actor, command({ publicationReceipt: oldReceipt })),
  );
  const supersedingSelection = {
    ...selection,
    selectedGroupIds: [],
    selectedWorkerIds: ['worker-a'],
  };
  const superseding = await service.preview(supersedingSelection);
  await assert.rejects(
    service.confirm(
      actor,
      command({ ...supersedingSelection, ...superseding.confirmation }),
    ),
  );
  const replacement = await service.confirm(
    actor,
    command({
      ...supersedingSelection,
      ...superseding.confirmation,
      supersedeRolloutIds: [confirmed.receipt.resourceId],
    }),
  );
  assert.notEqual(replacement.receipt.resourceId, confirmed.receipt.resourceId);
  assert.equal((await service.getUpdateDecision('worker-a')).action, 'prepare');
  const identity = {
    workerId: 'worker-a',
    keySha256: '1'.repeat(64),
    installationId: installationIds.get('worker-a'),
  };
  const revision = (await service.getUpdateDecision('worker-a')).policyRevision;
  for (const stage of [
    'downloading',
    'prepared',
    'waiting_for_idle',
    'validating',
    'activating',
    'running',
  ]) {
    if (stage === 'running')
      await models.WorkerRuntime.updateOne(
        { _id: 'worker-a' },
        { $set: { 'report.workerBuild': 2 } },
      );
    if (stage === 'activating') {
      await models.WorkerRuntime.updateOne(
        { _id: 'worker-a' },
        { $set: { 'report.modelSha256': 'f'.repeat(64) } },
      );
      await assert.rejects(
        service.updateStatus(identity, {
          policyRevision: revision,
          stage,
          observedBuild: 1,
          eventId: randomUUID(),
        }),
      );
      await models.WorkerRuntime.updateOne(
        { _id: 'worker-a' },
        { $set: { 'report.modelSha256': 'd'.repeat(64) } },
      );
    }
    await service.updateStatus(identity, {
      policyRevision: revision,
      stage,
      observedBuild: stage === 'running' ? 2 : 1,
      eventId: randomUUID(),
    });
  }
  await assert.rejects(
    service.updateStatus(identity, {
      policyRevision: revision,
      stage: 'verified',
      observedBuild: 2,
      eventId: randomUUID(),
    }),
  );
  await service.rolloutAction(
    actor,
    replacement.receipt.resourceId,
    'pause',
    command({ expectedRevision: 1 }),
  );
  assert.equal(
    (await service.detail(replacement.receipt.resourceId)).workers[0].stage,
    'running',
  );
  const processingAttemptId = randomUUID();
  await models.JobAttempt.create({
    workerId: 'worker-b',
    jobId: new Types.ObjectId(),
    attemptId: processingAttemptId,
    sessionId: randomUUID(),
    generation: 1,
    startedAt: new Date(),
    endedAt: new Date(),
    outcome: 'ready',
  });
  await models.WorkerRuntime.updateOne(
    { _id: 'worker-a' },
    { $set: { 'report.workerBuild': 2 } },
  );
  await assert.rejects(
    service.updateStatus(identity, {
      policyRevision: revision,
      stage: 'verified',
      observedBuild: 2,
      eventId: randomUUID(),
      processingAttemptId,
    }),
  );
  const ownAttemptId = randomUUID();
  await models.JobAttempt.create({
    workerId: 'worker-a',
    jobId: new Types.ObjectId(),
    attemptId: ownAttemptId,
    sessionId: randomUUID(),
    generation: 1,
    startedAt: new Date(),
    endedAt: new Date(),
    outcome: 'ready',
  });
  await service.updateStatus(identity, {
    policyRevision: revision,
    stage: 'verified',
    observedBuild: 2,
    eventId: randomUUID(),
    processingAttemptId: ownAttemptId,
  });
  assert.equal(
    (await service.detail(replacement.receipt.resourceId)).counts.verified,
    1,
  );
  const oldEvent = new Date(Date.now() - 600000);
  await models.WorkerUpdatePolicy.updateOne(
    { _id: 'worker-a' },
    { $set: { receivedAt: oldEvent } },
  );
  await models.WorkerRuntime.updateOne(
    { _id: 'worker-a' },
    { $set: { receivedAt: new Date() } },
  );
  assert.equal(
    (await service.detail(replacement.receipt.resourceId)).counts.offline,
    0,
  );
  await models.WorkerRuntime.updateOne(
    { _id: 'worker-a' },
    { $set: { receivedAt: oldEvent } },
  );
  await models.WorkerControl.updateOne(
    { _id: 'worker-a' },
    { $set: { lastSeenAt: oldEvent } },
  );
  assert.equal(
    (await service.detail(replacement.receipt.resourceId)).counts.offline,
    1,
  );
  assert.equal(
    (
      await service.detail(replacement.receipt.resourceId)
    ).workers[0].receivedAt.getTime(),
    oldEvent.getTime(),
  );
  const savedRuntime = await models.WorkerRuntime.findById('worker-a').lean();
  await models.WorkerRuntime.deleteOne({ _id: 'worker-a' });
  await models.WorkerControl.updateOne(
    { _id: 'worker-a' },
    { $set: { lastSeenAt: null } },
  );
  assert.equal(
    (await service.detail(replacement.receipt.resourceId)).counts.unknown,
    1,
  );
  assert.equal(
    (await service.detail(replacement.receipt.resourceId)).counts.offline,
    0,
  );
  await models.WorkerRuntime.create(savedRuntime);
  const nextReceipt = receipt(3);
  await service.createRelease(
    actor,
    command({ publicationReceipt: nextReceipt }),
  );
  await service.releaseAction(
    actor,
    nextReceipt.payload.releaseId,
    'publish',
    command({ publicationReceipt: nextReceipt }),
  );
  const fallbackSelection = {
    ...selection,
    selectedGroupIds: [],
    selectedWorkerIds: ['worker-c'],
    releaseId: nextReceipt.payload.releaseId,
    allowedFallbackReleaseIds: [signed.payload.releaseId],
  };
  const fallbackPreview = await service.preview(fallbackSelection);
  await service.confirm(
    actor,
    command({
      ...fallbackSelection,
      ...fallbackPreview.confirmation,
      supersedeRolloutIds: [fallbackPreview.workers[0].rolloutId],
    }),
  );
  assert.deepEqual(
    (await service.getUpdateDecision('worker-c')).allowedFallbackReleaseIds,
    [signed.payload.releaseId],
  );
  const upgraded = receipt(4);
  const source = {
    profileId: 'linux-x64-cuda',
    modelSha256: 'd'.repeat(64),
    runtimeLockSha256: 'c'.repeat(64),
    rollbackAllowed: true,
  };
  Object.assign(upgraded.payload.artifacts[0], {
    profileId: 'linux-x64-cuda-v2',
    modelSha256: 'e'.repeat(64),
    runtimeLockSha256: 'f'.repeat(64),
    compatibleSources: [source],
  });
  upgraded.payload.artifacts[0].artifactPath =
    upgraded.payload.artifacts[0].artifactPath.replace(
      '/linux-x64-cuda/',
      '/linux-x64-cuda-v2/',
    );
  const signReceipt = (r) => ({
    ...r,
    signature: sign(null, receiptBytes(r.payload), keys.privateKey).toString(
      'base64url',
    ),
  });
  const upgradeReceipt = signReceipt(upgraded);
  const tampered = structuredClone(upgradeReceipt);
  tampered.payload.artifacts[0].compatibleSources[0].rollbackAllowed = false;
  assert.throws(() => new PublicationReceiptVerifier(config).verify(tampered));
  await service.createRelease(
    actor,
    command({ publicationReceipt: upgradeReceipt }),
  );
  await service.releaseAction(
    actor,
    upgraded.payload.releaseId,
    'publish',
    command({ publicationReceipt: upgradeReceipt }),
  );
  const upgradeSelection = {
    ...fallbackSelection,
    releaseId: upgraded.payload.releaseId,
  };
  for (const bad of [
    { 'report.modelSha256': '0'.repeat(64) },
    { 'report.os': 'windows' },
    { 'report.arch': 'arm64' },
  ]) {
    await models.WorkerRuntime.updateOne({ _id: 'worker-c' }, { $set: bad });
    assert.ok(
      (await service.preview(upgradeSelection)).workers[0].reasonCodes.includes(
        'INCOMPATIBLE_PROFILE',
      ),
    );
    await models.WorkerRuntime.updateOne(
      { _id: 'worker-c' },
      {
        $set: {
          'report.modelSha256': source.modelSha256,
          'report.os': 'linux',
          'report.arch': 'x64',
        },
      },
    );
  }
  const upgradePreview = await service.preview(upgradeSelection);
  assert.deepEqual(upgradePreview.workers[0].reasonCodes, []);
  await service.confirm(
    actor,
    command({
      ...upgradeSelection,
      ...upgradePreview.confirmation,
      supersedeRolloutIds: [upgradePreview.workers[0].rolloutId],
    }),
  );
  const cIdentity = {
    workerId: 'worker-c',
    keySha256: '3'.repeat(64),
    installationId: installationIds.get('worker-c'),
  };
  const cRevision = (await service.getUpdateDecision('worker-c'))
    .policyRevision;
  for (const stage of [
    'downloading',
    'prepared',
    'waiting_for_idle',
    'validating',
    'activating',
  ])
    await service.updateStatus(cIdentity, {
      policyRevision: cRevision,
      stage,
      observedBuild: 1,
      eventId: randomUUID(),
    });
  assert.equal(
    (await models.WorkerUpdatePolicy.findById('worker-c')).observedBuild,
    1,
  );
  await assert.rejects(
    service.updateStatus(cIdentity, {
      policyRevision: cRevision,
      stage: 'running',
      observedBuild: 4,
      eventId: randomUUID(),
    }),
  );
  await models.WorkerRuntime.updateOne(
    { _id: 'worker-c' },
    {
      $set: {
        'report.workerBuild': 4,
        'report.profileId': 'linux-x64-cuda-v2',
        'report.modelSha256': 'e'.repeat(64),
        'report.runtimeLockSha256': 'f'.repeat(64),
      },
    },
  );
  await service.updateStatus(cIdentity, {
    policyRevision: cRevision,
    stage: 'running',
    observedBuild: 4,
    eventId: randomUUID(),
  });
  const upgradeAttempt = randomUUID();
  await models.JobAttempt.create({
    workerId: 'worker-c',
    jobId: new Types.ObjectId(),
    attemptId: upgradeAttempt,
    sessionId: randomUUID(),
    generation: 1,
    startedAt: new Date(),
    endedAt: new Date(),
    outcome: 'ready',
  });
  await models.WorkerRuntime.updateOne(
    { _id: 'worker-c' },
    { $set: { 'report.modelSha256': source.modelSha256 } },
  );
  await assert.rejects(
    service.updateStatus(cIdentity, {
      policyRevision: cRevision,
      stage: 'verified',
      observedBuild: 4,
      eventId: randomUUID(),
      processingAttemptId: upgradeAttempt,
    }),
  );
  await models.WorkerRuntime.updateOne(
    { _id: 'worker-c' },
    { $set: { 'report.modelSha256': 'e'.repeat(64) } },
  );
  await service.updateStatus(cIdentity, {
    policyRevision: cRevision,
    stage: 'verified',
    observedBuild: 4,
    eventId: randomUUID(),
    processingAttemptId: upgradeAttempt,
  });
  assert.deepEqual(
    (await service.getUpdateDecision('worker-c')).allowedFallbackReleaseIds,
    [signed.payload.releaseId],
  );
  await assert.rejects(
    service.updateStatus(cIdentity, {
      policyRevision: cRevision,
      stage: 'rolled_back',
      observedBuild: 2,
      eventId: randomUUID(),
    }),
  );
  await models.WorkerRuntime.updateOne(
    { _id: 'worker-c' },
    {
      $set: {
        'report.workerBuild': 2,
        'report.profileId': source.profileId,
        'report.modelSha256': source.modelSha256,
        'report.runtimeLockSha256': source.runtimeLockSha256,
      },
    },
  );
  await service.updateStatus(cIdentity, {
    policyRevision: cRevision,
    stage: 'rolled_back',
    observedBuild: 2,
    eventId: randomUUID(),
  });
  const forbiddenRollback = receipt(5);
  Object.assign(forbiddenRollback.payload.artifacts[0], {
    profileId: 'linux-x64-cuda-v2',
    modelSha256: 'e'.repeat(64),
    runtimeLockSha256: 'f'.repeat(64),
    compatibleSources: [{ ...source, rollbackAllowed: false }],
  });
  forbiddenRollback.payload.artifacts[0].artifactPath =
    forbiddenRollback.payload.artifacts[0].artifactPath.replace(
      '/linux-x64-cuda/',
      '/linux-x64-cuda-v2/',
    );
  const forbiddenSigned = signReceipt(forbiddenRollback);
  await service.createRelease(
    actor,
    command({ publicationReceipt: forbiddenSigned }),
  );
  await service.releaseAction(
    actor,
    forbiddenSigned.payload.releaseId,
    'publish',
    command({ publicationReceipt: forbiddenSigned }),
  );
  assert.ok(
    (
      await service.preview({
        ...upgradeSelection,
        releaseId: forbiddenSigned.payload.releaseId,
      })
    ).workers[0].reasonCodes.includes('INCOMPATIBLE_FALLBACK'),
  );
  const ambiguous = receipt(6);
  const baseArtifact = ambiguous.payload.artifacts[0];
  ambiguous.payload.artifacts.push({
    ...baseArtifact,
    profileId: 'linux-x64-cuda-v2',
    artifactPath: baseArtifact.artifactPath.replace(
      '/linux-x64-cuda/',
      '/linux-x64-cuda-v2/',
    ),
    modelSha256: 'e'.repeat(64),
    compatibleSources: [source],
  });
  const ambiguousSigned = signReceipt(ambiguous);
  await service.createRelease(
    actor,
    command({ publicationReceipt: ambiguousSigned }),
  );
  await service.releaseAction(
    actor,
    ambiguousSigned.payload.releaseId,
    'publish',
    command({ publicationReceipt: ambiguousSigned }),
  );
  assert.ok(
    (
      await service.preview({
        ...upgradeSelection,
        releaseId: ambiguousSigned.payload.releaseId,
      })
    ).workers[0].reasonCodes.includes('AMBIGUOUS_TARGET'),
  );
  await service.releaseAction(
    actor,
    signed.payload.releaseId,
    'withdraw',
    command({ expectedRevision: 2 }),
  );
  const withdrawn = await service.getUpdateDecision('worker-a');
  assert.equal(withdrawn.action, 'hold');
  assert.equal(withdrawn.target, null);
  assert.equal((await service.stable('linux-x64-cuda')).target, null);
  assert.deepEqual(
    (await service.getUpdateDecision('worker-c')).allowedFallbackReleaseIds,
    [],
  );
  const token = 'isolated-worker-update-token';
  await models.WorkerRegistration.updateOne(
    { _id: 'worker-c' },
    { $set: { keySha256: createHash('sha256').update(token).digest('hex') } },
  );
  const redis = new Redis({
    host: '127.0.0.1',
    port: redisPort,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
  });
  await new Promise((resolve) => redis.once('ready', resolve));
  t.after(() => redis.disconnect());
  const budget = new RateBudgetService(redis),
    keysService = new RateLimitKeys(
      new ConfigService({
        RATE_LIMIT_HASH_SECRET: 'isolated-test-secret'.repeat(3),
        FIREBASE_PROJECT_ID: 'demo-worker-rollouts',
      }),
    );
  const module = await Test.createTestingModule({
    controllers: [WorkerUpdateController],
    providers: [
      { provide: WorkerRolloutsService, useValue: service },
      { provide: RateBudgetService, useValue: budget },
      { provide: RateLimitKeys, useValue: keysService },
    ],
  }).compile();
  const app = module.createNestApplication();
  const workerConfig = new ConfigService({});
  app.useGlobalGuards(
    new WorkerAuthGuard(
      new Reflector(),
      workerConfig,
      new WorkerIdentityService(
        new WorkerRegistryService(
          models.WorkerRegistration,
          models.WorkerControl,
          workerConfig,
        ),
      ),
    ),
  );
  await app.init();
  t.after(() => app.close());
  const http = supertest(app.getHttpServer());
  assert.equal((await http.get('/worker/update-policy')).status, 401);
  assert.equal(
    (
      await http
        .get('/worker/update-policy')
        .auth('installation-token', { type: 'bearer' })
    ).status,
    401,
  );
  const own = await http
    .get('/worker/update-policy')
    .auth(token, { type: 'bearer' });
  assert.equal(own.status, 200);
  assert.equal(own.headers['cache-control'], 'no-store');
  assert.equal(
    (
      await http
        .post('/worker/update-status')
        .auth(token, { type: 'bearer' })
        .send({
          workerId: 'worker-a',
          policyRevision: 1,
          stage: 'failed',
          observedBuild: 1,
          eventId: randomUUID(),
        })
    ).status,
    400,
  );
  for (let i = 0; i < 60; i++)
    await budget.reserve([
      {
        key: keysService.bucket('worker-update', 'worker-c'),
        limit: 60,
        windowMs: 60000,
      },
    ]);
  assert.equal(
    (await http.get('/worker/update-policy').auth(token, { type: 'bearer' }))
      .status,
    429,
  );
  const redisKeys = await redis.keys('*');
  assert.ok(redisKeys.length);
  assert.ok(redisKeys.every((key) => !key.includes('worker-c')));
  redis.disconnect();
  assert.equal(
    (await http.get('/worker/update-policy').auth(token, { type: 'bearer' }))
      .status,
    503,
  );
  assert.ok((await audit.countDocuments()) >= 9);
});

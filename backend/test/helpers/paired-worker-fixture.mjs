import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  WorkerInstallationSchema,
  InstallationOperationSchema,
} from '../../dist/worker-installations/worker-installation.schema.js';
import { InstallationPairingService } from '../../dist/worker-installations/installation-pairing.service.js';
import { WorkerQualificationService } from '../../dist/worker/worker-qualification.service.js';
import { WorkerRuntimeService } from '../../dist/worker/worker-runtime.service.js';
import { WorkerRegistryService } from '../../dist/worker/worker-registry.service.js';
import { ProcessingTransactions } from '../../dist/processing/processing-transactions.js';
import { AdminAccessSchema } from '../../dist/admin/admin-access.schema.js';
import { AdminAuditEventSchema } from '../../dist/admin/admin-audit.schema.js';
import { AdminOperationSchema } from '../../dist/admin/admin-operation.schema.js';
import { AdminOperationsService } from '../../dist/admin/admin-operations.service.js';
import { AdminAuditService } from '../../dist/admin/admin-audit.service.js';

const digest = (raw) => createHash('sha256').update(raw).digest('hex');
const hash = 'a'.repeat(64);

// Synthetic approved recipe and service execution only: this is not native GPU proof.
// Every caller enrolls via the real pairing transaction and permanent readiness gate.
export async function pairedWorkerFixture(
  db,
  { label = 'Isolated worker', rawKey = randomBytes(32).toString('hex') } = {},
) {
  for (const [name, schema] of Object.entries({
    WorkerInstallation: WorkerInstallationSchema,
    InstallationOperation: InstallationOperationSchema,
    AdminAccess: AdminAccessSchema,
    AdminAuditEvent: AdminAuditEventSchema,
    AdminOperation: AdminOperationSchema,
  })) {
    if (!db.models[name]) db.model(name, schema);
    await db.model(name).init();
  }
  const config = new ConfigService({
    RATE_LIMIT_HASH_SECRET: 'isolated-fleet-pairing-fixture-secret',
    PROCESSING_LEASE_SECONDS: 90,
  });
  const registry = new WorkerRegistryService(
    db.model('WorkerRegistration'),
    db.model('WorkerControl'),
    config,
  );
  const operations = new AdminOperationsService(
    db,
    db.model('AdminAccess'),
    db.model('AdminOperation'),
    new AdminAuditService(db.model('AdminAuditEvent')),
  );
  const qualification = new WorkerQualificationService(db);
  const pairing = new InstallationPairingService(
    db,
    db.model('WorkerInstallation'),
    qualification,
    operations,
    config,
    registry,
  );
  const actor = {
    uid: `fixture-${randomUUID()}`,
    verifiedEmail: `pairing-${randomUUID()}@example.test`,
    role: 'worker_manager',
    permissions: ['workers.manage'],
    accessRevision: 0,
    authTimeSec: Math.floor(Date.now() / 1000),
  };
  await db.model('AdminAccess').create({
    uid: actor.uid,
    verifiedEmail: actor.verifiedEmail,
    role: actor.role,
    active: true,
  });
  let release = await db
    .model('WorkerRelease')
    .findOne({ buildNumber: 100 })
    .lean();
  if (!release) {
    const releaseId = randomUUID();
    release = await db.model('WorkerRelease').create({
      _id: releaseId,
      buildNumber: 100,
      state: 'published',
      metadata: {
        artifacts: [
          {
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
            approvedProfile: {
              evidenceSha256: hash,
              fixtureSha256: hash,
              fixtureDurationSeconds: 7200,
              provider: 'CUDAExecutionProvider',
              serviceBindingSha256: hash,
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
              maxDurationSeconds: 7200,
              maxPreparedAudioBytes: 30000000,
              maxWallMilliseconds: 60000,
            },
          },
        ],
      },
    });
  }
  const artifact = release.metadata.artifacts[0];
  const installationId = randomUUID(),
    token = randomBytes(32).toString('hex');
  await pairing.register({
    installationId,
    tokenSha256: digest(token),
    installerBuild: 1,
    os: 'linux',
    arch: 'x64',
  });
  const runtime = {
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
  const report = await pairing.report(installationId, `Bearer ${token}`, {
    runtime,
    qualificationReport: {
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
    serviceBindingSha256: hash,
  });
  const issued = await pairing.issue(installationId, `Bearer ${token}`, {
    operationId: randomUUID(),
    workerKeySha256: digest(rawKey),
    reportId: report.reportId,
  });
  const current = await pairing.status(installationId, `Bearer ${token}`);
  const approval = await pairing.approve(actor, {
    operationId: randomUUID(),
    userCode: issued.userCode,
    expectedRevision: current.revision,
    label,
  });
  const identity = await registry.authenticateDigest(digest(rawKey));
  assert.equal(identity.workerId, approval.workerId);
  const runtimeService = new WorkerRuntimeService(
    db.model('WorkerRuntime'),
    db.model('WorkerRegistration'),
    registry,
    new ProcessingTransactions(db),
  );
  const ready = await runtimeService.installationReady(identity, {
    installationId,
    runtime,
    qualificationReportId: report.reportId,
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
  assert.equal(ready.canClaim, true, JSON.stringify(ready));
  return { ...identity, rawKey, runtime, reportId: report.reportId };
}

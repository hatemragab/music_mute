import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import mongoose, { createConnection } from 'mongoose';
import { Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { InstallationPairingService } from '../dist/worker-installations/installation-pairing.service.js';
import { InstallationLimitsService } from '../dist/worker-installations/installation-limits.service.js';
import {
  WorkerInstallationsController,
  AdminWorkerInstallationsController,
  PermanentWorkerQualificationController,
} from '../dist/worker-installations/worker-installations.controller.js';
import {
  WorkerInstallationSchema,
  InstallationOperationSchema,
} from '../dist/worker-installations/worker-installation.schema.js';
import { tokenDigest } from '../dist/worker-installations/installation-secrets.js';
import { WorkerQualificationService } from '../dist/worker/worker-qualification.service.js';
import { WorkerRegistryService } from '../dist/worker/worker-registry.service.js';
import { AdminWorkersService } from '../dist/admin-workers/admin-workers.service.js';
import { WorkerIdentityService } from '../dist/worker/worker-identity.service.js';
import { WorkerAuthGuard } from '../dist/worker/worker-auth.guard.js';
import { WorkerController } from '../dist/worker/worker.controller.js';
import { WorkerCoordinatorService } from '../dist/worker/worker-coordinator.service.js';
import { WorkerOutputService } from '../dist/worker/worker-output.service.js';
import { WorkerTerminalService } from '../dist/worker/worker-terminal.service.js';
import { WorkerRecoveryService } from '../dist/worker/worker-recovery.service.js';
import { WorkerClaimWaitService } from '../dist/worker/worker-claim-wait.service.js';
import { WorkerRuntimeService } from '../dist/worker/worker-runtime.service.js';
import { AdminAccessSchema } from '../dist/admin/admin-access.schema.js';
import { AdminAuditEventSchema } from '../dist/admin/admin-audit.schema.js';
import { AdminOperationSchema } from '../dist/admin/admin-operation.schema.js';
import { AdminAuditService } from '../dist/admin/admin-audit.service.js';
import { AdminOperationsService } from '../dist/admin/admin-operations.service.js';
import { AdminGuard } from '../dist/admin/admin.guard.js';
import { AdminRateLimitService } from '../dist/admin/admin-rate-limit.service.js';
import { AuthGuard } from '../dist/auth/auth.guard.js';
import { RateBudgetService } from '../dist/rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../dist/rate-limits/rate-limit-keys.js';
import { PublicExceptionFilter } from '../dist/http/public-exception.filter.js';
mongoose.set('sanitizeFilter', true);

test('isolated compiled HTTP installation pairing, authority, races and privacy', async (t) => {
  const native = await IsolatedServices.create();
  t.after(() => native.stop());
  const services = await native.startDatabases({ replicaSet: true });
  const db = await createConnection(services.mongoUri).asPromise();
  t.after(() => db.close());
  const redis = new Redis(`redis://127.0.0.1:${services.redisPort}`, {
    maxRetriesPerRequest: 0,
  });
  t.after(() => redis.disconnect());
  for (const { name, schema } of PROCESSING_MODELS) db.model(name, schema);
  for (const [name, schema] of Object.entries({
    WorkerInstallation: WorkerInstallationSchema,
    InstallationOperation: InstallationOperationSchema,
    AdminAccess: AdminAccessSchema,
    AdminAuditEvent: AdminAuditEventSchema,
    AdminOperation: AdminOperationSchema,
  }))
    db.model(name, schema);
  await Promise.all(Object.values(db.models).map((model) => model.init()));
  const config = new ConfigService({
    RATE_LIMIT_HASH_SECRET: randomBytes(32).toString('hex'),
    FIREBASE_PROJECT_ID: 'isolated-pairing',
    PROCESSING_LEASE_SECONDS: 90,
    AUDIO_PROCESSING_ENABLED: true,
    ADMIN_WRITES_PER_MINUTE: 500,
  });
  const budgets = new RateBudgetService(redis),
    keys = new RateLimitKeys(config);
  const audit = new AdminAuditService(db.model('AdminAuditEvent'));
  const operations = new AdminOperationsService(
    db,
    db.model('AdminAccess'),
    db.model('AdminOperation'),
    audit,
  );
  const qualification = new WorkerQualificationService(db);
  const registry = new WorkerRegistryService(
    db.model('WorkerRegistration'),
    db.model('WorkerControl'),
    config,
  );
  const pairing = new InstallationPairingService(
    db,
    db.model('WorkerInstallation'),
    qualification,
    operations,
    config,
    registry,
  );
  const limits = new InstallationLimitsService(budgets, keys);
  const identities = new WorkerIdentityService(registry);
  const firebase = {
    verifySignature: async (token) => {
      if (!['manager', 'viewer', 'stale', 'guesser'].includes(token))
        throw new UnauthorizedException();
      return { uid: token };
    },
    verifySession: async (token) => ({
      uid: token,
      provider: 'google.com',
      tokenEmailVerified: true,
      authTimeSec:
        Math.floor(Date.now() / 1000) - (token === 'stale' ? 1000 : 0),
    }),
    getProfile: async (uid) => ({
      uid,
      email: `${uid}@example.test`,
      providerData: [
        { providerId: 'google.com', email: `${uid}@example.test` },
      ],
    }),
  };
  for (const uid of ['manager', 'viewer', 'stale', 'guesser'])
    await db.model('AdminAccess').create({
      uid,
      verifiedEmail: `${uid}@example.test`,
      role: uid === 'viewer' ? 'viewer' : 'worker_manager',
      active: true,
    });
  const providers = [
    [InstallationPairingService, pairing],
    [InstallationLimitsService, limits],
    [WorkerIdentityService, identities],
    ...[
      WorkerCoordinatorService,
      WorkerOutputService,
      WorkerTerminalService,
      WorkerRecoveryService,
      WorkerClaimWaitService,
      WorkerRuntimeService,
    ].map((type) => [type, {}]),
  ].map(([provide, useValue]) => ({ provide, useValue }));
  const module = await Test.createTestingModule({
    controllers: [
      WorkerInstallationsController,
      AdminWorkerInstallationsController,
      PermanentWorkerQualificationController,
      WorkerController,
    ],
    providers,
  }).compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new PublicExceptionFilter());
  const reflector = new Reflector();
  app.useGlobalGuards(
    new AuthGuard(reflector, firebase, {}, budgets, keys, config),
    new AdminGuard(
      reflector,
      firebase,
      db.model('AdminAccess'),
      new AdminRateLimitService(budgets, keys, config),
      config,
    ),
    new WorkerAuthGuard(reflector, config, identities),
  );
  await app.init();
  t.after(() => app.close());
  const http = supertest(app.getHttpServer());
  const post = (path, token, body) =>
    http
      .post(`/api/v1/${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const get = (path, token) =>
    http.get(`/api/v1/${path}`).set('Authorization', `Bearer ${token}`);
  const hash = 'a'.repeat(64),
    releaseId = randomUUID();
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
    approvedProfile: {
      fixtureDurationSeconds: 600,
      maxDurationSeconds: 600,
      fixtureSha256: hash,
      provider: 'CUDAExecutionProvider',
      serviceBindingSha256: hash,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      maxWallMilliseconds: 60000,
    },
  };
  await db.model('WorkerRelease').create({
    _id: releaseId,
    buildNumber: 100,
    state: 'published',
    metadata: { artifacts: [artifact] },
  });
  const make = async () => {
    const id = randomUUID(),
      token = randomBytes(32).toString('hex'),
      workerToken = randomBytes(32).toString('hex');
    const dto = {
      installationId: id,
      tokenSha256: tokenDigest(token),
      installerBuild: 1,
      os: 'linux',
      arch: 'x64',
    };
    await pairing.register(dto);
    const runtime = {
      installationId: id,
      workerBuild: 100,
      launcherBuild: 1,
      protocolVersion: 3,
      profileId: artifact.profileId,
      modelSha256: hash,
      runtimeLockSha256: hash,
      os: 'linux',
      arch: 'x64',
      activity: 'starting',
      bootVerified: false,
    };
    const body = {
      runtime,
      qualificationReport: {
        profileId: artifact.profileId,
        modelSha256: hash,
        fixtureSha256: hash,
        provider: 'CUDAExecutionProvider',
        acceleratorUsed: true,
        deviceLabel: 'PRIVATE-HOST-NAME',
        wallMilliseconds: 100,
        peakRamBytes: null,
        peakGpuMemoryBytes: null,
        outputValid: true,
        referenceCheckPassed: true,
        serviceContextPassed: true,
        reasonCodes: [],
      },
      serviceBindingSha256: hash,
    };
    const report = await post(
      `worker-installations/${id}/qualification`,
      token,
      body,
    ).expect(201);
    return {
      id,
      token,
      workerToken,
      dto,
      body,
      reportId: report.body.reportId,
    };
  };
  const a = await make();
  await post('worker-installations', '', { ...a.dto, extra: true }).expect(400);
  const clockStarted = Date.now();
  const registrationReply = await post(
    'worker-installations',
    '',
    a.dto,
  ).expect(201);
  const installationReply = await get(
    `worker-installations/${a.id}`,
    a.token,
  ).expect(200);
  for (const reply of [registrationReply, installationReply]) {
    const serverTime = Date.parse(reply.body.serverTime);
    assert.ok(serverTime >= clockStarted && serverTime <= Date.now());
    assert.equal(new Date(serverTime).toISOString(), reply.body.serverTime);
  }
  await post('worker-installations', '', {
    ...a.dto,
    tokenSha256: 'b'.repeat(64),
  }).expect(409);
  await Promise.all(Array.from({ length: 6 }, () => pairing.register(a.dto)));
  assert.equal(
    await db.model('WorkerInstallation').countDocuments({ _id: a.id }),
    1,
  );
  await get(`worker-installations/${a.id}`, a.workerToken).expect(401);
  await post('worker/identity', a.token, {}).expect(401);
  await get('admin/worker-installations', a.token).expect(401);
  await get('admin/worker-installations', 'viewer').expect(200);
  await post(`worker-installations/${a.id}/qualification`, a.token, {
    ...a.body,
    runtime: { ...a.body.runtime, installationId: randomUUID() },
  }).expect(400);
  const request = {
    operationId: randomUUID(),
    workerKeySha256: tokenDigest(a.workerToken),
    reportId: a.reportId,
  };
  const code = await post(
    `worker-installations/${a.id}/pairing`,
    a.token,
    request,
  ).expect(201);
  const replay = await post(
    `worker-installations/${a.id}/pairing`,
    a.token,
    request,
  ).expect(201);
  assert.deepEqual(code.body, replay.body);
  await post(`worker-installations/${a.id}/pairing`, a.token, {
    ...request,
    workerKeySha256: 'c'.repeat(64),
  }).expect(409);
  const approval = {
    operationId: randomUUID(),
    expectedRevision: 1,
    userCode: code.body.userCode,
    label: 'Test worker',
  };
  await post('admin/worker-installations/approve', 'viewer', approval).expect(
    403,
  );
  await post('admin/worker-installations/approve', 'stale', approval).expect(
    403,
  );
  const approved = await post(
    'admin/worker-installations/approve',
    'manager',
    approval,
  ).expect(201);
  const recovered = await get(`worker-installations/${a.id}`, a.token).expect(
    200,
  );
  assert.equal(recovered.body.assignedWorkerId, approved.body.workerId);
  assert.equal(recovered.body.setupState, 'pending_boot_verification');
  assert.equal(
    (
      await post(
        'admin/worker-installations/approve',
        'manager',
        approval,
      ).expect(201)
    ).body.workerId,
    approved.body.workerId,
  );
  await post('worker/identity', a.workerToken, {}).expect(200);
  assert.equal(
    await db
      .model('WorkerRuntime')
      .countDocuments({ _id: approved.body.workerId }),
    0,
  );
  assert.equal(
    await db
      .model('WorkerRegistration')
      .countDocuments({ installationId: a.id }),
    1,
  );
  await db
    .model('WorkerInstallation')
    .updateOne({ _id: a.id }, { $set: { tokenExpiresAt: new Date(0) } });
  config.set('AUDIO_PROCESSING_ENABLED', false);
  try {
    await post('worker/qualification', a.workerToken, a.body).expect(201);
    await post('worker/qualification', a.token, a.body).expect(401);
    await post('worker/qualification', a.workerToken, {
      ...a.body,
      runtime: { ...a.body.runtime, installationId: randomUUID() },
    }).expect(400);
    await post('worker/claim', a.workerToken, {}).expect(503);
    assert.equal(
      await db
        .model('WorkerRuntime')
        .countDocuments({ _id: approved.body.workerId }),
      0,
      'maintenance qualification must not create claim readiness',
    );
  } finally {
    config.set('AUDIO_PROCESSING_ENABLED', true);
  }
  await db
    .model('WorkerInstallation')
    .updateOne(
      { _id: a.id },
      { $set: { tokenExpiresAt: new Date(Date.now() + 86400000) } },
    );
  await post(`worker-installations/${a.id}/pairing`, a.token, request).expect(
    409,
  );
  const safe =
    JSON.stringify(
      (await get(`admin/worker-installations/${a.id}`, 'manager').expect(200))
        .body,
    ) +
    JSON.stringify(await db.model('AdminAuditEvent').find().lean()) +
    JSON.stringify(await db.model('AdminOperation').find().lean());
  for (const value of [
    a.token,
    a.workerToken,
    a.dto.tokenSha256,
    request.workerKeySha256,
    code.body.userCode,
    'PRIVATE-HOST-NAME',
  ])
    assert.ok(!safe.includes(value));
  const b = await make();
  await get(`worker-installations/${b.id}`, a.token).expect(401);
  const renew = { operationId: randomUUID() };
  const renewed = await post(
    `worker-installations/${b.id}/renew`,
    b.token,
    renew,
  ).expect(201);
  assert.deepEqual(
    (
      await post(`worker-installations/${b.id}/renew`, b.token, renew).expect(
        201,
      )
    ).body,
    renewed.body,
  );
  const createdAt = new Date(Date.now() - 6.5 * 86400000);
  await db
    .model('WorkerInstallation')
    .updateOne({ _id: b.id }, { $set: { createdAt } });
  const bounded = await post(`worker-installations/${b.id}/renew`, b.token, {
    operationId: randomUUID(),
  }).expect(201);
  assert.equal(
    Date.parse(bounded.body.tokenExpiresAt),
    +createdAt + 7 * 86400000,
  );
  await db
    .model('WorkerInstallation')
    .updateOne({ _id: b.id }, { $set: { tokenExpiresAt: new Date(0) } });
  await get(`worker-installations/${b.id}`, b.token).expect(401);
  await post(`worker-installations/${b.id}/renew`, b.token, renew).expect(401);
  await post('worker-installations', '', b.dto).expect(409);
  const c = await make();
  const cIssue = {
    operationId: randomUUID(),
    workerKeySha256: tokenDigest(c.workerToken),
    reportId: c.reportId,
  };
  const cCode = await post(
    `worker-installations/${c.id}/pairing`,
    c.token,
    cIssue,
  ).expect(201);
  const outcomes = await Promise.all([
    post('admin/worker-installations/approve', 'manager', {
      ...approval,
      operationId: randomUUID(),
      userCode: cCode.body.userCode,
    }),
    post(`admin/worker-installations/${c.id}/reject`, 'manager', {
      operationId: randomUUID(),
      expectedRevision: 1,
      reason: 'Cancelled',
    }),
  ]);
  assert.equal(outcomes.filter((r) => r.status === 201).length, 1);
  const cRow = await db.model('WorkerInstallation').findById(c.id);
  assert.equal(
    await db
      .model('WorkerRegistration')
      .countDocuments({ installationId: c.id }),
    cRow.assignedWorkerId ? 1 : 0,
  );
  const d = await make();
  const dIssue = {
    operationId: randomUUID(),
    workerKeySha256: tokenDigest(d.workerToken),
    reportId: d.reportId,
  };
  const dCode = await post(
    `worker-installations/${d.id}/pairing`,
    d.token,
    dIssue,
  ).expect(201);
  await db
    .model('WorkerInstallation')
    .updateOne({ _id: d.id }, { $set: { codeExpiresAt: new Date(0) } });
  await post('admin/worker-installations/approve', 'manager', {
    ...approval,
    operationId: randomUUID(),
    userCode: dCode.body.userCode,
  }).expect(404);
  await post(`worker-installations/${d.id}/pairing`, d.token, dIssue).expect(
    409,
  );
  await post(`worker-installations/${d.id}/pairing`, d.token, {
    ...dIssue,
    operationId: randomUUID(),
    workerKeySha256: 'd'.repeat(64),
  }).expect(409);
  await post(`worker-installations/${d.id}/pairing`, d.token, {
    ...dIssue,
    operationId: randomUUID(),
  }).expect(201);
  await db
    .model('WorkerInstallation')
    .updateOne({ _id: d.id }, { $set: { revoked: true } });
  await post(
    `worker-installations/${d.id}/qualification`,
    d.token,
    d.body,
  ).expect(401);
  const e = await make();
  const eRequest = {
    operationId: randomUUID(),
    workerKeySha256: tokenDigest(e.workerToken),
    reportId: e.reportId,
  };
  const eCode = await post(
    `worker-installations/${e.id}/pairing`,
    e.token,
    eRequest,
  ).expect(201);
  await post('admin/worker-installations/approve', 'manager', {
    ...approval,
    operationId: randomUUID(),
    expectedRevision: 0,
    userCode: eCode.body.userCode,
  }).expect(404);
  const duplicateApprovals = await Promise.all(
    [1, 2].map(() =>
      post('admin/worker-installations/approve', 'manager', {
        ...approval,
        operationId: randomUUID(),
        userCode: eCode.body.userCode,
      }),
    ),
  );
  assert.equal(duplicateApprovals.filter((r) => r.status === 201).length, 1);
  assert.equal(
    await db
      .model('WorkerRegistration')
      .countDocuments({ installationId: e.id }),
    1,
  );
  await db
    .model('WorkerRegistration')
    .updateOne({ installationId: e.id }, { $set: { state: 'revoked' } });
  await post('worker/qualification', e.workerToken, e.body).expect(401);
  const f = await make();
  const scopedRequest = {
    operationId: randomUUID(),
    workerKeySha256: f.dto.tokenSha256,
    reportId: f.reportId,
  };
  await post(
    `worker-installations/${f.id}/pairing`,
    f.token,
    scopedRequest,
  ).expect(409);
  await post(`worker-installations/${f.id}/pairing`, f.token, {
    ...scopedRequest,
    workerKeySha256: a.dto.tokenSha256,
  }).expect(409);
  await assert.rejects(
    pairing.register({
      ...a.dto,
      installationId: randomUUID(),
      tokenSha256: tokenDigest(e.workerToken),
    }),
  );
  const namespaceRaceDigest = tokenDigest(randomBytes(32).toString('hex'));
  const namespaceRace = await Promise.allSettled([
    pairing.register({
      ...a.dto,
      installationId: randomUUID(),
      tokenSha256: namespaceRaceDigest,
    }),
    pairing.issue(f.id, `Bearer ${f.token}`, {
      operationId: randomUUID(),
      workerKeySha256: namespaceRaceDigest,
      reportId: f.reportId,
    }),
  ]);
  assert.equal(
    namespaceRace.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    await db
      .model('CredentialReservation')
      .countDocuments({ _id: namespaceRaceDigest }),
    1,
  );
  const freshRegistration = {
    ...a.dto,
    installationId: randomUUID(),
    tokenSha256: tokenDigest(randomBytes(32).toString('hex')),
  };
  const freshResults = await Promise.all(
    Array.from({ length: 4 }, () => pairing.register(freshRegistration)),
  );
  assert.ok(
    freshResults.every(
      (result) => result.installationId === freshRegistration.installationId,
    ),
  );
  const manager = {
    uid: 'manager',
    verifiedEmail: 'manager@example.test',
    role: 'worker_manager',
    permissions: ['workers.manage'],
    accessRevision: 0,
    authTimeSec: Math.floor(Date.now() / 1000),
  };
  const manual = new AdminWorkersService(
    db.model('WorkerRegistration'),
    db.model('WorkerControl'),
    registry,
    {},
    operations,
    audit,
    config,
  );
  assert.equal(typeof manual.create, 'undefined');
  await post('admin/workers', 'manager', {
    operationId: randomUUID(),
    id: 'manual-disallowed',
    label: 'Disallowed',
    reason: 'Fixture',
  }).expect(404);
  const rotationFixture = await make();
  const rotationRequest = await pairing.issue(
    rotationFixture.id,
    `Bearer ${rotationFixture.token}`,
    {
      operationId: randomUUID(),
      workerKeySha256: tokenDigest(rotationFixture.workerToken),
      reportId: rotationFixture.reportId,
    },
  );
  const rotationState = await pairing.status(
    rotationFixture.id,
    `Bearer ${rotationFixture.token}`,
  );
  const rotationApproved = await pairing.approve(manager, {
    operationId: randomUUID(),
    userCode: rotationRequest.userCode,
    expectedRevision: rotationState.revision,
    label: 'Rotation fixture',
  });
  const manualCreated = { rawKey: rotationFixture.workerToken };
  const oldDigest = tokenDigest(manualCreated.rawKey);
  assert.equal(
    (await db.model('CredentialReservation').findById(oldDigest)).scope,
    'worker',
  );
  await assert.rejects(
    pairing.register({
      ...a.dto,
      installationId: randomUUID(),
      tokenSha256: oldDigest,
    }),
  );
  const rotated = await manual.update(
    manager,
    rotationApproved.workerId,
    'rotate-key',
    { operationId: randomUUID(), expectedRevision: 0, reason: 'Fixture' },
  );
  assert.ok(await db.model('CredentialReservation').findById(oldDigest));
  assert.equal(
    (
      await db
        .model('CredentialReservation')
        .findById(tokenDigest(rotated.rawKey))
    ).scope,
    'worker',
  );
  await assert.rejects(
    pairing.register({
      ...a.dto,
      installationId: randomUUID(),
      tokenSha256: tokenDigest(rotated.rawKey),
    }),
  );
  const g = await make();
  const failed = await post(
    `worker-installations/${g.id}/qualification`,
    g.token,
    {
      ...g.body,
      qualificationReport: {
        ...g.body.qualificationReport,
        acceleratorUsed: false,
        outputValid: false,
      },
    },
  ).expect(201);
  await post(`worker-installations/${g.id}/pairing`, g.token, {
    operationId: randomUUID(),
    workerKeySha256: tokenDigest(g.workerToken),
    reportId: failed.body.reportId,
  }).expect(409);
  for (let i = 0; i < 5; i++) {
    const unknown = await post(
      'admin/worker-installations/approve',
      'guesser',
      { ...approval, operationId: randomUUID(), userCode: '00000-00000' },
    ).expect(404);
    assert.equal(unknown.body.code, 'RESOURCE_NOT_FOUND');
    assert.ok(!JSON.stringify(unknown.body).includes('00000-00000'));
  }
  const limited = await post('admin/worker-installations/approve', 'guesser', {
    ...approval,
    operationId: randomUUID(),
    userCode: '00000-00000',
  }).expect(429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  await post('worker-installations', '', a.dto);
  await post('worker-installations', '', a.dto);
  const registrationLimited = await post(
    'worker-installations',
    '',
    a.dto,
  ).expect(429);
  assert.ok(Number(registrationLimited.headers['retry-after']) > 0);
  redis.disconnect();
  await get(`worker-installations/${a.id}`, a.token).expect(503);
});

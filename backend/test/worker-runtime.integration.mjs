import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { createConnection, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { WorkerRegistryService } from '../dist/worker/worker-registry.service.js';
import { WorkerRuntimeService } from '../dist/worker/worker-runtime.service.js';
import { PublicExceptionFilter } from '../dist/http/public-exception.filter.js';
import { WorkerController } from '../dist/worker/worker.controller.js';
import { WorkerAuthGuard } from '../dist/worker/worker-auth.guard.js';
import { WorkerIdentityService } from '../dist/worker/worker-identity.service.js';
import { WorkerCoordinatorService } from '../dist/worker/worker-coordinator.service.js';
import { WorkerClaimWaitService } from '../dist/worker/worker-claim-wait.service.js';
import { WorkerOutputService } from '../dist/worker/worker-output.service.js';
import { WorkerTerminalService } from '../dist/worker/worker-terminal.service.js';
import { WorkerRecoveryService } from '../dist/worker/worker-recovery.service.js';

const installationId = '11111111-1111-4111-8111-111111111111';
const fixture = JSON.parse(
  await readFile(
    new URL('../../worker/contracts/worker-protocol-v3.json', import.meta.url),
    'utf8',
  ),
);
const report = fixture.runtime;

test('compiled runtime isolates bindings, observations and lifecycle revisions', async (t) => {
  const native = await IsolatedServices.create();
  t.after(() => native.stop());
  const { mongoUri } = await native.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  const models = Object.fromEntries(
    PROCESSING_MODELS.map(({ name, schema }) => [
      name,
      connection.model(name, schema),
    ]),
  );
  await Promise.all(Object.values(models).map((model) => model.init()));
  const token = 'synthetic-runtime-worker-a';
  const identity = {
    workerId: 'worker-a',
    keySha256: createHash('sha256').update(token).digest('hex'),
    installationId,
  };
  await models.WorkerRegistration.create({
    _id: identity.workerId,
    keySha256: identity.keySha256,
    label: 'A',
    state: 'enabled',
    installationId,
  });
  await models.WorkerRegistration.create({
    _id: 'worker-b',
    keySha256: 'b'.repeat(64),
    label: 'B',
    state: 'enabled',
    installationId: '22222222-2222-4222-8222-222222222222',
  });
  await connection.collection('worker_installations').insertMany([
    {
      _id: installationId,
      assignedWorkerId: identity.workerId,
      pairingState: 'approved',
      revoked: false,
    },
    {
      _id: '22222222-2222-4222-8222-222222222222',
      assignedWorkerId: 'worker-b',
      pairingState: 'approved',
      revoked: false,
    },
  ]);
  const foreignJobId = new Types.ObjectId();
  await models.WorkerControl.create([
    { _id: identity.workerId, managementRevision: 7 },
    { _id: 'worker-b', managementRevision: 9, activeJobId: foreignJobId },
  ]);
  const registry = new WorkerRegistryService(
    models.WorkerRegistration,
    models.WorkerControl,
    new ConfigService({}),
  );
  const service = new WorkerRuntimeService(
    models.WorkerRuntime,
    models.WorkerRegistration,
    registry,
    new ProcessingTransactions(connection),
  );
  const ready = {
    installationId,
    runtime: report,
    qualificationReportId: installationId,
    bootReport: {
      serviceBindingSha256: 'd'.repeat(64),
      profileId: report.profileId,
      installed: true,
      serviceContextPassed: true,
      unattendedRebootPassed: true,
      observedBootId: 'boot-1',
      observedAt: '2026-01-01T00:00:00.000Z',
      reasonCodes: [],
    },
  };
  await assert.rejects(
    service.installationReady(identity, {
      ...ready,
      installationId: '22222222-2222-4222-8222-222222222222',
      runtime: {
        ...report,
        installationId: '22222222-2222-4222-8222-222222222222',
      },
    }),
    (e) => e.getResponse().code === 'INSTALLATION_BINDING_MISMATCH',
  );
  assert.equal(await models.WorkerRuntime.countDocuments(), 0);
  assert.equal(
    (await models.WorkerControl.findById('worker-b')).controlRevision,
    0,
  );
  assert.equal(
    (await models.WorkerControl.findById('worker-b')).activeJobId.toHexString(),
    foreignJobId.toHexString(),
  );
  const before = Date.now();
  await service.store(identity, report);
  const observed = await service.readRuntime(identity.workerId);
  assert.ok(observed.receivedAt.getTime() >= before);
  assert.equal(observed.report.bootVerified, true);
  assert.equal(observed.reportedBoot, null);
  assert.equal(
    (await models.WorkerControl.findById(identity.workerId)).controlRevision,
    0,
  );
  const decision = await service.installationReady(identity, ready);
  assert.equal(decision.canClaim, false);
  assert.ok(decision.reasonCodes.includes('GPU_QUALIFICATION_REQUIRED'));
  const control = await models.WorkerControl.findById(identity.workerId);
  assert.equal(control.controlRevision, 1);
  assert.equal(control.managementRevision, 7);
  assert.equal(control.activeJobId, null);
  await service.store(identity, {
    ...report,
    bootVerified: false,
    activity: 'paused',
  });
  assert.equal(
    (await service.readRuntime(identity.workerId)).reportedBoot
      .unattendedRebootPassed,
    true,
  );
  assert.equal(
    (await models.WorkerControl.findById(identity.workerId)).controlRevision,
    1,
  );
  assert.equal(
    (await models.WorkerControl.findById(identity.workerId)).managementRevision,
    7,
  );
  await models.WorkerRegistration.updateOne(
    { _id: identity.workerId },
    { $set: { state: 'draining' } },
  );
  assert.ok(
    (await service.installationReady(identity, ready)).reasonCodes.includes(
      'WORKER_NOT_ENABLED',
    ),
  );
  assert.equal(
    (await models.WorkerRegistration.findById(identity.workerId)).state,
    'draining',
  );

  const identities = new WorkerIdentityService(registry);
  const module = await Test.createTestingModule({
    controllers: [WorkerController],
    providers: [
      { provide: WorkerRuntimeService, useValue: service },
      { provide: WorkerIdentityService, useValue: identities },
      ...[
        WorkerCoordinatorService,
        WorkerClaimWaitService,
        WorkerOutputService,
        WorkerTerminalService,
        WorkerRecoveryService,
      ].map((provide) => ({ provide, useValue: {} })),
    ],
  }).compile();
  const app = module.createNestApplication();
  app.useGlobalGuards(
    new WorkerAuthGuard(new Reflector(), new ConfigService({}), identities),
  );
  app.useGlobalFilters(new PublicExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.init();
  t.after(() => app.close());
  const http = supertest(app.getHttpServer());
  assert.equal((await http.post('/worker/runtime').send(report)).status, 401);
  assert.equal(
    (
      await http
        .post('/worker/runtime')
        .auth('unpaired-installation-token', { type: 'bearer' })
        .send(report)
    ).status,
    401,
  );
  const response = await http
    .post('/worker/runtime')
    .auth(token, { type: 'bearer' })
    .send(report);
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  const foreign = await http
    .post('/worker/installation-ready')
    .auth(token, { type: 'bearer' })
    .send({
      ...ready,
      installationId: '22222222-2222-4222-8222-222222222222',
      runtime: {
        ...report,
        installationId: '22222222-2222-4222-8222-222222222222',
      },
    });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.code, 'INSTALLATION_BINDING_MISMATCH');
  const obsolete = await http
    .post('/worker/runtime')
    .auth(token, { type: 'bearer' })
    .send({ ...report, protocolVersion: 2 });
  assert.equal(obsolete.status, 426);
  assert.equal(obsolete.body.code, 'WORKER_REINSTALL_REQUIRED');
  assert.equal(
    (
      await http
        .post('/worker/runtime')
        .auth(token, { type: 'bearer' })
        .send({ ...report, workerId: 'worker-b' })
    ).status,
    400,
  );
  const description = await http
    .post('/worker/identity')
    .auth(token, { type: 'bearer' })
    .send({});
  assert.equal(description.body.protocolVersion, 3);
  assert.equal(description.status, 200);
  assert.equal(description.body.installationId, installationId);
  assert.equal(description.body.mediaPolicyVersion, 2);
  assert.equal(description.body.updateCapability.supported, false);
});

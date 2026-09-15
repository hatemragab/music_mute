import { pairedWorkerFixture } from './helpers/paired-worker-fixture.mjs';
import assert from 'node:assert/strict';
import { accountFixture } from './helpers/account-fixture.mjs';
import { WorkerRuntimeService } from '../dist/worker/worker-runtime.service.js';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { WorkerRegistryService } from '../dist/worker/worker-registry.service.js';
import { WorkerIdentityService } from '../dist/worker/worker-identity.service.js';
import { WorkerCoordinatorService } from '../dist/worker/worker-coordinator.service.js';
import { WorkerOutputService } from '../dist/worker/worker-output.service.js';
import { WorkerTerminalService } from '../dist/worker/worker-terminal.service.js';
import { WorkerRecoveryService } from '../dist/worker/worker-recovery.service.js';
import { WorkerController } from '../dist/worker/worker.controller.js';
import { WorkerAuthGuard } from '../dist/worker/worker-auth.guard.js';
import { WorkerClaimWaitService } from '../dist/worker/worker-claim-wait.service.js';
import { PublicExceptionFilter } from '../dist/http/public-exception.filter.js';
import { auditWorkerFleet } from '../dist/worker/worker-fleet-audit.js';

const code = (expected) => (error) => error.getResponse?.().code === expected;
const selector = (a) => ({
  jobId: a.jobId,
  attemptId: a.attemptId,
  sessionId: a.sessionId,
  generation: a.generation,
});
const event = (a) => ({ ...selector(a), eventId: randomUUID() });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test('fleet ownership across independent API instances', async (t) => {
  const native = await IsolatedServices.create();
  t.after(() => native.stop());
  const { mongoUri } = await native.startDatabases({ replicaSet: true });
  const connections = await Promise.all([
    createConnection(mongoUri, { sanitizeFilter: true }).asPromise(),
    createConnection(mongoUri, { sanitizeFilter: true }).asPromise(),
  ]);
  t.after(() =>
    Promise.all(connections.map((connection) => connection.close())),
  );
  for (const connection of connections) {
    for (const entry of PROCESSING_MODELS)
      connection.model(entry.name, entry.schema);
    await Promise.all(
      PROCESSING_MODELS.map(({ name }) => connection.model(name).init()),
    );
  }
  const config = new ConfigService({
    AUDIO_PROCESSING_ENABLED: true,
    PROCESSING_LEASE_SECONDS: 90,
    PROCESSING_OUTPUT_MAX_BYTES: 30_000_000,
  });
  const grants = [];
  const storage = {
    createDownloadGrant: async () => ({
      url: 'https://fixture.invalid/input',
      expiresAt: new Date().toISOString(),
    }),
    createOutputGrant: async (job) => {
      grants.push(job.workerId);
      return { url: 'https://fixture.invalid/output' };
    },
    findOutput: async () => null,
    verifyOutput: async (job) => ({
      key: job.outputReservation.key,
      bytes: job.outputReservation.bytes,
      sha256: job.outputReservation.sha256,
      contentType: job.outputReservation.contentType,
      versionId: 'fixture-output-version',
    }),
  };
  const accountAccess = { assertActive: async () => undefined };
  const apis = connections.map((connection) => {
    const model = (name) => connection.model(name);
    const transactions = new ProcessingTransactions(connection);
    const registry = new WorkerRegistryService(
      model('WorkerRegistration'),
      model('WorkerControl'),
      config,
    );
    const coordinator = new WorkerCoordinatorService(
      model('Job'),
      model('WorkerControl'),
      model('JobAttempt'),
      transactions,
      config,
      storage,
      model('JobReceipt'),
      accountAccess,
      registry,
    );
    const terminal = new WorkerTerminalService(
      coordinator,
      transactions,
      storage,
      model('JobAttempt'),
      model('JobReceipt'),
      model('JobError'),
      model('WorkerControl'),
      model('NotificationOutbox'),
      accountAccess,
    );
    return {
      registry,
      coordinator,
      terminal,
      transactions,
      identity: new WorkerIdentityService(registry),
      output: new WorkerOutputService(
        coordinator,
        transactions,
        storage,
        config,
        model('JobAttempt'),
        model('JobReceipt'),
        accountAccess,
      ),
      recovery: new WorkerRecoveryService(
        model('Job'),
        model('JobAttempt'),
        model('JobError'),
        model('WorkerControl'),
        transactions,
        coordinator,
        terminal,
        storage,
      ),
    };
  });
  const [a, b] = apis;
  const model = (name) => connections[0].model(name);
  const jobs = model('Job');
  const workers = model('WorkerControl');
  const attempts = model('JobAttempt');
  const reset = async () => {
    for (const { name } of PROCESSING_MODELS) await model(name).deleteMany({});
    grants.length = 0;
  };
  const workerIds = new Map();
  const register = async (label) => {
    const identity = await pairedWorkerFixture(connections[0], { label });
    workerIds.set(label, identity);
    return identity;
  };
  const enqueue = async (count) => {
    const ids = [];
    for (let i = 1; i <= count; i++) {
      const input = {
        key: `fixture/input-${i}`,
        extension: 'mp3',
        contentType: 'audio/mpeg',
        bytes: 100,
        durationSeconds: 10,
        sha256: Buffer.alloc(32).toString('base64'),
      };
      const job = await jobs.create({
        userId: new Types.ObjectId(),
        requestId: randomUUID(),
        requestHash: 'a'.repeat(64),
        inputReservation: input,
        inputObject: {
          key: input.key,
          bytes: input.bytes,
          sha256: input.sha256,
          contentType: input.contentType,
          versionId: 'fixture-input-version',
        },
        status: 'queued',
        queueOrder: BigInt(i),
      });
      await accountFixture(connections[0], [job.userId.toString()]);
      ids.push(job._id.toHexString());
    }
    return ids;
  };
  const change = async (identity, values) =>
    b.transactions.run(async (session) => {
      const control = await connections[1]
        .model('WorkerControl')
        .findById(identity.workerId)
        .session(session);
      await b.registry.touchControl(control, session);
      await connections[1]
        .model('WorkerRegistration')
        .updateOne({ _id: identity.workerId }, { $set: values }, { session });
    });
  const expire = async (assignment) => {
    await jobs.updateOne(
      { _id: assignment.jobId },
      { $set: { leaseExpiresAt: new Date(0) } },
    );
    await workers.updateOne(
      { _id: assignment.workerId },
      { $set: { leaseExpiresAt: new Date(0) } },
    );
  };

  await t.test(
    'twenty identities own twenty distinct oldest jobs with one slot per machine',
    async () => {
      await reset();
      const identities = [];
      assert.equal((await auditWorkerFleet(connections[0])).consistent, true);
      for (let index = 0; index < 20; index++)
        identities.push(await register(`machine-${index}`));
      const queued = await enqueue(21);
      const assignments = await Promise.all(
        identities.map((identity, index) =>
          apis[index % 2].coordinator.claim(randomUUID(), identity),
        ),
      );
      assert.equal(new Set(assignments.map((row) => row.jobId)).size, 20);
      assert.deepEqual(
        new Set(assignments.map((row) => row.jobId)),
        new Set(queued.slice(0, 20)),
      );
      for (let index = 0; index < identities.length; index++) {
        const identity = identities[index];
        const assigned = assignments[index];
        assert.equal(assigned.workerId, identity.workerId);
        assert.equal(
          (await jobs.findById(assigned.jobId)).workerId,
          identity.workerId,
        );
        assert.equal(
          (await attempts.findOne({ attemptId: assigned.attemptId })).workerId,
          identity.workerId,
        );
        const repeat = await b.coordinator.claim(assigned.sessionId, identity);
        assert.equal(repeat.attemptId, assigned.attemptId);
        await assert.rejects(
          a.coordinator.claim(randomUUID(), identity),
          code('WORKER_RECOVERY_REQUIRED'),
        );
      }
      assert.equal(await attempts.countDocuments(), 20);
      assert.equal(await jobs.countDocuments({ status: 'queued' }), 1);
    },
  );

  await t.test(
    'cannot operate on or replay another machine attempt, including after completion',
    async () => {
      await reset();
      const owner = await register('owner');
      const other = await register('other');
      await enqueue(2);
      const assignment = await a.coordinator.claim(randomUUID(), owner);
      const stage = event(assignment);
      const report = {
        stage: 'processing',
        durationSeconds: 10,
        decodable: true,
        hasAudio: true,
      };
      await a.coordinator.stage(stage, report, owner);
      await assert.rejects(
        b.coordinator.heartbeat(selector(assignment), other),
        code('STALE_ATTEMPT'),
      );
      await assert.rejects(
        b.coordinator.stage(stage, report, other),
        code('STALE_ATTEMPT'),
      );
      const output = {
        ...event(assignment),
        bytes: 100,
        contentType: 'audio/mpeg',
        playable: true,
        voiceOnly: true,
        sha256: Buffer.alloc(32).toString('base64'),
        durationSeconds: 10,
      };
      await assert.rejects(
        b.output.reserve(output, other),
        code('STALE_ATTEMPT'),
      );
      assert.equal(grants.length, 0);
      await a.output.reserve(output, owner);
      const completed = event(assignment);
      await assert.rejects(
        b.terminal.complete(completed, other),
        code('STALE_ATTEMPT'),
      );
      await a.terminal.complete(completed, owner);
      assert.deepEqual(await a.terminal.complete(completed, owner), {
        status: 'ready',
      });
      await assert.rejects(
        b.terminal.complete(completed, other),
        code('STALE_ATTEMPT'),
      );
      await assert.rejects(
        b.terminal.stopped(
          { ...event(assignment), stopped: true },
          'cancelled',
          other,
        ),
        code('STALE_ATTEMPT'),
      );
      await assert.rejects(
        b.recovery.reconcile(randomUUID(), assignment.attemptId, true, other),
        code('STALE_ATTEMPT'),
      );
      await assert.rejects(
        b.terminal.confirmLocalCleanup(
          { ...selector(assignment), localDataDeleted: true },
          other,
        ),
        code('STALE_ATTEMPT'),
      );
    },
  );

  await t.test(
    'expired worker retains only its own assignment; draining recovery releases without replacement',
    async () => {
      await reset();
      const owner = await register('offline');
      const other = await register('available');
      const queued = await enqueue(2);
      const assignment = await a.coordinator.claim(randomUUID(), owner);
      await expire(assignment);
      await a.recovery.markExpiredAssignments();
      assert.equal(
        (await jobs.findById(assignment.jobId)).status,
        'interrupted',
      );
      assert.equal(
        (await workers.findById(owner.workerId)).activeJobId.toHexString(),
        assignment.jobId,
      );
      assert.equal(
        (await b.coordinator.claim(randomUUID(), other)).jobId,
        queued[1],
      );
      await change(owner, { state: 'draining' });
      const released = await a.recovery.reconcile(
        randomUUID(),
        assignment.attemptId,
        true,
        owner,
      );
      assert.deepEqual(released, {
        status: 'released',
        previousAttemptId: assignment.attemptId,
      });
      assert.equal((await workers.findById(owner.workerId)).activeJobId, null);
      const restored = await jobs.findById(assignment.jobId);
      assert.equal(restored.status, 'queued');
      assert.equal(restored.workerId, null);
      assert.equal(restored.queueOrder, 1n);
      await assert.rejects(
        a.coordinator.claim(randomUUID(), owner),
        code('WORKER_NOT_ENABLED'),
      );
      assert.deepEqual(
        await a.recovery.reconcile(
          randomUUID(),
          assignment.attemptId,
          true,
          owner,
        ),
        released,
      );
    },
  );

  await t.test(
    'revocation committed after snapshot read prevents stale claim allocation',
    async () => {
      await reset();
      const identity = await register('racing');
      await enqueue(1);
      const read = deferred();
      const release = deferred();
      const original = a.registry.state.bind(a.registry);
      let pause = true;
      a.registry.state = async (...args) => {
        const state = await original(...args);
        if (pause && args[1]) {
          pause = false;
          read.resolve();
          await release.promise;
        }
        return state;
      };
      const pending = a.coordinator.claim(randomUUID(), identity);
      const rejected = assert.rejects(pending, code('UNAUTHENTICATED'));
      await read.promise;
      await change(identity, { state: 'revoked' });
      release.resolve();
      await rejected;
      a.registry.state = original;
      assert.equal(await attempts.countDocuments(), 0);
      assert.equal(await jobs.countDocuments({ status: 'queued' }), 1);
    },
  );

  await t.test(
    'current credential is rechecked before returning an externally prepared input grant',
    async () => {
      await reset();
      const identity = await register('grant-race');
      await enqueue(1);
      const entered = deferred();
      const release = deferred();
      const original = storage.createDownloadGrant;
      storage.createDownloadGrant = async () => {
        entered.resolve();
        await release.promise;
        return original();
      };
      const pending = a.coordinator.claim(randomUUID(), identity);
      const rejected = assert.rejects(pending, code('UNAUTHENTICATED'));
      await entered.promise;
      await change(identity, { state: 'revoked' });
      release.resolve();
      await rejected;
      storage.createDownloadGrant = original;
      assert.ok((await workers.findById(identity.workerId)).activeJobId);
      assert.equal(await attempts.countDocuments(), 1);
    },
  );

  await t.test(
    'fleet has no legacy credential or missing-context ownership fallback',
    async () => {
      await reset();
      const identity = await register('machine');
      assert.equal((await a.identity.describe(identity)).protocolVersion, 3);
      assert.equal(
        (await a.registry.authenticateDigest(identity.keySha256)).workerId,
        identity.workerId,
      );
      await assert.rejects(
        a.registry.authenticateDigest('f'.repeat(64)),
        code('UNAUTHENTICATED'),
      );
      await assert.rejects(
        a.coordinator.claim(randomUUID()),
        code('UNAUTHENTICATED'),
      );
      await enqueue(1);
      const assignment = await a.coordinator.claim(randomUUID(), identity);
      await jobs.collection.updateOne(
        { _id: new Types.ObjectId(assignment.jobId) },
        { $unset: { workerId: '' } },
      );
      await assert.rejects(
        a.coordinator.heartbeat(selector(assignment), identity),
        code('STALE_ATTEMPT'),
      );
    },
  );

  await t.test(
    'HTTP worker identity is credential-derived and all lifecycle calls preserve it',
    async () => {
      await reset();
      const owner = await register('http-owner');
      await register('http-other');
      await enqueue(2);
      const moduleRef = await Test.createTestingModule({
        controllers: [WorkerController],
        providers: [
          { provide: ConfigService, useValue: config },
          { provide: WorkerIdentityService, useValue: a.identity },
          { provide: WorkerCoordinatorService, useValue: a.coordinator },
          { provide: WorkerOutputService, useValue: a.output },
          { provide: WorkerTerminalService, useValue: a.terminal },
          { provide: WorkerRecoveryService, useValue: a.recovery },
          WorkerClaimWaitService,
          { provide: WorkerRuntimeService, useValue: {} },
          { provide: APP_GUARD, useClass: WorkerAuthGuard },
        ],
      }).compile();
      const app = moduleRef.createNestApplication({ logger: false });
      app.setGlobalPrefix('api/v1');
      app.useGlobalFilters(new PublicExceptionFilter());
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      await app.init();
      try {
        const post = (path, body, workerId = 'http-owner') =>
          request(app.getHttpServer())
            .post(`/api/v1/worker/${path}`)
            .set(
              'Authorization',
              `Bearer ${workerIds.get(workerId)?.rawKey ?? 'unknown-secret'}`,
            )
            .send(body);
        const described = await post('identity', {}).expect(200);
        assert.deepEqual(described.body, {
          workerId: owner.workerId,
          state: 'enabled',
          installationId: owner.installationId,
          protocolVersion: 3,
          mediaPolicyVersion: 2,
          updateCapability: {
            supported: false,
            reasonCode: 'UPDATE_SERVICE_UNAVAILABLE',
          },
        });
        assert.equal(described.headers['cache-control'], 'no-store');
        await post('identity', { workerId: 'http-other' }).expect(400);
        await post('identity', {}, 'unknown').expect(401);
        await post('claim', {
          sessionId: randomUUID(),
          workerId: 'http-other',
        }).expect(400);
        const claimed = await post('claim', { sessionId: randomUUID() })
          .set('X-Worker-Id', 'http-other')
          .expect(200);
        assert.equal(claimed.body.workerId, owner.workerId);
        await post('heartbeat', selector(claimed.body), 'http-other').expect(
          409,
        );
        await post('heartbeat', selector(claimed.body)).expect(200);
        await change(owner, { state: 'revoked' });
        await post('heartbeat', selector(claimed.body)).expect(401);
      } finally {
        await app.close();
      }
    },
  );

  await t.test(
    'availability follows the real owner and excludes draining or revoked capacity for queued work',
    async () => {
      await reset();
      const online = await register('online');
      const offline = await register('offline');
      await workers.updateOne(
        { _id: offline.workerId },
        { $set: { lastSeenAt: new Date(0) } },
      );
      await model('WorkerRuntime').updateOne(
        { _id: offline.workerId },
        { $set: { receivedAt: new Date(0) } },
      );
      await a.coordinator.claim(randomUUID(), online);
      assert.equal(
        await a.registry.available({
          workerId: null,
          attemptId: null,
          inputReservation: { durationSeconds: 10, bytes: 100 },
        }),
        true,
      );
      assert.equal(
        await a.registry.available({
          workerId: offline.workerId,
          attemptId: randomUUID(),
        }),
        false,
      );
      await change(online, { state: 'draining' });
      assert.equal(
        await a.registry.available({
          workerId: null,
          attemptId: null,
          inputReservation: { durationSeconds: 10, bytes: 100 },
        }),
        false,
      );
      assert.equal(
        await a.registry.available({
          workerId: online.workerId,
          attemptId: randomUUID(),
        }),
        true,
      );
      await change(online, { state: 'revoked' });
      assert.equal(
        await a.registry.available({
          workerId: online.workerId,
          attemptId: randomUUID(),
        }),
        false,
      );
    },
  );

  await t.test(
    'fleet integrity audit reports missing ownership without rewriting it',
    async () => {
      await reset();
      const identity = await register('audit-worker');
      const initial = await auditWorkerFleet(
        connections[0],
        identity.keySha256,
      );
      assert.equal(initial.consistent, true);
      assert.equal(JSON.stringify(initial).includes(identity.keySha256), false);
      await enqueue(1);
      const assignment = await a.coordinator.claim(randomUUID(), identity);
      await jobs.collection.updateOne(
        { _id: new Types.ObjectId(assignment.jobId) },
        { $unset: { workerId: '' } },
      );
      await attempts.collection.updateOne(
        { attemptId: assignment.attemptId },
        { $unset: { workerId: '' } },
      );
      const revision = (await workers.findById(identity.workerId))
        .controlRevision;
      const report = await auditWorkerFleet(connections[0], identity.keySha256);
      assert.equal(report.consistent, false);
      assert.equal(report.missingJobOwners, 1);
      assert.equal(report.missingAttemptOwners, 1);
      assert.equal(report.activeAssignments, 1);
      assert.equal(report.inconsistentAssignments, 1);
      assert.equal(
        (await workers.findById(identity.workerId)).controlRevision,
        revision,
      );
      assert.equal(
        (await attempts.collection.findOne({ attemptId: assignment.attemptId }))
          .workerId,
        undefined,
      );
      await assert.rejects(
        a.coordinator.heartbeat(selector(assignment), identity),
        code('STALE_ATTEMPT'),
      );
      await assert.rejects(
        a.coordinator.claim(assignment.sessionId),
        code('UNAUTHENTICATED'),
      );
    },
  );

  await t.test(
    'pending long polls observe credential rotation and release admission without allocating',
    async () => {
      await reset();
      const identity = await register('waiting');
      const checked = deferred();
      const state = a.registry.state.bind(a.registry);
      a.registry.state = async (...args) => {
        const value = await state(...args);
        checked.resolve();
        return value;
      };
      const waits = new WorkerClaimWaitService(a.coordinator, config);
      try {
        const pending = waits.claim(randomUUID(), 25, undefined, identity);
        const denied = assert.rejects(pending, code('UNAUTHENTICATED'));
        await checked.promise;
        const replacement = { ...identity, keySha256: 'b'.repeat(64) };
        await change(identity, { keySha256: replacement.keySha256 });
        await enqueue(1);
        await denied;
        assert.equal(await attempts.countDocuments(), 0);
        await assert.rejects(
          a.registry.authenticateDigest(identity.keySha256),
          code('UNAUTHENTICATED'),
        );
        assert.equal(
          (await a.registry.authenticateDigest(replacement.keySha256)).workerId,
          identity.workerId,
        );
        const assignment = await waits.claim(
          randomUUID(),
          25,
          undefined,
          replacement,
        );
        assert.equal(assignment.workerId, identity.workerId);
      } finally {
        a.registry.state = state;
        waits.onModuleDestroy();
      }
    },
  );
});

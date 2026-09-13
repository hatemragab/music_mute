import { accountFixture } from './helpers/account-fixture.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { ConfigService } from '@nestjs/config';
import mongoose, { createConnection, Types } from 'mongoose';
// Explicit activation catches operator casting; connection options alone are ignored by this installed Mongoose query path.
mongoose.set('sanitizeFilter', true);
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { WorkerClaimWaitService } from '../dist/worker/worker-claim-wait.service.js';
import { WorkerRegistryService } from '../dist/worker/worker-registry.service.js';
import { WorkerIdentityService } from '../dist/worker/worker-identity.service.js';
import { WorkerCoordinatorService } from '../dist/worker/worker-coordinator.service.js';
import { WorkerOutputService } from '../dist/worker/worker-output.service.js';
import { WorkerTerminalService } from '../dist/worker/worker-terminal.service.js';
import { WorkerRecoveryService } from '../dist/worker/worker-recovery.service.js';
import { AdminWorkersService } from '../dist/admin-workers/admin-workers.service.js';
import { AdminAccessSchema } from '../dist/admin/admin-access.schema.js';
import { AdminAuditEventSchema } from '../dist/admin/admin-audit.schema.js';
import { AdminOperationSchema } from '../dist/admin/admin-operation.schema.js';
import { AdminAuditService } from '../dist/admin/admin-audit.service.js';
import { AdminOperationsService } from '../dist/admin/admin-operations.service.js';

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

test('worker admin controls across independent API transactions', async (t) => {
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
    connection.model('AdminAccess', AdminAccessSchema);
    connection.model('AdminAuditEvent', AdminAuditEventSchema);
    connection.model('AdminOperation', AdminOperationSchema);
    await Promise.all(
      ['AdminAccess', 'AdminAuditEvent', 'AdminOperation'].map((name) =>
        connection.model(name).init(),
      ),
    );
    for (const entry of PROCESSING_MODELS)
      connection.model(entry.name, entry.schema);
    await Promise.all(
      PROCESSING_MODELS.map(({ name }) => connection.model(name).init()),
    );
  }
  const config = new ConfigService({
    PROCESSING_WORKER_AUTH_MODE: 'fleet',
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
  const registrations = model('WorkerRegistration');
  const reset = async () => {
    for (const { name } of PROCESSING_MODELS) await model(name).deleteMany({});
    await model('AdminAuditEvent').deleteMany({});
    await model('AdminOperation').deleteMany({});
    grants.length = 0;
  };
  const register = async (workerId) => {
    const keySha256 = createHash('sha256')
      .update(`synthetic-fleet-secret-${workerId}`)
      .digest('hex');
    await a.transactions.run(async (session) => {
      await registrations.create(
        [{ _id: workerId, label: workerId, keySha256, state: 'enabled' }],
        { session },
      );
      await workers.create([{ _id: workerId }], { session });
    });
    return { workerId, mode: 'fleet', keySha256 };
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
      const userId = new Types.ObjectId();
      await accountFixture(connections[0], [userId.toString()]);
      const job = await jobs.create({
        userId,
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
      ids.push(job._id.toHexString());
    }
    return ids;
  };
  const actor = {
    uid: 'fixture-owner',
    verifiedEmail: 'fixture-owner@example.test',
    role: 'owner',
    permissions: ['workers.manage', 'workers.recover'],
    accessRevision: 0,
    authTimeSec: Math.floor(Date.now() / 1000),
  };
  await model('AdminAccess').create({
    uid: actor.uid,
    verifiedEmail: actor.verifiedEmail,
    role: actor.role,
    revision: 0,
    active: true,
    authorizationFence: 0,
  });
  const admin = apis.map((api, index) => {
    const connection = connections[index];
    const model = (name) => connection.model(name);
    const audit = new AdminAuditService(model('AdminAuditEvent'));
    const operations = new AdminOperationsService(
      connection,
      model('AdminAccess'),
      model('AdminOperation'),
      audit,
    );
    return new AdminWorkersService(
      model('WorkerRegistration'),
      model('WorkerControl'),
      api.registry,
      api.recovery,
      operations,
      audit,
      config,
    );
  });
  const common = async (id) => ({
    expectedRevision: (await admin[0].detail(id)).revision,
    operationId: randomUUID(),
    reason: 'Synthetic scheduled maintenance',
  });
  const proof = async (identity, assignment) => ({
    ...(await common(identity.workerId)),
    ...selector(assignment),
    stoppedAt: new Date().toISOString(),
    stopEvidence:
      'Observed worker process PID 422 exit and verified it stopped.',
  });
  const digest = (raw) => createHash('sha256').update(raw).digest('hex');
  const holdFence = (api) => {
    const entered = deferred();
    const release = deferred();
    let held = false;
    const original = api.registry.touchControl.bind(api.registry);
    api.registry.touchControl = async (...args) => {
      await original(...args);
      if (!held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
    };
    return {
      entered: entered.promise,
      release: () => {
        api.registry.touchControl = original;
        release.resolve();
      },
    };
  };

  await t.test(
    'create and rotation reveal once; receipts, queries and audit contain no credential material',
    async () => {
      await reset();
      const dto = {
        id: 'admin-a',
        label: 'Admin A',
        operationId: randomUUID(),
        reason: 'Synthetic registration',
      };
      const created = await admin[0].create(actor, dto);
      assert.match(created.rawKey, /^[a-f0-9]{64}$/);
      const replay = await admin[1].create(actor, dto);
      assert.equal(replay.rawKey, undefined);
      assert.equal(replay.operation.status, 'succeeded');
      const identity = await a.registry.authenticateDigest(
        digest(created.rawKey),
      );
      const rotate = await common('admin-a');
      const rotated = await admin[1].update(
        actor,
        'admin-a',
        'rotate-key',
        rotate,
      );
      assert.notEqual(rotated.rawKey, created.rawKey);
      assert.equal(
        (await admin[0].update(actor, 'admin-a', 'rotate-key', rotate)).rawKey,
        undefined,
      );
      await assert.rejects(a.registry.state(identity), code('UNAUTHENTICATED'));
      await a.registry.authenticateDigest(digest(rotated.rawKey));
      const safe = JSON.stringify([
        await admin[0].list({}),
        await admin[0].detail('admin-a'),
        await model('AdminOperation').find().lean(),
        await model('AdminAuditEvent').find().lean(),
      ]);
      for (const secret of [
        created.rawKey,
        rotated.rawKey,
        digest(created.rawKey),
        digest(rotated.rawKey),
      ])
        assert.equal(safe.includes(secret), false);
      assert.equal(await model('AdminAuditEvent').countDocuments(), 2);
    },
  );

  await t.test(
    'management CAS tolerates idle claims and heartbeats but rejects competing edits on legacy controls',
    async () => {
      await reset();
      const identity = await register('node-a');
      await workers.collection.updateOne(
        { _id: 'node-a' },
        { $unset: { managementRevision: '' } },
      );
      const idleRevision = await common('node-a');
      const fenceBefore = (await workers.findById('node-a')).controlRevision;
      await a.coordinator.claim(randomUUID(), identity);
      assert.ok(
        (await workers.findById('node-a')).controlRevision > fenceBefore,
        'worker authority fence still advances',
      );
      await admin[0].update(actor, 'node-a', 'drain', idleRevision);
      await admin[0].update(actor, 'node-a', 'enable', await common('node-a'));
      await enqueue(1);
      const assignment = await a.coordinator.claim(randomUUID(), identity);
      const observed = await common('node-a');
      await a.coordinator.heartbeat(selector(assignment), identity);
      const drained = await admin[0].update(actor, 'node-a', 'drain', observed);
      assert.equal(drained.revision, observed.expectedRevision + 1);
      await assert.rejects(
        admin[1].update(actor, 'node-a', 'enable', {
          ...observed,
          operationId: randomUUID(),
        }),
        code('REVISION_CONFLICT'),
      );
      assert.equal(
        (await workers.findById('node-a')).activeJobId.toString(),
        assignment.jobId,
      );
      const competingRevision = await common('node-a');
      const competing = await Promise.allSettled(
        admin.map((service, index) =>
          service.update(actor, 'node-a', 'rename', {
            ...competingRevision,
            operationId: randomUUID(),
            label: `Concurrent ${index}`,
          }),
        ),
      );
      assert.equal(
        competing.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      assert.ok(
        code('REVISION_CONFLICT')(
          competing.find((result) => result.status === 'rejected').reason,
        ),
      );
    },
  );

  await t.test(
    'active drain preserves assignment, rotation refuses and emergency revoke leaves reservation',
    async () => {
      await reset();
      const identity = await register('node-a');
      await enqueue(2);
      const assignment = await a.coordinator.claim(randomUUID(), identity);
      await assert.rejects(
        admin[1].update(actor, 'node-a', 'rotate-key', await common('node-a')),
        code('WORKER_NOT_IDLE'),
      );
      const drained = await admin[1].update(
        actor,
        'node-a',
        'drain',
        await common('node-a'),
      );
      assert.equal(drained.activeJobId, assignment.jobId);
      await assert.rejects(
        admin[1].update(actor, 'node-a', 'revoke', {
          ...(await common('node-a')),
          emergency: false,
        }),
        code('WORKER_NOT_IDLE'),
      );
      const revoked = await admin[1].update(actor, 'node-a', 'revoke', {
        ...(await common('node-a')),
        emergency: true,
      });
      assert.equal(revoked.activeAttemptId, assignment.attemptId);
      assert.equal(revoked.recoveryRequired, true);
      await assert.rejects(
        admin[1].update(actor, 'node-a', 'enable', await common('node-a')),
        code('REVISION_CONFLICT'),
      );
      await assert.rejects(a.registry.state(identity), code('UNAUTHENTICATED'));
      assert.equal(await attempts.countDocuments({ endedAt: null }), 1);
    },
  );

  await t.test(
    'recovery rejects stale selectors, heartbeat-only proof and preserves FIFO and audit attestation',
    async () => {
      await reset();
      const identity = await register('node-a');
      await register('node-b');
      await enqueue(1);
      const assignment = await a.coordinator.claim(randomUUID(), identity);
      const before = await jobs.findById(assignment.jobId).lean();
      const valid = await proof(identity, assignment);
      for (const change of [
        { generation: valid.generation - 1 },
        { attemptId: randomUUID() },
        { sessionId: randomUUID() },
        { stoppedAt: '2000-01-01T00:00:00.000Z' },
        { stopEvidence: 'The worker heartbeat has stopped for ten minutes.' },
      ]) {
        await assert.rejects(
          admin[1].update(actor, 'node-a', 'release-stopped', {
            ...valid,
            ...change,
            operationId: randomUUID(),
          }),
          code('RECOVERY_PROOF_REQUIRED'),
        );
      }
      await assert.rejects(
        admin[1].update(actor, 'node-b', 'release-stopped', {
          ...valid,
          ...(await common('node-b')),
        }),
        code('RECOVERY_PROOF_REQUIRED'),
      );
      const released = await admin[1].update(
        actor,
        'node-a',
        'release-stopped',
        { ...valid, operationId: randomUUID() },
      );
      assert.equal(released.activeJobId, null);
      const after = await jobs.findById(assignment.jobId).lean();
      assert.equal(after.status, 'queued');
      assert.equal(after.queueOrder, before.queueOrder);
      assert.deepEqual(after.inputObject, before.inputObject);
      assert.equal(after.workerId, null);
      assert.ok(
        (await attempts.findOne({ attemptId: assignment.attemptId }))
          .releasedAt,
      );
      const audit = await model('AdminAuditEvent')
        .findOne({ action: 'workers.release-stopped' })
        .lean();
      assert.equal(audit.stopEvidence.attestation, valid.stopEvidence);
      assert.equal(audit.stopEvidence.generation, valid.generation);
      assert.equal(
        (await workers.findById('node-a')).lastSeenAt.getTime(),
        new Date(assignment.leaseExpiresAt).getTime() - 90000,
      );
    },
  );

  for (const adminFirst of [true, false])
    await t.test(
      `drain/claim race with ${adminFirst ? 'admin' : 'worker'} committing first`,
      async () => {
        await reset();
        const identity = await register('node-a');
        await enqueue(1);
        const command = await common('node-a');
        const hold = holdFence(adminFirst ? b : a);
        const first = adminFirst
          ? admin[1].update(actor, 'node-a', 'drain', command)
          : a.coordinator.claim(randomUUID(), identity);
        await hold.entered;
        const second = adminFirst
          ? a.coordinator.claim(randomUUID(), identity)
          : admin[1].update(actor, 'node-a', 'drain', command);
        const settled = Promise.allSettled([first, second]);
        hold.release();
        const results = await settled;
        assert.equal(results[0].status, 'fulfilled');
        if (adminFirst) {
          assert.equal(results[1].status, 'fulfilled');
          assert.equal(results[1].value, null);
          assert.equal(await attempts.countDocuments(), 0);
        } else {
          assert.equal(results[1].status, 'fulfilled');
          assert.equal(
            (await registrations.findById('node-a')).state,
            'draining',
          );
          assert.equal(
            await attempts.countDocuments(),
            results[0].value === null ? 0 : 1,
          );
        }
      },
    );

  for (const adminFirst of [true, false])
    await t.test(
      `recovery/finish race with ${adminFirst ? 'admin' : 'worker'} committing first`,
      async () => {
        await reset();
        const identity = await register('node-a');
        await enqueue(1);
        const assignment = await a.coordinator.claim(randomUUID(), identity);
        await jobs.updateOne(
          { _id: assignment.jobId },
          { $set: { status: 'cancel_requested' } },
        );
        const command = await proof(identity, assignment);
        const hold = holdFence(adminFirst ? b : a);
        const finish = () =>
          a.terminal.stopped(
            { ...event(assignment), stopped: true },
            'cancelled',
            identity,
          );
        const recover = () =>
          admin[1].update(actor, 'node-a', 'release-stopped', command);
        const first = adminFirst ? recover() : finish();
        await hold.entered;
        const second = adminFirst ? finish() : recover();
        const settled = Promise.allSettled([first, second]);
        hold.release();
        const results = await settled;
        assert.equal(results[0].status, 'fulfilled');
        assert.equal(results[1].status, 'rejected');
        assert.equal((await workers.findById('node-a')).activeJobId, null);
        assert.equal(
          (await jobs.findById(assignment.jobId)).status,
          'cancelled',
        );
        assert.equal(
          await model('AdminAuditEvent').countDocuments({
            action: 'workers.release-stopped',
          }),
          adminFirst ? 1 : 0,
        );
      },
    );
  for (const adminFirst of [true, false])
    await t.test(
      `revoke/output race with ${adminFirst ? 'admin' : 'worker'} committing first`,
      async () => {
        await reset();
        const identity = await register('node-a');
        await enqueue(1);
        const assignment = await a.coordinator.claim(randomUUID(), identity);
        await jobs.updateOne(
          { _id: assignment.jobId },
          { $set: { status: 'processing' } },
        );
        const dto = {
          ...event(assignment),
          bytes: 100,
          durationSeconds: 10,
          sha256: Buffer.alloc(32).toString('base64'),
          contentType: 'audio/mpeg',
          playable: true,
          voiceOnly: true,
        };
        const command = { ...(await common('node-a')), emergency: true };
        const hold = holdFence(adminFirst ? b : a);
        const revoke = () =>
          admin[1].update(actor, 'node-a', 'revoke', command);
        const output = () => a.output.reserve(dto, identity);
        const first = adminFirst ? revoke() : output();
        await hold.entered;
        const second = adminFirst ? output() : revoke();
        const settled = Promise.allSettled([first, second]);
        hold.release();
        const results = await settled;
        const adminResult = results[adminFirst ? 0 : 1];
        const workerResult = results[adminFirst ? 1 : 0];
        assert.equal(adminResult.status, 'fulfilled');
        if (workerResult.status === 'rejected') {
          assert.ok(code('UNAUTHENTICATED')(workerResult.reason));
          assert.equal(grants.length, adminFirst ? 0 : 1);
        } else {
          assert.equal(adminFirst, false);
          assert.equal(grants.length, 1);
        }
        assert.equal((await registrations.findById('node-a')).state, 'revoked');
        assert.equal(
          (await workers.findById('node-a')).attemptId,
          assignment.attemptId,
        );
      },
    );

  for (const adminFirst of [true, false])
    await t.test(
      `rotation/pending poll with ${adminFirst ? 'admin' : 'worker'} committing first`,
      async () => {
        await reset();
        const identity = await register('node-a');
        const waits = new WorkerClaimWaitService(a.coordinator, config);
        const command = await common('node-a');
        const hold = holdFence(adminFirst ? b : a);
        let pending;
        let denied;
        let rotation;
        try {
          if (adminFirst) {
            rotation = admin[1].update(actor, 'node-a', 'rotate-key', command);
            await hold.entered;
            pending = waits.claim(randomUUID(), 25, undefined, identity);
            denied = assert.rejects(pending, code('UNAUTHENTICATED'));
            hold.release();
            await rotation;
          } else {
            pending = waits.claim(randomUUID(), 25, undefined, identity);
            denied = assert.rejects(pending, code('UNAUTHENTICATED'));
            await hold.entered;
            rotation = admin[1].update(actor, 'node-a', 'rotate-key', command);
            hold.release();
            await rotation;
          }
          await denied;
          assert.equal(await attempts.countDocuments(), 0);
          assert.equal(
            await model('AdminAuditEvent').countDocuments({
              action: 'workers.rotate-key',
            }),
            1,
          );
        } finally {
          hold.release();
          waits.onModuleDestroy();
        }
      },
    );
});

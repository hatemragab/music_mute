import { pairedWorkerFixture } from './helpers/paired-worker-fixture.mjs';
import { accountFixture } from './helpers/account-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ConfigService } from '@nestjs/config';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { WorkerCoordinatorService } from '../dist/worker/worker-coordinator.service.js';

test('concurrent claims hold one registered worker slot and expired assignments cannot renew', async (t) => {
  const native = await IsolatedServices.create();
  t.after(() => native.stop());
  const { mongoUri } = await native.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  for (const entry of PROCESSING_MODELS)
    connection.model(entry.name, entry.schema);
  await Promise.all(
    PROCESSING_MODELS.map(({ name }) => connection.model(name).init()),
  );
  const workerIdentity = await pairedWorkerFixture(connection);
  const jobs = connection.model('Job');
  const workers = connection.model('WorkerControl');
  const attempts = connection.model('JobAttempt');
  const service = new WorkerCoordinatorService(
    jobs,
    workers,
    attempts,
    new ProcessingTransactions(connection),
    new ConfigService({ PROCESSING_LEASE_SECONDS: 90 }),
    {
      createDownloadGrant: async () => ({
        url: 'https://fixture.invalid/pinned',
        expiresAt: new Date().toISOString(),
      }),
    },
    connection.model('JobReceipt'),
    { assertActive: async () => undefined },
  );
  const input = {
    key: 'server/input',
    extension: 'mp3',
    contentType: 'audio/mpeg',
    bytes: 100,
    durationSeconds: 10,
    sha256: Buffer.alloc(32).toString('base64'),
  };
  const identity = {
    key: input.key,
    versionId: 'v1',
    bytes: input.bytes,
    sha256: input.sha256,
    contentType: input.contentType,
  };
  const first = await jobs.create({
    userId: new Types.ObjectId(),
    requestId: randomUUID(),
    requestHash: '0'.repeat(64),
    inputReservation: input,
    inputObject: identity,
    status: 'queued',
    queueOrder: 1n,
  });
  await jobs.create({
    userId: new Types.ObjectId(),
    requestId: randomUUID(),
    requestHash: '1'.repeat(64),
    inputReservation: input,
    inputObject: identity,
    status: 'queued',
    queueOrder: 2n,
  });
  await accountFixture(
    connection,
    (await jobs.find().lean()).map((job) => job.userId.toString()),
  );
  assert.equal(
    await service.claim(randomUUID(), workerIdentity, 2, true),
    null,
  );
  assert.equal(await attempts.countDocuments(), 0);
  assert.equal(await jobs.countDocuments({ status: 'queued' }), 2);
  const runtime = connection.model('WorkerRuntime');
  const readyRuntime = await runtime.findById(workerIdentity.workerId).lean();
  assert.ok(readyRuntime);
  await runtime.deleteOne({ _id: readyRuntime._id });
  assert.equal(
    await service.claim(randomUUID(), workerIdentity, 2, true),
    null,
  );
  await assert.rejects(
    service.claim(randomUUID(), workerIdentity, 2),
    (error) =>
      error.getResponse().reasonCodes.includes('RUNTIME_REPORT_REQUIRED'),
  );
  await runtime.create(readyRuntime);
  const results = await Promise.allSettled([
    service.claim(randomUUID(), workerIdentity, 2),
    service.claim(randomUUID(), workerIdentity, 2),
  ]);
  const wins = results.filter((result) => result.status === 'fulfilled');
  assert.equal(wins.length, 1);
  const assignment = wins[0].value;
  assert.equal(assignment.jobId, first._id.toString());
  assert.equal(await attempts.countDocuments(), 1);
  const repeat = await service.claim(assignment.sessionId, workerIdentity, 2);
  assert.equal(repeat.attemptId, assignment.attemptId);
  await runtime.deleteOne({ _id: readyRuntime._id });
  const recovered = await service.claim(
    assignment.sessionId,
    workerIdentity,
    2,
    true,
  );
  assert.equal(recovered.attemptId, assignment.attemptId);
  await assert.rejects(
    service.claim(randomUUID(), workerIdentity, 2, true),
    (error) => error.getResponse().code === 'WORKER_RECOVERY_REQUIRED',
  );
  await service.heartbeat(assignment, workerIdentity);
  await jobs.updateOne(
    { _id: first._id },
    { $set: { leaseExpiresAt: new Date(0) } },
  );
  await workers.updateOne(
    { _id: workerIdentity.workerId },
    { $set: { leaseExpiresAt: new Date(0) } },
  );
  await assert.rejects(
    service.heartbeat(assignment, workerIdentity),
    (error) => error.getStatus() === 409,
  );
  await assert.rejects(
    service.claim(randomUUID(), workerIdentity, 2),
    (error) => error.getStatus() === 409,
  );
  assert.equal(
    (await workers.findById(workerIdentity.workerId)).activeJobId.toString(),
    first._id.toString(),
  );
  assert.equal(await jobs.countDocuments({ status: 'queued' }), 1);
});

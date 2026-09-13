import { accountFixture } from './helpers/account-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigService } from '@nestjs/config';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { WorkerCoordinatorService } from '../dist/worker/worker-coordinator.service.js';
import { WorkerClaimWaitService } from '../dist/worker/worker-claim-wait.service.js';

test('waiting claims discover newly queued work and preserve one durable assignment', async (t) => {
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
  const jobs = connection.model('Job');
  const workers = connection.model('WorkerControl');
  const attempts = connection.model('JobAttempt');
  const coordinator = new WorkerCoordinatorService(
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
  const wait = new WorkerClaimWaitService(coordinator);
  t.after(() => wait.onModuleDestroy());
  const input = {
    key: 'fixture/input',
    extension: 'mp3',
    contentType: 'audio/mpeg',
    bytes: 100,
    durationSeconds: 10,
    sha256: Buffer.alloc(32).toString('base64'),
  };
  const inputObject = {
    key: input.key,
    versionId: 'v1',
    bytes: input.bytes,
    sha256: input.sha256,
    contentType: input.contentType,
  };
  // Confirm the durable queue is empty before opening the waiters.
  assert.equal(await wait.claim(randomUUID(), 0), null);
  const startedAt = performance.now();
  const pending = Promise.allSettled([
    wait.claim(randomUUID(), 5),
    wait.claim(randomUUID(), 5),
  ]);
  await delay(100);
  const first = await jobs.create({
    userId: new Types.ObjectId(),
    requestId: randomUUID(),
    requestHash: '0'.repeat(64),
    inputReservation: input,
    inputObject,
    status: 'queued',
    queueOrder: 1n,
  });
  await jobs.create({
    userId: new Types.ObjectId(),
    requestId: randomUUID(),
    requestHash: '1'.repeat(64),
    inputReservation: input,
    inputObject,
    status: 'queued',
    queueOrder: 2n,
  });
  await accountFixture(
    connection,
    (await jobs.find().lean()).map((job) => job.userId.toString()),
  );
  const results = await pending;
  const wins = results.filter((result) => result.status === 'fulfilled');
  const conflicts = results.filter((result) => result.status === 'rejected');
  assert.equal(wins.length, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason.getStatus(), 429);
  const assignment = wins[0].value;
  assert.ok(assignment);
  assert.equal(assignment.jobId, first._id.toString());
  assert.ok(
    performance.now() - startedAt < 4500,
    'claim precedes wait timeout',
  );
  assert.equal(await attempts.countDocuments(), 1);
  assert.equal(await jobs.countDocuments({ status: 'queued' }), 1);

  const repeats = await Promise.allSettled([
    wait.claim(assignment.sessionId, 25),
    wait.claim(assignment.sessionId, 25),
  ]);
  const repeated = repeats.filter((value) => value.status === 'fulfilled');
  const limited = repeats.filter((value) => value.status === 'rejected');
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].value.attemptId, assignment.attemptId);
  assert.equal(limited.length, 1);
  assert.equal(limited[0].reason.getStatus(), 429);
  assert.equal(
    (await wait.claim(assignment.sessionId, 25)).attemptId,
    assignment.attemptId,
  );
  assert.equal(await attempts.countDocuments(), 1);
  assert.equal((await workers.findById('z440')).generation, 1);
});

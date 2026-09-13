import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { accountFixture } from './helpers/account-fixture.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { FairQueueService } from '../dist/processing-queue/fair-queue.service.js';

test('Mongo queue selects by actual consumption, then duration, with aging and eligibility first', async (t) => {
  const native = await IsolatedServices.create();
  t.after(() => native.stop());
  const { mongoUri } = await native.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  for (const { name, schema } of PROCESSING_MODELS)
    connection.model(name, schema);
  await Promise.all(Object.values(connection.models).map((m) => m.init()));
  const owners = [
    new Types.ObjectId(),
    new Types.ObjectId(),
    new Types.ObjectId(),
  ];
  const { users } = await accountFixture(connection, owners.map(String));
  const jobs = connection.model('Job'),
    usage = connection.model('QueueExecutionUsage');
  const now = new Date();
  const create = async (owner, seconds, order, age = 1) =>
    jobs.create({
      userId: owner,
      requestId: randomUUID(),
      requestHash: 'a'.repeat(64),
      status: 'queued',
      queueOrder: BigInt(order),
      queuedAt: new Date(now.getTime() - age * 1000),
      inputReservation: {
        key: `fixture/${order}`,
        extension: 'mp3',
        contentType: 'audio/mpeg',
        bytes: 100,
        durationSeconds: seconds,
        sha256: Buffer.alloc(32).toString('base64'),
      },
    });
  const high = await create(owners[0], 10, 1),
    low = await create(owners[1], 500, 2);
  await usage.create([
    {
      _id: randomUUID(),
      userId: owners[0],
      executionSeconds: 1000,
      expiresAt: new Date(now.getTime() + 86400_000),
    },
    {
      _id: randomUUID(),
      userId: owners[1],
      executionSeconds: 10,
      expiresAt: new Date(now.getTime() + 86400_000),
    },
  ]);
  const queue = new FairQueueService(jobs),
    transactions = new ProcessingTransactions(connection);
  const pick = () =>
    transactions.run(async (session) =>
      (await queue.selectNextEligible(now, session))._id.toString(),
    );
  assert.equal(await pick(), low._id.toString());
  const shortest = await create(owners[1], 5, 3);
  assert.equal(await pick(), shortest._id.toString());
  await jobs.updateOne(
    { _id: high._id },
    { $set: { queuedAt: new Date(now.getTime() - 901000) } },
  );
  assert.equal(await pick(), high._id.toString());
  await users.updateOne(
    { _id: owners[0] },
    { $set: { processingSuspended: true } },
  );
  assert.equal(await pick(), shortest._id.toString());
  await jobs.updateOne({ _id: low._id }, { $set: { status: 'processing' } });
  const eligible = await create(owners[2], 20, 4);
  assert.equal(
    await pick(),
    eligible._id.toString(),
    'grandfathered queued work cannot bypass one running owner',
  );
  await users.updateOne(
    { _id: owners[0] },
    { $set: { processingSuspensionExpiresAt: new Date(now.getTime() - 1) } },
  );
  assert.equal(
    await pick(),
    high._id.toString(),
    'temporary suspension expires at claim without cleanup',
  );
});

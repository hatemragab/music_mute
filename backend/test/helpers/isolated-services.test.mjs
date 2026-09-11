import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { createConnection } from 'mongoose';

test('isolated fixtures reject external services and remove only their owned data', async () => {
  const { IsolatedServices, assertLoopbackUrl } =
    await import('./isolated-services.mjs');
  assert.throws(() => assertLoopbackUrl('mongodb://example.com/database'));
  assert.throws(() => assertLoopbackUrl('http://127.0.0.1.evil.test:9099'));
  assert.doesNotThrow(() =>
    assertLoopbackUrl('mongodb://127.0.0.1:27017/demo'),
  );
  const services = await IsolatedServices.create();
  const directory = services.directory;
  assert.ok(existsSync(directory));
  const child = services.spawn(process.execPath, [
    '-e',
    'setInterval(() => {}, 1000)',
  ]);
  await services.stop();
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(existsSync(directory), false);
  await services.stop();
});

test('startDatabases keeps the default MongoDB service standalone and usable', async (t) => {
  const { IsolatedServices, assertLoopbackUrl } =
    await import('./isolated-services.mjs');
  const services = await IsolatedServices.create();
  t.after(() => services.stop());
  const databases = await services.startDatabases();
  const mongoUrl = assertLoopbackUrl(databases.mongoUri);
  assert.equal(mongoUrl.searchParams.has('replicaSet'), false);
  assert.equal(typeof databases.startRedis, 'function');
  assert.equal(typeof databases.redisPort, 'number');
  assert.ok(databases.mongo);
  assert.ok(databases.redis);

  const connection = await createConnection(databases.mongoUri, {
    bufferCommands: false,
    serverSelectionTimeoutMS: 5000,
  }).asPromise();
  t.after(() => connection.close());
  const hello = await connection.db.admin().command({ hello: 1 });
  assert.equal(hello.setName, undefined);
  await connection.collection('standalone_fixture').insertOne({ value: 1 });
  assert.equal(
    await connection.collection('standalone_fixture').countDocuments(),
    1,
  );
});

test('startDatabases replica set commits and aborts real MongoDB transactions', async (t) => {
  const { IsolatedServices, assertLoopbackUrl } =
    await import('./isolated-services.mjs');
  const services = await IsolatedServices.create();
  t.after(() => services.stop());
  const databases = await services.startDatabases({ replicaSet: true });
  const mongoUrl = assertLoopbackUrl(databases.mongoUri);
  assert.ok(mongoUrl.searchParams.get('replicaSet'));

  const connection = await createConnection(databases.mongoUri, {
    bufferCommands: false,
    serverSelectionTimeoutMS: 5000,
  }).asPromise();
  t.after(() => connection.close());
  const transactions = connection.collection('transaction_fixture');
  const session = await connection.startSession();
  t.after(() => session.endSession());

  await session.withTransaction(async () => {
    await transactions.insertOne({ outcome: 'committed' }, { session });
  });
  await assert.rejects(
    session.withTransaction(async () => {
      await transactions.insertOne({ outcome: 'aborted' }, { session });
      throw new Error('abort fixture transaction');
    }),
    /abort fixture transaction/,
  );

  assert.equal(await transactions.countDocuments({ outcome: 'committed' }), 1);
  assert.equal(await transactions.countDocuments({ outcome: 'aborted' }), 0);
});

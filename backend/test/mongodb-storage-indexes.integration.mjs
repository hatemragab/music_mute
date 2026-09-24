import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import test from 'node:test';
import { createConnection, Schema, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';

async function schemas(directory = new URL('../dist/', import.meta.url)) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(
      entry.name + (entry.isDirectory() ? '/' : ''),
      directory,
    );
    if (entry.isDirectory()) result.push(...(await schemas(url)));
    else if (entry.name.endsWith('.schema.js')) {
      for (const [name, schema] of Object.entries(await import(url.href))) {
        if (schema instanceof Schema && schema.options.collection)
          result.push({ name, schema });
      }
    }
  }
  return result;
}
function stages(plan) {
  if (!plan || typeof plan !== 'object') return [];
  return [plan.stage, ...Object.values(plan).flatMap(stages)].filter(Boolean);
}

test('fresh schemas retain constraints and indexed cleanup/history access', async (t) => {
  const services = await IsolatedServices.create();
  t.after(() => services.stop());
  const { mongoUri } = await services.startDatabases();
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  const entries = await schemas();
  assert.ok(entries.length >= 40);
  for (const { name, schema } of entries) {
    const model = connection.model(name, schema);
    await model.init();
    const indexes = await model.listIndexes();
    assert.equal(indexes.length, schema.indexes().length + 1, name);
    for (const [key, options] of schema.indexes()) {
      const actual = indexes.find(
        (index) => JSON.stringify(index.key) === JSON.stringify(key),
      );
      assert.ok(actual, `${name}: ${JSON.stringify(key)}`);
      assert.equal(actual.unique === true, options.unique === true);
      assert.equal(actual.expireAfterSeconds, options.expireAfterSeconds);
      assert.deepEqual(
        actual.partialFilterExpression,
        options.partialFilterExpression,
      );
    }
  }
  const accountId = new Types.ObjectId();
  const jobId = new Types.ObjectId();
  const cases = [
    [
      'ClientErrorSchema',
      { userId: accountId, eventId: 'event' },
      { userId: accountId },
    ],
    ['JobErrorSchema', { jobId, eventId: 'event' }, { jobId }],
    ['AccountRestrictionSchema', { accountId }, { accountId }],
    [
      'WorkerSlotSchema',
      { _id: 'slot', machineId: 'machine', gpuId: 'gpu', slotIndex: 0 },
      { machineId: 'machine' },
    ],
    [
      'UploadGrantReceiptSchema',
      {
        _id: 'upload',
        accountId,
        jobId,
        logicalAudioId: jobId,
        attemptNumber: 1,
      },
      { accountId, jobId },
    ],
    [
      'DownloadGrantReceiptSchema',
      { _id: 'download', accountId },
      { accountId },
    ],
    ['ProcessingReservationSchema', { _id: jobId, accountId }, { accountId }],
    [
      'WorkerInstallationSessionSchema',
      {
        _id: 'installation',
        machineId: 'machine',
        invitationId: 'invitation',
        credentialDigest: 'digest',
        phase: 'activated',
      },
      { machineId: 'machine', phase: 'activated' },
    ],
  ];
  for (const [name, fixture, filter] of cases) {
    const collection = connection.model(name).collection;
    // Raw synthetic records isolate index semantics from unrelated validation.
    await collection.insertOne(fixture);
    if (name === 'WorkerInstallationSessionSchema') {
      await collection.insertMany(
        Array.from({ length: 100 }, (_, i) => ({
          _id: `installation-${i}`,
          machineId: `other-machine-${i}`,
          invitationId: `invitation-${i}`,
          credentialDigest: `digest-${i}`,
          phase: 'activated',
        })),
      );
    }
    const plan = await collection.find(filter).explain('executionStats');
    assert.equal(plan.executionStats.nReturned, 1, name);
    assert.ok(
      stages(plan.queryPlanner.winningPlan).some(
        (stage) => stage === 'IXSCAN' || stage === 'EXPRESS_IXSCAN',
      ),
      JSON.stringify({ name, plan: plan.queryPlanner.winningPlan }),
    );
  }
  await assert.rejects(
    connection
      .model('ClientErrorSchema')
      .collection.insertOne({ userId: accountId, eventId: 'event' }),
    { code: 11000 },
  );
  await assert.rejects(
    connection.model('WorkerSlotSchema').collection.insertOne({
      _id: 'other-slot',
      machineId: 'machine',
      gpuId: 'gpu',
      slotIndex: 0,
    }),
    { code: 11000 },
  );
  const attempts = connection.model('WorkerAttemptSchema').collection;
  await attempts.insertMany(
    Array.from({ length: 20 }, (_, i) => ({
      _id: `attempt-${i}`,
      machineId: 'machine',
      workerId: `slot-${i % 2}`,
      claimRequestId: `claim-${i}`,
      jobId,
      attemptNumber: i,
      createdAt: new Date(1_000 + i),
    })),
  );
  const history = await attempts
    .find({ machineId: 'machine' })
    .sort({ createdAt: -1 })
    .limit(5)
    .explain('executionStats');
  assert.equal(history.executionStats.nReturned, 5);
  assert.ok(stages(history.queryPlanner.winningPlan).includes('IXSCAN'));
  assert.ok(!stages(history.queryPlanner.winningPlan).includes('SORT'));
});

test('shared dashboard indexes preserve filters and cursor pages', async (t) => {
  const services = await IsolatedServices.create();
  t.after(() => services.stop());
  const { mongoUri } = await services.startDatabases();
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  const definitions = await schemas();
  const accountId = new Types.ObjectId();
  const cases = [
    {
      name: 'WorkerMachineSchema',
      time: 'lastSeenAt',
      direction: 1,
      filters: [
        {},
        { status: 'active' },
        { groupId: 'selected' },
        { 'approvedCapabilities.platform': 'macos' },
        { 'runtimeIdentity.workerVersion': 'selected' },
      ],
      row: (i) => ({
        _id: `machine-${String(i).padStart(4, '0')}`,
        credentialDigest: `digest-${i}`,
        status: i % 3 ? 'active' : 'offline',
        groupId: i % 3 ? 'other' : 'selected',
        approvedCapabilities: [{ platform: i % 3 ? 'windows' : 'macos' }],
        runtimeIdentity: { workerVersion: i % 3 ? 'other' : 'selected' },
      }),
    },
    {
      name: 'AdminAuditEventSchema',
      time: 'at',
      direction: -1,
      filters: [
        {},
        { actorUid: 'selected' },
        { resourceType: 'job', resourceId: 'selected' },
      ],
      row: (i) => ({
        _id: new Types.ObjectId(),
        actorUid: i % 3 ? 'other' : 'selected',
        resourceType: 'job',
        resourceId: i % 3 ? 'other' : 'selected',
      }),
    },
    {
      name: 'AbuseEventBucketSchema',
      time: 'lastOccurredAt',
      direction: -1,
      filters: [
        {},
        { type: 'selected' },
        { severity: 'warning' },
        { type: 'selected', severity: 'warning' },
        { accountId, severity: 'warning' },
      ],
      row: (i) => ({
        _id: new Types.ObjectId(),
        accountId,
        type: i % 3 ? 'other' : 'selected',
        severity: i % 3 ? 'critical' : 'warning',
        operationClass: 'fixture',
        bucketStart: new Date(i),
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    },
  ];
  for (const scenario of cases) {
    const { schema } = definitions.find(({ name }) => name === scenario.name);
    const model = connection.model(scenario.name, schema);
    await model.init();
    // Include tied timestamps to exercise the _id cursor tie-breaker.
    const rows = Array.from({ length: 300 }, (_, i) => ({
      ...scenario.row(i),
      [scenario.time]: new Date(1000 + Math.floor(i / 3)),
    }));
    await model.collection.insertMany(rows);
    const sort = { [scenario.time]: -1, _id: scenario.direction };
    for (const filter of scenario.filters) {
      // Natural scan is an independent correctness reference, not a query hint in production.
      const expected = await model.collection
        .find(filter)
        .hint({ $natural: 1 })
        .sort(sort)
        .toArray();
      const received = [];
      let after;
      do {
        const cursorFilter = after
          ? {
              $and: [
                filter,
                {
                  $or: [
                    { [scenario.time]: { $lt: after[scenario.time] } },
                    {
                      [scenario.time]: after[scenario.time],
                      _id: {
                        [scenario.direction === 1 ? '$gt' : '$lt']: after._id,
                      },
                    },
                  ],
                },
              ],
            }
          : filter;
        const query = () =>
          model.collection
            .find(cursorFilter)
            .sort(sort)
            .limit(25)
            .maxTimeMS(5000);
        const page = await query().toArray();
        const plan = await query().explain('executionStats');
        assert.ok(
          stages(plan.queryPlanner.winningPlan).includes('IXSCAN'),
          scenario.name,
        );
        assert.ok(
          !stages(plan.queryPlanner.winningPlan).includes('SORT'),
          scenario.name,
        );
        received.push(...page.map((row) => row._id.toString()));
        after = page.length === 25 ? page.at(-1) : null;
      } while (after);
      assert.deepEqual(
        received,
        expected.map((row) => row._id.toString()),
      );
    }
  }
});

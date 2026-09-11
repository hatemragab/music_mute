import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import {
  inspectLegacyWorkerFleetMigration,
  migrateLegacyWorkerFleet,
} from '../dist/worker/worker-fleet-migration.js';

const legacyDigest = createHash('sha256')
  .update('synthetic-migration-worker-secret')
  .digest('hex');

const job = (overrides = {}) => ({
  _id: new Types.ObjectId(),
  attemptId: '11111111-1111-4111-8111-111111111111',
  status: 'ready',
  adminRevision: 4,
  ...overrides,
});

const attempt = (jobId, overrides = {}) => ({
  _id: new Types.ObjectId(),
  jobId,
  attemptId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  generation: 1,
  startedAt: new Date('2026-01-01T00:00:00.000Z'),
  endedAt: new Date('2026-01-01T00:01:00.000Z'),
  ...overrides,
});

test('legacy worker migration is dry-run safe, bounded, and idempotent', async (t) => {
  const native = await IsolatedServices.create();
  t.after(() => native.stop());
  const { mongoUri } = await native.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  const db = connection.db;
  assert.ok(db);

  const jobs = db.collection('audio_jobs');
  const attempts = db.collection('audio_job_attempts');
  const controls = db.collection('audio_worker_control');
  const registrations = db.collection('audio_workers');
  const historicalJobs = [
    job(),
    job({ attemptId: '33333333-3333-4333-8333-333333333333' }),
  ];
  await jobs.insertMany(historicalJobs);
  await attempts.insertMany([
    attempt(historicalJobs[0]._id),
    attempt(historicalJobs[1]._id, {
      attemptId: '33333333-3333-4333-8333-333333333333',
    }),
  ]);
  const lastSeenAt = new Date('2026-01-02T00:00:00.000Z');
  await controls.insertOne({
    _id: 'z440',
    controlRevision: 7,
    activeJobId: null,
    attemptId: null,
    sessionId: null,
    generation: 9,
    lastSeenAt,
    leaseExpiresAt: null,
  });

  const dryRun = await inspectLegacyWorkerFleetMigration(
    connection,
    legacyDigest,
  );
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.canApply, true);
  assert.equal(dryRun.registration, 'create');
  assert.equal(dryRun.control, 'preserve');
  assert.equal(dryRun.missingJobOwners, 2);
  assert.equal(dryRun.missingAttemptOwners, 2);
  assert.equal(JSON.stringify(dryRun).includes(legacyDigest), false);
  assert.equal(await registrations.countDocuments(), 0);
  assert.equal(await jobs.countDocuments({ workerId: 'z440' }), 0);

  const applied = await migrateLegacyWorkerFleet(connection, legacyDigest, {
    batchSize: 1,
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.jobsBackfilled, 2);
  assert.equal(applied.attemptsBackfilled, 2);
  assert.equal(applied.batches, 4);
  assert.equal(JSON.stringify(applied).includes(legacyDigest), false);
  assert.deepEqual(
    await registrations.findOne(
      { _id: 'z440' },
      { projection: { _id: 1, label: 1, state: 1 } },
    ),
    { _id: 'z440', label: 'Z440', state: 'enabled' },
  );
  const preserved = await controls.findOne({ _id: 'z440' });
  assert.equal(preserved.controlRevision, 7);
  assert.equal(preserved.generation, 9);
  assert.deepEqual(preserved.lastSeenAt, lastSeenAt);
  assert.equal(
    (await jobs.findOne({ _id: historicalJobs[0]._id })).adminRevision,
    5,
  );

  const repeated = await migrateLegacyWorkerFleet(connection, legacyDigest, {
    batchSize: 1,
  });
  assert.equal(repeated.registration, 'preserve');
  assert.equal(repeated.control, 'preserve');
  assert.equal(repeated.jobsBackfilled, 0);
  assert.equal(repeated.attemptsBackfilled, 0);
  assert.equal(repeated.batches, 0);
});

test('legacy worker migration resumes a partial apply without rewriting state', async (t) => {
  const native = await IsolatedServices.create();
  t.after(() => native.stop());
  const { mongoUri } = await native.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  const db = connection.db;
  assert.ok(db);

  const jobs = db.collection('audio_jobs');
  const attempts = db.collection('audio_job_attempts');
  const registrations = db.collection('audio_workers');
  const historicalJob = job({ workerId: 'z440' });
  await jobs.insertOne(historicalJob);
  await attempts.insertOne(attempt(historicalJob._id));
  const createdAt = new Date('2026-01-03T00:00:00.000Z');
  await registrations.insertOne({
    _id: 'z440',
    label: 'Z440',
    state: 'enabled',
    keySha256: legacyDigest,
    createdAt,
    updatedAt: createdAt,
  });

  const result = await migrateLegacyWorkerFleet(connection, legacyDigest);
  assert.equal(result.registration, 'preserve');
  assert.equal(result.control, 'create');
  assert.equal(result.jobsBackfilled, 0);
  assert.equal(result.attemptsBackfilled, 1);
  assert.deepEqual(
    (await registrations.findOne({ _id: 'z440' })).createdAt,
    createdAt,
  );
  assert.equal((await attempts.findOne({})).workerId, 'z440');
});

test('legacy worker migration refuses active work and identity conflicts before writes', async (t) => {
  const native = await IsolatedServices.create();
  t.after(() => native.stop());
  const { mongoUri } = await native.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  const db = connection.db;
  assert.ok(db);

  const controls = db.collection('audio_worker_control');
  const registrations = db.collection('audio_workers');
  await controls.insertOne({
    _id: 'z440',
    controlRevision: 1,
    activeJobId: new Types.ObjectId(),
    attemptId: '44444444-4444-4444-8444-444444444444',
    sessionId: '55555555-5555-4555-8555-555555555555',
    generation: 2,
  });
  const blocked = await inspectLegacyWorkerFleetMigration(
    connection,
    legacyDigest,
  );
  assert.equal(blocked.canApply, false);
  assert.equal(blocked.activeControls, 1);
  await assert.rejects(
    migrateLegacyWorkerFleet(connection, legacyDigest),
    /LEGACY_MIGRATION_ACTIVE_WORK/,
  );
  assert.equal(await registrations.countDocuments(), 0);

  await controls.deleteMany({});
  await registrations.insertOne({
    _id: 'z440',
    label: 'Existing',
    state: 'enabled',
    keySha256: 'f'.repeat(64),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const conflicting = await inspectLegacyWorkerFleetMigration(
    connection,
    legacyDigest,
  );
  assert.equal(conflicting.canApply, false);
  assert.equal(conflicting.identityConflict, true);
  await assert.rejects(
    migrateLegacyWorkerFleet(connection, legacyDigest),
    /LEGACY_MIGRATION_IDENTITY_CONFLICT/,
  );
  assert.equal(
    (await registrations.findOne({ _id: 'z440' })).keySha256,
    'f'.repeat(64),
  );
});

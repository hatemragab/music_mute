import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';

const inputReservation = {
  key: 'users/fixture/jobs/source/input/source.mp3',
  extension: 'mp3',
  contentType: 'audio/mpeg',
  bytes: 4096,
  durationSeconds: 30,
  sha256: Buffer.alloc(32, 7).toString('base64'),
};
const hasCode = (code) => (error) => error?.getResponse?.().code === code;

test('job cancellation preserves owner and state boundaries', async (t) => {
  const services = await IsolatedServices.create();
  t.after(() => services.stop());
  const { mongoUri } = await services.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri, {
    bufferCommands: false,
    sanitizeFilter: true,
  }).asPromise();
  t.after(() => connection.close());
  for (const { name, schema } of PROCESSING_MODELS)
    connection.model(name, schema);
  await Promise.all(
    PROCESSING_MODELS.map(({ name }) => connection.model(name).init()),
  );
  const [{ JobActionsService }, { ProcessingTransactions }] = await Promise.all(
    [
      import('../dist/jobs/job-actions.service.js'),
      import('../dist/processing/processing-transactions.js'),
    ],
  );
  const jobs = connection.model('Job');
  const actions = new JobActionsService(
    jobs,
    new ProcessingTransactions(connection),
    { assertActive: async () => undefined },
    {},
    { settleJob: async () => undefined },
  );
  const ownerId = new Types.ObjectId();
  const otherId = new Types.ObjectId();
  const createJob = (overrides = {}) =>
    jobs.create({
      userId: ownerId,
      requestId: randomUUID(),
      requestHash: '0'.repeat(64),
      inputReservation,
      ...overrides,
    });

  for (const status of ['awaiting_upload', 'queued']) {
    const job = await createJob({ status });
    assert.deepEqual(
      await actions.cancel(ownerId.toHexString(), job._id.toHexString()),
      { id: job._id.toHexString(), status: 'cancelled' },
    );
    const stored = await jobs.findById(job._id).lean();
    assert.ok(stored.finishedAt instanceof Date);
    assert.equal(stored.revision, 1);
  }

  const active = await createJob({ status: 'processing' });
  assert.deepEqual(
    await actions.cancel(ownerId.toHexString(), active._id.toHexString()),
    { id: active._id.toHexString(), status: 'cancelled' },
  );
  assert.ok(
    (await jobs.findById(active._id).lean()).finishedAt instanceof Date,
  );

  const cancelled = await createJob({
    status: 'cancelled',
    finishedAt: new Date(),
    revision: 4,
  });
  assert.equal(
    (await actions.cancel(ownerId.toHexString(), cancelled._id.toHexString()))
      .status,
    'cancelled',
  );
  assert.equal((await jobs.findById(cancelled._id).lean()).revision, 4);

  const terminal = await createJob({ status: 'ready', finishedAt: new Date() });
  await assert.rejects(
    actions.cancel(ownerId.toHexString(), terminal._id.toHexString()),
    hasCode('JOB_STATE_CONFLICT'),
  );
  const ownerOnly = await createJob({ status: 'queued' });
  await assert.rejects(
    actions.cancel(otherId.toHexString(), ownerOnly._id.toHexString()),
    hasCode('JOB_NOT_FOUND'),
  );
});

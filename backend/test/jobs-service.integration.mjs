import { accountFixture } from './helpers/account-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { JobsService } from '../dist/jobs/jobs.service.js';
import { EnqueueService } from '../dist/jobs/enqueue.service.js';

test('verified upload ordering, owner idempotency and cancellation race persist correctly', async (t) => {
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
  const owner = new Types.ObjectId().toString();
  const input = {
    extension: 'mp3',
    contentType: 'audio/mpeg',
    bytes: 1024,
    durationSeconds: 30,
    sha256: Buffer.alloc(32).toString('base64'),
  };
  const storage = {
    createInputGrant: async () => ({
      method: 'PUT',
      url: 'https://storage.invalid/upload',
      headers: {},
      expiresAt: new Date().toISOString(),
    }),
    verifyInput: async (job) => ({
      key: job.inputReservation.key,
      versionId: 'pinned-v1',
      bytes: 1024,
      sha256: input.sha256,
      contentType: 'audio/mpeg',
    }),
  };
  const foreignOwner = new Types.ObjectId().toString();
  const { access } = await accountFixture(connection, [owner, foreignOwner]);
  const service = new JobsService(
    jobs,
    storage,
    new ProcessingTransactions(connection),
    new EnqueueService(connection.model('QueueCounter')),
    access,
    {
      assertNewWork: async () => ({
        settingsRevision: 0,
        maxInputBytesExclusive: 30_000_000,
        maxDurationSecondsExclusive: 600,
        maxActiveJobsPerUser: null,
        reservationExpiresAt: new Date(Date.now() + 900_000),
      }),
      assertAcceptedReservation: (job) =>
        job.admissionSnapshot ?? {
          settingsRevision: 0,
          maxInputBytesExclusive: 30_000_000,
          maxDurationSecondsExclusive: 600,
          maxActiveJobsPerUser: null,
          reservationExpiresAt: new Date(Date.now() + 900_000),
        },
    },
  );
  const requestId = randomUUID();
  const source = {
    sourceTitle: 'Fixture video',
    sourceKind: 'url',
    sourceUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  };
  const a = await service.create(owner, input, requestId, source);
  const repeated = await service.create(owner, input, requestId, source);
  assert.equal(repeated.id, a.id);
  assert.equal(await jobs.countDocuments(), 1);
  assert.equal((await jobs.findById(a.id).lean()).sourceUrl, source.sourceUrl);
  await assert.rejects(
    service.create(owner, { ...input, bytes: 2048 }, requestId),
    {
      response: {
        statusCode: 409,
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'The request identifier was already used',
      },
    },
  );
  const b = await service.create(owner, input, randomUUID());
  await service.confirmUpload(owner, b.id);
  await service.confirmUpload(owner, a.id);
  await service.confirmUpload(owner, b.id);
  const sorted = await jobs
    .find({ status: 'queued' })
    .sort({ queueOrder: 1 })
    .lean();
  assert.deepEqual(
    sorted.map((job) => job._id.toString()),
    [b.id, a.id],
  );
  assert.equal(
    (await connection.model('QueueCounter').findById('audio')).sequence,
    2n,
  );
  await assert.rejects(
    service.confirmUpload(foreignOwner, a.id),
    (error) => error.getStatus() === 404,
  );
  const cancelled = await service.create(owner, input, randomUUID());
  storage.verifyInput = async (job) => {
    await jobs.updateOne({ _id: job._id }, { $set: { status: 'cancelled' } });
    return {
      key: job.inputReservation.key,
      versionId: 'pinned-v2',
      bytes: 1024,
      sha256: input.sha256,
      contentType: 'audio/mpeg',
    };
  };
  await assert.rejects(
    service.confirmUpload(owner, cancelled.id),
    (error) => error.getStatus() === 409,
  );
  assert.equal((await jobs.findById(cancelled.id)).status, 'cancelled');
  assert.equal(
    (await connection.model('QueueCounter').findById('audio')).sequence,
    2n,
  );
});

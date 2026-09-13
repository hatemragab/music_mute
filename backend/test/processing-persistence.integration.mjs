import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';

test('processing documents commit together and abort without partial slot or error state', async (t) => {
  const services = await IsolatedServices.create();
  t.after(() => services.stop());
  const { mongoUri } = await services.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  for (const entry of PROCESSING_MODELS)
    connection.model(entry.name, entry.schema);
  await Promise.all(
    PROCESSING_MODELS.map(({ name }) => connection.model(name).init()),
  );
  const jobs = connection.model('Job');
  const control = connection.model('WorkerControl');
  const errors = connection.model('JobError');
  const jobId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  const session = await connection.startSession();
  t.after(() => session.endSession());
  const job = {
    _id: jobId,
    userId,
    requestId: randomUUID(),
    requestHash: 'a'.repeat(64),
    inputReservation: {
      key: `users/${userId}/jobs/${jobId}/input/test.mp3`,
      extension: 'mp3',
      contentType: 'audio/mpeg',
      bytes: 1024,
      durationSeconds: 30,
      sha256: Buffer.alloc(32).toString('base64'),
    },
  };
  await assert.rejects(
    session.withTransaction(async () => {
      await jobs.create([job], { session });
      await control.create([{ _id: 'z440', activeJobId: jobId }], { session });
      await errors.create(
        [
          {
            jobId,
            eventId: randomUUID(),
            classification: 'processing',
            code: 'SEPARATOR_FAILED',
            message: 'Processing failed',
            stage: 'processing',
            createdAt: new Date(),
          },
        ],
        { session },
      );
      throw new Error('intentional fixture abort');
    }),
    /intentional fixture abort/,
  );
  assert.equal(await jobs.countDocuments(), 0);
  assert.equal(await control.countDocuments(), 0);
  assert.equal(await errors.countDocuments(), 0);
  await session.withTransaction(async () => {
    await jobs.create([job], { session });
    await control.create([{ _id: 'z440', activeJobId: jobId }], { session });
  });
  assert.equal(await jobs.countDocuments({ _id: jobId }), 1);
  assert.equal(
    (await control.findById('z440').lean()).activeJobId.toString(),
    jobId.toString(),
  );
  for (const entry of PROCESSING_MODELS) {
    if (['ProcessingUsageLedger', 'QueueExecutionUsage'].includes(entry.name))
      continue; // Minimal accounting has explicitly bounded retention; job history does not.
    const indexes = await connection.model(entry.name).listIndexes();
    assert.ok(
      indexes.every((index) => index.expireAfterSeconds === undefined),
      'retained records must not expire',
    );
  }
});

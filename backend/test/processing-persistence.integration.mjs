import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';

test('processing documents commit together and abort without partial job or error state', async (t) => {
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
    extra_data: {
      schema_version: 1,
      provider: 'fixture',
      audio_codec: 'mp3',
      raw: 'must-not-persist',
    },
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
  assert.equal(await errors.countDocuments(), 0);
  await session.withTransaction(async () => {
    await jobs.create([job], { session });
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
  });
  assert.equal(await jobs.countDocuments({ _id: jobId }), 1);
  assert.deepEqual((await jobs.findById(jobId).lean()).extra_data, {
    schema_version: 1,
    provider: 'fixture',
    audio_codec: 'mp3',
  });
  assert.equal(await errors.countDocuments({ jobId }), 1);
  for (const name of [
    'Job',
    'PurgedJobRequest',
    'NotificationOutbox',
    'ProcessingAdmissionFence',
  ]) {
    const indexes = await connection.model(name).listIndexes();
    assert.ok(
      indexes.every((index) => index.expireAfterSeconds === undefined),
      `${name} must retain live history, replay protection, and coordination records`,
    );
  }
  const errorTtlIndexes = (await errors.listIndexes()).filter(
    (index) => index.expireAfterSeconds !== undefined,
  );
  assert.equal(errorTtlIndexes.length, 1);
  assert.deepEqual(errorTtlIndexes[0].key, { purgeAt: 1 });
  assert.equal(errorTtlIndexes[0].expireAfterSeconds, 0);
  const activeError = await errors.findOne({ jobId }).lean();
  assert.equal(activeError.finalizedAt, null);
  assert.equal(
    activeError.purgeAt,
    null,
    'unfinished errors have no TTL deadline',
  );
  assert.equal((await jobs.findById(jobId).lean()).status, 'awaiting_upload');
  assert.ok(
    await errors.exists({ _id: activeError._id, purgeAt: null }),
    'active errors remain alongside their live job',
  );
});

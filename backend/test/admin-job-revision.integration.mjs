import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { JobSchema } from '../dist/jobs/job.schema.js';
test(
  'administrative revision covers document and query lifecycle writers including legacy records',
  { timeout: 30000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
      connection = await createConnection(mongoUri).asPromise();
      const jobs = connection.model('Job', JobSchema);
      await jobs.init();
      const job = await jobs.create({
        userId: new Types.ObjectId(),
        requestId: '70cf8e69-db25-4dc8-ad7b-48430c8208ac',
        requestHash: 'a'.repeat(64),
        inputReservation: {
          key: 'fixture/key',
          extension: 'mp3',
          contentType: 'audio/mpeg',
          bytes: 1,
          durationSeconds: 1,
          sha256: Buffer.alloc(32).toString('base64'),
        },
      });
      assert.equal(job.adminRevision, 0);
      job.status = 'queued';
      job.revision++;
      await job.save();
      assert.equal((await jobs.findById(job._id)).adminRevision, 1);
      await jobs.updateOne(
        { _id: job._id },
        { $set: { status: 'validating' }, $inc: { revision: 1 } },
      );
      assert.equal((await jobs.findById(job._id)).adminRevision, 2);
      await jobs.findOneAndUpdate(
        { _id: job._id },
        { $set: { displayName: 'Fixture name' }, $inc: { revision: 1 } },
      );
      assert.equal((await jobs.findById(job._id)).adminRevision, 3);
      await jobs.updateMany(
        { _id: job._id },
        { $set: { deletedAt: new Date() }, $inc: { revision: 1 } },
      );
      assert.equal((await jobs.findById(job._id)).adminRevision, 4);
      await jobs.collection.updateOne(
        { _id: job._id },
        { $unset: { adminRevision: '' } },
      );
      await jobs.updateOne({ _id: job._id }, { $inc: { revision: 1 } });
      assert.equal((await jobs.findById(job._id)).adminRevision, 1);
      await jobs.updateOne(
        { _id: job._id },
        { $set: { cleanupToken: 'fixture-cleanup' } },
      );
      assert.equal((await jobs.findById(job._id)).adminRevision, 1);
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);

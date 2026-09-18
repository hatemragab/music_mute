import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { accountFixture } from './helpers/account-fixture.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { ProcessingUsageService } from '../dist/processing-usage/processing-usage.service.js';
import {
  ProcessingSettings,
  ProcessingSettingsSchema,
} from '../dist/admin-settings/processing-settings.schema.js';

test('usage reservations are idempotent and terminal failure releases them', async (t) => {
  const native = await IsolatedServices.create();
  t.after(() => native.stop());
  const { mongoUri } = await native.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  for (const { name, schema } of [
    ...PROCESSING_MODELS,
    { name: ProcessingSettings.name, schema: ProcessingSettingsSchema },
  ])
    connection.model(name, schema);
  const owner = new Types.ObjectId();
  await accountFixture(connection, [owner.toString()]);
  await Promise.all(Object.values(connection.models).map((m) => m.init()));
  const jobs = connection.model('Job');
  const ledger = connection.model('ProcessingUsageLedger');
  const usage = new ProcessingUsageService(ledger, jobs);
  const transactions = new ProcessingTransactions(connection);
  const job = await jobs.create({
    userId: owner,
    requestId: randomUUID(),
    requestHash: 'a'.repeat(64),
    status: 'queued',
    inputReservation: {
      key: `users/${owner}/jobs/fixture/input.mp3`,
      extension: 'mp3',
      contentType: 'audio/mpeg',
      bytes: 1024,
      durationSeconds: 30,
      sha256: Buffer.alloc(32).toString('base64'),
    },
  });

  await transactions.run(async (session) => {
    await usage.reserveForJob(job._id, owner, 29.1, session);
    await usage.reserveForJob(job._id, owner, 29.1, session);
  });
  const reserved = await usage.readUsage(owner);
  assert.equal(reserved.reservedAudioSeconds, 30);
  assert.equal(reserved.availability, 'busy');
  assert.equal(await ledger.countDocuments(), 1);

  await transactions.run(async (session) => {
    const failed = await jobs.findById(job._id).session(session);
    failed.status = 'failed';
    failed.finishedAt = new Date();
    await failed.save({ session });
    await usage.settleJob(failed, session);
    await usage.settleJob(failed, session);
  });
  const released = await usage.readUsage(owner);
  assert.equal(released.reservedAudioSeconds, 0);
  assert.equal((await ledger.findById(job._id)).state, 'released');
});

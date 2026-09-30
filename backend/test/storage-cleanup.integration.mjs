import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { JobSchema } from '../dist/jobs/job.schema.js';
import { JobActionsService } from '../dist/jobs/job-actions.service.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { StorageCleanupTaskSchema } from '../dist/storage/storage-cleanup-task.schema.js';
import { StorageCleanupService } from '../dist/storage/storage-cleanup.service.js';

test(
  'R2 cleanup protects shared retry inputs and reconciles delayed PUTs before account purge',
  { timeout: 60000 },
  async (t) => {
    const fixture = await IsolatedServices.create();
    t.after(() => fixture.stop());
    const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
    const connection = await createConnection(mongoUri).asPromise();
    t.after(() => connection.close());
    const jobs = connection.model('Job', JobSchema);
    const tasks = connection.model(
      'StorageCleanupTask',
      StorageCleanupTaskSchema,
    );
    await Promise.all([jobs.init(), tasks.init()]);
    const owner = new Types.ObjectId();
    const now = new Date('2026-09-30T00:00:00Z');
    const key = `users/${owner}/jobs/${new Types.ObjectId()}/input/${randomUUID()}.mp3`;
    const reservation = {
      key,
      extension: 'mp3',
      bytes: 12,
      durationSeconds: 1,
      contentType: 'audio/mpeg',
      sha256: Buffer.alloc(32).toString('base64'),
    };
    const object = {
      key,
      etag: '"test-etag"',
      bytes: 12,
      contentType: reservation.contentType,
      sha256: reservation.sha256,
    };
    const createJob = (fields) =>
      jobs.create({
        userId: owner,
        requestId: randomUUID(),
        requestHash: 'a'.repeat(64),
        inputReservation: reservation,
        inputObject: object,
        ...fields,
      });
    const source = await createJob({
      status: 'failed',
      reservationCleanupScheduledAt: now,
    });
    const retry = await createJob({
      status: 'queued',
      retryOfJobId: source._id,
    });
    let stored = true;
    const deleted = [];
    const cleanup = new StorageCleanupService(tasks, {
      deleteObject: async (exactKey) => {
        assert.equal(exactKey, key);
        deleted.push(exactKey);
        stored = false;
      },
    });
    await cleanup.schedule({
      key,
      ownerUserId: owner,
      reason: 'AUDIO_INPUT_TERMINAL',
      nextAt: now,
      settleUntil: now,
    });
    await cleanup.cleanupDue(now);
    assert.equal(deleted.length, 0);
    assert.equal(stored, true);
    assert.equal(await cleanup.hasPendingForOwner(owner), true);
    // The owner cannot create another shared-input retry after cleanup was fenced.
    const actions = new JobActionsService(
      jobs,
      new ProcessingTransactions(connection),
      { assertActive: async () => {} },
      {},
      {},
    );
    await assert.rejects(
      actions.retry(
        owner.toHexString(),
        source._id.toHexString(),
        randomUUID(),
      ),
      (error) => error.getResponse().code === 'NEW_INPUT_REQUIRED',
    );
    await jobs.updateOne(
      { _id: retry._id },
      { $set: { status: 'cancelled', reservationCleanupScheduledAt: now } },
    );
    const first = new Date(now.getTime() + 3_600_000);
    await cleanup.cleanupDue(first);
    assert.equal(deleted.length, 1);
    assert.equal(stored, false);
    assert.equal(await cleanup.hasPendingForOwner(owner), true);
    stored = true; // A request started before grant expiry commits late.
    const second = new Date(
      first.getTime() + StorageCleanupService.LATE_UPLOAD_RECHECK_MS,
    );
    await cleanup.cleanupDue(new Date(second.getTime() - 1));
    assert.equal(stored, true);
    await cleanup.cleanupDue(second);
    assert.equal(deleted.length, 2);
    assert.equal(stored, false);
    assert.equal(await cleanup.hasPendingForOwner(owner), false);
    assert.equal(
      (await tasks.findOne({ key }).lean()).completedAt.getTime(),
      second.getTime(),
    );
  },
);

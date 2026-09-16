import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { JobSchema } from '../dist/jobs/job.schema.js';
import { JobAttemptSchema } from '../dist/jobs/job-attempt.schema.js';
import { WorkerControlSchema } from '../dist/worker/worker-control.schema.js';
import { UserSchema } from '../dist/users/user.schema.js';
import { AdminJobsQueryService } from '../dist/admin-jobs/admin-jobs-query.service.js';
test(
  'administrative job pages preserve tie ordering, privacy, eligibility and reserved recovery',
  { timeout: 30000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
      connection = await createConnection(mongoUri).asPromise();
      connection.options = { ...connection.options, sanitizeFilter: true };
      const jobs = connection.model('Job', JobSchema),
        attempts = connection.model('JobAttempt', JobAttemptSchema),
        controls = connection.model('WorkerControl', WorkerControlSchema),
        users = connection.model('User', UserSchema);
      await Promise.all([jobs, attempts, controls, users].map((m) => m.init()));
      const userId = new Types.ObjectId(),
        disabledId = new Types.ObjectId();
      await users.collection.insertMany([
        {
          _id: userId,
          firebaseUid: 'fixture-active',
          status: 'active',
          email: 'private@example.invalid',
          displayName: 'Private Person',
        },
        {
          _id: disabledId,
          firebaseUid: 'fixture-disabled',
          status: 'disabled',
          email: 'disabled@example.invalid',
          displayName: 'Disabled Person',
        },
      ]);
      const make = (order, extra = {}) => ({
        _id: new Types.ObjectId(order.toString().padStart(24, '0')),
        userId,
        requestId: randomUUID(),
        requestHash: 'a'.repeat(64),
        status: 'queued',
        queueOrder: BigInt(order),
        queuedAt: new Date(0),
        createdAt: new Date(0),
        sourceTitle: 'Private audio name',
        inputReservation: {
          key: 'private/key',
          extension: 'mp3',
          contentType: 'audio/mpeg',
          bytes: 1,
          durationSeconds: 1,
          sha256: Buffer.alloc(32).toString('base64'),
        },
        ...extra,
      });
      const records = await jobs.create([
        make(1),
        make(2),
        make(3),
        make(4, { deletedAt: new Date() }),
        make(5, { userId: disabledId }),
      ]);
      const service = new AdminJobsQueryService(
          jobs,
          attempts,
          users,
          controls,
        ),
        actor = {
          uid: 'fixture-admin',
          role: 'support',
          permissions: ['jobs.read'],
        };
      const query = { userId: userId.toString(), limit: '2' };
      const first = await service.list(actor, query);
      assert.equal(first.items.length, 2);
      assert.equal(first.items[0].id, records[2]._id.toString());
      assert.deepEqual(
        first.items.map((j) => j.queuePosition),
        [null, null],
      );
      assert.equal(JSON.stringify(first).includes('Private'), false);
      assert.equal(JSON.stringify(first).includes('private'), false);
      await jobs.create(make(6, { createdAt: new Date(), queueOrder: 6n }));
      const next = await service.list(actor, {
        ...query,
        cursor: first.nextCursor,
      });
      assert.deepEqual(
        next.items.map((j) => j.id),
        [records[0]._id.toString()],
      );
      await assert.rejects(
        service.list(actor, {
          ...query,
          status: 'failed',
          cursor: first.nextCursor,
        }),
        (error) => error.getResponse().code === 'INVALID_CURSOR',
      );
      const ranged = await service.list(actor, {
        userId: userId.toString(),
        from: new Date(0).toISOString(),
        to: new Date(1).toISOString(),
      });
      assert.equal(ranged.items.length, 3);
      const detailed = await service.detail(
        { ...actor, permissions: ['jobs.read', 'users.read', 'media.read'] },
        records[0]._id.toString(),
      );
      assert.equal(detailed.userEmail, 'private@example.invalid');
      assert.equal(detailed.displayName, 'Private audio name');
      assert.equal(JSON.stringify(detailed).includes('private/key'), false);
      await assert.rejects(
        service.detail(actor, records[3]._id.toString()),
        (error) => error.getStatus() === 404,
      );
      const job = records[2];
      await jobs.updateOne(
        { _id: job._id },
        { $set: { status: 'interrupted' } },
      );
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      await attempts.create(
        ids.map((attemptId, i) => ({
          jobId: job._id,
          workerId: 'fixture-worker',
          attemptId,
          sessionId: randomUUID(),
          generation: i + 1,
          startedAt: new Date(0),
          interruptedAt: new Date(1),
          outcome: 'interrupted',
        })),
      );
      await controls.create({
        _id: 'fixture-worker',
        activeJobId: job._id,
        attemptId: ids[2],
        leaseExpiresAt: new Date(0),
      });
      assert.equal(
        (await service.detail(actor, job._id.toString())).recoveryRequired,
        true,
      );
      const history = await service.history(job._id.toString(), { limit: '2' });
      assert.equal(history.items.length, 2);
      assert.equal(history.items[0].processingElapsedApproximate, false);
      assert.equal(history.items[0].replacementAttemptId, null);
      assert.equal(history.items[0].localDataDeletedAt, null);
      const older = await service.history(job._id.toString(), {
        limit: '2',
        cursor: history.nextCursor,
      });
      assert.equal(older.items.length, 1);
      assert.equal(
        new Set([...history.items, ...older.items].map((a) => a.id)).size,
        3,
      );
      assert.equal(
        [...history.items, ...older.items].filter((a) => a.recoveryRequired)
          .length,
        1,
      );
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);

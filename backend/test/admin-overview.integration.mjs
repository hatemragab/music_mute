import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { JobSchema } from '../dist/jobs/job.schema.js';
import { JobAttemptSchema } from '../dist/jobs/job-attempt.schema.js';
import { UserSchema } from '../dist/users/user.schema.js';
import { WorkerRegistrationSchema } from '../dist/worker/worker-registration.schema.js';
import { WorkerControlSchema } from '../dist/worker/worker-control.schema.js';
import { ReleaseSchema } from '../dist/releases/release.schema.js';
import { AdminOverviewService } from '../dist/admin-observability/admin-overview.service.js';

test(
  'overview reconciles separate UTC cohorts, missing timing, permissions and indexed ranges',
  { timeout: 30000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
      connection = await createConnection(mongoUri).asPromise();
      connection.options = { ...connection.options, sanitizeFilter: true };
      const attempts = connection.model('JobAttempt', JobAttemptSchema);
      await attempts.init();
      const jobs = connection.model('Job', JobSchema),
        users = connection.model('User', UserSchema),
        workers = connection.model(
          'WorkerRegistration',
          WorkerRegistrationSchema,
        ),
        controls = connection.model('WorkerControl', WorkerControlSchema),
        releases = connection.model('Release', ReleaseSchema);
      await Promise.all(
        [jobs, users, workers, controls, releases].map((m) => m.init()),
      );
      const user1 = new Types.ObjectId(),
        user2 = new Types.ObjectId();
      await users.collection.insertMany([
        { _id: user1, firebaseUid: 'fixture-1', status: 'active' },
        { _id: user2, firebaseUid: 'fixture-2', status: 'active' },
      ]);
      const make = (createdAt, status, fields = {}) => ({
        _id: new Types.ObjectId(),
        userId: user1,
        requestId: randomUUID(),
        requestHash: 'a'.repeat(64),
        createdAt: new Date(createdAt),
        status,
        deletedAt: null,
        ...fields,
      });
      await jobs.collection.insertMany(
        Array.from({ length: 3000 }, () =>
          make('2025-01-01', 'ready', { finishedAt: new Date('2025-01-01') }),
        ),
      );
      const source = make('2026-08-31', 'failed', {
        finishedAt: new Date('2026-09-01T03:00:00Z'),
      });
      await jobs.collection.insertMany([
        make('2026-08-30', 'ready', {
          finishedAt: new Date('2026-09-01T01:00:00Z'),
          processingStartedAt: new Date('2026-09-01T00:00:00Z'),
          processingFinishedAt: new Date('2026-09-01T00:00:10Z'),
          processingAccumulatedMs: 10000,
        }),
        source,
        make('2026-09-01T12:00:00Z', 'failed', {
          retryOfJobId: source._id,
          finishedAt: new Date('2026-09-02T01:00:00Z'),
        }),
        make('2026-09-02T12:00:00Z', 'ready', {
          userId: user2,
          finishedAt: new Date('2026-09-03T00:00:00Z'),
        }),
        make('2026-09-01T18:00:00Z', 'queued', {
          userId: user2,
          queuedAt: new Date('2026-09-01T18:01:00Z'),
        }),
        make('2026-09-02T06:00:00Z', 'cancelled', {
          queuedAt: new Date('2026-09-02T06:00:01Z'),
          validatingAt: new Date('2026-09-02T06:00:03Z'),
          processingStartedAt: new Date('2026-09-02T06:00:04Z'),
          processingFinishedAt: new Date('2026-09-02T06:00:06Z'),
          processingAccumulatedMs: 2000,
          finishedAt: new Date('2026-09-02T06:00:10Z'),
        }),
        make('2026-09-01', 'failed', {
          deletedAt: new Date(),
          finishedAt: new Date('2026-09-02'),
        }),
      ]);
      const recovery = make('2026-09-01T08:00:00Z', 'validating', {
        queuedAt: new Date('2026-09-01T08:00:00Z'),
        validatingAt: new Date('2026-09-01T08:01:40Z'),
        processingStartedAt: null,
      });
      await jobs.collection.insertOne(recovery);
      await attempts.collection.insertMany([
        {
          jobId: recovery._id,
          attemptId: randomUUID(),
          startedAt: new Date('2026-09-01T08:00:10Z'),
          processingStartedAt: null,
        },
        {
          jobId: recovery._id,
          attemptId: randomUUID(),
          startedAt: new Date('2026-09-01T08:01:40Z'),
          processingStartedAt: null,
        },
      ]);
      const installationIds = [randomUUID(), randomUUID(), randomUUID()];
      await connection.collection('worker_installations').insertMany(
        ['online', 'offline', 'revoked'].map((id, index) => ({
          _id: installationIds[index],
          assignedWorkerId: id,
          pairingState: 'approved',
          revoked: false,
        })),
      );
      await workers.collection.insertMany([
        {
          _id: 'online',
          installationId: installationIds[0],
          state: 'enabled',
          keySha256: '1'.repeat(64),
        },
        {
          _id: 'offline',
          installationId: installationIds[1],
          state: 'draining',
          keySha256: '2'.repeat(64),
        },
        {
          _id: 'revoked',
          installationId: installationIds[2],
          state: 'revoked',
          keySha256: '3'.repeat(64),
        },
      ]);
      await controls.collection.insertMany([
        { _id: 'online', lastSeenAt: new Date() },
        { _id: 'offline', lastSeenAt: new Date(0) },
        { _id: 'revoked', lastSeenAt: new Date() },
        { _id: 'unregistered-control', lastSeenAt: new Date() },
      ]);
      await releases.collection.insertMany([
        {
          _id: new Types.ObjectId(),
          platform: 'android',
          source: 'direct_apk',
          buildNumber: 1,
          state: 'draft',
          artifactState: 'rejected',
        },
        {
          _id: new Types.ObjectId(),
          platform: 'android',
          source: 'direct_apk',
          buildNumber: 2,
          state: 'published',
        },
      ]);
      const config = new ConfigService({
        PROCESSING_LEASE_SECONDS: 90,
      });
      const service = new AdminOverviewService(
        jobs,
        workers,
        controls,
        releases,
        config,
      );
      const actor = { permissions: ['overview.read'] };
      const range = {
        from: '2026-09-01T03:00:00+03:00',
        to: '2026-09-03T00:00:00Z',
      };
      const result = await service.read(actor, range);
      assert.deepEqual(result.counts, {
        submitted: 5,
        processingActiveUsers: 2,
        completed: 1,
        failed: 2,
        cancelled: 1,
      });
      assert.deepEqual(result.timings, {
        meanQueueWaitSeconds: 6,
        meanProcessingSeconds: 6,
        sampleCount: { queueWait: 2, processing: 2 },
      });
      assert.deepEqual(result.workers, { total: 2, online: 1 });
      assert.equal(result.queue.waiting, 1);
      assert.equal(result.queue.processing, 1);
      assert.equal(result.series.length, 2);
      assert.equal(result.series[0].submitted, 3);
      assert.equal(result.series[0].failed, 1);
      assert.equal(result.series[1].submitted, 2);
      assert.equal(result.series[1].cancelled, 1);
      assert.equal(JSON.stringify(result).includes(user1.toString()), false);
      assert.equal('releaseSummary' in result, false);
      const privileged = await service.read(
        { permissions: ['overview.read', 'releases.read'] },
        range,
      );
      assert.deepEqual(privileged.releaseSummary, {
        draft: 1,
        published: 1,
        withdrawn: 0,
        rejectedArtifacts: 1,
      });
      const empty = await service.read(actor, {
        from: '2027-01-01T00:00:00Z',
        to: '2027-01-02T00:00:00Z',
      });
      assert.equal(empty.counts.submitted, 0);
      assert.equal(empty.timings.meanProcessingSeconds, null);
      const explain = await jobs.collection
        .find({
          finishedAt: { $gte: new Date(range.from), $lt: new Date(range.to) },
          deletedAt: null,
          status: { $in: ['ready', 'failed', 'cancelled'] },
        })
        .explain('executionStats');
      console.log(
        `overview finished cohort: docsExamined=${explain.executionStats.totalDocsExamined} keysExamined=${explain.executionStats.totalKeysExamined} returned=${explain.executionStats.nReturned}`,
      );
      assert.ok(explain.executionStats.nReturned > 0);
      assert.ok(explain.executionStats.totalDocsExamined < 20);
      assert.ok(explain.executionStats.totalKeysExamined < 20);
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);

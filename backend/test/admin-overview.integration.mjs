import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { JobSchema } from '../dist/jobs/job.schema.js';
import { ReleaseSchema } from '../dist/releases/release.schema.js';
import { UserSchema } from '../dist/users/user.schema.js';
import { AdminOverviewService } from '../dist/admin-observability/admin-overview.service.js';

test('overview reports job activity and permission-scoped releases', async (t) => {
  const fixture = await IsolatedServices.create();
  t.after(() => fixture.stop());
  const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  const jobs = connection.model('Job', JobSchema);
  const releases = connection.model('Release', ReleaseSchema);
  const users = connection.model('User', UserSchema);
  await Promise.all([jobs, releases, users].map((model) => model.init()));
  const userId = new Types.ObjectId();
  await users.collection.insertOne({
    _id: userId,
    firebaseUid: 'overview-fixture',
    status: 'active',
  });
  const inputReservation = {
    key: `users/${userId}/jobs/fixture/input.mp3`,
    extension: 'mp3',
    contentType: 'audio/mpeg',
    bytes: 1024,
    durationSeconds: 30,
    sha256: Buffer.alloc(32).toString('base64'),
  };
  await jobs.create([
    {
      userId,
      requestId: randomUUID(),
      requestHash: 'a'.repeat(64),
      status: 'queued',
      createdAt: new Date('2026-09-01T12:00:00Z'),
      queuedAt: new Date('2026-09-01T12:00:01Z'),
      inputReservation,
    },
    {
      userId,
      requestId: randomUUID(),
      requestHash: 'b'.repeat(64),
      status: 'ready',
      createdAt: new Date('2026-09-01T13:00:00Z'),
      processingStartedAt: new Date('2026-09-01T13:01:00Z'),
      processingFinishedAt: new Date('2026-09-01T13:01:30Z'),
      processingAccumulatedMs: 30_000,
      finishedAt: new Date('2026-09-01T13:02:00Z'),
      inputReservation,
    },
  ]);
  const service = new AdminOverviewService(jobs, releases);
  const range = {
    from: '2026-09-01T00:00:00Z',
    to: '2026-09-02T00:00:00Z',
  };
  const actor = { permissions: ['overview.read'] };
  const result = await service.read(actor, range);
  assert.equal(result.counts.submitted, 2);
  assert.equal(result.counts.completed, 1);
  assert.equal(result.queue.waiting, 1);
  assert.equal(result.timings.meanProcessingSeconds, 30);
  assert.equal('releaseSummary' in result, false);

  const privileged = await service.read(
    { permissions: ['overview.read', 'releases.read'] },
    range,
  );
  assert.deepEqual(privileged.releaseSummary, {
    draft: 0,
    published: 0,
    withdrawn: 0,
    rejectedArtifacts: 0,
  });
});

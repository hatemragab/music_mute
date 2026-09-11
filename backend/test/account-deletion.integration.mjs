import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnection, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { User, UserSchema } from '../dist/users/user.schema.js';
import { Job, JobSchema } from '../dist/jobs/job.schema.js';
import {
  JobAttempt,
  JobAttemptSchema,
} from '../dist/jobs/job-attempt.schema.js';
import {
  WorkerControl,
  WorkerControlSchema,
} from '../dist/worker/worker-control.schema.js';
import { WorkerTerminalService } from '../dist/worker/worker-terminal.service.js';
import { WorkerCoordinatorService } from '../dist/worker/worker-coordinator.service.js';
import {
  WorkerRegistration,
  WorkerRegistrationSchema,
} from '../dist/worker/worker-registration.schema.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import {
  UserIdentityFence,
  UserIdentityFenceSchema,
} from '../dist/users/user-identity-fence.schema.js';
import { UserIdentityFenceService } from '../dist/users/user-identity-fence.service.js';
import { randomUUID } from 'node:crypto';
import { AccountAccessService } from '../dist/users/account-access.service.js';
import { AccountDeletionCleanupService } from '../dist/users/account-deletion-cleanup.service.js';

test(
  'deletion lease survives replica competition and provider failure; bounded cleanup preserves foreign ownership',
  { timeout: 60000 },
  async (t) => {
    const fixture = await IsolatedServices.create();
    t.after(() => fixture.stop());
    const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
    const connection = await createConnection(mongoUri, {
      sanitizeFilter: true,
    }).asPromise();
    t.after(() => connection.close());
    const users = connection.model(User.name, UserSchema);
    const jobs = connection.model(Job.name, JobSchema);
    const fences = connection.model(
      UserIdentityFence.name,
      UserIdentityFenceSchema,
    );
    await fences.init();
    const identities = new UserIdentityFenceService(fences);
    await Promise.all([users.init(), jobs.init()]);
    const user = await users.create({
      firebaseUid: 'deletion-fixture',
      displayName: 'Fixture',
      nameSource: 'numeric_alias',
      profileSyncedAt: new Date(),
      lastSeenAt: new Date(),
      status: 'deleting',
      deletionRequestId: '00000000-0000-4000-8000-000000000001',
      deletionRequestedAt: new Date('2025-01-01T00:00:00.000Z'),
      deletionRecoverUntil: new Date('2025-04-01T00:00:00.000Z'),
      deletionNextAt: new Date(0),
    });
    await identities.withDeletion(user.firebaseUid, async () => undefined);
    const foreign = new Types.ObjectId();
    await connection.collection('device_installation_owners').insertMany([
      { _id: 'owned-installation', userId: user._id },
      { _id: 'transferred-installation', userId: foreign },
    ]);
    let unavailable = true;
    let deleted = false;
    const firebase = {
      revokeRefreshTokens: async () => {
        if (unavailable) throw new Error('fixture outage');
      },
      updateUser: async () => {},
      deleteUser: async () => {
        deleted = true;
      },
    };
    const cleanup = () =>
      new AccountDeletionCleanupService(
        users,
        jobs,
        connection,
        {},
        {},
        firebase,
        identities,
      );
    const first = await Promise.all([
      cleanup().advanceDeletion(),
      cleanup().advanceDeletion(),
    ]);
    assert.equal(first.filter(Boolean).length, 1);
    const purging = await users.findById(user._id);
    assert.equal(purging.status, 'purging');
    assert.ok(purging.deletionPurgeStartedAt instanceof Date);
    assert.equal(deleted, false);
    await assert.rejects(
      new AccountAccessService(users).runActive(user._id, async (session) => {
        await connection
          .collection('client_errors')
          .insertOne({ userId: user._id }, { session });
      }),
      (error) => error.status === 403,
    );
    assert.equal(
      await connection.collection('client_errors').countDocuments(),
      0,
    );
    const attempts = connection.model(JobAttempt.name, JobAttemptSchema);
    const controls = connection.model(WorkerControl.name, WorkerControlSchema);
    const registrations = connection.model(
      WorkerRegistration.name,
      WorkerRegistrationSchema,
    );
    await Promise.all([attempts.init(), controls.init(), registrations.init()]);
    await controls.create({ _id: 'z440' });
    const job = await jobs.create({
      userId: user._id,
      requestId: randomUUID(),
      requestHash: '0'.repeat(64),
      status: 'cancelled',
      deletedAt: new Date(),
      cleanupCompletedAt: new Date(),
      inputReservation: {
        key: `users/${user._id}/jobs/fixture/input.mp3`,
        extension: 'mp3',
        contentType: 'audio/mpeg',
        bytes: 10,
        sha256: Buffer.alloc(32).toString('base64'),
        durationSeconds: 1,
      },
    });
    const attempt = await attempts.create({
      workerId: 'z440',
      jobId: job._id,
      attemptId: randomUUID(),
      sessionId: randomUUID(),
      generation: 1,
      startedAt: new Date(),
      endedAt: new Date(),
      outcome: 'cancelled',
    });
    unavailable = false;
    await users.updateOne(
      { _id: user._id },
      { $set: { deletionNextAt: new Date(0) } },
    );
    await cleanup().advanceDeletion();
    assert.equal(
      deleted,
      false,
      'missing local file acknowledgement must block completion',
    );
    assert.ok(await attempts.exists({ _id: attempt._id }));
    const terminal = new WorkerTerminalService(
      new WorkerCoordinatorService(
        jobs,
        controls,
        attempts,
        new ProcessingTransactions(connection),
        new ConfigService({ PROCESSING_WORKER_AUTH_MODE: 'legacy' }),
        null,
        null,
        null,
      ),
      new ProcessingTransactions(connection),
      null,
      attempts,
      null,
      null,
      controls,
      null,
      null,
    );
    const acknowledgement = {
      jobId: job._id.toHexString(),
      attemptId: attempt.attemptId,
      sessionId: attempt.sessionId,
      generation: 1,
      eventId: randomUUID(),
      localDataDeleted: true,
    };
    await assert.rejects(
      terminal.confirmLocalCleanup({
        ...acknowledgement,
        sessionId: randomUUID(),
      }),
      (error) => error.status === 409,
    );
    assert.deepEqual(await terminal.confirmLocalCleanup(acknowledgement), {
      status: 'cleaned',
    });

    for (
      let iteration = 0;
      iteration < 10 && (await users.exists({ _id: user._id }));
      iteration++
    ) {
      await users.updateOne(
        { _id: user._id },
        { $set: { deletionNextAt: new Date(0) } },
      );
      await cleanup().advanceDeletion();
    }
    assert.equal(deleted, true);
    assert.equal(await users.exists({ _id: user._id }), null);
    assert.equal(
      await connection
        .collection('device_installation_owners')
        .countDocuments({ userId: user._id }),
      0,
    );
    assert.equal(
      await connection
        .collection('device_installation_owners')
        .countDocuments({ userId: foreign }),
      1,
    );
  },
);

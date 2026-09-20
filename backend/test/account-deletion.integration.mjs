import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { User, UserSchema } from '../dist/users/user.schema.js';
import { Job, JobSchema } from '../dist/jobs/job.schema.js';
import {
  UserIdentityFence,
  UserIdentityFenceSchema,
} from '../dist/users/user-identity-fence.schema.js';
import { UserIdentityFenceService } from '../dist/users/user-identity-fence.service.js';
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
      deletionRecoverUntil: new Date('2025-01-16T00:00:00.000Z'),
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
        { hasPendingForOwner: async () => false, schedule: async () => {} },
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
    await jobs.create({
      userId: user._id,
      requestId: '00000000-0000-4000-8000-000000000002',
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
    unavailable = false;
    await users.updateOne(
      { _id: user._id },
      { $set: { deletionNextAt: new Date(0) } },
    );
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
    const tombstone = await connection
      .collection('account_deletion_tombstones')
      .findOne({ _id: '00000000-0000-4000-8000-000000000001' });
    assert.deepEqual(Object.keys(tombstone).sort(), [
      '_id',
      'acceptedAt',
      'completedAt',
      'schemaVersion',
      'status',
    ]);
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

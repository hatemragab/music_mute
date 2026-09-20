import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';

test(
  'admin users remain searchable without legacy embedded restriction state',
  { timeout: 30000 },
  async (t) => {
    const fixture = await IsolatedServices.create();
    t.after(() => fixture.stop());
    const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
    const connection = await createConnection(mongoUri, {
      bufferCommands: false,
    }).asPromise();
    t.after(() => connection.close());
    connection.options = { ...connection.options, sanitizeFilter: true };
    const [{ User, UserSchema }, { Job, JobSchema }, { AdminUsersService }] =
      await Promise.all([
        import('../dist/users/user.schema.js'),
        import('../dist/jobs/job.schema.js'),
        import('../dist/admin-users/admin-users.service.js'),
      ]);
    const users = connection.model(User.name, UserSchema);
    const jobs = connection.model(Job.name, JobSchema);
    await Promise.all([users.init(), jobs.init()]);
    const userId = new Types.ObjectId();
    const now = new Date();
    await users.create({
      _id: userId,
      firebaseUid: 'admin-users-fixture',
      email: 'person@example.test',
      emailVerified: true,
      displayName: 'Person One',
      nameSource: 'email_prefix',
      providerIds: ['password'],
      status: 'active',
      sessionsRevokedAfterSec: 0,
      profileSyncedAt: now,
      lastSeenAt: now,
    });
    const adminUsers = new AdminUsersService(
      users,
      jobs,
      { readUsage: async () => ({}) },
      { currentOverride: async () => null },
    );
    const page = await adminUsers.list({ query: 'person@example.test' });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].id, userId.toHexString());
    assert.equal('processingSuspended' in page.items[0], false);
    const detail = await adminUsers.detail(userId.toHexString());
    assert.equal(detail.id, userId.toHexString());
    assert.equal('suspension' in detail, false);
    await assert.rejects(
      adminUsers.list({ processingSuspended: 'true' }),
      (error) => error.getResponse().code === 'INVALID_REQUEST',
    );
  },
);

import 'reflect-metadata';
import { accountFixture } from './helpers/account-fixture.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnection } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';

test(
  'real MongoDB enforces user identity, immutable state, and activity coalescing',
  { timeout: 30000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
      connection = await createConnection(mongoUri, {
        sanitizeFilter: true,
        bufferCommands: false,
      }).asPromise();
      const { User, UserSchema } = await import('../dist/users/user.schema.js');
      const { UsersService } = await import('../dist/users/users.service.js');
      const model = connection.model(User.name, UserSchema);
      await model.init();
      const { identities } = await accountFixture(connection);
      const users = new UsersService(model, identities);
      const authTimeSec = Math.floor(Date.now() / 1000) - 10;
      const identity = {
        uid: 'fixture-owner',
        authTimeSec,
        provider: 'password',
        tokenEmailVerified: false,
      };
      const profile = {
        uid: identity.uid,
        email: 'example@fixture.invalid',
        emailVerified: false,
        disabled: false,
        providerData: [{ providerId: 'password' }],
      };
      const results = await Promise.all(
        Array.from({ length: 20 }, () => users.provision(identity, profile)),
      );
      assert.equal(new Set(results.map((user) => user._id.toString())).size, 1);
      assert.equal(await model.countDocuments(), 1);
      const first = results[0];
      assert.equal(first.displayName, 'example');
      assert.equal(first.emailVerified, false);
      await model.updateOne(
        { _id: first._id },
        { $set: { firebaseUid: 'fixture-tampered' } },
        { runValidators: true },
      );
      assert.equal(
        (await model.findById(first._id).exec()).firebaseUid,
        identity.uid,
      );
      await assert.rejects(
        model.updateOne(
          { _id: first._id },
          { $set: { unknownProfileField: 'rejected' } },
          { runValidators: true },
        ),
        (error) => error.name === 'StrictModeError',
      );
      const second = await users.provision(
        { ...identity, uid: 'fixture-other' },
        { ...profile, uid: 'fixture-other' },
      );
      assert.notEqual(first._id.toString(), second._id.toString());
      assert.equal(await model.countDocuments(), 2);

      const firstSeen = first.lastSeenAt.getTime();
      await users.recordActivity(first._id.toString());
      assert.equal(
        (await users.findByFirebaseUid(identity.uid)).lastSeenAt.getTime(),
        firstSeen,
      );
      await model.updateOne(
        { _id: first._id },
        { $set: { lastSeenAt: new Date(Date.now() - 600000) } },
      );
      await users.recordActivity(first._id.toString());
      assert.ok(
        (await users.findByFirebaseUid(identity.uid)).lastSeenAt.getTime() >
          Date.now() - 5000,
      );

      await users.setLogoutCutoff(first._id.toString(), authTimeSec + 1);
      await users.setLogoutCutoff(first._id.toString(), authTimeSec - 1);
      assert.equal(
        (await users.findByFirebaseUid(identity.uid)).sessionsRevokedAfterSec,
        authTimeSec + 1,
      );
      await assert.rejects(
        users.provision(identity, profile),
        (error) => error.status === 401,
      );
      await model.updateOne(
        { _id: first._id },
        { $set: { status: 'disabled' } },
      );
      await assert.rejects(
        users.provision({ ...identity, authTimeSec: authTimeSec + 2 }, profile),
        (error) => error.status === 403,
      );
      assert.equal(
        (await users.findByFirebaseUid(identity.uid)).status,
        'disabled',
      );

      const appleIdentity = {
        ...identity,
        uid: 'fixture-apple',
        provider: 'apple.com',
      };
      const apple = await users.provision(appleIdentity, {
        ...profile,
        uid: appleIdentity.uid,
        email: 'hidden@privaterelay.appleid.com',
        providerData: [{ providerId: 'apple.com' }],
      });
      const renamed = await users.syncProfile(
        apple._id.toString(),
        {
          ...profile,
          uid: appleIdentity.uid,
          email: 'new-email@fixture.invalid',
          providerData: [{ providerId: 'apple.com' }],
        },
        appleIdentity,
      );
      assert.match(apple.displayName, /^\d{12}$/);
      assert.equal(renamed.displayName, apple.displayName);
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);

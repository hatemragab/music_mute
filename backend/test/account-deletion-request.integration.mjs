import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection } from 'mongoose';
import { createHash } from 'node:crypto';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { accountFixture } from './helpers/account-fixture.mjs';
import { AccountDeletionService } from '../dist/users/account-deletion.service.js';
import { UsersService } from '../dist/users/users.service.js';

test('acceptance is idempotent, serializes with provisioning and prevents deleted identity replay', async (t) => {
  const native = await IsolatedServices.create();
  t.after(() => native.stop());
  const { mongoUri } = await native.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  const { users, identities, fences } = await accountFixture(connection);
  const profiles = new UsersService(users, identities);
  const deletion = new AccountDeletionService(users, identities);
  const authTimeSec = Math.floor(Date.now() / 1000);
  const identity = {
    uid: 'deletion-fixture',
    authTimeSec,
    provider: 'password',
    tokenEmailVerified: false,
  };
  const profile = {
    uid: identity.uid,
    email: 'owned@fixture.invalid',
    emailVerified: false,
    providerData: [{ providerId: 'password' }],
  };
  const owner = await profiles.provision(identity, profile);
  const receipts = await Promise.all(
    Array.from({ length: 10 }, () =>
      deletion.requestDeletion(owner._id.toHexString(), authTimeSec),
    ),
  );
  assert.equal(new Set(receipts.map((r) => r.requestId)).size, 1);
  assert.equal((await users.findById(owner._id)).status, 'deleting');
  await assert.rejects(
    profiles.provision(identity, profile),
    (e) => e.getResponse().code === 'ACCOUNT_DISABLED',
  );
  // Simulate confirmed external erasure: no profile remains to reject stale provisioning.
  await identities.complete(identity.uid);
  await users.deleteOne({ _id: owner._id });
  await assert.rejects(
    profiles.provision(identity, profile),
    (e) => e.getResponse().code === 'ACCOUNT_DISABLED',
  );
  assert.equal(await users.countDocuments(), 0);
  const fence = await fences
    .findById(createHash('sha256').update(identity.uid).digest('hex'))
    .lean();
  assert.equal(fence.blocked, true);
  assert.ok(fence.expiresAt > new Date());
  assert.equal(JSON.stringify(fence).includes(identity.uid), false);

  const other = await profiles.provision(
    { ...identity, uid: 'new-identity' },
    { ...profile, uid: 'new-identity' },
  );
  await users.updateOne({ _id: other._id }, { $set: { status: 'disabled' } });
  await assert.rejects(
    deletion.requestVerifiedDeletion(other._id.toHexString(), 'wrong-identity'),
    (e) => e.getResponse().code === 'INVALID_INPUT',
  );
  const support = await deletion.requestVerifiedDeletion(
    other._id.toHexString(),
    'new-identity',
  );
  assert.equal(support.status, 'accepted');
  assert.equal((await users.findById(other._id)).status, 'deleting');

  const racingUid = 'disabled-during-acceptance';
  const racingOwner = await profiles.provision(
    { ...identity, uid: racingUid },
    { ...profile, uid: racingUid },
  );
  const raced = new AccountDeletionService(users, {
    withDeletion: async (uid, operation) => {
      await users.updateOne(
        { _id: racingOwner._id },
        { $set: { status: 'disabled' } },
      );
      return identities.withDeletion(uid, operation);
    },
  });
  await assert.rejects(
    raced.requestDeletion(racingOwner._id.toHexString(), authTimeSec),
    (e) => e.getResponse().code === 'ACCOUNT_DISABLED',
  );
  const unchangedFence = await fences.findById(
    createHash('sha256').update(racingUid).digest('hex'),
  );
  assert.equal(
    unchangedFence.blocked,
    false,
    'failed acceptance rolls back the replay fence',
  );
});

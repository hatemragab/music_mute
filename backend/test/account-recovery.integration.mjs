import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';

test(
  'recovery requests are idempotent and cannot start after cleanup owns the account',
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

    const [
      { User, UserSchema },
      { AccountRecoveryRequest, AccountRecoveryRequestSchema },
      { AccountRecoveryService },
    ] = await Promise.all([
      import('../dist/users/user.schema.js'),
      import('../dist/users/account-recovery-request.schema.js'),
      import('../dist/users/account-recovery.service.js'),
    ]);
    const users = connection.model(User.name, UserSchema);
    const requests = connection.model(
      AccountRecoveryRequest.name,
      AccountRecoveryRequestSchema,
    );
    await Promise.all([users.init(), requests.init()]);
    const recovery = new AccountRecoveryService(users, requests);
    const now = new Date();
    const recoverUntil = new Date(now.getTime() + 60_000);
    const createDeletingUser = async (uid, leaseToken = null) => {
      const userId = new Types.ObjectId();
      await users.create({
        _id: userId,
        firebaseUid: uid,
        email: `${uid}@example.test`,
        emailVerified: true,
        displayName: uid,
        nameSource: 'email_prefix',
        providerIds: ['password'],
        status: 'deleting',
        deletionRequestId: randomUUID(),
        deletionRequestedAt: now,
        deletionRecoverUntil: recoverUntil,
        deletionNextAt: recoverUntil,
        deletionLeaseUntil: leaseToken
          ? new Date(now.getTime() + 60_000)
          : null,
        deletionLeaseToken: leaseToken,
        sessionsRevokedAfterSec: 0,
        profileSyncedAt: now,
        lastSeenAt: now,
      });
      return userId;
    };

    const recoverableUserId = await createDeletingUser('recoverable-user');
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        recovery.request(
          recoverableUserId.toHexString(),
          { reason: 'Please restore my account' },
          now,
        ),
      ),
    );
    assert.equal(new Set(results.map((item) => item.id)).size, 1);
    assert.equal(
      await requests.countDocuments({ userId: recoverableUserId }),
      1,
    );

    const leasedUserId = await createDeletingUser(
      'cleanup-owned-user',
      'cleanup-lease',
    );
    await assert.rejects(
      recovery.request(
        leasedUserId.toHexString(),
        { reason: 'This must not race irreversible cleanup' },
        now,
      ),
      (error) => error?.getResponse?.().code === 'ACCOUNT_RECOVERY_EXPIRED',
    );
    assert.equal(await requests.countDocuments({ userId: leasedUserId }), 0);
  },
);

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
      { AccountDeletionCleanupService },
    ] = await Promise.all([
      import('../dist/users/user.schema.js'),
      import('../dist/users/account-recovery-request.schema.js'),
      import('../dist/users/account-recovery.service.js'),
      import('../dist/users/account-deletion-cleanup.service.js'),
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

    const legacyUserId = new Types.ObjectId();
    await users.create({
      _id: legacyUserId,
      firebaseUid: 'legacy-deleting-user',
      displayName: 'Legacy user',
      nameSource: 'numeric_alias',
      status: 'deleting',
      deletionRequestId: randomUUID(),
      deletionRequestedAt: new Date('2026-01-31T12:00:00.000Z'),
      deletionRecoverUntil: null,
      deletionNextAt: new Date(0),
      sessionsRevokedAfterSec: 0,
      profileSyncedAt: now,
      lastSeenAt: now,
    });
    const cleanup = new AccountDeletionCleanupService(
      users,
      {
        find: () => ({
          sort: () => ({ limit: () => ({ lean: async () => [] }) }),
        }),
      },
      connection,
      {},
      {},
      {},
      {},
    );
    await cleanup.advanceDeletion(new Date('2026-02-01T00:00:00.000Z'));
    const normalized = await users.findById(legacyUserId).lean();
    assert.equal(normalized.status, 'deleting');
    assert.equal(
      normalized.deletionRecoverUntil.toISOString(),
      '2026-02-15T12:00:00.000Z',
    );
    assert.equal(
      normalized.deletionNextAt.toISOString(),
      '2026-02-15T12:00:00.000Z',
    );
    assert.equal(normalized.deletionLeaseToken, null);
  },
);

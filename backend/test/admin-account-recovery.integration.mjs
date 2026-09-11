import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';

test(
  'account recovery atomically restores a deleting user and rejects an expired request',
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
      { UserIdentityFence, UserIdentityFenceSchema },
      { UserIdentityFenceService },
      { AccountRecoveryRequest, AccountRecoveryRequestSchema },
      { AdminAccountRecoveryService },
    ] = await Promise.all([
      import('../dist/users/user.schema.js'),
      import('../dist/users/user-identity-fence.schema.js'),
      import('../dist/users/user-identity-fence.service.js'),
      import('../dist/users/account-recovery-request.schema.js'),
      import('../dist/admin-users/admin-account-recovery.service.js'),
    ]);
    const users = connection.model(User.name, UserSchema);
    const fences = connection.model(
      UserIdentityFence.name,
      UserIdentityFenceSchema,
    );
    const requests = connection.model(
      AccountRecoveryRequest.name,
      AccountRecoveryRequestSchema,
    );
    await Promise.all([users.init(), fences.init(), requests.init()]);

    const transactionalOperations = {
      async run(_actor, _command, mutate) {
        const session = await connection.startSession();
        try {
          const result = await session.withTransaction(() => mutate(session));
          return { value: result.value, receipt: {}, replayed: false };
        } finally {
          await session.endSession();
        }
      },
    };
    const identities = new UserIdentityFenceService(fences);
    const recovery = new AdminAccountRecoveryService(
      requests,
      users,
      identities,
      transactionalOperations,
    );
    const actor = {
      uid: 'support-admin',
      verifiedEmail: 'support@example.test',
      role: 'support',
      permissions: ['users.account-recovery.manage'],
      accessRevision: 0,
      authTimeSec: Math.floor(Date.now() / 1000),
    };
    const createPending = async ({ uid, recoverUntil }) => {
      const userId = new Types.ObjectId();
      const requestId = randomUUID();
      const requestedAt = new Date(Date.now() - 60_000);
      await users.create({
        _id: userId,
        firebaseUid: uid,
        email: `${uid}@example.test`,
        emailVerified: true,
        displayName: uid,
        nameSource: 'email_prefix',
        providerIds: ['password'],
        status: 'deleting',
        deletionRequestId: requestId,
        deletionRequestedAt: requestedAt,
        deletionRecoverUntil: recoverUntil,
        deletionNextAt: recoverUntil,
        processingSuspended: true,
        sessionsRevokedAfterSec: 0,
        profileSyncedAt: requestedAt,
        lastSeenAt: requestedAt,
      });
      await fences.create({
        _id: createHash('sha256').update(uid).digest('hex'),
        blocked: true,
        revision: 1,
        expiresAt: null,
      });
      const request = await requests.create({
        userId,
        deletionRequestId: requestId,
        deletionRequestedAt: requestedAt,
        recoverUntil,
        reason: 'I changed my mind',
      });
      return { userId, request };
    };

    const active = await createPending({
      uid: 'recoverable-user',
      recoverUntil: new Date(Date.now() + 60_000),
    });
    const approved = await recovery.decide(
      actor,
      active.request._id.toHexString(),
      {
        expectedRevision: 0,
        operationId: randomUUID(),
        reason: 'Ownership and request reviewed',
      },
      true,
    );
    assert.equal(approved.status, 'approved');
    assert.equal(approved.revision, 1);
    const restored = await users.findById(active.userId).lean();
    assert.equal(restored.status, 'active');
    assert.equal(restored.deletionRequestId, null);
    assert.equal(restored.deletionRecoverUntil, null);
    assert.equal(restored.deletionNextAt, null);
    assert.equal(restored.processingSuspended, true);
    assert.equal(restored.adminRevision, 1);
    assert.equal(
      (
        await fences
          .findById(
            createHash('sha256').update('recoverable-user').digest('hex'),
          )
          .lean()
      ).blocked,
      false,
    );

    const expired = await createPending({
      uid: 'expired-user',
      recoverUntil: new Date(Date.now() - 1000),
    });
    await assert.rejects(
      recovery.decide(
        actor,
        expired.request._id.toHexString(),
        {
          expectedRevision: 0,
          operationId: randomUUID(),
          reason: 'Too late to restore safely',
        },
        true,
      ),
      (error) => error?.getResponse?.().code === 'INVALID_REQUEST',
    );
    assert.equal(
      (await users.findById(expired.userId).lean()).status,
      'deleting',
    );
    assert.equal(
      (await requests.findById(expired.request._id).lean()).status,
      'pending',
    );
    assert.equal(
      (
        await fences
          .findById(createHash('sha256').update('expired-user').digest('hex'))
          .lean()
      ).blocked,
      true,
    );
  },
);

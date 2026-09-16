import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';

test(
  'processing suspension preserves account and existing jobs',
  { timeout: 30000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
      connection = await createConnection(mongoUri, {
        bufferCommands: false,
      }).asPromise();
      connection.options = { ...connection.options, sanitizeFilter: true };
      const [
        { User, UserSchema },
        { UserIdentityFence, UserIdentityFenceSchema },
        { UserIdentityFenceService },
        { Job, JobSchema },
        { ProcessingAdmissionFence, ProcessingAdmissionFenceSchema },
        { AdminUsersService },
      ] = await Promise.all([
        import('../dist/users/user.schema.js'),
        import('../dist/users/user-identity-fence.schema.js'),
        import('../dist/users/user-identity-fence.service.js'),
        import('../dist/jobs/job.schema.js'),
        import('../dist/admin-settings/processing-settings.schema.js'),
        import('../dist/admin-users/admin-users.service.js'),
      ]);
      const users = connection.model(User.name, UserSchema);
      const identityFences = connection.model(
        UserIdentityFence.name,
        UserIdentityFenceSchema,
      );
      const jobs = connection.model(Job.name, JobSchema);
      const admissionFences = connection.model(
        ProcessingAdmissionFence.name,
        ProcessingAdmissionFenceSchema,
      );
      await Promise.all([
        users.init(),
        identityFences.init(),
        jobs.init(),
        admissionFences.init(),
      ]);

      const userId = new Types.ObjectId();
      const existingJobId = new Types.ObjectId();
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
      // A pre-B07 record has neither the revision nor suspension fields.
      await users.collection.updateOne(
        { _id: userId },
        {
          $unset: {
            adminRevision: '',
            processingSuspended: '',
            processingSuspensionReason: '',
            processingSuspendedBy: '',
            processingSuspendedAt: '',
          },
        },
      );
      await jobs.create({
        _id: existingJobId,
        userId,
        requestId: randomUUID(),
        requestHash: 'a'.repeat(64),
        status: 'processing',
        inputReservation: {
          key: `users/${userId}/jobs/${existingJobId}/input/a.mp3`,
          extension: 'mp3',
          contentType: 'audio/mpeg',
          bytes: 100,
          durationSeconds: 10,
          sha256: Buffer.alloc(32).toString('base64'),
        },
      });
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
      const adminUsers = new AdminUsersService(
        users,
        jobs,
        admissionFences,
        new UserIdentityFenceService(identityFences),
        transactionalOperations,
      );
      const actor = {
        uid: 'support-admin',
        role: 'support',
        accessRevision: 0,
      };
      const suspension = await adminUsers.suspend(actor, userId.toHexString(), {
        expectedRevision: 0,
        operationId: randomUUID(),
        reason: 'Investigate repeated abuse',
      });
      assert.equal(suspension.processingSuspended, true);
      assert.equal((await users.findById(userId).lean()).status, 'active');
      assert.equal(
        (await jobs.findById(existingJobId).lean()).status,
        'processing',
      );
      await users.updateOne({ _id: userId }, { $set: { status: 'deleting' } });
      const resumed = await adminUsers.resume(actor, userId.toHexString(), {
        expectedRevision: 1,
        operationId: randomUUID(),
        reason: 'Support review complete',
      });
      assert.equal(resumed.processingSuspended, false);
      assert.equal((await users.findById(userId).lean()).status, 'deleting');
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);

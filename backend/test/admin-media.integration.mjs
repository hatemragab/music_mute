import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { JobSchema } from '../dist/jobs/job.schema.js';
import { UserSchema } from '../dist/users/user.schema.js';
import { AccountAccessService } from '../dist/users/account-access.service.js';
import { AdminAccessSchema } from '../dist/admin/admin-access.schema.js';
import { AdminAuditEventSchema } from '../dist/admin/admin-audit.schema.js';
import { AdminOperationSchema } from '../dist/admin/admin-operation.schema.js';
import { AdminAuditService } from '../dist/admin/admin-audit.service.js';
import { AdminOperationsService } from '../dist/admin/admin-operations.service.js';
import { AdminMediaService } from '../dist/admin-jobs/admin-media.service.js';

test(
  'media issuance commits private audit atomically and denies replay or deletion',
  { timeout: 30000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
      connection = await createConnection(mongoUri, {
        sanitizeFilter: true,
      }).asPromise();
      connection.options = { ...connection.options, sanitizeFilter: true };
      const jobs = connection.model('Job', JobSchema),
        users = connection.model('User', UserSchema),
        access = connection.model('AdminAccess', AdminAccessSchema),
        events = connection.model('AdminAuditEvent', AdminAuditEventSchema),
        receipts = connection.model('AdminOperation', AdminOperationSchema);
      await Promise.all(
        [jobs, users, access, events, receipts].map((m) => m.init()),
      );
      const actor = {
        uid: 'fixture-support',
        verifiedEmail: 'support@example.invalid',
        role: 'support',
        accessRevision: 0,
        permissions: ['jobs.read', 'media.read'],
        authTimeSec: 1,
      };
      await access.create({
        uid: actor.uid,
        verifiedEmail: actor.verifiedEmail,
        role: actor.role,
        active: true,
      });
      const userId = new Types.ObjectId();
      await users.collection.insertOne({
        _id: userId,
        firebaseUid: 'fixture-media-user',
        status: 'active',
      });
      const reservation = {
        key: 'private/input.mp3',
        extension: 'mp3',
        contentType: 'audio/mpeg',
        bytes: 42,
        durationSeconds: 1,
        sha256: Buffer.alloc(32).toString('base64'),
      };
      const identity = {
        key: reservation.key,
        contentType: reservation.contentType,
        bytes: reservation.bytes,
        sha256: reservation.sha256,
      };
      const job = await jobs.create({
        userId,
        requestId: randomUUID(),
        requestHash: 'a'.repeat(64),
        status: 'ready',
        inputReservation: reservation,
        inputObject: { ...identity, versionId: 'input-pinned' },
        outputObject: {
          ...identity,
          key: 'private/vocals.mp3',
          versionId: 'output-pinned',
        },
      });
      const audit = new AdminAuditService(events);
      const operations = new AdminOperationsService(
        connection,
        access,
        receipts,
        audit,
      );
      let signed = 0;
      const storage = {
        isPinnedObjectAvailable: async () => true,
        createMediaGrant: async (object) => {
          signed++;
          assert.equal(object.versionId, 'output-pinned');
          return {
            url: 'https://example.invalid/private-signed-url',
            expiresAt: new Date(Date.now() + 300000).toISOString(),
          };
        },
      };
      const service = new AdminMediaService(
        jobs,
        new AccountAccessService(users),
        storage,
        operations,
      );
      const body = () => ({
        asset: 'result',
        purpose: 'play',
        reason: 'Support investigation',
        operationId: randomUUID(),
      });
      const first = body();
      assert.ok((await service.grant(actor, job._id.toString(), first)).url);
      assert.equal(signed, 1);
      assert.equal(await events.countDocuments(), 1);
      const stored = JSON.stringify([
        await events.find().lean(),
        await receipts.find().lean(),
      ]);
      assert.equal(/private|signed-url|filename|versionId/.test(stored), false);
      await assert.rejects(
        service.grant(actor, job._id.toString(), first),
        (e) => e.getStatus() === 409,
      );
      assert.equal(signed, 1);
      const before = await jobs.findById(job._id).lean();
      const originalRecord = audit.record.bind(audit);
      audit.record = async () => {
        throw new Error('fixture audit unavailable');
      };
      const failed = body();
      await assert.rejects(service.grant(actor, job._id.toString(), failed));
      assert.equal((await jobs.findById(job._id)).revision, before.revision);
      assert.equal(
        (await receipts.findOne({ operationId: failed.operationId })).status,
        'failed',
      );
      assert.equal(await events.countDocuments(), 1);
      audit.record = originalRecord;
      await users.updateOne({ _id: userId }, { $set: { status: 'deleting' } });
      const beforeDeletion = signed;
      await assert.rejects(service.grant(actor, job._id.toString(), body()));
      assert.equal(signed, beforeDeletion);
      assert.equal(await events.countDocuments(), 1);
      await users.updateOne({ _id: userId }, { $set: { status: 'active' } });
      storage.isPinnedObjectAvailable = async () => false;
      await assert.rejects(
        service.grant(actor, job._id.toString(), body()),
        (e) => e.getStatus() === 410,
      );
      assert.equal(signed, beforeDeletion);
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);

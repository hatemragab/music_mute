import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnection } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { AdminAccessSchema } from '../dist/admin/admin-access.schema.js';
import { AdminAuditEventSchema } from '../dist/admin/admin-audit.schema.js';
import { AdminOperationSchema } from '../dist/admin/admin-operation.schema.js';
import { AdminAuditService } from '../dist/admin/admin-audit.service.js';
import { AdminOperationsService } from '../dist/admin/admin-operations.service.js';

test(
  'admin mutations atomically audit, deduplicate and fence revoked access',
  { timeout: 60000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
      connection = await createConnection(mongoUri).asPromise();
      const accesses = connection.model('AdminAccess', AdminAccessSchema);
      const events = connection.model('AdminAuditEvent', AdminAuditEventSchema);
      const receipts = connection.model('AdminOperation', AdminOperationSchema);
      await Promise.all([accesses.init(), events.init(), receipts.init()]);
      const audit = new AdminAuditService(events);
      const operations = new AdminOperationsService(
        connection,
        accesses,
        receipts,
        audit,
      );
      const actor = {
        uid: 'fixture-owner',
        verifiedEmail: 'owner@example.invalid',
        role: 'owner',
        permissions: [],
        accessRevision: 0,
        authTimeSec: Math.floor(Date.now() / 1000),
      };
      await accesses.create({
        uid: actor.uid,
        verifiedEmail: actor.verifiedEmail,
        role: actor.role,
        active: true,
      });
      const values = connection.db.collection('fixture_admin_changes');
      await values.insertOne({ _id: 'job-one', revision: 0 });
      const operationId = randomUUID();
      const command = {
        operationId,
        route: 'POST /admin/jobs/job-one/cancel',
        request: { expectedRevision: 0 },
        action: 'jobs.cancel',
        reason: 'Customer support request',
        resourceType: 'job',
      };
      const mutate = async (session) => {
        await values.updateOne(
          { _id: 'job-one' },
          { $inc: { revision: 1 } },
          { session },
        );
        return {
          resourceId: 'job-one',
          previousRevision: 0,
          revision: 1,
          value: { rawKey: 'fixture-one-time-secret' },
        };
      };
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const first = operations.run(actor, command, async (session) => {
        entered.resolve();
        await release.promise;
        return mutate(session);
      });
      let firstResult;
      try {
        await entered.promise;
        const pending = await operations.read(actor, operationId);
        assert.equal(pending.status, 'pending');
        assert.equal(pending.resourceId, null);
        await assert.rejects(
          operations.run(actor, command, mutate),
          (error) => error.getResponse().code === 'OPERATION_IN_PROGRESS',
        );
      } finally {
        release.resolve();
        firstResult = await first;
      }
      const results = [
        firstResult,
        await operations.run(actor, command, mutate),
      ];
      assert.equal((await values.findOne({ _id: 'job-one' })).revision, 1);
      assert.equal(results.filter((result) => result.value?.rawKey).length, 1);
      assert.equal(await events.countDocuments(), 1);
      assert.equal(await receipts.countDocuments(), 1);
      assert.equal(
        JSON.stringify(await receipts.find().lean()).includes(
          'fixture-one-time-secret',
        ),
        false,
      );
      assert.equal(
        JSON.stringify(await events.find().lean()).includes('rawKey'),
        false,
      );
      await assert.rejects(
        operations.run(
          actor,
          { ...command, request: { expectedRevision: 99 } },
          mutate,
        ),
        (error) => error.getStatus() === 409,
      );
      await assert.rejects(
        operations.read(
          { ...actor, uid: 'another', role: 'viewer' },
          operationId,
        ),
        (error) => error.getStatus() === 404,
      );

      const failingAudit = {
        record: async () => {
          throw new Error('fixture audit unavailable');
        },
      };
      const fail = new AdminOperationsService(
        connection,
        accesses,
        receipts,
        failingAudit,
      );
      const failedOperationId = randomUUID();
      await assert.rejects(
        fail.run(actor, { ...command, operationId: failedOperationId }, mutate),
      );
      assert.deepEqual(await operations.read(actor, failedOperationId), {
        operationId: failedOperationId,
        status: 'failed',
        resourceId: null,
        revision: null,
        code: 'DEPENDENCY_UNAVAILABLE',
      });
      assert.equal(
        (await values.findOne({ _id: 'job-one' })).revision,
        1,
        'audit failure rolls domain changes back',
      );
      assert.equal(await events.countDocuments(), 1);
      const expiredId = randomUUID();
      await receipts.create({
        actorUid: actor.uid,
        operationId: expiredId,
        route: command.route,
        requestHash: 'a'.repeat(64),
        status: 'pending',
        executionToken: randomUUID(),
        pendingUntil: new Date(Date.now() - 1000),
      });
      assert.deepEqual(await operations.read(actor, expiredId), {
        operationId: expiredId,
        status: 'failed',
        resourceId: null,
        revision: null,
        code: 'DEPENDENCY_UNAVAILABLE',
      });
      await accesses.updateOne(
        { uid: actor.uid },
        { $set: { active: false }, $inc: { revision: 1 } },
      );
      await assert.rejects(
        operations.run(
          actor,
          { ...command, operationId: randomUUID() },
          mutate,
        ),
        (error) => error.getStatus() === 403,
      );
      assert.equal((await values.findOne({ _id: 'job-one' })).revision, 1);
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);

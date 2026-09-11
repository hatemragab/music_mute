import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';

test(
  'concurrent owner demotions retain one active owner',
  { timeout: 30000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
      connection = await createConnection(mongoUri, {
        bufferCommands: false,
      }).asPromise();
      const [
        { AdminAccess, AdminAccessSchema },
        { AdminOwnerFence, AdminOwnerFenceSchema },
        { AdminAccessService },
        { AdminAuditEvent, AdminAuditEventSchema },
        { AdminOperation, AdminOperationSchema },
        { AdminAuditService },
        { AdminOperationsService },
      ] = await Promise.all([
        import('../dist/admin/admin-access.schema.js'),
        import('../dist/admin/admin-owner-fence.schema.js'),
        import('../dist/admin/admin-access.service.js'),
        import('../dist/admin/admin-audit.schema.js'),
        import('../dist/admin/admin-operation.schema.js'),
        import('../dist/admin/admin-audit.service.js'),
        import('../dist/admin/admin-operations.service.js'),
      ]);
      const accesses = connection.model(AdminAccess.name, AdminAccessSchema);
      const fences = connection.model(
        AdminOwnerFence.name,
        AdminOwnerFenceSchema,
      );
      const auditEvents = connection.model(
        AdminAuditEvent.name,
        AdminAuditEventSchema,
      );
      const operationRecords = connection.model(
        AdminOperation.name,
        AdminOperationSchema,
      );
      const audit = new AdminAuditService(auditEvents);
      const operations = new AdminOperationsService(
        connection,
        accesses,
        operationRecords,
        audit,
      );
      await Promise.all([
        accesses.init(),
        fences.init(),
        audit.onModuleInit(),
        operations.onModuleInit(),
      ]);
      await accesses.create([
        {
          uid: 'owner-a',
          verifiedEmail: 'a@example.test',
          role: 'owner',
          active: true,
          revision: 0,
          authorizationFence: 0,
        },
        {
          uid: 'owner-b',
          verifiedEmail: 'b@example.test',
          role: 'owner',
          active: true,
          revision: 0,
          authorizationFence: 0,
        },
      ]);
      await fences.create({ _id: 'membership', revision: 0 });
      const service = new AdminAccessService(accesses, fences, {}, operations);
      const actorA = {
        uid: 'owner-a',
        verifiedEmail: 'a@example.test',
        role: 'owner',
        permissions: ['admin.access.manage'],
        accessRevision: 0,
        authTimeSec: 1,
      };
      const actorB = {
        ...actorA,
        uid: 'owner-b',
        verifiedEmail: 'b@example.test',
      };
      const attempts = await Promise.allSettled([
        service.update(actorA, 'owner-a', {
          role: 'viewer',
          expectedRevision: 0,
          operationId: '3e838cee-77bb-48d9-9099-33895cd76915',
          reason: 'Owner A leaves',
        }),
        service.update(actorB, 'owner-b', {
          active: false,
          expectedRevision: 0,
          operationId: 'de7a6c37-645b-4ad9-90dc-2152f7a09a64',
          reason: 'Owner B leaves',
        }),
      ]);
      assert.equal(
        attempts.filter((item) => item.status === 'fulfilled').length,
        1,
      );
      assert.equal(
        attempts.filter((item) => item.status === 'rejected').length,
        1,
      );
      assert.equal(
        await accesses.countDocuments({ role: 'owner', active: true }),
        1,
      );
      assert.equal(
        await auditEvents.countDocuments({ outcome: 'succeeded' }),
        1,
      );
      assert.equal(
        await operationRecords.countDocuments({ status: 'succeeded' }),
        1,
      );
      assert.equal(
        await operationRecords.countDocuments({ status: 'failed' }),
        1,
      );
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);

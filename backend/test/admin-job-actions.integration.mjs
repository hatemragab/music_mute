import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { JobActionsService } from '../dist/jobs/job-actions.service.js';
import { AdminJobActionsService } from '../dist/admin-jobs/admin-job-actions.service.js';
import { AdminAccessSchema } from '../dist/admin/admin-access.schema.js';
import { AdminAuditEventSchema } from '../dist/admin/admin-audit.schema.js';
import { AdminOperationSchema } from '../dist/admin/admin-operation.schema.js';
import { AdminAuditService } from '../dist/admin/admin-audit.service.js';
import { AdminOperationsService } from '../dist/admin/admin-operations.service.js';
import { ProcessingUnavailableService } from '../dist/processing/processing-unavailable.service.js';

test('administrative cancellation is audited and retry is unavailable', async (t) => {
  const fixture = await IsolatedServices.create();
  t.after(() => fixture.stop());
  const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  for (const { name, schema } of PROCESSING_MODELS)
    connection.model(name, schema);
  connection.model('AdminAccess', AdminAccessSchema);
  connection.model('AdminAuditEvent', AdminAuditEventSchema);
  connection.model('AdminOperation', AdminOperationSchema);
  await Promise.all(Object.values(connection.models).map((m) => m.init()));
  const jobs = connection.model('Job');
  const access = connection.model('AdminAccess');
  const events = connection.model('AdminAuditEvent');
  const receipts = connection.model('AdminOperation');
  const actor = {
    uid: 'admin-job-actions',
    verifiedEmail: 'admin@example.invalid',
    role: 'support',
    accessRevision: 0,
    authTimeSec: 1,
    permissions: ['jobs.read', 'jobs.manage'],
  };
  await access.create({
    uid: actor.uid,
    verifiedEmail: actor.verifiedEmail,
    role: actor.role,
    active: true,
  });
  const operations = new AdminOperationsService(
    connection,
    access,
    receipts,
    new AdminAuditService(events),
  );
  const actions = new JobActionsService(
    jobs,
    new ProcessingTransactions(connection),
    { assertActive: async () => undefined },
    {},
    { settleJob: async () => undefined },
  );
  const service = new AdminJobActionsService(
    actions,
    operations,
    new ProcessingUnavailableService(),
  );
  const owner = new Types.ObjectId();
  const job = await jobs.create({
    userId: owner,
    requestId: randomUUID(),
    requestHash: 'a'.repeat(64),
    status: 'queued',
    adminRevision: 0,
    inputReservation: {
      key: `users/${owner}/jobs/fixture/input.mp3`,
      extension: 'mp3',
      contentType: 'audio/mpeg',
      bytes: 1024,
      durationSeconds: 30,
      sha256: Buffer.alloc(32).toString('base64'),
    },
  });
  const dto = {
    operationId: randomUUID(),
    expectedRevision: 0,
    reason: 'Customer support request',
  };
  const cancelled = await service.cancel(actor, job._id.toHexString(), dto);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await events.findOne().lean()).action, 'jobs.cancel');
  assert.equal((await receipts.findOne().lean()).status, 'succeeded');

  await assert.rejects(
    service.retry(actor, job._id.toHexString(), {
      ...dto,
      operationId: randomUUID(),
    }),
    (error) => error.getResponse().code === 'PROCESSING_UNAVAILABLE',
  );
});

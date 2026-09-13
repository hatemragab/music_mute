import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { accountFixture } from './helpers/account-fixture.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import {
  AdminAccess,
  AdminAccessSchema,
} from '../dist/admin/admin-access.schema.js';
import {
  AdminOperation,
  AdminOperationSchema,
} from '../dist/admin/admin-operation.schema.js';
import {
  AdminAuditEvent,
  AdminAuditEventSchema,
} from '../dist/admin/admin-audit.schema.js';
import { AdminAuditService } from '../dist/admin/admin-audit.service.js';
import { AdminOperationsService } from '../dist/admin/admin-operations.service.js';
import { AdminUsersService } from '../dist/admin-users/admin-users.service.js';
import { QueuePolicyService } from '../dist/admin-settings/queue-policy.service.js';
import { DEFAULT_QUEUE_POLICY } from '../dist/admin-settings/queue-policy.schema.js';
import {
  ProcessingSettings,
  ProcessingSettingsSchema,
} from '../dist/admin-settings/processing-settings.schema.js';
import { ProcessingSettingsService } from '../dist/admin-settings/processing-settings.service.js';

test('queue policy and account exception mutations commit with audit, revision and replay authority', async (t) => {
  const native = await IsolatedServices.create();
  t.after(() => native.stop());
  const { mongoUri } = await native.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  for (const { name, schema } of [
    ...PROCESSING_MODELS,
    { name: AdminAccess.name, schema: AdminAccessSchema },
    { name: AdminOperation.name, schema: AdminOperationSchema },
    { name: AdminAuditEvent.name, schema: AdminAuditEventSchema },
    { name: ProcessingSettings.name, schema: ProcessingSettingsSchema },
  ])
    connection.model(name, schema);
  await Promise.all(Object.values(connection.models).map((m) => m.init()));
  const owner = new Types.ObjectId();
  const { users, identities } = await accountFixture(connection, [
    owner.toString(),
  ]);
  const audit = new AdminAuditService(connection.model(AdminAuditEvent.name));
  const operations = new AdminOperationsService(
    connection,
    connection.model(AdminAccess.name),
    connection.model(AdminOperation.name),
    audit,
  );
  const actor = {
    uid: 'fixture-admin',
    role: 'owner',
    accessRevision: 0,
    permissions: ['settings.manage', 'users.processing.manage'],
  };
  await connection.model(AdminAccess.name).create({
    uid: actor.uid,
    verifiedEmail: 'fixture-admin@example.invalid',
    role: 'owner',
    active: true,
    revision: 0,
  });
  const fences = connection.model('ProcessingAdmissionFence');
  const policy = new QueuePolicyService(
    connection.model('ProcessingQueuePolicy'),
    fences,
    operations,
  );
  const update = {
    ...DEFAULT_QUEUE_POLICY,
    schemaVersion: 2,
    maxOutstandingJobs: 3,
    expectedRevision: 0,
    operationId: randomUUID(),
    reason: 'Isolated fixture policy',
    qualification: null,
  };
  assert.equal((await policy.update(actor, update)).revision, 1);
  assert.equal(
    (await policy.update(actor, update)).revision,
    1,
    'replay must not increment policy',
  );
  await assert.rejects(
    policy.update(actor, { ...update, operationId: randomUUID() }),
    (e) => e.getResponse().code === 'REVISION_CONFLICT',
  );
  assert.equal(
    await connection.model(AdminAuditEvent.name).countDocuments({
      action: 'settings.processing-v2.update',
      outcome: 'succeeded',
    }),
    1,
  );
  const legacy = new ProcessingSettingsService(
    connection.model(ProcessingSettings.name),
    fences,
    operations,
    new ConfigService({ AUDIO_PROCESSING_ENABLED: true }),
    policy,
  );
  assert.equal((await legacy.publicPolicy('2')).revision, 1);
  await legacy.update(actor, {
    acceptNewJobs: true,
    maintenanceMessageEn: '',
    maintenanceMessageAr: null,
    maxInputBytesExclusive: 30000000,
    maxDurationSecondsExclusive: 600,
    maxActiveJobsPerUser: null,
    expectedRevision: 0,
    operationId: randomUUID(),
    reason: 'Isolated legacy edit',
  });
  assert.equal(
    (await legacy.publicPolicy('2')).revision,
    2,
    'v2 revision includes legacy switch changes',
  );
  const adminUsers = new AdminUsersService(
    users,
    connection.model('Job'),
    fences,
    identities,
    operations,
  );
  const allowance = {
    expectedRevision: 0,
    operationId: randomUUID(),
    reason: 'Isolated support exception',
    allowanceAudioSeconds: 7200,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  assert.equal(
    (await adminUsers.changeAllowance(actor, owner.toString(), allowance))
      .revision,
    1,
  );
  assert.equal(
    (await adminUsers.processingUsage(owner.toString())).allowanceAudioSeconds,
    7200,
  );
  assert.equal(
    (await adminUsers.processingUsage(owner.toString())).policyRevision,
    2,
  );
  await adminUsers.changeAllowance(actor, owner.toString(), allowance);
  const allowanceAudit = await connection
    .model(AdminAuditEvent.name)
    .findOne({ action: 'users.processing.allowance.update' })
    .lean();
  assert.deepEqual(allowanceAudit.processingChanges, [
    { field: 'allowanceAudioSeconds', before: null, after: 7200 },
    { field: 'allowanceExpiresAt', before: null, after: allowance.expiresAt },
  ]);

  assert.equal(
    await connection.model(AdminAuditEvent.name).countDocuments({
      action: 'users.processing.allowance.update',
      outcome: 'succeeded',
    }),
    1,
  );
  await users.updateOne(
    { _id: owner },
    { $set: { processingAllowanceExpiresAt: new Date(Date.now() - 1) } },
  );
  assert.equal(
    (await adminUsers.processingUsage(owner.toString())).allowanceAudioSeconds,
    3600,
  );
  await adminUsers.changeAllowance(
    actor,
    owner.toString(),
    {
      expectedRevision: 1,
      operationId: randomUUID(),
      reason: 'Revoke fixture exception',
    },
    true,
  );
  assert.equal(
    (await adminUsers.processingUsage(owner.toString())).allowanceOverride,
    null,
  );
});

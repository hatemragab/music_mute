import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { accountFixture } from './helpers/account-fixture.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingUsageService } from '../dist/processing-usage/processing-usage.service.js';
import { AccountPolicyService } from '../dist/admin-settings/account-policy.service.js';
import {
  AccountPolicySchema,
  AccountPolicyOverrideSchema,
} from '../dist/admin-settings/account-policy.schema.js';
import { AdminUsersService } from '../dist/admin-users/admin-users.service.js';
import { AdminOperationsService } from '../dist/admin/admin-operations.service.js';
import { AdminAuditService } from '../dist/admin/admin-audit.service.js';
import { AdminAccessSchema } from '../dist/admin/admin-access.schema.js';
import { AdminOperationSchema } from '../dist/admin/admin-operation.schema.js';
import { AdminAuditEventSchema } from '../dist/admin/admin-audit.schema.js';
import { MediaImportSchema } from '../dist/url-imports/media-import.schema.js';
import {
  utcMonthPeriod,
  utcDayPeriod,
  usagePeriodId,
} from '../dist/processing-usage/usage-accounting.js';

test(
  'account reset is atomic, audited, idempotent and preserves storage/history/other accounts',
  { timeout: 60000 },
  async (t) => {
    const native = await IsolatedServices.create();
    t.after(() => native.stop());
    const { mongoUri } = await native.startDatabases({ replicaSet: true });
    const connection = await createConnection(mongoUri).asPromise();
    t.after(() => connection.close());
    connection.options = { ...connection.options, sanitizeFilter: true };
    for (const { name, schema } of PROCESSING_MODELS)
      connection.model(name, schema);
    for (const [name, schema] of Object.entries({
      AccountPolicy: AccountPolicySchema,
      AccountPolicyOverride: AccountPolicyOverrideSchema,
      AdminAccess: AdminAccessSchema,
      AdminOperation: AdminOperationSchema,
      AdminAuditEvent: AdminAuditEventSchema,
      MediaImport: MediaImportSchema,
    }))
      connection.model(name, schema);
    const owner = new Types.ObjectId();
    const other = new Types.ObjectId();
    const { users } = await accountFixture(connection, [
      owner.toString(),
      other.toString(),
    ]);
    await Promise.all(
      Object.values(connection.models).map((model) => model.init()),
    );
    const model = (name) => connection.model(name);
    const operations = new AdminOperationsService(
      connection,
      model('AdminAccess'),
      model('AdminOperation'),
      new AdminAuditService(model('AdminAuditEvent')),
    );
    const actor = {
      uid: 'reset-admin',
      verifiedEmail: 'reset@example.test',
      role: 'support',
      permissions: ['users.processing.manage'],
      accessRevision: 0,
      authTimeSec: Math.floor(Date.now() / 1000),
    };
    await model('AdminAccess').create({
      uid: actor.uid,
      verifiedEmail: actor.verifiedEmail,
      role: actor.role,
    });
    const policy = new AccountPolicyService(
      model('AccountPolicy'),
      model('AccountPolicyOverride'),
      model('ProcessingAdmissionFence'),
      users,
      operations,
      new ConfigService({ AUDIO_PROCESSING_ENABLED: true }),
    );
    const usage = new ProcessingUsageService(
      ...[
        'AccountUsagePeriod',
        'AccountDailyUsagePeriod',
        'ProcessingReservation',
        'UploadGrantReceipt',
        'DownloadGrantReceipt',
        'ServiceUsagePeriod',
        'Job',
      ].map(model),
      users,
      policy,
    );
    const service = new AdminUsersService(
      users,
      model('Job'),
      usage,
      policy,
      operations,
      model('MediaImport'),
      model('ProcessingAdmissionFence'),
    );
    const now = new Date();
    const month = utcMonthPeriod(now);
    const day = utcDayPeriod(now);
    const periodId = usagePeriodId(owner, month.key);
    const dayId = usagePeriodId(owner, day.key);
    const counters = {
      processingUsedSeconds: 500,
      processingReleasedSeconds: 90,
      uploadGrants: 9,
      confirmedUploadBytes: 1000,
      downloadGrants: 7,
      estimatedDownloadBytes: 2000,
    };
    for (const accountId of [owner, other])
      await model('AccountUsagePeriod').create({
        _id: usagePeriodId(accountId, month.key),
        accountId,
        periodKey: month.key,
        ...counters,
        revision: 4,
        lastMutationAt: now,
      });
    await model('AccountUsagePeriod').create({
      _id: usagePeriodId(owner, '2025-01'),
      accountId: owner,
      periodKey: '2025-01',
      ...counters,
      lastMutationAt: now,
    });
    await model('AccountDailyUsagePeriod').create({
      _id: dayId,
      accountId: owner,
      dayKey: day.key,
      uploadGrants: 3,
      revision: 2,
      lastMutationAt: now,
      purgeAt: day.purgeAt,
    });
    await users.updateOne(
      { _id: owner },
      { $set: { retainedOutputBytes: 3210 } },
    );
    await model('ServiceUsagePeriod').create({
      _id: month.key,
      periodKey: month.key,
      estimatedOutboundBytes: 9876,
      lastMutationAt: now,
      purgeAt: month.purgeAt,
    });
    const command = (extra = {}) => ({
      expectedRevision: 4,
      periodKey: month.key,
      dayKey: day.key,
      operationId: randomUUID(),
      reason: 'Synthetic reset test',
      ...extra,
    });
    const rejected = async (input, code) =>
      assert.rejects(
        service.resetUsage(actor, owner.toString(), input),
        (error) => error.getResponse().code === code,
      );
    await rejected(command({ expectedRevision: 3 }), 'REVISION_CONFLICT');
    await rejected(command({ dayKey: '2025-01-01' }), 'REVISION_CONFLICT');
    await rejected(command({ periodKey: '2025-01' }), 'REVISION_CONFLICT');
    const holdId = new Types.ObjectId();
    await model('ProcessingReservation').create({
      _id: holdId,
      accountId: owner,
      periodKey: month.key,
      processingSeconds: 30,
      state: 'reserved',
      globalPolicyRevision: 0,
      acceptedLimitSeconds: 7200,
      createdAt: now,
    });
    await rejected(command(), 'USAGE_RESET_ACTIVE_WORK');
    await model('ProcessingReservation').updateOne(
      { _id: holdId },
      { $set: { state: 'released' } },
    );
    // Synthetic minimal active records exercise the guard without provider/storage calls.
    const importId = new Types.ObjectId();
    await model('MediaImport').collection.insertOne({
      _id: importId,
      userId: owner,
      status: 'queued',
    });
    await rejected(command(), 'USAGE_RESET_ACTIVE_WORK');
    await model('MediaImport').collection.updateOne(
      { _id: importId },
      { $set: { status: 'failed' } },
    );
    const jobId = new Types.ObjectId();
    await model('Job').collection.insertOne({
      _id: jobId,
      userId: owner,
      status: 'queued',
      deletedAt: null,
    });
    await rejected(command(), 'USAGE_RESET_ACTIVE_WORK');
    await model('Job').collection.updateOne(
      { _id: jobId },
      { $set: { status: 'ready' } },
    );
    const request = command();
    const result = await service.resetUsage(actor, owner.toString(), request);
    assert.equal(result.processing.usedSeconds, 0);
    assert.equal(result.processing.releasedSeconds, 0);
    assert.equal(result.processing.reservedSeconds, 0);
    assert.equal(result.uploads.dailyGrants, 0);
    assert.equal(result.uploads.monthlyGrants, 0);
    assert.equal(result.uploads.confirmedBytes, 0);
    assert.equal(result.downloads.monthlyGrants, 0);
    assert.equal(result.downloads.estimatedBytes, 0);
    assert.equal(result.storage.retainedBytes, 3210);
    assert.equal(result.usageRevision, 5);
    assert.equal(
      (
        await model('AccountUsagePeriod').findById(
          usagePeriodId(other, month.key),
        )
      ).processingUsedSeconds,
      500,
    );
    assert.equal(
      (
        await model('AccountUsagePeriod').findById(
          usagePeriodId(owner, '2025-01'),
        )
      ).processingUsedSeconds,
      500,
    );
    assert.equal(
      (await model('ServiceUsagePeriod').findById(month.key))
        .estimatedOutboundBytes,
      9876,
    );
    assert.equal(await model('Job').countDocuments({ userId: owner }), 1);
    const audit = await model('AdminAuditEvent')
      .findOne({ action: 'users.account_usage.reset' })
      .lean();
    assert.equal(audit.reason, request.reason);
    assert.ok(
      audit.processingChanges.some(
        (change) =>
          change.field === 'processingUsedSeconds' &&
          change.before === 500 &&
          change.after === 0,
      ),
    );
    await model('AccountUsagePeriod').updateOne(
      { _id: periodId },
      { $inc: { processingUsedSeconds: 20, revision: 1 } },
    );
    const replay = await service.resetUsage(actor, owner.toString(), request);
    assert.equal(replay.processing.usedSeconds, 20);
    assert.equal(
      await model('AdminAuditEvent').countDocuments({
        action: 'users.account_usage.reset',
      }),
      1,
    );
    // Two confirmations of the same revision cannot both commit.
    const races = await Promise.allSettled([
      service.resetUsage(
        actor,
        owner.toString(),
        command({ expectedRevision: 6 }),
      ),
      service.resetUsage(
        actor,
        owner.toString(),
        command({ expectedRevision: 6 }),
      ),
    ]);
    assert.equal(races.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(races.filter((r) => r.status === 'rejected').length, 1);
    // No existing period is also a supported reset, without touching another account.
    const empty = new Types.ObjectId();
    await accountFixture(connection, [empty.toString()]);
    assert.equal(
      (
        await service.resetUsage(
          actor,
          empty.toString(),
          command({ expectedRevision: 0 }),
        )
      ).usageRevision,
      1,
    );
  },
);

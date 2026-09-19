import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ConfigService } from '@nestjs/config';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { accountFixture } from './helpers/account-fixture.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { ProcessingUsageService } from '../dist/processing-usage/processing-usage.service.js';
import {
  AccountPolicy,
  AccountPolicyOverride,
  AccountPolicyOverrideSchema,
  AccountPolicySchema,
  DEFAULT_ACCOUNT_POLICY_VALUES,
} from '../dist/admin-settings/account-policy.schema.js';

const createJob = (jobs, owner, durationSeconds) =>
  jobs.create({
    userId: owner,
    requestId: randomUUID(),
    requestHash: randomUUID().replaceAll('-', '').padEnd(64, 'a'),
    status: 'queued',
    inputReservation: {
      key: `users/${owner}/jobs/${randomUUID()}/input.mp3`,
      extension: 'mp3',
      contentType: 'audio/mpeg',
      bytes: 1024,
      durationSeconds,
      sha256: Buffer.alloc(32).toString('base64'),
    },
  });

test('UTC-month reservations are idempotent, bounded, and fully released on failure', async (t) => {
  const native = await IsolatedServices.create();
  t.after(() => native.stop());
  const { mongoUri } = await native.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  for (const { name, schema } of [
    ...PROCESSING_MODELS,
    { name: AccountPolicy.name, schema: AccountPolicySchema },
    { name: AccountPolicyOverride.name, schema: AccountPolicyOverrideSchema },
  ])
    connection.model(name, schema);
  const owner = new Types.ObjectId();
  const { users } = await accountFixture(connection, [owner.toString()]);
  await Promise.all(
    Object.values(connection.models).map((model) => model.init()),
  );

  const jobs = connection.model('Job');
  const periods = connection.model('AccountUsagePeriod');
  const reservations = connection.model('ProcessingReservation');
  const policies = connection.model(AccountPolicy.name);
  const overrides = connection.model(AccountPolicyOverride.name);
  const fences = connection.model('ProcessingAdmissionFence');
  const policy = new (
    await import('../dist/admin-settings/account-policy.service.js')
  ).AccountPolicyService(
    policies,
    overrides,
    fences,
    users,
    {},
    new ConfigService({ AUDIO_PROCESSING_ENABLED: true }),
  );
  const usage = new ProcessingUsageService(
    periods,
    reservations,
    jobs,
    users,
    policy,
    new ConfigService({ AUDIO_PROCESSING_ENABLED: true }),
  );
  const transactions = new ProcessingTransactions(connection);
  const job = await createJob(jobs, owner, 30);

  await transactions.run(async (session) => {
    await usage.reserveForJob(
      job._id,
      owner,
      29.1,
      session,
      new Date('2026-09-30T23:59:59.000Z'),
    );
    await usage.reserveForJob(
      job._id,
      owner,
      29.1,
      session,
      new Date('2026-09-30T23:59:59.000Z'),
    );
  });
  const reserved = await usage.readUsage(
    owner,
    undefined,
    new Date('2026-09-30T23:59:59.000Z'),
  );
  assert.equal(reserved.period.key, '2026-09');
  assert.equal(reserved.processing.limitSeconds, 7_200);
  assert.equal(reserved.processing.reservedSeconds, 30);
  assert.equal(reserved.processing.remainingSeconds, 7_170);
  assert.equal(await reservations.countDocuments(), 1);
  const openPeriod = await periods.findOne({
    accountId: owner,
    periodKey: '2026-09',
  });
  assert.equal(openPeriod.processingReservationCount, 1);
  assert.equal(openPeriod.purgeAt, null);

  await transactions.run(async (session) => {
    const failed = await jobs.findById(job._id).session(session);
    failed.status = 'failed';
    failed.finishedAt = new Date();
    await failed.save({ session });
    await usage.settleJob(failed, session);
    await usage.settleJob(failed, session);
  });
  const released = await usage.readUsage(
    owner,
    undefined,
    new Date('2026-09-30T23:59:59.000Z'),
  );
  assert.equal(released.processing.reservedSeconds, 0);
  assert.equal(released.processing.releasedSeconds, 30);
  assert.equal(released.processing.remainingSeconds, 7_200);
  assert.equal((await reservations.findById(job._id)).state, 'released');
  const closedPeriod = await periods.findOne({
    accountId: owner,
    periodKey: '2026-09',
  });
  assert.equal(closedPeriod.processingReservationCount, 0);
  assert.equal(closedPeriod.purgeAt.toISOString(), '2027-10-01T00:00:00.000Z');

  const nextMonth = await usage.readUsage(
    owner,
    undefined,
    new Date('2026-10-01T00:00:00.000Z'),
  );
  assert.equal(nextMonth.period.key, '2026-10');
  assert.equal(nextMonth.processing.remainingSeconds, 7_200);

  const successfulJob = await createJob(jobs, owner, 20);
  const october = new Date('2026-10-01T00:00:01.000Z');
  await transactions.run(async (session) => {
    await usage.reserveForJob(successfulJob._id, owner, 20, session, october);
    const ready = await jobs.findById(successfulJob._id).session(session);
    await usage.reconcileMeasured(ready, 25.1, session);
    ready.status = 'ready';
    ready.finishedAt = october;
    await ready.save({ session });
    await usage.settleJob(ready, session, october);
    await usage.settleJob(ready, session, october);
  });
  const consumed = await usage.readUsage(owner, undefined, october);
  assert.equal(consumed.processing.usedSeconds, 26);
  assert.equal(consumed.processing.reservedSeconds, 0);
  assert.equal(consumed.processing.remainingSeconds, 7_174);
  assert.equal((await reservations.findById(successfulJob._id)).state, 'used');

  await policies.create({
    _id: 'standard',
    revision: 1,
    acceptNewJobs: true,
    maintenanceMessageEn: '',
    maintenanceMessageAr: null,
    ...DEFAULT_ACCOUNT_POLICY_VALUES,
    monthlyProcessingSeconds: 60,
    updatedBy: 'fixture-admin',
    updatedAt: new Date(),
  });
  const first = await createJob(jobs, owner, 40);
  const second = await createJob(jobs, owner, 40);
  const outcomes = await Promise.allSettled([
    transactions.run((session) =>
      usage.reserveForJob(first._id, owner, 40, session),
    ),
    transactions.run((session) =>
      usage.reserveForJob(second._id, owner, 40, session),
    ),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'rejected').length,
    1,
  );
  const current = await usage.readUsage(owner);
  assert.equal(current.processing.reservedSeconds, 40);
  assert.equal(current.processing.remainingSeconds, 20);

  const secondAccount = new Types.ObjectId();
  await users.create({
    _id: secondAccount,
    firebaseUid: `fixture-${secondAccount}`,
    displayName: 'Second Account',
    nameSource: 'numeric_alias',
    profileSyncedAt: new Date(),
    lastSeenAt: new Date(),
  });
  const independent = await usage.readUsage(secondAccount);
  assert.equal(independent.processing.limitSeconds, 60);
  assert.equal(independent.processing.usedSeconds, 0);
  assert.equal(independent.processing.reservedSeconds, 0);
  assert.equal(independent.processing.remainingSeconds, 60);

  await overrides.create({
    _id: new Types.ObjectId(),
    accountId: owner,
    monthlyProcessingSeconds: 10,
    expiresAt: null,
    reason: 'Fixture reduction below already reserved usage',
    createdBy: 'fixture-admin',
    updatedBy: 'fixture-admin',
    createdAt: new Date(),
    updatedAt: new Date(),
    revision: 1,
  });
  const reduced = await usage.readUsage(owner);
  assert.equal(reduced.effectivePolicySource, 'account_override');
  assert.equal(reduced.processing.limitSeconds, 10);
  assert.equal(reduced.processing.reservedSeconds, 40);
  assert.equal(reduced.processing.remainingSeconds, 0);
  assert.deepEqual(reduced.availability, {
    status: 'blocked',
    reason: 'monthly_limit_reached',
  });
});

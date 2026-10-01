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
import { ProcessingUsageMaintenanceService } from '../dist/processing-usage/processing-usage-maintenance.service.js';
import { AccountUsagePeriodSchema } from '../dist/processing-usage/processing-usage.schema.js';
import { ProcessingAdmissionService } from '../dist/admin-settings/processing-admission.service.js';
import {
  AccountPolicy,
  AccountPolicyOverride,
  AccountPolicyOverrideSchema,
  AccountPolicySchema,
  DEFAULT_ACCOUNT_POLICY_VALUES,
} from '../dist/admin-settings/account-policy.schema.js';

const createJob = (
  jobs,
  owner,
  durationSeconds,
  logicalAudioId = null,
  maxClientInputAttempts = 5,
) => {
  const id = new Types.ObjectId();
  return jobs.create({
    _id: id,
    userId: owner,
    logicalAudioId: logicalAudioId ?? id,
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
    admissionSnapshot: {
      policyVersion: 2,
      maxDurationSeconds: 1_200,
      maxInputBytes: 50_000_000,
      preparationProfileId: 'audio-cap-aac-lc-160-v1',
      source: 'audio_file',
      settingsRevision: 0,
      maxWaitingJobs: 3,
      maxProcessingJobs: 1,
      maxInfrastructureAttempts: 3,
      maxClientInputAttempts,
      reservationExpiresAt: new Date('2026-12-01T00:00:00.000Z'),
    },
  });
};

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
  const dailyPeriods = connection.model('AccountDailyUsagePeriod');
  const reservations = connection.model('ProcessingReservation');
  const uploadGrants = connection.model('UploadGrantReceipt');
  const downloadGrants = connection.model('DownloadGrantReceipt');
  const servicePeriods = connection.model('ServiceUsagePeriod');
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
  await policies.create({
    _id: 'standard',
    revision: 1,
    acceptNewJobs: true,
    maintenanceMessageEn: '',
    maintenanceMessageAr: null,
    ...DEFAULT_ACCOUNT_POLICY_VALUES,
    dailyUploadGrants: 2,
    monthlyUploadGrants: 3,
    monthlyConfirmedUploadBytes: 1_500,
    monthlyDownloadGrants: 3,
    monthlyEstimatedDownloadBytes: 2_500,
    monthlyServiceOutboundBytes: 3_000,
    maxClientInputAttempts: 3,
    updatedBy: 'fixture-admin',
    updatedAt: new Date(),
  });
  const usage = new ProcessingUsageService(
    periods,
    dailyPeriods,
    reservations,
    uploadGrants,
    downloadGrants,
    servicePeriods,
    jobs,
    users,
    policy,
    new ConfigService({ AUDIO_PROCESSING_ENABLED: true }),
  );
  const transactions = new ProcessingTransactions(connection);
  const job = await createJob(jobs, owner, 30, null, 3);

  const firstGrantId = randomUUID();
  const septemberDayOne = new Date('2026-09-10T12:00:00.000Z');
  await transactions.run(async (session) => {
    await usage.reserveUploadGrant(job, firstGrantId, session, septemberDayOne);
    await usage.reserveUploadGrant(job, firstGrantId, session, septemberDayOne);
  });
  assert.equal(await uploadGrants.countDocuments(), 1);
  assert.equal((await jobs.findById(job._id)).uploadAttemptCount, 1);
  assert.equal(
    (
      await periods.findOne({ accountId: owner, periodKey: '2026-09' })
    ).purgeAt.toISOString(),
    '2027-10-01T00:00:00.000Z',
  );

  const concurrent = await Promise.allSettled([
    transactions.run((session) =>
      usage.reserveUploadGrant(job, randomUUID(), session, septemberDayOne),
    ),
    transactions.run((session) =>
      usage.reserveUploadGrant(job, randomUUID(), session, septemberDayOne),
    ),
  ]);
  assert.equal(
    concurrent.filter((outcome) => outcome.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    concurrent.filter((outcome) => outcome.status === 'rejected').length,
    1,
  );
  assert.equal((await jobs.findById(job._id)).uploadAttemptCount, 2);
  assert.equal(await uploadGrants.countDocuments(), 2);

  const septemberDayTwo = new Date('2026-09-11T12:00:00.000Z');
  await transactions.run((session) =>
    usage.reserveUploadGrant(job, randomUUID(), session, septemberDayTwo),
  );
  const uploadOctober = new Date('2026-10-01T00:00:01.000Z');
  const octoberJob = await createJob(jobs, owner, 30);
  await transactions.run((session) =>
    usage.reserveUploadGrant(octoberJob, randomUUID(), session, uploadOctober),
  );
  const octoberUsage = await usage.readUsage(owner, undefined, uploadOctober);
  assert.equal(octoberUsage.uploads.dailyGrants, 1);
  assert.equal(octoberUsage.uploads.monthlyGrants, 1);
  assert.equal(octoberUsage.uploads.dailyResetAt, '2026-10-02T00:00:00.000Z');

  const sameLogicalAudio = await createJob(
    jobs,
    owner,
    30,
    job.logicalAudioId,
    3,
  );
  await assert.rejects(
    transactions.run((session) =>
      usage.reserveUploadGrant(
        sameLogicalAudio,
        randomUUID(),
        session,
        uploadOctober,
      ),
    ),
    (error) => error.getResponse().code === 'UPLOAD_ATTEMPT_LIMIT_REACHED',
  );
  assert.equal((await jobs.findById(job._id)).uploadAttemptCount, 3);
  assert.equal(
    (await jobs.findById(sameLogicalAudio._id)).uploadAttemptCount,
    0,
  );
  assert.equal(await uploadGrants.countDocuments(), 4);

  await transactions.run(async (session) => {
    const current = await jobs.findById(job._id).session(session);
    await usage.confirmUploadBytes(current, 1_024, session, septemberDayTwo);
    await usage.confirmUploadBytes(current, 1_024, session, septemberDayTwo);
  });
  const overLimitJob = await createJob(jobs, owner, 30);
  await assert.rejects(
    transactions.run(async (session) => {
      const current = await jobs.findById(overLimitJob._id).session(session);
      await usage.confirmUploadBytes(current, 1_024, session, septemberDayTwo);
    }),
    (error) => error.getResponse().code === 'UPLOAD_BYTE_LIMIT_REACHED',
  );
  const uploadUsage = await usage.readUsage(owner, undefined, septemberDayTwo);
  assert.equal(
    (
      await periods.findOne({ accountId: owner, periodKey: '2026-09' })
    ).purgeAt.toISOString(),
    '2027-10-01T00:00:00.000Z',
  );
  assert.deepEqual(uploadUsage.uploads, {
    dailyGrantLimit: 2,
    dailyGrants: 1,
    dailyRemainingGrants: 1,
    dailyResetAt: '2026-09-12T00:00:00.000Z',
    monthlyGrantLimit: 3,
    monthlyGrants: 3,
    monthlyRemainingGrants: 0,
    monthlyByteLimit: 1_500,
    confirmedBytes: 1_024,
    monthlyRemainingBytes: 476,
    monthlyResetAt: '2026-10-01T00:00:00.000Z',
  });

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
  assert.equal(reserved.processing.limitSeconds, 36_000);
  assert.equal(reserved.processing.reservedSeconds, 30);
  assert.equal(reserved.processing.remainingSeconds, 35_970);
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
  assert.equal(released.processing.remainingSeconds, 36_000);
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
  assert.equal(nextMonth.processing.remainingSeconds, 36_000);

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
  assert.equal(consumed.processing.remainingSeconds, 35_974);
  assert.equal((await reservations.findById(successfulJob._id)).state, 'used');

  await policies.updateOne(
    { _id: 'standard' },
    {
      $set: { monthlyProcessingSeconds: 60, updatedAt: new Date() },
      $inc: { revision: 1 },
    },
  );
  const first = await createJob(jobs, owner, 40);
  const second = await createJob(jobs, owner, 40);
  // Keep this allowance scenario separate from the consumed October fixture.
  const quotaDate = new Date('2026-11-01T00:00:01.000Z');
  const outcomes = await Promise.allSettled([
    transactions.run((session) =>
      usage.reserveForJob(first._id, owner, 40, session, quotaDate),
    ),
    transactions.run((session) =>
      usage.reserveForJob(second._id, owner, 40, session, quotaDate),
    ),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    2,
  );
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'rejected').length,
    0,
  );
  const current = await usage.readUsage(owner, undefined, quotaDate);
  assert.equal(current.processing.reservedSeconds, 80);
  assert.equal(current.processing.remainingSeconds, 0);

  const secondAccount = new Types.ObjectId();
  await users.create({
    _id: secondAccount,
    firebaseUid: `fixture-${secondAccount}`,
    displayName: 'Second Account',
    emailVerified: true,
    nameSource: 'numeric_alias',
    profileSyncedAt: new Date(),
    lastSeenAt: new Date(),
  });
  const independent = await usage.readUsage(secondAccount);
  assert.equal(independent.processing.limitSeconds, 60);
  assert.equal(independent.processing.usedSeconds, 0);
  assert.equal(independent.processing.reservedSeconds, 0);
  assert.equal(independent.processing.remainingSeconds, 60);
  assert.deepEqual(independent.storage, {
    limitBytes: 5_000_000_000,
    retainedBytes: 0,
    remainingBytes: 5_000_000_000,
  });

  const retainedObject = {
    key: `users/${secondAccount}/jobs/output/vocals.mp3`,
    etag: '"retained-v1"',
    bytes: 5_000_000_001,
    sha256: Buffer.alloc(32, 2).toString('base64'),
    contentType: 'audio/mpeg',
  };
  await transactions.run((session) =>
    usage.recordRetainedOutput(
      {
        userId: secondAccount,
        outputObject: null,
        retainedOutputAccountedAt: null,
        retainedOutputReleasedAt: null,
      },
      retainedObject.bytes,
      session,
    ),
  );
  const overStorage = await usage.readUsage(secondAccount);
  assert.equal(overStorage.storage.retainedBytes, retainedObject.bytes);
  assert.deepEqual(overStorage.availability, {
    status: 'blocked',
    reason: 'storage_limit_reached',
  });
  await assert.rejects(
    transactions.run((session) =>
      usage.assertRetainedCapacity(
        secondAccount,
        DEFAULT_ACCOUNT_POLICY_VALUES.maxRetainedOutputBytes,
        session,
      ),
    ),
    (error) => error.getResponse().code === 'RETAINED_STORAGE_LIMIT_REACHED',
  );
  await transactions.run((session) =>
    usage.releaseRetainedOutput(
      {
        userId: secondAccount,
        outputObject: retainedObject,
        retainedOutputAccountedAt: new Date(),
        retainedOutputReleasedAt: null,
      },
      session,
    ),
  );
  assert.equal((await usage.readUsage(secondAccount)).storage.retainedBytes, 0);

  const downloadJob = await createJob(jobs, secondAccount, 30);
  const septemberDownload = new Date('2026-09-12T12:00:00.000Z');
  const firstDownloadRequest = randomUUID();
  const firstResult = { etag: '"result-v1"', bytes: 1_000 };
  const reserveFirstResult = () =>
    transactions.run((session) =>
      usage.reserveDownloadGrant(
        {
          accountId: secondAccount,
          jobId: downloadJob._id,
          scope: 'user_result',
          requestId: firstDownloadRequest,
          object: firstResult,
        },
        session,
        septemberDownload,
      ),
    );
  const concurrentReplay = await Promise.allSettled([
    reserveFirstResult(),
    reserveFirstResult(),
  ]);
  assert.equal(
    concurrentReplay.filter((outcome) => outcome.status === 'fulfilled').length,
    2,
  );
  assert.equal(
    (
      await periods.findOne({ accountId: secondAccount, periodKey: '2026-09' })
    ).purgeAt.toISOString(),
    '2027-10-01T00:00:00.000Z',
  );
  await transactions.run((session) =>
    usage.reserveDownloadGrant(
      {
        accountId: secondAccount,
        jobId: downloadJob._id,
        scope: 'user_result',
        requestId: firstDownloadRequest,
        object: firstResult,
      },
      session,
      septemberDownload,
    ),
  );
  await assert.rejects(
    transactions.run((session) =>
      usage.reserveDownloadGrant(
        {
          accountId: secondAccount,
          jobId: downloadJob._id,
          scope: 'user_result',
          requestId: firstDownloadRequest,
          object: { etag: '"result-v2"', bytes: 1_000 },
        },
        session,
        septemberDownload,
      ),
    ),
    (error) => error.getResponse().code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(await downloadGrants.countDocuments(), 1);
  assert.equal(
    (await servicePeriods.findById('2026-09')).estimatedOutboundBytes,
    1_000,
  );

  const downloadRace = await Promise.allSettled([
    transactions.run((session) =>
      usage.reserveDownloadGrant(
        {
          accountId: secondAccount,
          jobId: downloadJob._id,
          scope: 'user_result',
          requestId: randomUUID(),
          object: { etag: '"result-v2"', bytes: 1_500 },
        },
        session,
        septemberDownload,
      ),
    ),
    transactions.run((session) =>
      usage.reserveDownloadGrant(
        {
          accountId: secondAccount,
          jobId: downloadJob._id,
          scope: 'user_result',
          requestId: randomUUID(),
          object: { etag: '"result-v2"', bytes: 1_500 },
        },
        session,
        septemberDownload,
      ),
    ),
  ]);
  assert.equal(
    downloadRace.filter((outcome) => outcome.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    downloadRace.filter(
      (outcome) =>
        outcome.status === 'rejected' &&
        outcome.reason.getResponse().code === 'DOWNLOAD_BYTE_LIMIT_REACHED',
    ).length,
    1,
  );

  const userInputRequest = randomUUID();
  await transactions.run((session) =>
    usage.reserveDownloadGrant(
      {
        accountId: secondAccount,
        jobId: downloadJob._id,
        scope: 'user_input',
        requestId: userInputRequest,
        object: { etag: '"input-v1"', bytes: 200 },
      },
      session,
      septemberDownload,
    ),
  );
  const workerInputRequest = randomUUID();
  const attemptId = randomUUID();
  await transactions.run(async (session) => {
    await usage.reserveDownloadGrant(
      {
        accountId: secondAccount,
        jobId: downloadJob._id,
        scope: 'worker_input',
        requestId: workerInputRequest,
        attemptId,
        object: { etag: '"input-v1"', bytes: 300 },
      },
      session,
      septemberDownload,
    );
    await usage.reserveDownloadGrant(
      {
        accountId: secondAccount,
        jobId: downloadJob._id,
        scope: 'worker_input',
        requestId: workerInputRequest,
        attemptId,
        object: { etag: '"input-v1"', bytes: 300 },
      },
      session,
      septemberDownload,
    );
  });
  const septemberDownloads = (
    await usage.readUsage(secondAccount, undefined, septemberDownload)
  ).downloads;
  assert.deepEqual(septemberDownloads, {
    monthlyGrantLimit: 3,
    monthlyGrants: 2,
    monthlyRemainingGrants: 1,
    monthlyByteLimit: 2_500,
    estimatedBytes: 2_500,
    monthlyRemainingBytes: 0,
    monthlyResetAt: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(
    (await servicePeriods.findById('2026-09')).estimatedOutboundBytes,
    3_000,
  );
  await assert.rejects(
    transactions.run((session) =>
      usage.reserveDownloadGrant(
        {
          accountId: secondAccount,
          jobId: downloadJob._id,
          scope: 'worker_input',
          requestId: randomUUID(),
          attemptId,
          object: { etag: '"input-v1"', bytes: 1 },
        },
        session,
        septemberDownload,
      ),
    ),
    (error) => error.getResponse().code === 'SERVICE_BANDWIDTH_LIMIT_REACHED',
  );
  await assert.rejects(
    transactions.run((session) =>
      usage.reserveDownloadGrant(
        {
          accountId: secondAccount,
          jobId: downloadJob._id,
          scope: 'user_input',
          requestId: userInputRequest,
          object: { etag: '"input-v1"', bytes: 200 },
        },
        session,
        new Date('2026-09-12T12:10:01.000Z'),
      ),
    ),
    (error) => error.getResponse().code === 'DOWNLOAD_RESERVATION_EXPIRED',
  );

  const octoberDownload = new Date('2026-10-01T00:00:01.000Z');
  for (let index = 0; index < 3; index += 1)
    await transactions.run((session) =>
      usage.reserveDownloadGrant(
        {
          accountId: secondAccount,
          jobId: downloadJob._id,
          scope: 'user_result',
          requestId: randomUUID(),
          object: { etag: '"result-v3"', bytes: 1 },
        },
        session,
        octoberDownload,
      ),
    );
  await assert.rejects(
    transactions.run((session) =>
      usage.reserveDownloadGrant(
        {
          accountId: secondAccount,
          jobId: downloadJob._id,
          scope: 'user_result',
          requestId: randomUUID(),
          object: { etag: '"result-v3"', bytes: 1 },
        },
        session,
        octoberDownload,
      ),
    ),
    (error) => error.getResponse().code === 'DOWNLOAD_GRANT_LIMIT_REACHED',
  );
  const octoberDownloads = (
    await usage.readUsage(secondAccount, undefined, octoberDownload)
  ).downloads;
  assert.equal(octoberDownloads.monthlyGrants, 3);
  assert.equal(octoberDownloads.estimatedBytes, 3);
  assert.equal(
    (await servicePeriods.findById('2026-10')).estimatedOutboundBytes,
    3,
  );

  for (const model of [dailyPeriods, periods, servicePeriods]) {
    const rows = await model.collection.find({}).toArray();
    assert.ok(rows.length > 0);
    for (const row of rows) {
      for (const field of ['dayStart', 'dayEnd', 'periodStart', 'periodEnd'])
        assert.equal(Object.hasOwn(row, field), false);
    }
  }

  const raceAccount = new Types.ObjectId();
  await users.create({
    _id: raceAccount,
    firebaseUid: `fixture-${raceAccount}`,
    displayName: 'Settlement Race Account',
    nameSource: 'numeric_alias',
    profileSyncedAt: new Date(),
    lastSeenAt: new Date(),
  });
  const raceJob = await createJob(jobs, raceAccount, 30);
  await transactions.run((session) =>
    usage.reserveForJob(raceJob._id, raceAccount, 30, session),
  );
  await jobs.updateOne(
    { _id: raceJob._id },
    { $set: { status: 'processing' }, $inc: { revision: 1 } },
  );
  const settleRace = (status) =>
    transactions.run(async (session) => {
      const current = await jobs.findById(raceJob._id).session(session);
      if (current.status !== 'processing') return false;
      const changed = await jobs.updateOne(
        {
          _id: current._id,
          status: 'processing',
          revision: current.revision,
        },
        {
          $set: { status, finishedAt: new Date() },
          $inc: { revision: 1 },
        },
        { session, runValidators: true },
      );
      if (changed.modifiedCount !== 1) return false;
      await usage.settleJob({ ...current.toObject(), status }, session);
      return true;
    });
  const settlementOutcomes = await Promise.all([
    settleRace('ready'),
    settleRace('cancelled'),
  ]);
  assert.equal(settlementOutcomes.filter(Boolean).length, 1);
  const settledReservation = await reservations.findById(raceJob._id).lean();
  assert.ok(['used', 'released'].includes(settledReservation.state));
  const raceUsage = await usage.readUsage(raceAccount);
  assert.equal(raceUsage.processing.reservedSeconds, 0);
  assert.equal(
    raceUsage.processing.usedSeconds + raceUsage.processing.releasedSeconds,
    30,
  );

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
  const reduced = await usage.readUsage(owner, undefined, quotaDate);
  assert.equal(reduced.effectivePolicySource, 'account_override');
  assert.equal(reduced.processing.limitSeconds, 10);
  assert.equal(reduced.processing.reservedSeconds, 80);
  assert.equal(reduced.processing.remainingSeconds, 0);
  assert.deepEqual(reduced.availability, {
    status: 'blocked',
    reason: 'monthly_limit_reached',
  });

  const retentionOwner = new Types.ObjectId();
  await accountFixture(connection, [retentionOwner.toString()]);
  const retentionJob = await createJob(jobs, retentionOwner, 1);
  const august = new Date('2026-08-12T12:00:00Z');
  const grantRetentionDownload = () =>
    transactions.run((session) =>
      usage.reserveDownloadGrant(
        {
          accountId: retentionOwner,
          jobId: retentionJob._id,
          scope: 'user_result',
          requestId: randomUUID(),
          object: { etag: '"retention-result"', bytes: 1 },
        },
        session,
        august,
      ),
    );
  const retentionPeriodId = `${retentionOwner}:2026-08`;
  await transactions.run((session) =>
    usage.reserveForJob(retentionJob._id, retentionOwner, 1, session, august),
  );
  await grantRetentionDownload();
  assert.equal((await periods.findById(retentionPeriodId)).purgeAt, null);
  await transactions.run((session) =>
    usage.settleJob(
      { _id: retentionJob._id, userId: retentionOwner, status: 'ready' },
      session,
      august,
    ),
  );
  await grantRetentionDownload();
  assert.equal(
    (await periods.findById(retentionPeriodId)).purgeAt.toISOString(),
    '2027-09-01T00:00:00.000Z',
  );

  // Simulate a historical download clearing expiry after the final settlement.
  await periods.updateOne(
    { _id: retentionPeriodId },
    { $set: { purgeAt: null } },
  );
  const maintenance = new ProcessingUsageMaintenanceService(
    periods,
    usage,
    transactions,
  );
  await maintenance.repairDue(new Date('2026-09-30T12:00:00Z'));
  assert.equal(
    (await periods.findById(retentionPeriodId)).purgeAt.toISOString(),
    '2027-09-01T00:00:00.000Z',
  );

  const heldJob = await createJob(jobs, retentionOwner, 1);
  await transactions.run((session) =>
    usage.reserveForJob(heldJob._id, retentionOwner, 1, session, august),
  );
  await maintenance.repairDue(new Date('2026-09-30T12:00:00Z'));
  assert.equal((await periods.findById(retentionPeriodId)).purgeAt, null);
  // Even inconsistent zero counters must not allow expiry of a live ledger hold.
  await periods.updateOne(
    { _id: retentionPeriodId },
    { $set: { processingReservedSeconds: 0, processingReservationCount: 0 } },
  );
  assert.equal(
    await transactions.run((session) =>
      usage.restoreClosedPeriodExpiry(
        retentionPeriodId,
        session,
        new Date('2026-09-30T12:00:00Z'),
      ),
    ),
    false,
  );
  assert.equal((await periods.findById(retentionPeriodId)).purgeAt, null);
});

test('unverified quotas enforce one fifth and verification preserves usage while restoring full limits', async (t) => {
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
  const owners = Array.from({ length: 8 }, () => new Types.ObjectId());
  const [
    owner,
    uploadOwner,
    uploadByteOwner,
    downloadOwner,
    downloadByteOwner,
    storageOwner,
    importOwner,
    zeroOwner,
  ] = owners;
  const { users } = await accountFixture(connection, owners.map(String));
  await users.updateMany({}, { $set: { emailVerified: false } });
  const model = (name) => connection.model(name);
  await Promise.all(
    Object.values(connection.models).map((value) => value.init()),
  );
  const values = {
    ...DEFAULT_ACCOUNT_POLICY_VALUES,
    monthlyProcessingSeconds: 50,
    dailyUploadGrants: 10,
    monthlyUploadGrants: 10,
    monthlyConfirmedUploadBytes: 1_000,
    monthlyDownloadGrants: 10,
    monthlyEstimatedDownloadBytes: 1_000,
    maxRetainedOutputBytes: 1_000,
  };
  await model(AccountPolicy.name).create({
    _id: 'standard',
    revision: 1,
    acceptNewJobs: true,
    maintenanceMessageEn: '',
    maintenanceMessageAr: null,
    ...values,
    updatedBy: 'fixture-admin',
    updatedAt: new Date(),
  });
  const { AccountPolicyService } =
    await import('../dist/admin-settings/account-policy.service.js');
  const policy = new AccountPolicyService(
    model(AccountPolicy.name),
    model(AccountPolicyOverride.name),
    model('ProcessingAdmissionFence'),
    users,
    {},
    new ConfigService(),
  );
  const jobs = model('Job');
  const usage = new ProcessingUsageService(
    model('AccountUsagePeriod'),
    model('AccountDailyUsagePeriod'),
    model('ProcessingReservation'),
    model('UploadGrantReceipt'),
    model('DownloadGrantReceipt'),
    model('ServiceUsagePeriod'),
    jobs,
    users,
    policy,
    new ConfigService({ AUDIO_PROCESSING_ENABLED: true }),
  );
  const transactions = new ProcessingTransactions(connection);
  const now = new Date('2026-09-30T12:00:00Z');
  const run = (fn) => transactions.run(fn);
  const code = (expected) => (error) => error.getResponse().code === expected;
  const before = await usage.readUsage(owner, undefined, now);
  assert.equal(before.processing.limitSeconds, 10);
  assert.equal(before.uploads.dailyGrantLimit, 2);
  assert.equal(before.uploads.monthlyGrantLimit, 2);
  assert.equal(before.uploads.monthlyByteLimit, 200);
  assert.equal(before.downloads.monthlyGrantLimit, 2);
  assert.equal(before.downloads.monthlyByteLimit, 200);
  assert.equal(before.storage.limitBytes, 200);
  assert.equal(before.maxWaitingJobs, 20);
  assert.equal(before.maxProcessingJobs, 1);
  assert.equal(before.effectiveLimits.maxDurationSeconds, 1_800);
  assert.deepEqual((await policy.current()).values, values);

  // Preserve admission of a complete file when any positive allowance remains.
  const firstJob = await createJob(jobs, owner, 9);
  const secondJob = await createJob(jobs, owner, 2);
  await run((session) =>
    usage.reserveForJob(firstJob._id, owner, 9, session, now),
  );
  await run((session) =>
    usage.settleJob({ ...firstJob.toObject(), status: 'ready' }, session, now),
  );
  await run((session) =>
    usage.reserveForJob(secondJob._id, owner, 2, session, now),
  );
  await assert.rejects(
    run((session) =>
      usage.reserveForJob(new Types.ObjectId(), owner, 1, session, now),
    ),
    code('PROCESSING_ALLOWANCE_EXHAUSTED'),
  );
  const exhausted = await usage.readUsage(owner, undefined, now);
  assert.equal(exhausted.processing.usedSeconds, 9);
  assert.equal(exhausted.processing.reservedSeconds, 2);
  assert.equal(exhausted.processing.remainingSeconds, 0);

  const uploadJob = await createJob(jobs, uploadOwner, 1);
  const grants = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      run((session) =>
        usage.reserveUploadGrant(uploadJob, randomUUID(), session, now),
      ),
    ),
  );
  assert.equal(
    grants.filter((grant) => grant.status === 'fulfilled').length,
    2,
  );
  assert.equal(
    grants.filter(
      (grant) =>
        grant.status === 'rejected' &&
        code('UPLOAD_GRANT_LIMIT_REACHED')(grant.reason),
    ).length,
    1,
  );
  const tomorrow = new Date('2026-10-01T12:00:00Z');
  const laterSameMonth = new Date('2026-09-30T13:00:00Z');
  // A fresh UTC day cannot bypass the independent monthly grant limit.
  const yesterday = new Date('2026-09-29T12:00:00Z');
  const earlierJob = await createJob(jobs, uploadByteOwner, 1);
  await run((session) =>
    usage.reserveUploadGrant(earlierJob, randomUUID(), session, yesterday),
  );
  await run((session) =>
    usage.reserveUploadGrant(earlierJob, randomUUID(), session, yesterday),
  );
  await assert.rejects(
    run((session) =>
      usage.reserveUploadGrant(
        earlierJob,
        randomUUID(),
        session,
        laterSameMonth,
      ),
    ),
    code('UPLOAD_GRANT_LIMIT_REACHED'),
  );
  const uploadOne = await createJob(jobs, uploadByteOwner, 1);
  const uploadTwo = await createJob(jobs, uploadByteOwner, 1);
  await run((session) =>
    usage.confirmUploadBytes(uploadOne, 200, session, now),
  );
  await assert.rejects(
    run((session) => usage.confirmUploadBytes(uploadTwo, 1, session, now)),
    code('UPLOAD_BYTE_LIMIT_REACHED'),
  );

  const downloadJobs = new Map(
    await Promise.all(
      [downloadOwner, downloadByteOwner, zeroOwner].map(async (accountId) => [
        String(accountId),
        await createJob(jobs, accountId, 1),
      ]),
    ),
  );
  const download = (accountId, bytes) =>
    run((session) =>
      usage.reserveDownloadGrant(
        {
          accountId,
          jobId: downloadJobs.get(String(accountId))._id,
          scope: 'user_result',
          requestId: randomUUID(),
          object: { etag: '"verified-quota-fixture"', bytes },
        },
        session,
        now,
      ),
    );
  await download(downloadOwner, 1);
  await download(downloadOwner, 1);
  await assert.rejects(
    download(downloadOwner, 1),
    code('DOWNLOAD_GRANT_LIMIT_REACHED'),
  );
  await download(downloadByteOwner, 200);
  await assert.rejects(
    download(downloadByteOwner, 1),
    code('DOWNLOAD_BYTE_LIMIT_REACHED'),
  );

  await users.updateOne(
    { _id: storageOwner },
    { $set: { retainedOutputBytes: 201 } },
  );
  const overStorage = await usage.readUsage(storageOwner, undefined, now);
  assert.equal(overStorage.storage.remainingBytes, 0);
  assert.equal(overStorage.storage.retainedBytes, 201);
  assert.equal(overStorage.availability.reason, 'storage_limit_reached');
  await run(async (session) => {
    const effective = await policy.effective(storageOwner, now, session);
    await assert.rejects(
      usage.assertRetainedCapacity(
        storageOwner,
        effective.values.maxRetainedOutputBytes,
        session,
      ),
      code('RETAINED_STORAGE_LIMIT_REACHED'),
    );
  });

  const importId = new Types.ObjectId();
  await run((session) =>
    usage.reserveForImport(importId, importOwner, 1_800, session, now),
  );
  await assert.rejects(
    run((session) =>
      usage.reserveForImport(
        new Types.ObjectId(),
        importOwner,
        1_800,
        session,
        now,
      ),
    ),
    code('PROCESSING_ALLOWANCE_EXHAUSTED'),
  );
  await run((session) => usage.releaseImport(importId, importOwner, session));
  assert.equal(
    (await usage.readUsage(importOwner, undefined, now)).processing
      .remainingSeconds,
    10,
  );

  await model(AccountPolicyOverride.name).create({
    _id: new Types.ObjectId(),
    accountId: zeroOwner,
    revision: 1,
    monthlyProcessingSeconds: 4,
    dailyUploadGrants: 4,
    monthlyUploadGrants: 4,
    monthlyConfirmedUploadBytes: 4,
    monthlyDownloadGrants: 4,
    monthlyEstimatedDownloadBytes: 4,
    maxRetainedOutputBytes: 4,
    reason: 'fixture-small-quotas',
    createdBy: 'fixture-admin',
    updatedBy: 'fixture-admin',
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
  });
  const zero = await usage.readUsage(zeroOwner, undefined, now);
  assert.equal(zero.effectivePolicySource, 'account_override');
  assert.equal(zero.processing.limitSeconds, 0);
  assert.equal(zero.uploads.dailyGrantLimit, 0);
  assert.equal(zero.uploads.monthlyGrantLimit, 0);
  assert.equal(zero.uploads.monthlyByteLimit, 0);
  assert.equal(zero.downloads.monthlyGrantLimit, 0);
  assert.equal(zero.downloads.monthlyByteLimit, 0);
  assert.equal(zero.storage.limitBytes, 0);
  await assert.rejects(
    run((session) =>
      usage.reserveForJob(new Types.ObjectId(), zeroOwner, 1, session, now),
    ),
    code('PROCESSING_ALLOWANCE_EXHAUSTED'),
  );
  await assert.rejects(
    run((session) =>
      usage.reserveUploadGrant(
        downloadJobs.get(String(zeroOwner)),
        randomUUID(),
        session,
        now,
      ),
    ),
    code('UPLOAD_GRANT_LIMIT_REACHED'),
  );
  await assert.rejects(
    download(zeroOwner, 1),
    code('DOWNLOAD_GRANT_LIMIT_REACHED'),
  );

  const countersBefore = await model('AccountUsagePeriod').find({}).lean();
  const holdsBefore = await model('ProcessingReservation').find({}).lean();
  await users.updateMany({}, { $set: { emailVerified: true } });
  assert.deepEqual(
    await model('AccountUsagePeriod').find({}).lean(),
    countersBefore,
  );
  assert.deepEqual(
    await model('ProcessingReservation').find({}).lean(),
    holdsBefore,
  );
  const verified = await usage.readUsage(owner, undefined, now);
  assert.equal(verified.processing.limitSeconds, 50);
  assert.equal(verified.processing.usedSeconds, 9);
  assert.equal(verified.processing.reservedSeconds, 2);
  assert.equal(verified.processing.remainingSeconds, 39);
  assert.equal(verified.uploads.dailyGrantLimit, 10);
  assert.equal(verified.uploads.monthlyGrantLimit, 10);
  assert.equal(verified.uploads.monthlyByteLimit, 1_000);
  assert.equal(verified.downloads.monthlyGrantLimit, 10);
  assert.equal(verified.downloads.monthlyByteLimit, 1_000);
  assert.equal(verified.storage.limitBytes, 1_000);
  assert.equal(
    (await usage.readUsage(storageOwner, undefined, now)).storage.retainedBytes,
    201,
  );
  await run((session) =>
    usage.reserveForJob(new Types.ObjectId(), owner, 1, session, now),
  );
  await run((session) =>
    usage.reserveUploadGrant(uploadJob, randomUUID(), session, now),
  );
  await run((session) => usage.confirmUploadBytes(uploadTwo, 1, session, now));
  await download(downloadOwner, 1);
  await download(downloadByteOwner, 1);
  await run((session) =>
    usage.assertRetainedCapacity(
      storageOwner,
      values.maxRetainedOutputBytes,
      session,
    ),
  );
  // Both UTC period rollover and a later verification downgrade retain safe limits.
  await users.updateOne({ _id: owner }, { $set: { emailVerified: false } });
  await run((session) =>
    usage.settleJob({ ...secondJob.toObject(), status: 'ready' }, session, now),
  );
  const downgraded = await usage.readUsage(owner, undefined, now);
  assert.equal(downgraded.processing.usedSeconds, 11);
  assert.equal(downgraded.processing.remainingSeconds, 0);
  assert.equal(
    (await usage.readUsage(owner, undefined, tomorrow)).processing
      .remainingSeconds,
    10,
  );
});

test('usage retention repair scans candidates without sorting retained or held history', async (t) => {
  const native = await IsolatedServices.create();
  t.after(() => native.stop());
  const { mongoUri } = await native.startDatabases();
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  const periods = connection.model(
    'AccountUsagePeriod',
    AccountUsagePeriodSchema,
  );
  await periods.init();
  await periods.collection.insertMany([
    ...Array.from({ length: 2_000 }, (_, index) => ({
      _id: `history-${String(index).padStart(4, '0')}:2026-08`,
      accountId: new Types.ObjectId(),
      periodKey: '2026-08',
      purgeAt: index % 2 ? new Date('2099-01-01T00:00:00Z') : null,
      processingReservationCount: index % 2 ? 0 : 1,
      processingReservedSeconds: index % 2 ? 0 : 30,
    })),
    ...['repair-a:2026-08', 'repair-b:2026-08'].map((_id) => ({
      _id,
      accountId: new Types.ObjectId(),
      periodKey: '2026-08',
      purgeAt: null,
      processingReservationCount: 0,
      processingReservedSeconds: 0,
    })),
  ]);
  const plan = await periods.collection
    .find({
      _id: { $gt: 'repair-a:2026-08' },
      periodKey: { $lt: '2026-09' },
      purgeAt: null,
      processingReservationCount: 0,
      processingReservedSeconds: 0,
    })
    .sort({ _id: 1 })
    .limit(100)
    .maxTimeMS(5000)
    .explain('executionStats');
  assert.equal(plan.executionStats.nReturned, 1);
  assert.ok(plan.executionStats.totalDocsExamined <= 2);
  const winning = JSON.stringify(plan.queryPlanner.winningPlan);
  assert.ok(winning.includes('account_usage_retention_repair'));
  assert.ok(!winning.includes('"stage":"SORT"'));
});

test('account admission atomically accepts only twenty waiting jobs', async (t) => {
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
  const fences = connection.model('ProcessingAdmissionFence');
  const policies = connection.model(AccountPolicy.name);
  const overrides = connection.model(AccountPolicyOverride.name);
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
  await policies.create({
    _id: 'standard',
    revision: 1,
    acceptNewJobs: true,
    maintenanceMessageEn: '',
    maintenanceMessageAr: null,
    ...DEFAULT_ACCOUNT_POLICY_VALUES,
    updatedBy: 'fixture-admin',
    updatedAt: new Date(),
  });
  const usage = new ProcessingUsageService(
    connection.model('AccountUsagePeriod'),
    connection.model('AccountDailyUsagePeriod'),
    connection.model('ProcessingReservation'),
    connection.model('UploadGrantReceipt'),
    connection.model('DownloadGrantReceipt'),
    connection.model('ServiceUsagePeriod'),
    jobs,
    users,
    policy,
    new ConfigService({ AUDIO_PROCESSING_ENABLED: true }),
  );
  const admission = new ProcessingAdmissionService(
    fences,
    users,
    jobs,
    policy,
    usage,
    new ConfigService({
      AUDIO_PROCESSING_ENABLED: true,
      PROCESSING_URL_SECONDS: 600,
    }),
  );
  const transactions = new ProcessingTransactions(connection);
  const metadata = {
    policyVersion: 2,
    preparationProfileId: 'audio-cap-aac-lc-160-v1',
    source: 'audio_file',
  };

  const createWaitingJob = () => {
    const jobId = new Types.ObjectId();
    return transactions.run(async (session) => {
      const snapshot = await admission.assertNewWork(
        owner,
        { bytes: 1_024, durationSeconds: 30 },
        session,
        jobId,
        metadata,
      );
      await jobs.create(
        [
          {
            _id: jobId,
            userId: owner,
            logicalAudioId: jobId,
            requestId: randomUUID(),
            requestHash: randomUUID().replaceAll('-', '').padEnd(64, 'a'),
            status: 'awaiting_upload',
            inputReservation: {
              key: `users/${owner}/jobs/${jobId}/input.mp3`,
              extension: 'mp3',
              contentType: 'audio/mpeg',
              bytes: 1_024,
              durationSeconds: 30,
              sha256: Buffer.alloc(32).toString('base64'),
            },
            admissionSnapshot: snapshot,
          },
        ],
        { session },
      );
      return jobId;
    });
  };

  const outcomes = await Promise.allSettled(
    Array.from({ length: 21 }, () => createWaitingJob()),
  );
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    20,
  );
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
  assert.equal(rejected.reason.getResponse().code, 'PROCESSING_LIMIT_REACHED');
  assert.deepEqual(rejected.reason.getResponse().capacity, {
    waitingJobs: 20,
    maxWaitingJobs: 20,
    processingJobs: 0,
    maxProcessingJobs: 1,
  });
  assert.equal(
    await jobs.countDocuments({ userId: owner, status: 'awaiting_upload' }),
    20,
  );
  assert.equal(
    await connection.model('ProcessingReservation').countDocuments({
      accountId: owner,
      state: 'reserved',
    }),
    20,
  );

  const claimable = await jobs
    .find({ userId: owner, status: 'awaiting_upload' })
    .sort({ _id: 1 })
    .limit(2)
    .lean();
  await Promise.all(
    claimable.map((job, index) =>
      jobs.updateOne(
        { _id: job._id },
        {
          $set: {
            status: 'queued',
            queuedAt: new Date(`2026-09-20T00:0${index}:00.000Z`),
          },
        },
      ),
    ),
  );
  const claim = (jobId) =>
    transactions.run(async (session) => {
      const job = await jobs.findById(jobId).session(session);
      if (!(await admission.claimProcessingSlot(job, session))) return null;
      const updated = await jobs.findOneAndUpdate(
        { _id: jobId, status: 'queued', revision: job.revision },
        { $set: { status: 'processing' }, $inc: { revision: 1 } },
        { session, returnDocument: 'after', runValidators: true },
      );
      return updated?._id ?? null;
    });
  const claimResults = await Promise.all(
    claimable.map((job) => claim(job._id)),
  );
  assert.equal(claimResults.filter(Boolean).length, 1);
  assert.equal(
    await jobs.countDocuments({ userId: owner, status: 'processing' }),
    1,
  );
});

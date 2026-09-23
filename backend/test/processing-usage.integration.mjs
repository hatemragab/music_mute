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

  await policies.updateOne(
    { _id: 'standard' },
    {
      $set: { monthlyProcessingSeconds: 60, updatedAt: new Date() },
      $inc: { revision: 1 },
    },
  );
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
  assert.deepEqual(independent.storage, {
    limitBytes: 1_000_000_000,
    retainedBytes: 0,
    remainingBytes: 1_000_000_000,
  });

  const retainedObject = {
    key: `users/${secondAccount}/jobs/output/vocals.mp3`,
    versionId: 'retained-v1',
    bytes: 1_000_000_001,
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
  const firstResult = { versionId: 'result-v1', bytes: 1_000 };
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
          object: { versionId: 'result-v2', bytes: 1_000 },
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
          object: { versionId: 'result-v2', bytes: 1_500 },
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
          object: { versionId: 'result-v2', bytes: 1_500 },
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
        object: { versionId: 'input-v1', bytes: 200 },
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
        object: { versionId: 'input-v1', bytes: 300 },
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
        object: { versionId: 'input-v1', bytes: 300 },
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
          object: { versionId: 'input-v1', bytes: 1 },
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
          object: { versionId: 'input-v1', bytes: 200 },
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
          object: { versionId: 'result-v3', bytes: 1 },
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
          object: { versionId: 'result-v3', bytes: 1 },
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

test('account admission atomically accepts only three waiting jobs', async (t) => {
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
    Array.from({ length: 4 }, () => createWaitingJob()),
  );
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    3,
  );
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
  assert.equal(rejected.reason.getResponse().code, 'PROCESSING_LIMIT_REACHED');
  assert.deepEqual(rejected.reason.getResponse().capacity, {
    waitingJobs: 3,
    maxWaitingJobs: 3,
    processingJobs: 0,
    maxProcessingJobs: 1,
  });
  assert.equal(
    await jobs.countDocuments({ userId: owner, status: 'awaiting_upload' }),
    3,
  );
  assert.equal(
    await connection.model('ProcessingReservation').countDocuments({
      accountId: owner,
      state: 'reserved',
    }),
    3,
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

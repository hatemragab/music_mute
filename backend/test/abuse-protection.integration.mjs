import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import {
  AbuseEventBucket,
  AbuseEventBucketSchema,
  AbuseMonthlySummary,
  AbuseMonthlySummarySchema,
} from '../dist/abuse-protection/abuse-event.schema.js';
import {
  AccountRestriction,
  AccountRestrictionSchema,
} from '../dist/abuse-protection/account-restriction.schema.js';
import { AbuseEventsService } from '../dist/abuse-protection/abuse-events.service.js';
import { AccountRestrictionsService } from '../dist/abuse-protection/account-restrictions.service.js';

test('abuse records aggregate atomically, paginate safely, expire, and contain only bounded fields', async (t) => {
  const services = await IsolatedServices.create();
  t.after(() => services.stop());
  const { mongoUri } = await services.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  const events = connection.model(
    AbuseEventBucket.name,
    AbuseEventBucketSchema,
  );
  const summaries = connection.model(
    AbuseMonthlySummary.name,
    AbuseMonthlySummarySchema,
  );
  const restrictions = connection.model(
    AccountRestriction.name,
    AccountRestrictionSchema,
  );
  await Promise.all([events.init(), summaries.init(), restrictions.init()]);
  const recorder = new AbuseEventsService(events, summaries, restrictions);
  const accountId = new Types.ObjectId();
  const occurredAt = new Date('2026-09-20T10:15:00.000Z');
  await Promise.all(
    Array.from({ length: 50 }, () =>
      recorder.record({
        accountId: accountId.toHexString(),
        type: 'upload_grant_limit',
        severity: 'medium',
        operationClass: 'upload_grant',
        policyRevision: 7,
        occurredAt,
      }),
    ),
  );
  const bucket = await events.findOne({ accountId }).lean();
  assert.equal(bucket.count, 50);
  assert.equal(bucket.bucketStart.toISOString(), '2026-09-20T10:00:00.000Z');
  assert.equal(bucket.bucketEnd.toISOString(), '2026-09-20T11:00:00.000Z');
  assert.equal(bucket.expiresAt.toISOString(), '2026-12-19T11:00:00.000Z');
  assert.deepEqual(Object.keys(bucket).sort(), [
    '_id',
    'accountId',
    'bucketEnd',
    'bucketStart',
    'count',
    'expiresAt',
    'firstOccurredAt',
    'lastOccurredAt',
    'operationClass',
    'policyRevision',
    'restrictionId',
    'severity',
    'type',
  ]);
  await recorder.record({
    accountId: accountId.toHexString(),
    type: 'upload_grant_limit',
    severity: 'medium',
    operationClass: 'upload_grant',
    occurredAt: new Date('2026-09-20T10:45:00.000Z'),
  });
  await recorder.record({
    accountId: accountId.toHexString(),
    type: 'upload_grant_limit',
    severity: 'medium',
    operationClass: 'upload_grant',
    occurredAt: new Date('2026-09-20T10:05:00.000Z'),
  });
  const reordered = await events.findOne({ accountId }).lean();
  assert.equal(reordered.count, 52);
  assert.equal(
    reordered.firstOccurredAt.toISOString(),
    '2026-09-20T10:05:00.000Z',
  );
  assert.equal(
    reordered.lastOccurredAt.toISOString(),
    '2026-09-20T10:45:00.000Z',
  );
  const summary = await summaries.findOne({ accountId }).lean();
  assert.equal(summary.count, 52);
  assert.equal(
    summary.firstOccurredAt.toISOString(),
    '2026-09-20T10:05:00.000Z',
  );
  assert.equal(
    summary.lastOccurredAt.toISOString(),
    '2026-09-20T10:45:00.000Z',
  );
  assert.equal(summary.month, '2026-09');
  assert.equal(summary.expiresAt.toISOString(), '2027-10-01T00:00:00.000Z');

  await recorder.record({
    accountId: accountId.toHexString(),
    type: 'download_grant_limit',
    severity: 'low',
    operationClass: 'download_grant',
    occurredAt: new Date('2026-09-20T12:15:00.000Z'),
  });
  const firstPage = await recorder.list({
    accountId: accountId.toHexString(),
    limit: '1',
  });
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.items[0].type, 'download_grant_limit');
  assert.equal(firstPage.items[0].restrictionStatus, 'none');
  assert.ok(firstPage.nextCursor);
  const secondPage = await recorder.list({
    accountId: accountId.toHexString(),
    limit: '1',
    cursor: firstPage.nextCursor,
  });
  assert.equal(secondPage.items[0].type, 'upload_grant_limit');
  await assert.rejects(
    recorder.list({ type: 'not_an_event' }),
    (error) => error.getResponse().code === 'INVALID_REQUEST',
  );
  await assert.rejects(
    recorder.list({
      accountId: accountId.toHexString(),
      limit: '1',
      cursor: `${firstPage.nextCursor}x`,
    }),
    (error) => error.getResponse().code === 'INVALID_CURSOR',
  );

  const eventIndexes = await events.listIndexes();
  assert.equal(
    eventIndexes.find((index) => index.name === 'abuse_event_expiry')
      .expireAfterSeconds,
    0,
  );
  const summaryIndexes = await summaries.listIndexes();
  assert.equal(
    summaryIndexes.find((index) => index.name === 'abuse_summary_expiry')
      .expireAfterSeconds,
    0,
  );
});

test('account restrictions are revisioned, expire lazily, and never auto-create from events', async (t) => {
  const services = await IsolatedServices.create();
  t.after(() => services.stop());
  const { mongoUri } = await services.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  const eventModel = connection.model(
    AbuseEventBucket.name,
    AbuseEventBucketSchema,
  );
  const summaryModel = connection.model(
    AbuseMonthlySummary.name,
    AbuseMonthlySummarySchema,
  );
  const restrictionModel = connection.model(
    AccountRestriction.name,
    AccountRestrictionSchema,
  );
  await Promise.all([
    eventModel.init(),
    summaryModel.init(),
    restrictionModel.init(),
  ]);
  const events = new AbuseEventsService(
    eventModel,
    summaryModel,
    restrictionModel,
  );
  const service = new AccountRestrictionsService(restrictionModel, events);
  const accountId = new Types.ObjectId();
  await events.record({
    accountId: accountId.toHexString(),
    type: 'endpoint_rate_limit',
    severity: 'low',
    operationClass: 'job_create',
  });
  assert.equal(await restrictionModel.countDocuments(), 0);

  const session = await connection.startSession();
  t.after(() => session.endSession());
  let applied;
  await session.withTransaction(async () => {
    applied = await service.apply(
      {
        accountId: accountId.toHexString(),
        expectedRevision: 0,
        reasonCode: 'manual_review',
        note: 'Support review',
        expiresAt: null,
        actorUid: 'admin-fixture',
      },
      session,
    );
  });
  assert.equal(applied.revision, 1);
  await assert.rejects(
    service.assertAllowed(accountId, 'job_create'),
    (error) => error.getResponse().code === 'ACCOUNT_RESTRICTED',
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    await eventModel.countDocuments({ type: 'restriction_bypass_attempt' }),
    1,
  );
  await restrictionModel.updateOne(
    { accountId },
    { $set: { expiresAt: new Date(Date.now() - 1) } },
  );
  assert.equal(await service.current(accountId), null);
  const expired = await restrictionModel.findOne({ accountId }).lean();
  assert.equal(expired.status, 'expired');
  assert.equal(expired.revision, 2);
});

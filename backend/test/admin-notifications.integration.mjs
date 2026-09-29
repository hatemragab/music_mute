import { UserSchema } from '../dist/users/user.schema.js';
import { AccountAccessService } from '../dist/users/account-access.service.js';
import { AdminAccessSchema } from '../dist/admin/admin-access.schema.js';
import { AdminAuditEventSchema } from '../dist/admin/admin-audit.schema.js';
import { AdminOperationSchema } from '../dist/admin/admin-operation.schema.js';
import { AdminAuditService } from '../dist/admin/admin-audit.service.js';
import { AdminOperationsService } from '../dist/admin/admin-operations.service.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection, set, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import {
  NotificationCampaign,
  NotificationCampaignSchema,
  CampaignDelivery,
  CampaignDeliverySchema,
} from '../dist/admin-notifications/notification-campaign.schema.js';
import { CampaignDispatcherService } from '../dist/admin-notifications/campaign-dispatcher.service.js';
import { AdminNotificationsService } from '../dist/admin-notifications/admin-notifications.service.js';
import {
  PushInstallation,
  PushInstallationSchema,
} from '../dist/notifications/push-installation.schema.js';
import { randomUUID } from 'node:crypto';

test('broadcasts freeze bounded targets, survive restart and record safe outcomes', async (t) => {
  set('sanitizeFilter', true);
  const isolated = await IsolatedServices.create();
  let connection;
  t.after(async () => {
    await connection?.close();
    await isolated.stop();
  });
  const { mongoUri } = await isolated.startDatabases({ replicaSet: true });
  connection = await createConnection(mongoUri).asPromise();
  const campaigns = connection.model(
    NotificationCampaign.name,
    NotificationCampaignSchema,
  );
  const deliveries = connection.model(
    CampaignDelivery.name,
    CampaignDeliverySchema,
  );
  const installations = connection.model(
    PushInstallation.name,
    PushInstallationSchema,
  );
  await Promise.all([
    campaigns.init(),
    deliveries.init(),
    installations.init(),
  ]);
  const users = connection.model('User', UserSchema);
  const access = new AccountAccessService(users);
  const accesses = connection.model('AdminAccess', AdminAccessSchema);
  const events = connection.model('AdminAuditEvent', AdminAuditEventSchema);
  const receipts = connection.model('AdminOperation', AdminOperationSchema);
  await Promise.all([accesses.init(), events.init(), receipts.init()]);
  const operations = new AdminOperationsService(
    connection,
    accesses,
    receipts,
    new AdminAuditService(events),
  );
  const actor = {
    uid: 'fixture-owner',
    verifiedEmail: 'owner@example.invalid',
    role: 'owner',
    permissions: ['notifications.send'],
    accessRevision: 0,
    authTimeSec: Math.floor(Date.now() / 1000),
  };
  await accesses.create({
    uid: actor.uid,
    verifiedEmail: actor.verifiedEmail,
    role: 'owner',
    active: true,
  });
  let sent = [];
  let invalidated = [];
  let fail = null;
  let ineligible = false;
  const registrations = {
    async eligibleFor(userId, expected) {
      const row = await installations
        .findById(expected.registrationId)
        .select('+token');
      return row &&
        !ineligible &&
        row.bindingRevision === expected.bindingRevision
        ? [
            {
              id: String(row._id),
              userId,
              bindingRevision: row.bindingRevision,
              installationId: row.installationId,
              token: row.token,
            },
          ]
        : [];
    },
    async deactivateIfCurrent(...args) {
      invalidated.push(args);
    },
  };
  const messaging = {
    async send(message) {
      sent.push(message);
      if (fail) throw fail;
      return 'fixture-id';
    },
  };
  const dispatcher = () =>
    new CampaignDispatcherService(
      campaigns,
      deliveries,
      installations,
      registrations,
      messaging,
      access,
    );
  const history = new AdminNotificationsService(
    campaigns,
    deliveries,
    operations,
  );
  const addTarget = async () => {
    const userId = new Types.ObjectId();
    await users.collection.insertOne({
      _id: userId,
      firebaseUid: 'fixture-' + userId.toHexString(),
      status: 'active',
      accessRevision: 0,
    });
    return installations.create({
      userId,
      installationId: randomUUID(),
      token: 'fixture-token',
      tokenHash: new Types.ObjectId().toHexString().padEnd(64, '0'),
      authTimeSec: 1,
    });
  };
  const create = () =>
    campaigns.create({
      title: 'System update',
      body: 'A fixture announcement',
      actorUid: 'fixture-owner',
      reason: 'Test',
    });
  const reset = async () => {
    await Promise.all([
      campaigns.deleteMany({}),
      deliveries.deleteMany({}),
      installations.deleteMany({}),
    ]);
    sent = [];
    invalidated = [];
    fail = null;
    ineligible = false;
  };
  await t.test(
    'snapshots more than one page and never stores tokens in history',
    async () => {
      await Promise.all(Array.from({ length: 101 }, addTarget));
      const campaign = await create();
      await dispatcher().dispatchDue();
      assert.equal(await deliveries.countDocuments(), 100);
      assert.equal((await campaigns.findById(campaign._id)).frozen, false);
      await dispatcher().dispatchDue();
      assert.equal(await deliveries.countDocuments(), 101);
      assert.equal((await campaigns.findById(campaign._id)).frozen, true);
      for (let i = 0; i < 26; i++) await dispatcher().dispatchDue();
      const result = await history.detail(String(campaign._id));
      assert.equal(result.state, 'completed');
      assert.equal(result.counts.sent, 101);
      assert.equal(sent.length, 101);
      assert.equal(sent[0].data.type, 'system_announcement');
      assert.doesNotMatch(
        JSON.stringify(result),
        /fixture-token|tokenHash|registrationId/,
      );
      assert.equal(await dispatcher().dispatchDue(), false);
    },
  );
  await t.test(
    'concurrent replicas send a target once after expired lease recovery',
    async () => {
      await reset();
      await addTarget();
      const campaign = await create();
      await dispatcher().dispatchDue();
      await campaigns.updateOne(
        { _id: campaign._id },
        { $set: { leaseId: randomUUID(), leaseExpiresAt: new Date(0) } },
      );
      await Promise.all([
        dispatcher().dispatchDue(),
        dispatcher().dispatchDue(),
      ]);
      assert.equal(sent.length, 1);
      assert.equal((await history.detail(String(campaign._id))).counts.sent, 1);
    },
  );
  await t.test('binding changes are skipped before sending', async () => {
    await reset();
    const target = await addTarget();
    const campaign = await create();
    await dispatcher().dispatchDue();
    await installations.updateOne(
      { _id: target._id },
      { $inc: { bindingRevision: 1 } },
    );
    await dispatcher().dispatchDue();
    assert.equal(sent.length, 0);
    assert.equal(
      (await history.detail(String(campaign._id))).counts.ineligible,
      1,
    );
  });
  await t.test(
    'invalid destinations are fenced and transient failures retry without re-sending successes',
    async () => {
      await reset();
      await addTarget();
      const campaign = await create();
      await dispatcher().dispatchDue();
      fail = {
        code: 'messaging/internal-error',
        message: 'private-provider-diagnostics',
      };
      await dispatcher().dispatchDue();
      let delivery = await deliveries.findOne();
      assert.equal(delivery.status, 'pending');
      assert.equal(delivery.attempts, 1);
      assert.equal(await dispatcher().dispatchDue(), false);
      await campaigns.updateOne(
        { _id: campaign._id },
        { $set: { nextAttemptAt: new Date(0) } },
      );
      await deliveries.updateOne(
        { _id: delivery._id },
        { $set: { nextAttemptAt: new Date(0) } },
      );
      fail = { code: 'messaging/registration-token-not-registered' };
      await dispatcher().dispatchDue();
      delivery = await deliveries.findOne();
      assert.equal(delivery.status, 'invalid');
      assert.equal(delivery.attempts, 2);
      assert.equal(invalidated.length, 1);
      assert.doesNotMatch(
        JSON.stringify(await history.detail(String(campaign._id))),
        /private-provider/,
      );
    },
  );
  await t.test(
    'exhausted attempts and empty audiences settle; history pagination is bounded',
    async () => {
      await reset();
      await addTarget();
      const campaign = await create();
      await dispatcher().dispatchDue();
      await deliveries.updateOne({}, { $set: { attempts: 8 } });
      await dispatcher().dispatchDue();
      assert.equal(sent.length, 0);
      assert.equal(
        (await history.detail(String(campaign._id))).counts.failed,
        1,
      );
      await installations.deleteMany({});
      const empty = await create();
      await dispatcher().dispatchDue();
      await dispatcher().dispatchDue();
      assert.equal(
        (await history.detail(String(empty._id))).state,
        'completed',
      );
      const page = await history.list({ limit: '1' });
      assert.equal(page.items.length, 1);
      assert.ok(page.nextCursor);
      const next = await history.list({ limit: '1', cursor: page.nextCursor });
      assert.equal(next.items[0].id, String(campaign._id));
      await assert.rejects(history.list({ limit: '51' }));
      await assert.rejects(history.list({ cursor: 'bad' }));
    },
  );
  await t.test('deletion acceptance fences new delivery records', async () => {
    await reset();
    const target = await addTarget();
    const campaign = await create();
    await users.updateOne(
      { _id: target.userId },
      { $set: { status: 'deletion_pending' } },
    );
    await dispatcher().dispatchDue();
    await dispatcher().dispatchDue();
    assert.equal(await deliveries.countDocuments(), 0);
    assert.equal(sent.length, 0);
    assert.equal(
      (await history.detail(String(campaign._id))).state,
      'completed',
    );
  });
  await t.test(
    'creation deduplicates operation IDs and atomically audits without sending',
    async () => {
      await reset();
      const input = {
        operationId: randomUUID(),
        title: 'Notice',
        body: 'Hello',
        reason: 'Test broadcast',
      };
      const first = await history.create(actor, input);
      const replay = await history.create(actor, input);
      assert.equal(first.id, replay.id);
      assert.equal(await campaigns.countDocuments(), 1);
      assert.equal(
        await events.countDocuments({ action: 'notifications.create' }),
        1,
      );
      assert.equal(sent.length, 0);
      await assert.rejects(
        history.create(actor, { ...input, body: 'Changed' }),
      );
      await accesses.updateOne({ uid: actor.uid }, { $set: { active: false } });
      await assert.rejects(
        history.create(actor, { ...input, operationId: randomUUID() }),
      );
      assert.equal(await campaigns.countDocuments(), 1);
    },
  );
});

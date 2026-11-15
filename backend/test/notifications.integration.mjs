import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection, set, Types } from 'mongoose';
import {
  JobError,
  JobErrorSchema,
} from '../dist/job-errors/job-error.schema.js';
import {
  NotificationDelivery,
  NotificationDeliverySchema,
} from '../dist/notifications/notification-delivery.schema.js';
import { NotificationDispatcherService } from '../dist/notifications/notification-dispatcher.service.js';
import {
  NotificationOutbox,
  NotificationOutboxSchema,
} from '../dist/notifications/notification-outbox.schema.js';
import { IsolatedServices } from './helpers/isolated-services.mjs';

const installationId = 'd7ea7de6-52e9-4b96-8834-3b517941bdb0';

class FakeRegistrations {
  target;
  eligible = true;
  failAfterDeactivation = false;
  deactivations = [];

  constructor(userId) {
    this.target = {
      id: new Types.ObjectId().toHexString(),
      userId: userId.toHexString(),
      installationId,
      token: 'private-fixture-token',
      bindingRevision: 3,
    };
  }

  async eligiblePage(userId, options) {
    assert.equal(userId, this.target.userId);
    assert.ok(options.changedBefore instanceof Date);
    assert.equal(options.limit, 50);
    return {
      items: options.afterId ? [] : [this.target],
      nextCursor: null,
      throughId: this.target.id,
    };
  }

  async eligibleFor(userId, expected) {
    assert.equal(userId, this.target.userId);
    return this.eligible &&
      expected.registrationId === this.target.id &&
      expected.bindingRevision === this.target.bindingRevision
      ? [this.target]
      : [];
  }

  async deactivateIfCurrent(...args) {
    this.deactivations.push(args);
    if (this.failAfterDeactivation) {
      this.failAfterDeactivation = false;
      this.eligible = false;
      throw new Error('simulated lost response after committed deactivation');
    }
    return true;
  }
}

class FakeMessaging {
  outcomes = [];
  sent = [];

  async send(message) {
    this.sent.push(message);
    const outcome = this.outcomes.shift();
    if (outcome instanceof Error || outcome?.code || outcome?.response)
      throw outcome;
    return outcome ?? 'fixture-provider-message-id';
  }
}

test('notification outbox dispatch is durable, bounded and account-safe', async (t) => {
  set('sanitizeFilter', true);
  const isolated = await IsolatedServices.create();
  let connection;
  t.after(async () => {
    if (connection) await connection.close();
    await isolated.stop();
  });
  const { mongoUri } = await isolated.startDatabases();
  connection = await createConnection(mongoUri).asPromise();
  const outbox = connection.model(
    NotificationOutbox.name,
    NotificationOutboxSchema,
  );
  const deliveries = connection.model(
    NotificationDelivery.name,
    NotificationDeliverySchema,
  );
  const errors = connection.model(JobError.name, JobErrorSchema);
  await Promise.all([outbox.init(), deliveries.init(), errors.init()]);

  const createEvent = async (overrides = {}) => {
    const userId = new Types.ObjectId();
    const jobId = new Types.ObjectId();
    const event = await outbox.create({
      jobId,
      userId,
      outcome: 'ready',
      ...overrides,
    });
    return { event, userId, jobId };
  };
  const serviceFor = (registrations, messaging) =>
    new NotificationDispatcherService(
      outbox,
      deliveries,
      errors,
      registrations,
      messaging,
      { runActive: async (_userId, operation) => operation(undefined) },
    );

  await t.test(
    'concurrent replicas claim once and send one generic visible alert',
    async () => {
      const { event, userId, jobId } = await createEvent();
      const registrations = new FakeRegistrations(userId);
      const messaging = new FakeMessaging();
      const first = serviceFor(registrations, messaging);
      const second = serviceFor(registrations, messaging);
      const claimed = await Promise.all([
        first.dispatchDue(new Date()),
        second.dispatchDue(new Date()),
      ]);
      assert.deepEqual(claimed.sort(), [false, true]);
      assert.deepEqual(messaging.sent, [
        {
          token: 'private-fixture-token',
          data: {
            type: 'audio_job_outcome',
            jobId: jobId.toHexString(),
            eventId: event._id.toHexString(),
            outcome: 'ready',
          },
          notification: {
            title: 'Vocal',
            body: 'Your audio is ready. Open Vocal to listen.',
          },
          android: {
            priority: 'normal',
            notification: {
              channelId: 'audio_processing_outcomes',
              tag: event._id.toHexString(),
              sound: 'default',
            },
          },
          apns: {
            headers: {
              'apns-push-type': 'alert',
              'apns-priority': '5',
              'apns-collapse-id': event._id.toHexString(),
            },
            payload: {
              aps: {
                alert: {
                  title: 'Vocal',
                  body: 'Your audio is ready. Open Vocal to listen.',
                },
                sound: 'default',
              },
            },
          },
        },
      ]);
      assert.equal(
        (await deliveries.findOne({ outboxId: event._id }).lean()).status,
        'sent',
      );
      const completed = await outbox.findById(event._id).lean();
      assert.equal(completed.state, 'completed');
      assert.equal(completed.leaseId, null);
    },
  );

  await t.test(
    'transient failures honor Retry-After and keep safe history',
    async () => {
      const { event, userId } = await createEvent();
      const registrations = new FakeRegistrations(userId);
      const messaging = new FakeMessaging();
      messaging.outcomes.push({
        code: 'messaging/internal-error',
        response: { headers: { 'retry-after': '240' } },
      });
      const before = Date.now();
      await serviceFor(registrations, messaging).dispatchDue(new Date());
      const delivery = await deliveries.findOne({ outboxId: event._id }).lean();
      assert.equal(delivery.status, 'pending');
      assert.equal(delivery.attempts, 1);
      assert.equal(delivery.lastFailureKind, 'transient');
      assert.ok(delivery.nextAttemptAt.getTime() >= before + 240_000);
      const failure = await errors.findOne({ jobId: event.jobId }).lean();
      assert.deepEqual(
        {
          classification: failure.classification,
          code: failure.code,
          message: failure.message,
          stage: failure.stage,
        },
        {
          classification: 'notification',
          code: 'NOTIFICATION_FAILED',
          message: 'A push notification could not be delivered.',
          stage: 'notification',
        },
      );
      assert.doesNotMatch(
        JSON.stringify(failure),
        /private-fixture-token|internal-error/,
      );
      await deliveries.updateOne(
        { _id: delivery._id },
        { $set: { nextAttemptAt: new Date(0) } },
      );
      await outbox.updateOne(
        { _id: event._id },
        { $set: { nextAttemptAt: new Date(0) } },
      );
      await serviceFor(registrations, messaging).dispatchDue(new Date());
      assert.equal(
        (await deliveries.findById(delivery._id).lean()).status,
        'sent',
      );
      assert.equal(await errors.countDocuments({ jobId: event.jobId }), 1);
      assert.equal(
        messaging.sent[0].data.eventId,
        messaging.sent[1].data.eventId,
      );
    },
  );

  await t.test(
    'invalid destinations are terminal and deactivate only the frozen binding',
    async () => {
      const { event, userId } = await createEvent();
      const registrations = new FakeRegistrations(userId);
      const messaging = new FakeMessaging();
      messaging.outcomes.push({
        code: 'messaging/registration-token-not-registered',
      });
      await serviceFor(registrations, messaging).dispatchDue(new Date());
      const delivery = await deliveries.findOne({ outboxId: event._id }).lean();
      assert.equal(delivery.status, 'invalid');
      assert.equal(delivery.lastFailureKind, 'invalid_destination');
      assert.deepEqual(registrations.deactivations, [
        [
          userId.toHexString(),
          installationId,
          registrations.target.id,
          registrations.target.bindingRevision,
        ],
      ]);
      assert.equal(
        (await outbox.findById(event._id).lean()).state,
        'completed',
      );
    },
  );

  await t.test(
    'an account switch after target freeze prevents provider send',
    async () => {
      const { event, userId } = await createEvent();
      const registrations = new FakeRegistrations(userId);
      registrations.eligible = false;
      const messaging = new FakeMessaging();
      await serviceFor(registrations, messaging).dispatchDue(new Date());
      const delivery = await deliveries.findOne({ outboxId: event._id }).lean();
      assert.equal(delivery.status, 'ineligible');
      assert.equal(delivery.attempts, 0);
      assert.equal(messaging.sent.length, 0);
      assert.equal(
        (await outbox.findById(event._id).lean()).state,
        'completed',
      );
    },
  );

  await t.test(
    'a crash after invalid-token deactivation recovers without retargeting it',
    async () => {
      const { event, userId } = await createEvent();
      const registrations = new FakeRegistrations(userId);
      registrations.failAfterDeactivation = true;
      const messaging = new FakeMessaging();
      messaging.outcomes.push({
        code: 'messaging/registration-token-not-registered',
      });
      const service = serviceFor(registrations, messaging);
      await service.dispatchDue(new Date());
      const interrupted = await deliveries
        .findOne({ outboxId: event._id })
        .lean();
      assert.equal(interrupted.status, 'pending');
      assert.equal(interrupted.attempts, 1);
      assert.equal((await outbox.findById(event._id).lean()).state, 'pending');

      await outbox.updateOne(
        { _id: event._id },
        { $set: { nextAttemptAt: new Date(0) } },
      );
      await service.dispatchDue(new Date());
      const recovered = await deliveries.findById(interrupted._id).lean();
      assert.equal(recovered.status, 'ineligible');
      assert.equal(recovered.attempts, 1);
      assert.equal(messaging.sent.length, 1);
      assert.equal(
        (await outbox.findById(event._id).lean()).state,
        'completed',
      );
    },
  );

  await t.test(
    'an expired lease restarts safely and the eighth failure is terminal',
    async () => {
      const { event, userId } = await createEvent({
        state: 'dispatching',
        leaseId: 'dead-replica',
        leaseExpiresAt: new Date(0),
        targetSnapshotAt: new Date(0),
        targetsFrozenAt: new Date(0),
      });
      const registrations = new FakeRegistrations(userId);
      await deliveries.create({
        outboxId: event._id,
        registrationId: new Types.ObjectId(registrations.target.id),
        bindingRevision: registrations.target.bindingRevision,
        attempts: 7,
        nextAttemptAt: new Date(0),
      });
      const messaging = new FakeMessaging();
      messaging.outcomes.push({ code: 'messaging/unavailable' });
      await serviceFor(registrations, messaging).dispatchDue(new Date());
      const delivery = await deliveries.findOne({ outboxId: event._id }).lean();
      assert.equal(delivery.attempts, 8);
      assert.equal(delivery.status, 'failed');
      assert.equal(delivery.lastFailureKind, 'exhausted');
      assert.ok(delivery.failedAt instanceof Date);
      assert.equal(
        (await outbox.findById(event._id).lean()).state,
        'completed',
      );
    },
  );

  await t.test(
    'an orphaned eighth attempt is recorded and cannot starve a later event',
    async () => {
      const userId = new Types.ObjectId();
      const first = await createEvent({
        userId,
        state: 'dispatching',
        nextAttemptAt: new Date(0),
        leaseId: 'crashed-after-eighth-attempt',
        leaseExpiresAt: new Date(0),
        targetSnapshotAt: new Date(0),
        targetsFrozenAt: new Date(0),
      });
      const registrations = new FakeRegistrations(userId);
      await deliveries.create({
        outboxId: first.event._id,
        registrationId: new Types.ObjectId(registrations.target.id),
        bindingRevision: registrations.target.bindingRevision,
        attempts: 8,
        nextAttemptAt: new Date(0),
      });
      const later = await createEvent({
        userId,
        nextAttemptAt: new Date(1),
      });
      const messaging = new FakeMessaging();
      const service = serviceFor(registrations, messaging);

      await service.dispatchDue(new Date());
      const recovered = await deliveries
        .findOne({ outboxId: first.event._id })
        .lean();
      assert.equal(recovered.status, 'failed');
      assert.equal(recovered.lastFailureKind, 'exhausted');
      assert.equal(
        await errors.countDocuments({
          jobId: first.jobId,
          code: 'NOTIFICATION_FAILED',
        }),
        1,
      );
      assert.equal(
        (await outbox.findById(first.event._id).lean()).state,
        'completed',
      );
      assert.equal(messaging.sent.length, 0);

      await service.dispatchDue(new Date());
      assert.equal(
        (await outbox.findById(later.event._id).lean()).state,
        'completed',
      );
      assert.equal(messaging.sent.length, 1);
      assert.equal(messaging.sent[0].data.jobId, later.jobId.toHexString());
    },
  );
});

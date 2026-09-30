import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices, until } from './helpers/isolated-services.mjs';
import { ClientErrorSchema } from '../dist/client-errors/client-error.schema.js';
import { JobErrorSchema } from '../dist/job-errors/job-error.schema.js';
import { AdminAlertSchema } from '../dist/admin-observability/admin-alert.schema.js';
import { AdminAuditEventSchema } from '../dist/admin/admin-audit.schema.js';
import { AdminOperationSchema } from '../dist/admin/admin-operation.schema.js';
import { NotificationDeliverySchema } from '../dist/notifications/notification-delivery.schema.js';
import {
  NotificationCampaignSchema,
  CampaignDeliverySchema,
} from '../dist/admin-notifications/notification-campaign.schema.js';
import { PushInstallationSchema } from '../dist/notifications/push-installation.schema.js';
import { WorkerDiagnosticSchema } from '../dist/worker-fleet/telemetry/worker-diagnostic.schema.js';
import { StorageCleanupTaskSchema } from '../dist/storage/storage-cleanup-task.schema.js';
import { AccountUsagePeriodSchema } from '../dist/processing-usage/processing-usage.schema.js';

test(
  'Mongo TTL removes expired details and preserves active state and replay receipts',
  { timeout: 30_000 },
  async (t) => {
    const services = await IsolatedServices.create();
    t.after(() => services.stop());
    const { mongoUri } = await services.startDatabases();
    const connection = await createConnection(mongoUri).asPromise();
    t.after(() => connection.close());
    // Accelerate only this owned loopback mongod, never the user's configured DB.
    await connection.db
      .admin()
      .command({ setParameter: 1, ttlMonitorSleepSecs: 1 });
    const now = Date.now();
    const past = new Date(now - 10_000);
    const future = new Date(now + 86_400_000);
    const daysAgo = (days) => new Date(now - days * 86_400_000);
    const checks = [];
    async function records(name, schema, expired, retained) {
      const model = connection.model(name, schema);
      await model.init();
      // Raw synthetic rows isolate Mongo index behavior from DTO/model validation.
      await model.collection.insertMany([...expired, ...retained]);
      checks.push({
        model,
        expired: expired.map((row) => row._id),
        retained: retained.map((row) => row._id),
      });
    }
    const errorRow = (receivedAt, occurredAt) => ({
      _id: new Types.ObjectId(),
      userId: new Types.ObjectId(),
      eventId: randomUUID(),
      receivedAt,
      occurredAt,
    });
    await records(
      'ClientError',
      ClientErrorSchema,
      [errorRow(daysAgo(31), new Date(now))],
      [errorRow(new Date(now), daysAgo(400))],
    );
    const alertRow = (state, resolvedAt) => ({
      _id: new Types.ObjectId(),
      type: 'dependency_probe_failed',
      resourceId: randomUUID(),
      state,
      resolvedAt,
    });
    await records(
      'AdminAlert',
      AdminAlertSchema,
      [alertRow('resolved', daysAgo(91))],
      [alertRow('active', daysAgo(91)), alertRow('resolved', new Date(now))],
    );
    await records(
      'AdminAuditEvent',
      AdminAuditEventSchema,
      [{ _id: new Types.ObjectId(), at: daysAgo(366) }],
      [{ _id: new Types.ObjectId(), at: new Date(now) }],
    );
    const deliveryRow = (status, purgeAt) => ({
      _id: new Types.ObjectId(),
      outboxId: new Types.ObjectId(),
      registrationId: new Types.ObjectId(),
      bindingRevision: 1,
      status,
      purgeAt,
    });
    for (const [name, schema] of [
      ['NotificationDelivery', NotificationDeliverySchema],
      ['CampaignDelivery', CampaignDeliverySchema],
    ])
      await records(
        name,
        schema,
        [deliveryRow('sent', past)],
        [
          deliveryRow('pending', null),
          deliveryRow('pending', past),
          deliveryRow('sent', future),
        ],
      );
    await records(
      'NotificationCampaign',
      NotificationCampaignSchema,
      [{ _id: new Types.ObjectId(), state: 'completed', purgeAt: past }],
      [
        { _id: new Types.ObjectId(), state: 'sending', purgeAt: null },
        { _id: new Types.ObjectId(), state: 'sending', purgeAt: past },
      ],
    );
    const registrationRow = (active, purgeAt) => ({
      _id: new Types.ObjectId(),
      installationId: randomUUID(),
      tokenHash: randomUUID(),
      active,
      purgeAt,
    });
    await records(
      'PushInstallation',
      PushInstallationSchema,
      [registrationRow(false, past)],
      [registrationRow(true, past), registrationRow(false, future)],
    );
    await records(
      'JobError',
      JobErrorSchema,
      [
        {
          _id: new Types.ObjectId(),
          jobId: new Types.ObjectId(),
          eventId: randomUUID(),
          purgeAt: past,
        },
      ],
      [
        {
          _id: new Types.ObjectId(),
          jobId: new Types.ObjectId(),
          eventId: randomUUID(),
          purgeAt: null,
        },
      ],
    );
    await records(
      'WorkerDiagnostic',
      WorkerDiagnosticSchema,
      [{ _id: randomUUID(), expiresAt: past }],
      [{ _id: randomUUID(), expiresAt: future }],
    );
    await records(
      'StorageCleanupTask',
      StorageCleanupTaskSchema,
      [
        {
          _id: new Types.ObjectId(),
          key: randomUUID(),
          completedAt: daysAgo(31),
        },
      ],
      [
        {
          _id: new Types.ObjectId(),
          key: randomUUID(),
          completedAt: null,
          createdAt: daysAgo(400),
        },
      ],
    );
    await records(
      'AccountUsagePeriod',
      AccountUsagePeriodSchema,
      [
        {
          _id: 'closed',
          accountId: new Types.ObjectId(),
          periodKey: '2025-01',
          purgeAt: past,
        },
      ],
      [
        {
          _id: 'held',
          accountId: new Types.ObjectId(),
          periodKey: '2025-01',
          purgeAt: null,
          processingReservationCount: 1,
        },
      ],
    );
    await records(
      'AdminOperation',
      AdminOperationSchema,
      [],
      [
        {
          _id: new Types.ObjectId(),
          actorUid: 'fixture-admin',
          operationId: randomUUID(),
          createdAt: daysAgo(400),
        },
      ],
    );
    await until(
      async () => {
        const remaining = await Promise.all(
          checks.map(async ({ model, expired }) =>
            expired.length
              ? model.collection.countDocuments({ _id: { $in: expired } })
              : 0,
          ),
        );
        return remaining.every((count) => count === 0);
      },
      'expired records removed by the actual Mongo TTL monitor',
      15_000,
    );
    for (const { model, retained } of checks)
      assert.equal(
        await model.collection.countDocuments({ _id: { $in: retained } }),
        retained.length,
        model.collection.name,
      );
  },
);

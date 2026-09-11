import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose, { createConnection } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';

mongoose.set('sanitizeFilter', true);

test('alert episodes deduplicate across API replicas and recur after resolution', async (t) => {
  const native = await IsolatedServices.create();
  t.after(() => native.stop());
  const { mongoUri } = await native.startDatabases({ replicaSet: true });
  const connections = await Promise.all([
    createConnection(mongoUri, { sanitizeFilter: true }).asPromise(),
    createConnection(mongoUri, { sanitizeFilter: true }).asPromise(),
  ]);
  t.after(() => Promise.all(connections.map((value) => value.close())));
  const [
    { AdminAlert, AdminAlertSchema },
    { AdminAlertObservation, AdminAlertObservationSchema },
    { AdminAlertsService },
  ] = await Promise.all([
    import('../dist/admin-observability/admin-alert.schema.js'),
    import('../dist/admin-observability/admin-alert-observation.schema.js'),
    import('../dist/admin-observability/admin-alerts.service.js'),
  ]);
  const models = connections.map((connection) =>
    connection.model(AdminAlert.name, AdminAlertSchema),
  );
  const observations = connections.map((connection) =>
    connection.model(AdminAlertObservation.name, AdminAlertObservationSchema),
  );
  const services = models.map(
    (model, index) =>
      new AdminAlertsService(model, observations[index], connections[index], {
        run: async () => undefined,
      }),
  );
  await Promise.all(services.map((service) => service.onModuleInit()));
  const condition = {
    type: 'worker_offline',
    severity: 'warning',
    resourceId: 'worker-fixture',
    message: 'Enabled worker is offline',
  };
  const firstAt = new Date('2026-09-11T00:00:01Z');
  await Promise.all(
    services.map((service) =>
      service.reconcile([condition], ['worker_offline'], firstAt),
    ),
  );
  let episodes = await models[0].find({}).sort({ firstSeenAt: 1 }).lean();
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].state, 'active');

  await services[0].reconcile(
    [],
    ['worker_offline'],
    new Date('2026-09-11T00:00:31Z'),
  );
  await services[1].reconcile(
    [condition],
    ['worker_offline'],
    new Date('2026-09-11T00:01:01Z'),
  );
  episodes = await models[0].find({}).sort({ firstSeenAt: 1 }).lean();
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].state, 'resolved');
  assert.equal(episodes[1].state, 'active');
  assert.equal(episodes[1].acknowledgedAt, null);

  await services[0].reconcile(
    [],
    ['worker_offline'],
    new Date('2026-09-11T00:02:01Z'),
  );
  await services[1].reconcile(
    [condition],
    ['worker_offline'],
    new Date('2026-09-11T00:01:31Z'),
  );
  episodes = await models[0].find({}).sort({ firstSeenAt: 1 }).lean();
  assert.equal(episodes.length, 2);
  assert.equal(episodes[1].state, 'resolved');
});

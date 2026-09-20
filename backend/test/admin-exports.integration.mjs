import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { JobSchema } from '../dist/jobs/job.schema.js';
import { ReleaseSchema } from '../dist/releases/release.schema.js';
import { AdminAccessSchema } from '../dist/admin/admin-access.schema.js';
import { AdminAuditEventSchema } from '../dist/admin/admin-audit.schema.js';
import { AdminOperationSchema } from '../dist/admin/admin-operation.schema.js';
import { AdminAuditService } from '../dist/admin/admin-audit.service.js';
import { AdminOperationsService } from '../dist/admin/admin-operations.service.js';
import { AdminOverviewService } from '../dist/admin-observability/admin-overview.service.js';
import { AdminExportsService } from '../dist/admin-exports/admin-exports.service.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const isCode = (code) => (error) => error?.getResponse?.().code === code;

test('bounded audited CSV snapshots', { timeout: 60000 }, async (t) => {
  const fixture = await IsolatedServices.create();
  t.after(() => fixture.stop());
  const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
  const connections = await Promise.all([
    createConnection(mongoUri).asPromise(),
    createConnection(mongoUri).asPromise(),
  ]);
  t.after(() =>
    Promise.all(connections.map((connection) => connection.close())),
  );
  for (const connection of connections) {
    connection.options = { ...connection.options, sanitizeFilter: true };
    connection.model('Job', JobSchema);
    connection.model('Release', ReleaseSchema);
    connection.model('AdminAccess', AdminAccessSchema);
    connection.model('AdminAuditEvent', AdminAuditEventSchema);
    connection.model('AdminOperation', AdminOperationSchema);
    await Promise.all(
      Object.values(connection.models).map((model) => model.init()),
    );
  }
  const [connection, concurrent] = connections;
  const jobs = connection.model('Job'),
    access = connection.model('AdminAccess'),
    events = connection.model('AdminAuditEvent'),
    receipts = connection.model('AdminOperation');
  const actor = {
    uid: 'synthetic-export-admin',
    verifiedEmail: 'export-admin@example.invalid',
    role: 'owner',
    accessRevision: 0,
    authTimeSec: 1,
    permissions: [
      'exports.read',
      'jobs.read',
      'overview.read',
      'users.read',
      'media.read',
    ],
  };
  await access.create({
    uid: actor.uid,
    verifiedEmail: actor.verifiedEmail,
    role: actor.role,
    active: true,
  });
  const audit = new AdminAuditService(events);
  const operations = new AdminOperationsService(
    connection,
    access,
    receipts,
    audit,
  );
  const overview = new AdminOverviewService(jobs, connection.model('Release'));
  const service = new AdminExportsService(jobs, overview, operations);
  const range = {
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-09-03T00:00:00.000Z',
  };
  const userId = new Types.ObjectId();
  const row = (extra = {}) => ({
    _id: new Types.ObjectId(),
    userId,
    requestId: randomUUID(),
    requestHash: 'a'.repeat(64),
    status: 'ready',
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
    queuedAt: null,
    finishedAt: new Date('2026-09-02T12:00:00.000Z'),
    deletedAt: null,
    processingAccumulatedMs: null,
    sourceTitle: 'PRIVATE_TITLE',
    displayName: 'PRIVATE_NAME',
    inputObject: { key: 'PRIVATE_OBJECT_KEY', versionId: 'PRIVATE_VERSION' },
    ...extra,
  });
  const reset = async () => {
    await jobs.deleteMany({});
    await events.deleteMany({});
    await receipts.deleteMany({});
  };

  await t.test(
    'exact cap exports fixed private-safe projection and cap+1 rejects atomically',
    async () => {
      await reset();
      await jobs.collection.insertMany(
        Array.from({ length: 10000 }, () => row()),
      );
      const report = await service.export(actor, 'jobs', range);
      assert.equal(report.csv.split('\r\n').length, 10002);
      assert.equal(
        /PRIVATE|displayName|inputObject|https:/.test(report.csv),
        false,
      );
      const auditRow = await events.findOne().lean();
      assert.deepEqual(auditRow.exportMetadata, {
        dataset: 'jobs',
        ...range,
        rowCount: 10000,
      });
      assert.equal(auditRow.reason, null);
      assert.equal(auditRow.actorUid, actor.uid);
      assert.equal(
        /PRIVATE|csv|inputObject/.test(
          JSON.stringify(await receipts.find().lean()).replaceAll(
            '/admin/exports/jobs.csv',
            'route',
          ),
        ),
        false,
      );
      await jobs.collection.insertOne(row());
      await assert.rejects(
        service.export(actor, 'jobs', range),
        isCode('EXPORT_TOO_LARGE'),
      );
      assert.equal(await events.countDocuments(), 1);
      assert.equal(await receipts.countDocuments({ status: 'failed' }), 1);
      const filtered = await service.export(actor, 'jobs', {
        ...range,
        status: 'failed',
      });
      assert.equal(filtered.csv.split('\r\n').length, 2);
      assert.equal(
        (await events.findOne({ 'exportMetadata.rowCount': 0 }).lean())
          .exportMetadata.rowCount,
        0,
      );
    },
  );

  await t.test(
    'overview uses matching UTC series semantics and metadata-only audit',
    async () => {
      await reset();
      await jobs.collection.insertOne(row());
      const report = await service.export(actor, 'overview', {
        ...range,
        bucket: 'day',
      });
      assert.equal(
        report.csv,
        'bucketStart,submitted,completed,failed,cancelled\r\n"2026-09-01T00:00:00.000Z",1,0,0,0\r\n"2026-09-02T00:00:00.000Z",0,1,0,0\r\n',
      );
      assert.deepEqual((await events.findOne().lean()).exportMetadata, {
        dataset: 'overview',
        ...range,
        rowCount: 2,
      });
    },
  );

  await t.test(
    'dataset changes after snapshot starts do not change the returned rows',
    async () => {
      await reset();
      const stored = row();
      await jobs.collection.insertOne(stored);
      const entered = deferred(),
        release = deferred();
      const originalAggregate = jobs.aggregate.bind(jobs);
      let once = false;
      jobs.aggregate = (...args) => {
        const query = originalAggregate(...args),
          originalExec = query.exec.bind(query);
        query.exec = async () => {
          if (!once) {
            once = true;
            entered.resolve();
            await release.promise;
          }
          return originalExec();
        };
        return query;
      };
      try {
        const pending = service.export(actor, 'jobs', range);
        await entered.promise;
        await concurrent
          .model('Job')
          .updateOne({ _id: stored._id }, { $set: { status: 'cancelled' } });
        release.resolve();
        const report = await pending;
        assert.equal(report.csv.includes('"ready"'), true);
        assert.equal(report.csv.includes('"cancelled"'), false);
        assert.equal(
          (await concurrent.model('Job').findById(stored._id)).status,
          'cancelled',
        );
      } finally {
        release.resolve();
        jobs.aggregate = originalAggregate;
      }
    },
  );

  await t.test(
    'audit failure and disconnect produce no successful export event or retained CSV',
    async () => {
      await reset();
      await jobs.collection.insertOne(row());
      const originalRecord = audit.record.bind(audit);
      audit.record = async () => {
        throw new Error('synthetic audit outage');
      };
      await assert.rejects(service.export(actor, 'jobs', range));
      assert.equal(await events.countDocuments(), 0);
      audit.record = originalRecord;
      const originalAggregate = jobs.aggregate.bind(jobs);
      const abort = new AbortController();
      jobs.aggregate = (...args) => {
        const query = originalAggregate(...args),
          originalExec = query.exec.bind(query);
        query.exec = async () => {
          const rows = await originalExec();
          abort.abort();
          return rows;
        };
        return query;
      };
      try {
        await assert.rejects(
          service.export(actor, 'jobs', range, abort.signal),
        );
      } finally {
        jobs.aggregate = originalAggregate;
      }
      assert.equal(await events.countDocuments(), 0);
      assert.equal(await receipts.countDocuments({ status: 'failed' }), 2);
      assert.equal(
        JSON.stringify(await receipts.find().lean()).includes('PRIVATE'),
        false,
      );
    },
  );
});

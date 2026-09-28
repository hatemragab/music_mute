import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { accountFixture } from './helpers/account-fixture.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { ProcessingUsageService } from '../dist/processing-usage/processing-usage.service.js';
import { DEFAULT_ACCOUNT_POLICY_VALUES } from '../dist/admin-settings/account-policy.schema.js';
import { ProcessingAdmissionService } from '../dist/admin-settings/processing-admission.service.js';
import { JobsService } from '../dist/jobs/jobs.service.js';
import {
  MediaImport,
  MediaImportSchema,
} from '../dist/url-imports/media-import.schema.js';
import { ImportsService } from '../dist/url-imports/imports.service.js';
import { ImportProcessor } from '../dist/url-imports/import-processor.js';

const errorCode = (expected) => (error) =>
  error.getResponse?.().code === expected;

test('URL acquisition holds allowance before paid work and releases safely', async (t) => {
  const native = await IsolatedServices.create();
  t.after(() => native.stop());
  const { mongoUri } = await native.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  for (const { name, schema } of PROCESSING_MODELS)
    connection.model(name, schema);
  const records = connection.model(MediaImport.name, MediaImportSchema);
  const owners = Array.from({ length: 6 }, () => new Types.ObjectId());
  const { users } = await accountFixture(connection, owners.map(String));
  await Promise.all(
    Object.values(connection.models).map((model) => model.init()),
  );
  const model = (name) => connection.model(name);
  const transactions = new ProcessingTransactions(connection);
  const values = {
    ...DEFAULT_ACCOUNT_POLICY_VALUES,
    monthlyProcessingSeconds: 1200,
    dailyUploadGrants: 2,
    monthlyUploadGrants: 3,
  };
  const policies = {
    effective: async () => ({
      values,
      acceptNewJobs: true,
      globalRevision: 1,
      overrideRevision: null,
    }),
    touchGlobalFence: async () => {},
  };
  const config = new ConfigService({
    AUDIO_PROCESSING_ENABLED: true,
    PROCESSING_URL_SECONDS: 900,
    URL_IMPORT_ENABLED: true,
    URL_IMPORT_MAX_OUTSTANDING: 20,
    URL_IMPORT_MIN_FREE_BYTES: 0,
    URL_IMPORT_TEMP_ROOT: join(native.directory, 'imports'),
  });
  const usage = new ProcessingUsageService(
    model('AccountUsagePeriod'),
    model('AccountDailyUsagePeriod'),
    model('ProcessingReservation'),
    model('UploadGrantReceipt'),
    model('DownloadGrantReceipt'),
    model('ServiceUsagePeriod'),
    model('Job'),
    users,
    policies,
    config,
  );
  const access = { assertActive: async () => {} };
  const imports = new ImportsService(
    records,
    model('ProcessingAdmissionFence'),
    transactions,
    access,
    usage,
    config,
    { add: async () => {} },
    { assertAllowed: async () => {} },
  );
  await imports.initialize();
  let providerCalls = 0;
  const processor = new ImportProcessor(
    imports,
    {
      download: async () => {
        providerCalls++;
        throw new Error('fixture upstream failure');
      },
    },
    {},
    { cancelPendingUpload: async () => {} },
    config,
    model('Job'),
  );
  const makeImport = (owner, status = 'downloading') =>
    records.create({
      userId: owner,
      requestId: randomUUID(),
      jobRequestId: randomUUID(),
      provider: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      status,
      executionId: randomUUID(),
      deadlineAt: new Date(Date.now() + 900000),
    });

  await t.test(
    'at-limit accounts reject before provider invocation',
    async () => {
      await transactions.run((session) =>
        usage.reserveForJob(new Types.ObjectId(), owners[0], 1200, session),
      );
      await assert.rejects(
        imports.create(
          String(owners[0]),
          'https://youtu.be/aqz-KE-bpKQ',
          randomUUID(),
        ),
        errorCode('PROCESSING_ALLOWANCE_EXHAUSTED'),
      );
      const record = await makeImport(owners[0], 'queued');
      await processor.process({ data: { importId: String(record._id) } });
      assert.equal(providerCalls, 0);
      const failed = await records.findById(record._id).lean();
      assert.equal(failed.error.code, 'PROCESSING_ALLOWANCE_EXHAUSTED');
      assert.equal(
        failed.stageTimings.some((s) => s.stage === 'source-download'),
        false,
      );
    },
  );

  await t.test(
    'concurrent imports cannot spend the same allowance',
    async () => {
      const a = await makeImport(owners[1]);
      const b = await makeImport(owners[1]);
      const results = await Promise.allSettled([
        imports.reserveAcquisition(a),
        imports.reserveAcquisition(b),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(
        (await usage.readUsage(owners[1])).processing.reservedSeconds,
        1200,
      );
      await assert.rejects(
        transactions.run((session) =>
          usage.reserveForJob(new Types.ObjectId(), owners[1], 1, session),
        ),
        errorCode('PROCESSING_ALLOWANCE_EXHAUSTED'),
      );
      await imports.failAcquisition(a, {
        code: 'IMPORT_DEPENDENCY_FAILED',
        message: 'fixture',
      });
      await imports.failAcquisition(b, {
        code: 'IMPORT_DEPENDENCY_FAILED',
        message: 'fixture',
      });
      assert.equal(
        (await usage.readUsage(owners[1])).processing.reservedSeconds,
        0,
      );
    },
  );

  await t.test(
    'measured job atomically replaces hold without double reservation',
    async () => {
      // Only one minute remains, but the entire four-minute song must be admitted.
      await transactions.run((session) =>
        usage.reserveForJob(new Types.ObjectId(), owners[2], 1140, session),
      );
      const record = await makeImport(owners[2]);
      await imports.reserveAcquisition(record);
      const admission = new ProcessingAdmissionService(
        model('ProcessingAdmissionFence'),
        users,
        model('Job'),
        policies,
        usage,
        config,
      );
      const jobs = new JobsService(
        model('Job'),
        {
          createInputGrant: async () => ({
            url: 'https://fixture.invalid',
            headers: {},
          }),
        },
        transactions,
        access,
        admission,
        usage,
        {},
      );
      const args = [
        String(owners[2]),
        {
          bytes: 1024,
          durationSeconds: 240,
          extension: 'mp3',
          contentType: 'audio/mpeg',
          sha256: Buffer.alloc(32).toString('base64'),
        },
        record.jobRequestId,
        {
          policyVersion: 2,
          preparationProfileId: 'audio-cap-aac-lc-160-v1',
          source: 'youtube',
          sourceKind: 'url',
          sourceUrl: record.sourceUrl,
        },
        true,
        undefined,
        null,
        record._id,
      ];
      const first = await jobs.create(...args);
      const second = await jobs.create(...args);
      assert.equal(first.id, second.id);
      assert.equal(
        (await usage.readUsage(owners[2])).processing.reservedSeconds,
        1380,
      );
      assert.equal(
        (await model('ProcessingReservation').findById(record._id)).state,
        'released',
      );
      assert.equal(
        (await model('ProcessingReservation').findById(first.id))
          .processingSeconds,
        240,
      );
    },
  );

  await t.test(
    'upstream failures release holds and do not consume processing allowance',
    async () => {
      for (let i = 0; i < 3; i++) {
        const record = await makeImport(owners[3], 'queued');
        await processor.process({ data: { importId: String(record._id) } });
        assert.equal(
          (await usage.readUsage(owners[3])).processing.reservedSeconds,
          0,
        );
      }
      assert.equal(providerCalls, 3);
      const monthly = await model('AccountUsagePeriod').findOne({
        accountId: owners[3],
      });
      assert.equal(monthly.processingReservationCount, 0);
    },
  );

  await t.test(
    'crash recovery releases once and prevents late acquisition',
    async () => {
      const record = await makeImport(owners[4]);
      await imports.reserveAcquisition(record);
      await processor.reconcileFailure(record, new Error('fixture crash'));
      await processor.reconcileFailure(record, new Error('fixture crash'));
      assert.equal(
        (await usage.readUsage(owners[4])).processing.reservedSeconds,
        0,
      );
      await assert.rejects(
        imports.reserveAcquisition(record),
        errorCode('IMPORT_DEPENDENCY_FAILED'),
      );
      const unreserved = await makeImport(owners[4]);
      await imports.failAcquisition(unreserved, {
        code: 'IMPORT_DEPENDENCY_FAILED',
        message: 'fixture crash before reservation',
      });
      await assert.rejects(
        imports.reserveAcquisition(unreserved),
        errorCode('IMPORT_DEPENDENCY_FAILED'),
      );
    },
  );

  await t.test(
    'local uploads accept a full song with one minute left, then block the next file',
    async () => {
      const owner = owners[5];
      await transactions.run((session) =>
        usage.reserveForJob(new Types.ObjectId(), owner, 1140, session),
      );
      const id = new Types.ObjectId();
      await transactions.run((session) =>
        usage.reserveForJob(id, owner, 240, session),
      );
      assert.equal(
        (await usage.readUsage(owner)).processing.reservedSeconds,
        1380,
      );
      await assert.rejects(
        transactions.run((session) =>
          usage.reserveForJob(new Types.ObjectId(), owner, 1, session),
        ),
        errorCode('PROCESSING_ALLOWANCE_EXHAUSTED'),
      );
      // Authoritative measurement cannot retroactively reject the admitted song.
      await transactions.run((session) =>
        usage.reconcileMeasured({ _id: id, userId: owner }, 245.1, session),
      );
      await transactions.run((session) =>
        usage.settleJob({ _id: id, userId: owner, status: 'ready' }, session),
      );
      assert.equal((await usage.readUsage(owner)).processing.usedSeconds, 246);
      assert.equal(
        (await usage.readUsage(owner)).processing.remainingSeconds,
        0,
      );
      await assert.rejects(
        imports.create(
          String(owner),
          'https://youtu.be/aqz-KE-bpKQ',
          randomUUID(),
        ),
        errorCode('PROCESSING_ALLOWANCE_EXHAUSTED'),
      );
    },
  );
});

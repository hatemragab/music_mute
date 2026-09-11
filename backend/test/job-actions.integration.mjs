import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';

const inputReservation = {
  key: 'users/fixture/jobs/source/input/source.mp3',
  extension: 'mp3',
  contentType: 'audio/mpeg',
  bytes: 4096,
  durationSeconds: 30,
  sha256: Buffer.alloc(32, 7).toString('base64'),
};
const inputObject = {
  key: inputReservation.key,
  versionId: 'fixture-version-1',
  bytes: inputReservation.bytes,
  sha256: inputReservation.sha256,
  contentType: inputReservation.contentType,
};

const hasCode = (code) => (error) => error?.getResponse?.().code === code;

test(
  'job actions cancel by state and retry eligible pinned input at the FIFO tail',
  { timeout: 30000 },
  async () => {
    const services = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri } = await services.startDatabases({ replicaSet: true });
      connection = await createConnection(mongoUri, {
        bufferCommands: false,
        sanitizeFilter: true,
      }).asPromise();
      const [
        { Job, JobSchema },
        { QueueCounter, QueueCounterSchema },
        { WorkerControl, WorkerControlSchema },
        { ProcessingTransactions },
        { EnqueueService },
        { JobActionsService },
      ] = await Promise.all([
        import('../dist/jobs/job.schema.js'),
        import('../dist/jobs/queue-counter.schema.js'),
        import('../dist/worker/worker-control.schema.js'),
        import('../dist/processing/processing-transactions.js'),
        import('../dist/jobs/enqueue.service.js'),
        import('../dist/jobs/job-actions.service.js'),
      ]);
      const jobs = connection.model(Job.name, JobSchema);
      const counters = connection.model(QueueCounter.name, QueueCounterSchema);
      const control = connection.model(WorkerControl.name, WorkerControlSchema);
      await Promise.all([jobs.init(), counters.init(), control.init()]);
      const transactions = new ProcessingTransactions(connection);
      const enqueue = new EnqueueService(counters);
      const actions = new JobActionsService(
        jobs,
        transactions,
        enqueue,
        {
          assertActive: async () => undefined,
        },
        {
          assertNewWork: async () => ({
            settingsRevision: 0,
            maxInputBytesExclusive: 30_000_000,
            maxDurationSecondsExclusive: 600,
            maxActiveJobsPerUser: null,
            reservationExpiresAt: new Date(Date.now() + 900_000),
          }),
        },
      );
      const ownerId = new Types.ObjectId();
      const otherId = new Types.ObjectId();
      const createJob = (overrides = {}) =>
        jobs.create({
          userId: ownerId,
          requestId: randomUUID(),
          requestHash: '0'.repeat(64),
          inputReservation,
          ...overrides,
        });

      for (const status of ['awaiting_upload', 'queued']) {
        const job = await createJob({ status });
        const result = await actions.cancel(
          ownerId.toHexString(),
          job._id.toHexString(),
        );
        const stored = await jobs.findById(job._id).lean();
        assert.deepEqual(result, {
          id: job._id.toHexString(),
          status: 'cancelled',
        });
        assert.equal(stored.status, 'cancelled');
        assert.ok(stored.finishedAt instanceof Date);
        assert.equal(stored.revision, 1);
      }

      const active = await createJob({
        status: 'validating',
        inputObject,
        queueOrder: 1n,
        queuedAt: new Date(),
        attemptId: randomUUID(),
        sessionId: randomUUID(),
        generation: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      await control.create({
        _id: 'z440',
        activeJobId: active._id,
        attemptId: active.attemptId,
        sessionId: active.sessionId,
        generation: 1,
        lastSeenAt: new Date(),
        leaseExpiresAt: active.leaseExpiresAt,
      });
      assert.deepEqual(
        await actions.cancel(ownerId.toHexString(), active._id.toHexString()),
        { id: active._id.toHexString(), status: 'cancel_requested' },
      );
      const activeAfter = await jobs.findById(active._id).lean();
      assert.equal(activeAfter.status, 'cancel_requested');
      assert.equal(activeAfter.finishedAt, null);
      assert.equal(
        (await control.findById('z440').lean()).activeJobId.toHexString(),
        active._id.toHexString(),
      );

      const interrupted = await createJob({
        status: 'interrupted',
        inputObject,
        queueOrder: 2n,
        queuedAt: new Date(),
      });
      assert.equal(
        (
          await actions.cancel(
            ownerId.toHexString(),
            interrupted._id.toHexString(),
          )
        ).status,
        'cancel_requested',
      );

      const cancelled = await createJob({
        status: 'cancelled',
        finishedAt: new Date(),
        revision: 4,
      });
      assert.equal(
        (
          await actions.cancel(
            ownerId.toHexString(),
            cancelled._id.toHexString(),
          )
        ).status,
        'cancelled',
      );
      assert.equal((await jobs.findById(cancelled._id).lean()).revision, 4);

      for (const status of ['ready', 'failed']) {
        const terminal = await createJob({
          status,
          inputObject,
          finishedAt: new Date(),
          ...(status === 'failed'
            ? {
                lastError: {
                  code: 'SEPARATOR_FAILED',
                  message: 'Processing failed.',
                  at: new Date(),
                },
              }
            : {}),
        });
        await assert.rejects(
          actions.cancel(ownerId.toHexString(), terminal._id.toHexString()),
          hasCode('JOB_STATE_CONFLICT'),
        );
      }
      const ownerOnly = await createJob({ status: 'queued' });
      await assert.rejects(
        actions.cancel(otherId.toHexString(), ownerOnly._id.toHexString()),
        hasCode('JOB_NOT_FOUND'),
      );
      assert.equal(
        (await jobs.findById(ownerOnly._id).lean()).status,
        'queued',
      );

      await counters.updateOne(
        { _id: 'audio' },
        { $set: { sequence: 41n } },
        { upsert: true },
      );
      await createJob({
        status: 'queued',
        inputObject,
        queueOrder: 41n,
        queuedAt: new Date(),
      });
      const failed = await createJob({
        status: 'failed',
        sourceTitle: 'Fixture video',
        sourceKind: 'url',
        sourceUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
        inputObject,
        queueOrder: 5n,
        queuedAt: new Date(),
        finishedAt: new Date(),
        lastError: {
          code: 'SEPARATOR_FAILED',
          message: 'Processing failed.',
          at: new Date(),
        },
      });
      const retryRequestId = randomUUID();
      const retried = await actions.retry(
        ownerId.toHexString(),
        failed._id.toHexString(),
        retryRequestId,
      );
      const retry = await jobs.findById(retried.id).lean();
      assert.equal(retried.status, 'queued');
      assert.equal(retry.retryOfJobId.toHexString(), failed._id.toHexString());
      assert.equal(String(retry.queueOrder), '42');
      assert.deepEqual(retry.inputReservation, inputReservation);
      assert.deepEqual(retry.inputObject, inputObject);
      assert.equal(
        retry.sourceUrl,
        'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      );
      assert.equal(retry.admissionSnapshot.maxDurationSecondsExclusive, 600);
      assert.equal(retry.outputObject, null);
      assert.equal(retry.lastError, null);
      assert.equal(retry.finishedAt, null);
      assert.equal(retry.requestId, retryRequestId);

      const repeated = await actions.retry(
        ownerId.toHexString(),
        failed._id.toHexString(),
        retryRequestId,
      );
      assert.deepEqual(repeated, retried);
      assert.equal(await jobs.countDocuments({ requestId: retryRequestId }), 1);

      const differentOriginal = await createJob({
        status: 'failed',
        inputObject,
        finishedAt: new Date(),
        lastError: {
          code: 'SEPARATOR_FAILED',
          message: 'Processing failed.',
          at: new Date(),
        },
      });
      await assert.rejects(
        actions.retry(
          ownerId.toHexString(),
          differentOriginal._id.toHexString(),
          retryRequestId,
        ),
        hasCode('IDEMPOTENCY_CONFLICT'),
      );

      for (const code of [
        'INVALID_AUDIO',
        'INPUT_TOO_LONG',
        'INPUT_CHECKSUM_MISMATCH',
      ]) {
        const badMedia = await createJob({
          status: 'failed',
          inputObject,
          finishedAt: new Date(),
          lastError: { code, message: 'Invalid input.', at: new Date() },
        });
        await assert.rejects(
          actions.retry(
            ownerId.toHexString(),
            badMedia._id.toHexString(),
            randomUUID(),
          ),
          hasCode('NEW_INPUT_REQUIRED'),
        );
      }
      const failedWithoutPinnedInput = await createJob({
        status: 'failed',
        finishedAt: new Date(),
        lastError: {
          code: 'DOWNLOAD_FAILED',
          message: 'Download failed.',
          at: new Date(),
        },
      });
      await assert.rejects(
        actions.retry(
          ownerId.toHexString(),
          failedWithoutPinnedInput._id.toHexString(),
          randomUUID(),
        ),
        hasCode('NEW_INPUT_REQUIRED'),
      );
    } finally {
      await connection?.close();
      await services.stop();
    }
  },
);

import { pairedWorkerFixture } from './helpers/paired-worker-fixture.mjs';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ConfigService } from '@nestjs/config';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { UserSchema } from '../dist/users/user.schema.js';
import { UserIdentityFenceSchema } from '../dist/users/user-identity-fence.schema.js';
import { UserIdentityFenceService } from '../dist/users/user-identity-fence.service.js';
import { AccountAccessService } from '../dist/users/account-access.service.js';
import { AccountDeletionService } from '../dist/users/account-deletion.service.js';
import { AdminAccessSchema } from '../dist/admin/admin-access.schema.js';
import { AdminOperationSchema } from '../dist/admin/admin-operation.schema.js';
import { AdminAuditEventSchema } from '../dist/admin/admin-audit.schema.js';
import { AdminAuditService } from '../dist/admin/admin-audit.service.js';
import { AdminOperationsService } from '../dist/admin/admin-operations.service.js';
import { AdminUsersService } from '../dist/admin-users/admin-users.service.js';
import {
  ProcessingAdmissionFenceSchema,
  ProcessingSettingsSchema,
} from '../dist/admin-settings/processing-settings.schema.js';
import { ProcessingSettingsService } from '../dist/admin-settings/processing-settings.service.js';
import { ProcessingAdmissionService } from '../dist/admin-settings/processing-admission.service.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { EnqueueService } from '../dist/jobs/enqueue.service.js';
import { JobActionsService } from '../dist/jobs/job-actions.service.js';
import { AdminJobActionsService } from '../dist/admin-jobs/admin-job-actions.service.js';
import { WorkerCoordinatorService } from '../dist/worker/worker-coordinator.service.js';
import { WorkerOutputService } from '../dist/worker/worker-output.service.js';
import { WorkerTerminalService } from '../dist/worker/worker-terminal.service.js';

const code = (expected) => (error) => error?.getResponse?.().code === expected;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test(
  'administrative job actions preserve shared lifecycle, ownership, admission and atomic receipts',
  { timeout: 90000 },
  async (t) => {
    const services = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri } = await services.startDatabases({ replicaSet: true });
      connection = await createConnection(mongoUri, {
        bufferCommands: false,
        sanitizeFilter: true,
      }).asPromise();
      for (const { name, schema } of PROCESSING_MODELS)
        connection.model(name, schema);
      const users = connection.model('User', UserSchema);
      const identityFences = connection.model(
        'UserIdentityFence',
        UserIdentityFenceSchema,
      );
      const access = connection.model('AdminAccess', AdminAccessSchema);
      const receipts = connection.model('AdminOperation', AdminOperationSchema);
      const auditEvents = connection.model(
        'AdminAuditEvent',
        AdminAuditEventSchema,
      );
      const settingsModel = connection.model(
        'ProcessingSettings',
        ProcessingSettingsSchema,
      );
      const admissionFences = connection.model(
        'ProcessingAdmissionFence',
        ProcessingAdmissionFenceSchema,
      );
      await Promise.all(
        Object.values(connection.models).map((model) => model.init()),
      );
      const jobs = connection.model('Job'),
        attempts = connection.model('JobAttempt');
      const controls = connection.model('WorkerControl'),
        counters = connection.model('QueueCounter');
      const userAccess = new AccountAccessService(users);
      const identities = new UserIdentityFenceService(identityFences);
      const audit = new AdminAuditService(auditEvents);
      const operations = new AdminOperationsService(
        connection,
        access,
        receipts,
        audit,
      );
      const config = new ConfigService({
        AUDIO_PROCESSING_ENABLED: true,
        PROCESSING_LEASE_SECONDS: 90,
        PROCESSING_URL_SECONDS: 900,
        PROCESSING_OUTPUT_MAX_BYTES: 30_000_000,
      });
      const settings = new ProcessingSettingsService(
        settingsModel,
        admissionFences,
        operations,
        config,
      );
      const admission = new ProcessingAdmissionService(
        admissionFences,
        users,
        jobs,
        settings,
        config,
      );
      const transactions = new ProcessingTransactions(connection);
      const enqueue = new EnqueueService(counters);
      const actions = new JobActionsService(
        jobs,
        transactions,
        enqueue,
        userAccess,
        admission,
        controls,
      );
      const admin = new AdminJobActionsService(actions, operations, audit);
      const adminUsers = new AdminUsersService(
        users,
        jobs,
        admissionFences,
        identities,
        operations,
      );
      const deletion = new AccountDeletionService(users, identities);
      const actor = {
        uid: 'support-fixture',
        verifiedEmail: 'support@example.invalid',
        role: 'support',
        permissions: ['jobs.read', 'jobs.manage', 'users.processing.manage'],
        accessRevision: 0,
        authTimeSec: Math.floor(Date.now() / 1000),
      };
      const otherActor = {
        ...actor,
        uid: 'second-support-fixture',
        verifiedEmail: 'second@example.invalid',
      };
      for (const principal of [actor, otherActor])
        await access.create({
          uid: principal.uid,
          verifiedEmail: principal.verifiedEmail,
          role: principal.role,
          active: true,
          revision: 0,
        });

      const reset = async () => {
        for (const model of [
          jobs,
          attempts,
          controls,
          counters,
          users,
          settingsModel,
          admissionFences,
          receipts,
          auditEvents,
          identityFences,
          connection.model('JobReceipt'),
          connection.model('JobError'),
          connection.model('NotificationOutbox'),
        ]) {
          await model.deleteMany({});
        }
      };
      const owner = async (overrides = {}) =>
        users.create({
          firebaseUid: `owner-${randomUUID()}`,
          email: 'owner@example.invalid',
          displayName: 'Fixture owner',
          emailVerified: true,
          nameSource: 'email_prefix',
          providerIds: ['password'],
          status: 'active',
          profileSyncedAt: new Date(),
          lastSeenAt: new Date(),
          ...overrides,
        });
      const makeJob = async (user, status, overrides = {}) => {
        const id = new Types.ObjectId();
        const inputReservation = {
          key: `users/${user._id}/jobs/${id}/input/fixture.mp3`,
          extension: 'mp3',
          contentType: 'audio/mpeg',
          bytes: 100,
          durationSeconds: 10,
          sha256: Buffer.alloc(32).toString('base64'),
        };
        return jobs.create({
          _id: id,
          userId: user._id,
          requestId: randomUUID(),
          requestHash: 'a'.repeat(64),
          status,
          sourceTitle: 'PRIVATE_FIXTURE_MEDIA',
          displayName: 'PRIVATE_FIXTURE_MEDIA',
          processingAccumulatedMs: 0,
          inputReservation,
          inputObject: {
            key: inputReservation.key,
            versionId: 'pinned-fixture-version',
            bytes: 100,
            sha256: inputReservation.sha256,
            contentType: 'audio/mpeg',
          },
          ...(status === 'failed'
            ? {
                finishedAt: new Date(),
                lastError: {
                  code: 'SEPARATOR_FAILED',
                  message: 'Private fixture diagnostic',
                  at: new Date(),
                },
              }
            : {}),
          ...overrides,
        });
      };
      const command = (expectedRevision = 0) => ({
        operationId: randomUUID(),
        expectedRevision,
        reason: 'Fixture lifecycle review',
      });

      await t.test(
        'cancellation follows every real state and never releases an unfinished worker slot',
        async () => {
          await reset();
          const user = await owner();
          for (const status of [
            'awaiting_upload',
            'queued',
            'validating',
            'processing',
            'uploading_result',
            'interrupted',
            'cancel_requested',
            'cancelled',
          ]) {
            const job = await makeJob(user, status);
            const active = [
              'validating',
              'processing',
              'uploading_result',
              'interrupted',
              'cancel_requested',
            ].includes(status);
            if (active)
              await controls.create({
                _id: `fixture-${status.replaceAll('_', '-')}`,
                activeJobId: job._id,
                attemptId: randomUUID(),
              });
            const body = command();
            const result = await admin.cancel(actor, job.id, body);
            assert.equal(
              result.status,
              active ? 'cancel_requested' : 'cancelled',
            );
            assert.equal(result.revision, 1);
            assert.equal((await jobs.findById(job._id)).adminRevision, 1);
            assert.equal(
              Boolean(await controls.exists({ activeJobId: job._id })),
              active,
            );
            assert.deepEqual(await admin.cancel(actor, job.id, body), result);
            assert.equal((await jobs.findById(job._id)).adminRevision, 1);
          }
          for (const status of ['ready', 'failed']) {
            const job = await makeJob(user, status);
            await assert.rejects(
              admin.cancel(actor, job.id, command()),
              code('JOB_STATE_CONFLICT'),
            );
            assert.equal((await jobs.findById(job._id)).status, status);
          }
        },
      );

      await t.test(
        'mobile ownership remains explicit and administrative legacy-zero CAS works under active filter sanitization',
        async () => {
          await reset();
          const user = await owner(),
            other = await owner();
          const job = await makeJob(user, 'queued');
          await assert.rejects(
            actions.cancel(other.id, job.id),
            code('JOB_NOT_FOUND'),
          );
          await assert.rejects(
            actions.retry(other.id, job.id, randomUUID()),
            code('JOB_NOT_FOUND'),
          );
          await jobs.collection.updateOne(
            { _id: job._id },
            { $unset: { adminRevision: '' } },
          );
          // Mongoose stores the connection option separately; activate the actual query flag here.
          const previousOptions = connection.options;
          connection.options = { ...connection.options, sanitizeFilter: true };
          try {
            const result = await connection.transaction((session) =>
              actions.cancelAsAdmin(actor, job.id, 0, session),
            );
            assert.equal(result.revision, 1);
          } finally {
            connection.options = previousOptions;
          }
          assert.equal((await jobs.findById(job._id)).adminRevision, 1);
          await assert.rejects(
            admin.cancel(actor, job.id, command(0)),
            code('REVISION_CONFLICT'),
          );
        },
      );

      await t.test(
        'one operation creates one retry at the FIFO tail with source/new audit attribution and a safe replay receipt',
        async () => {
          await reset();
          const user = await owner();
          const source = await makeJob(user, 'failed', {
            queueOrder: 5n,
            queuedAt: new Date(0),
          });
          await counters.create({ _id: 'audio', sequence: 41n });
          await makeJob(await owner(), 'queued', { queueOrder: 41n });
          const body = command();
          const results = await Promise.allSettled([
            admin.retry(actor, source.id, body),
            admin.retry(actor, source.id, body),
          ]);
          assert.ok(
            results.some((r) => r.status === 'fulfilled'),
            JSON.stringify(
              results.map((r) =>
                r.status === 'rejected' ? r.reason.getResponse?.() : r.status,
              ),
            ),
          );
          for (const r of results)
            if (r.status === 'rejected')
              assert.ok(code('OPERATION_IN_PROGRESS')(r.reason));
          const retried = await admin.retry(actor, source.id, body);
          assert.deepEqual(Object.keys(retried).sort(), [
            'newJobId',
            'sourceJobId',
            'status',
          ]);
          assert.equal(
            await jobs.countDocuments({ retryOfJobId: source._id }),
            1,
          );
          const next = await jobs.findById(retried.newJobId);
          assert.equal(next.status, 'queued');
          assert.equal(next.queueOrder, 42n);
          assert.deepEqual(
            next.inputObject.toObject(),
            source.inputObject.toObject(),
          );
          assert.notEqual(next.requestId, body.operationId);
          const original = await jobs.findById(source._id);
          assert.equal(original.status, 'failed');
          assert.equal(original.queueOrder, 5n);
          assert.equal(original.adminRevision, 1);
          const events = await auditEvents
            .find({ operationId: body.operationId })
            .lean();
          assert.equal(events.length, 2);
          assert.deepEqual(
            new Set(events.map((e) => e.resourceId)),
            new Set([source.id, next.id]),
          );
          assert.ok(events.every((e) => e.actorUid === actor.uid));
          assert.doesNotMatch(
            JSON.stringify(events),
            /PRIVATE_FIXTURE_MEDIA|fixture\.mp3|sha256|versionId/,
          );
          assert.equal(
            (await operations.read(actor, body.operationId)).resourceId,
            next.id,
          );
          await assert.rejects(
            admin.retry(actor, source.id, {
              ...body,
              reason: 'Different request',
            }),
            code('REVISION_CONFLICT'),
          );
          assert.equal(
            await jobs.countDocuments({ retryOfJobId: source._id }),
            1,
          );
        },
      );

      await t.test(
        'retry refuses bad input, terminal alternatives, interrupted ownership and an unreleased failed slot',
        async () => {
          await reset();
          const user = await owner();
          for (const failure of [
            'INVALID_AUDIO',
            'INPUT_TOO_LONG',
            'INPUT_CHECKSUM_MISMATCH',
          ]) {
            const source = await makeJob(user, 'failed', {
              lastError: {
                code: failure,
                message: 'Fixture failure',
                at: new Date(),
              },
            });
            await assert.rejects(
              admin.retry(actor, source.id, command()),
              code('NEW_INPUT_REQUIRED'),
            );
            assert.equal(
              await jobs.countDocuments({ retryOfJobId: source._id }),
              0,
            );
          }
          const unpinned = await makeJob(user, 'failed', { inputObject: null });
          await assert.rejects(
            admin.retry(actor, unpinned.id, command()),
            code('NEW_INPUT_REQUIRED'),
          );
          for (const status of [
            'awaiting_upload',
            'queued',
            'validating',
            'processing',
            'uploading_result',
            'ready',
            'cancelled',
            'cancel_requested',
          ]) {
            const source = await makeJob(user, status);
            await assert.rejects(
              admin.retry(actor, source.id, command()),
              code('JOB_STATE_CONFLICT'),
            );
          }
          const interrupted = await makeJob(user, 'interrupted');
          await assert.rejects(
            admin.retry(actor, interrupted.id, command()),
            code('WORKER_RECOVERY_REQUIRED'),
          );
          const reserved = await makeJob(user, 'failed');
          await controls.create({
            _id: 'reserved-fixture',
            activeJobId: reserved._id,
            attemptId: randomUUID(),
          });
          await assert.rejects(
            admin.retry(actor, reserved.id, command()),
            code('WORKER_RECOVERY_REQUIRED'),
          );
          assert.equal((await counters.findById('audio')).sequence, 0n);
        },
      );

      await t.test(
        'disabled, deleting, suspended and closed-admission owners cannot receive retries',
        async () => {
          await reset();
          for (const overrides of [
            { status: 'disabled' },
            { status: 'deleting' },
            { processingSuspended: true },
          ]) {
            const user = await owner(overrides),
              source = await makeJob(user, 'failed');
            await assert.rejects(
              admin.retry(actor, source.id, command()),
              code('PROCESSING_UNAVAILABLE'),
            );
            assert.equal(
              await jobs.countDocuments({ retryOfJobId: source._id }),
              0,
            );
          }
          const user = await owner(),
            source = await makeJob(user, 'failed');
          await settingsModel.create({
            _id: 'processing',
            revision: 1,
            acceptNewJobs: false,
            maintenanceMessageEn: 'Fixture pause',
            maintenanceMessageAr: null,
            maxInputBytesExclusive: 30_000_000,
            maxDurationSecondsExclusive: 600,
            maxActiveJobsPerUser: null,
            updatedAt: new Date(),
          });
          await assert.rejects(
            admin.retry(actor, source.id, command()),
            code('PROCESSING_UNAVAILABLE'),
          );
          assert.equal(
            await jobs.countDocuments({ retryOfJobId: source._id }),
            0,
          );
        },
      );

      await t.test(
        'account deletion or suspension committed after the source read prevents new admission',
        async () => {
          for (const change of ['delete', 'suspend']) {
            await reset();
            const user = await owner(),
              source = await makeJob(user, 'failed');
            const entered = deferred(),
              release = deferred();
            const original = actions.findForAction.bind(actions);
            let paused = false;
            actions.findForAction = async (...args) => {
              const found = await original(...args);
              if (!paused) {
                paused = true;
                entered.resolve();
                await release.promise;
              }
              return found;
            };
            try {
              const pending = admin.retry(actor, source.id, command());
              const denied = assert.rejects(
                pending,
                code('PROCESSING_UNAVAILABLE'),
              );
              await entered.promise;
              if (change === 'delete')
                await deletion.requestVerifiedDeletion(
                  user.id,
                  user.firebaseUid,
                );
              else await adminUsers.suspend(otherActor, user.id, command());
              release.resolve();
              await denied;
              assert.equal(
                await jobs.countDocuments({ retryOfJobId: source._id }),
                0,
              );
              assert.equal((await jobs.findById(source._id)).adminRevision, 0);
            } finally {
              release.resolve();
              actions.findForAction = original;
            }
          }
        },
      );

      await t.test(
        'failed audit persistence rolls back retry, source revision and FIFO allocation together',
        async () => {
          await reset();
          const user = await owner(),
            source = await makeJob(user, 'failed');
          await actions.prepareRetry();
          const original = audit.record.bind(audit);
          audit.record = async (event, session) => {
            if (event.action === 'jobs.retry')
              throw new Error('Owned fixture audit failure');
            return original(event, session);
          };
          const body = command();
          try {
            await assert.rejects(
              admin.retry(actor, source.id, body),
              /Owned fixture audit failure/,
            );
          } finally {
            audit.record = original;
          }
          assert.equal(
            await jobs.countDocuments({ retryOfJobId: source._id }),
            0,
          );
          assert.equal((await jobs.findById(source._id)).adminRevision, 0);
          assert.equal((await counters.findById('audio')).sequence, 0n);
          assert.equal(
            await auditEvents.countDocuments({ operationId: body.operationId }),
            0,
          );
          assert.equal(
            (await operations.read(actor, body.operationId)).status,
            'failed',
          );
        },
      );

      await t.test(
        'concurrent mobile/admin cancellation does not release the slot or overwrite a winner',
        async () => {
          await reset();
          const user = await owner(),
            job = await makeJob(user, 'processing');
          await controls.create({
            _id: 'concurrent-fixture',
            activeJobId: job._id,
            attemptId: randomUUID(),
          });
          const results = await Promise.allSettled([
            actions.cancel(user.id, job.id),
            admin.cancel(actor, job.id, command()),
          ]);
          assert.equal(results[0].status, 'fulfilled');
          if (results[1].status === 'rejected')
            assert.ok(code('REVISION_CONFLICT')(results[1].reason));
          const stored = await jobs.findById(job._id);
          assert.equal(stored.status, 'cancel_requested');
          assert.equal(stored.adminRevision, 1);
          assert.equal(
            (
              await controls.findById('concurrent-fixture')
            ).activeJobId.toString(),
            job.id,
          );
        },
      );

      await t.test(
        'completion/cancel races require worker stop proof and preserve completed results',
        async () => {
          await reset();
          const user = await owner();
          const storage = {
            createDownloadGrant: async () => ({
              url: 'https://fixture.invalid/input',
              expiresAt: new Date().toISOString(),
            }),
            createOutputGrant: async () => ({
              url: 'https://fixture.invalid/output',
              expiresAt: new Date().toISOString(),
            }),
            verifyOutput: async (job) => ({
              key: job.outputReservation.key,
              bytes: job.outputReservation.bytes,
              contentType: job.outputReservation.contentType,
              sha256: job.outputReservation.sha256,
              versionId: 'output-version',
            }),
          };
          const coordinator = new WorkerCoordinatorService(
            jobs,
            controls,
            attempts,
            transactions,
            config,
            storage,
            connection.model('JobReceipt'),
            userAccess,
          );
          const output = new WorkerOutputService(
            coordinator,
            transactions,
            storage,
            config,
            attempts,
            connection.model('JobReceipt'),
            userAccess,
          );
          const terminal = new WorkerTerminalService(
            coordinator,
            transactions,
            storage,
            attempts,
            connection.model('JobReceipt'),
            connection.model('JobError'),
            controls,
            connection.model('NotificationOutbox'),
            userAccess,
          );
          const workerIdentity = await pairedWorkerFixture(connection);
          const upload = async () => {
            const job = await makeJob(user, 'queued', {
              queueOrder: BigInt((await jobs.countDocuments()) + 1),
              queuedAt: new Date(),
            });
            const assigned = await coordinator.claim(
              randomUUID(),
              workerIdentity,
              2,
            );
            const selector = {
              jobId: assigned.jobId,
              attemptId: assigned.attemptId,
              sessionId: assigned.sessionId,
              generation: assigned.generation,
            };
            await coordinator.stage(
              { ...selector, eventId: randomUUID() },
              {
                stage: 'processing',
                decodable: true,
                hasAudio: true,
                durationSeconds: 10,
              },
              workerIdentity,
            );
            await output.reserve(
              {
                ...selector,
                eventId: randomUUID(),
                bytes: 100,
                sha256: Buffer.alloc(32).toString('base64'),
                contentType: 'audio/mpeg',
                durationSeconds: 10,
                playable: true,
                voiceOnly: true,
              },
              workerIdentity,
            );
            return { job, selector };
          };
          const first = await upload(),
            entered = deferred(),
            release = deferred();
          const verify = storage.verifyOutput;
          storage.verifyOutput = async (job) => {
            entered.resolve();
            await release.promise;
            return verify(job);
          };
          const pending = terminal.complete(
            {
              ...first.selector,
              eventId: randomUUID(),
            },
            workerIdentity,
          );
          const conflicted = assert.rejects(
            pending,
            code('JOB_STATE_CONFLICT'),
          );
          await entered.promise;
          const before = await jobs.findById(first.job._id);
          const requested = await admin.cancel(
            actor,
            first.job.id,
            command(before.adminRevision),
          );
          assert.equal(requested.status, 'cancel_requested');
          assert.equal(
            (
              await controls.findById(workerIdentity.workerId)
            ).activeJobId.toString(),
            first.job.id,
          );
          release.resolve();
          await conflicted;
          storage.verifyOutput = verify;
          await terminal.stopped(
            { ...first.selector, eventId: randomUUID(), stopped: true },
            'cancelled',
            workerIdentity,
          );
          assert.equal(
            (await jobs.findById(first.job._id)).status,
            'cancelled',
            workerIdentity,
          );
          assert.equal(
            (await controls.findById(workerIdentity.workerId)).activeJobId,
            null,
          );
          const second = await upload();
          const priorRevision = (await jobs.findById(second.job._id))
            .adminRevision;
          await terminal.complete(
            {
              ...second.selector,
              eventId: randomUUID(),
            },
            workerIdentity,
          );
          await assert.rejects(
            admin.cancel(actor, second.job.id, command(priorRevision)),
            code('REVISION_CONFLICT'),
          );
          const ready = await jobs.findById(second.job._id);
          await assert.rejects(
            admin.cancel(actor, second.job.id, command(ready.adminRevision)),
            code('JOB_STATE_CONFLICT'),
          );
          assert.equal((await jobs.findById(second.job._id)).status, 'ready');
          assert.ok(ready.outputObject);
        },
      );
    } finally {
      await connection?.close();
      await services.stop();
    }
  },
);

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ConfigService } from '@nestjs/config';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';

test(
  'per-user admission fence prevents concurrent cap overflow and preserves accepted limits',
  { timeout: 30000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
      connection = await createConnection(mongoUri, {
        bufferCommands: false,
      }).asPromise();
      const [
        { Job, JobSchema },
        { QueueCounter, QueueCounterSchema },
        { User, UserSchema },
        {
          ProcessingSettings,
          ProcessingSettingsSchema,
          ProcessingAdmissionFence,
          ProcessingAdmissionFenceSchema,
        },
        { ProcessingSettingsService },
        { ProcessingAdmissionService },
        { ProcessingTransactions },
        { AccountAccessService },
        { EnqueueService },
        { JobsService },
      ] = await Promise.all([
        import('../dist/jobs/job.schema.js'),
        import('../dist/jobs/queue-counter.schema.js'),
        import('../dist/users/user.schema.js'),
        import('../dist/admin-settings/processing-settings.schema.js'),
        import('../dist/admin-settings/processing-settings.service.js'),
        import('../dist/admin-settings/processing-admission.service.js'),
        import('../dist/processing/processing-transactions.js'),
        import('../dist/users/account-access.service.js'),
        import('../dist/jobs/enqueue.service.js'),
        import('../dist/jobs/jobs.service.js'),
      ]);
      const jobs = connection.model(Job.name, JobSchema);
      const counters = connection.model(QueueCounter.name, QueueCounterSchema);
      const users = connection.model(User.name, UserSchema);
      const settingsModel = connection.model(
        ProcessingSettings.name,
        ProcessingSettingsSchema,
      );
      const fences = connection.model(
        ProcessingAdmissionFence.name,
        ProcessingAdmissionFenceSchema,
      );
      await Promise.all([
        jobs.init(),
        counters.init(),
        users.init(),
        settingsModel.init(),
        fences.init(),
      ]);
      const userId = new Types.ObjectId();
      const now = new Date();
      await users.create({
        _id: userId,
        firebaseUid: 'admission-fixture',
        email: null,
        emailVerified: false,
        displayName: 'Fixture',
        nameSource: 'numeric_alias',
        providerIds: ['password'],
        status: 'active',
        sessionsRevokedAfterSec: 0,
        profileSyncedAt: now,
        lastSeenAt: now,
      });
      await settingsModel.create({
        _id: 'processing',
        revision: 1,
        acceptNewJobs: true,
        maintenanceMessageEn: '',
        maintenanceMessageAr: null,
        maxInputBytesExclusive: 30_000_000,
        maxDurationSecondsExclusive: 600,
        maxActiveJobsPerUser: 1,
        updatedAt: now,
      });
      const config = new ConfigService({
        AUDIO_PROCESSING_ENABLED: true,
        PROCESSING_URL_SECONDS: 900,
      });
      const settingsOperations = {
        async run(_actor, _command, mutate) {
          const session = await connection.startSession();
          try {
            const result = await session.withTransaction(() => mutate(session));
            return { value: result.value, receipt: {}, replayed: false };
          } finally {
            await session.endSession();
          }
        },
      };
      const settings = new ProcessingSettingsService(
        settingsModel,
        fences,
        settingsOperations,
        config,
      );
      const admission = new ProcessingAdmissionService(
        fences,
        users,
        jobs,
        settings,
        config,
      );
      const transactions = new ProcessingTransactions(connection);
      const storage = {
        createInputGrant: async (job) => ({
          url: 'https://storage.invalid/upload',
          fields: {},
          expiresAt: job.admissionSnapshot.reservationExpiresAt.toISOString(),
        }),
        verifyInput: async (job) => ({
          key: job.inputReservation.key,
          versionId: 'fixture-v1',
          bytes: job.inputReservation.bytes,
          sha256: job.inputReservation.sha256,
          contentType: job.inputReservation.contentType,
        }),
      };
      const service = new JobsService(
        jobs,
        storage,
        transactions,
        new EnqueueService(counters),
        new AccountAccessService(users),
        admission,
      );
      const input = {
        extension: 'mp3',
        contentType: 'audio/mpeg',
        bytes: 1024,
        durationSeconds: 500,
        sha256: Buffer.alloc(32).toString('base64'),
      };
      const attempts = await Promise.allSettled([
        service.create(userId.toHexString(), input, randomUUID()),
        service.create(userId.toHexString(), input, randomUUID()),
      ]);
      assert.equal(
        attempts.filter((item) => item.status === 'fulfilled').length,
        1,
      );
      assert.equal(
        attempts.filter((item) => item.status === 'rejected').length,
        1,
      );
      const accepted = await jobs.findOne().lean();
      assert.equal(accepted.admissionSnapshot.maxDurationSecondsExclusive, 600);
      storage.verifyInput = async (job) => ({
        key: job.inputReservation.key,
        versionId: 'fixture-v1',
        bytes: 30_000_000,
        sha256: job.inputReservation.sha256,
        contentType: job.inputReservation.contentType,
      });
      await assert.rejects(
        service.confirmUpload(userId.toHexString(), accepted._id.toHexString()),
        (error) => error?.getResponse?.().code === 'PROCESSING_UNAVAILABLE',
      );
      storage.verifyInput = async (job) => ({
        key: job.inputReservation.key,
        versionId: 'fixture-v1',
        bytes: job.inputReservation.bytes,
        sha256: job.inputReservation.sha256,
        contentType: job.inputReservation.contentType,
      });
      await settingsModel.updateOne(
        { _id: 'processing' },
        { $set: { maxDurationSecondsExclusive: 300 }, $inc: { revision: 1 } },
      );
      await assert.rejects(
        service.create(userId.toHexString(), input, randomUUID()),
        (error) => error?.getResponse?.().code === 'PROCESSING_UNAVAILABLE',
      );
      await service.confirmUpload(
        userId.toHexString(),
        accepted._id.toHexString(),
      );
      assert.equal((await jobs.findById(accepted._id).lean()).status, 'queued');

      await jobs.updateOne(
        { _id: accepted._id },
        { $set: { status: 'ready', finishedAt: new Date() } },
      );
      await settingsModel.updateOne(
        { _id: 'processing' },
        {
          $set: { maxDurationSecondsExclusive: 600 },
          $inc: { revision: 1 },
        },
      );
      const race = await Promise.allSettled([
        service.create(userId.toHexString(), input, randomUUID()),
        settings.update(
          { uid: 'admin-owner' },
          {
            acceptNewJobs: true,
            maintenanceMessageEn: '',
            maintenanceMessageAr: null,
            maxInputBytesExclusive: 30_000_000,
            maxDurationSecondsExclusive: 300,
            maxActiveJobsPerUser: 1,
            expectedRevision: 3,
            operationId: '029347dc-3a96-4eaa-b0ce-435aa19b5710',
            reason: 'Lower measured duration ceiling',
          },
        ),
      ]);
      assert.equal(race[1].status, 'fulfilled');
      const racedJob = await jobs.findOne({ status: 'awaiting_upload' }).lean();
      if (race[0].status === 'fulfilled') {
        assert.equal(
          racedJob.admissionSnapshot.maxDurationSecondsExclusive,
          600,
        );
      } else {
        assert.equal(racedJob, null);
        assert.equal(
          race[0].reason?.getResponse?.().code,
          'PROCESSING_UNAVAILABLE',
        );
      }
      assert.equal(
        (await settingsModel.findById('processing').lean())
          .maxDurationSecondsExclusive,
        300,
      );
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);

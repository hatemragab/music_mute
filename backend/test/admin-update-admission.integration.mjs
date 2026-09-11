import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';

test(
  'published minimum build blocks trusted outdated installations without mutating accepted jobs',
  { timeout: 30000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
      connection = await createConnection(mongoUri, {
        bufferCommands: false,
      }).asPromise();
      connection.options = { ...connection.options, sanitizeFilter: true };
      const [
        { AppPolicy, AppPolicySchema },
        { AppPolicyService },
        { ProcessingAccessGuard },
        { Release, ReleaseSchema },
        { Device, DeviceSchema },
        { DevicesService },
        { Job, JobSchema },
      ] = await Promise.all([
        import('../dist/app-policy/app-policy.schema.js'),
        import('../dist/app-policy/app-policy.service.js'),
        import('../dist/app-policy/processing-access.guard.js'),
        import('../dist/releases/release.schema.js'),
        import('../dist/devices/device.schema.js'),
        import('../dist/devices/devices.service.js'),
        import('../dist/jobs/job.schema.js'),
      ]);
      const policies = connection.model(AppPolicy.name, AppPolicySchema);
      const releases = connection.model(Release.name, ReleaseSchema);
      const devices = connection.model(Device.name, DeviceSchema);
      const jobs = connection.model(Job.name, JobSchema);
      await Promise.all([
        policies.init(),
        releases.init(),
        devices.init(),
        jobs.init(),
      ]);
      const userId = new Types.ObjectId();
      const jobId = new Types.ObjectId();
      const release = await releases.create({
        platform: 'android',
        source: 'google_play',
        versionName: '2.0.0',
        buildNumber: 10,
        changelogEn: 'Required update',
        storeUrl:
          'https://play.google.com/store/apps/details?id=com.musicmute.app',
        state: 'published',
        artifactState: null,
        revision: 1,
        createdBy: 'release-admin',
        publishedBy: 'release-admin',
        publishedAt: new Date(),
      });
      await policies.create({
        _id: 'global',
        requireVerifiedEmail: false,
        platforms: {
          android: {
            minimumBuild: 10,
            latestBuild: 10,
            downloadUrl: release.storeUrl,
            releaseSelection: {
              source: 'google_play',
              directReleaseId: null,
              storeReleaseId: release._id.toHexString(),
            },
          },
          ios: { minimumBuild: null, latestBuild: null, downloadUrl: null },
        },
        revision: 1,
        updatedAt: new Date(),
      });
      const installationId = randomUUID();
      await devices.create({
        userId,
        installationId,
        platform: 'android',
        appVersion: '1.0.0',
        buildNumber: 9,
        metadataRevision: 1,
        osVersion: '16',
        deviceModel: 'fixture',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        lastAuthenticatedAtSec: Math.floor(Date.now() / 1000),
        versionHistory: [],
      });
      await jobs.create({
        _id: jobId,
        userId,
        requestId: randomUUID(),
        requestHash: 'a'.repeat(64),
        status: 'processing',
        inputReservation: {
          key: `users/${userId}/jobs/${jobId}/input/a.mp3`,
          extension: 'mp3',
          contentType: 'audio/mpeg',
          bytes: 100,
          durationSeconds: 10,
          sha256: Buffer.alloc(32).toString('base64'),
        },
      });
      const policyService = new AppPolicyService(policies, releases);
      const deviceService = new DevicesService(devices, {}, {});
      const guard = new ProcessingAccessGuard(
        { getAllAndOverride: () => true },
        deviceService,
        policyService,
      );
      const request = {
        identity: { tokenEmailVerified: true },
        user: { _id: userId },
        headers: { 'x-installation-id': installationId },
      };
      const context = {
        getHandler: () => function handler() {},
        getClass: () => class Controller {},
        switchToHttp: () => ({ getRequest: () => request }),
      };
      await assert.rejects(
        guard.canActivate(context),
        (error) => error?.getResponse?.().code === 'APP_UPDATE_REQUIRED',
      );
      await jobs.updateOne(
        { _id: jobId },
        { $set: { status: 'uploading_result' } },
      );
      await jobs.updateOne(
        { _id: jobId },
        { $set: { status: 'ready', finishedAt: new Date() } },
      );
      assert.equal((await jobs.findById(jobId).lean()).status, 'ready');
      await devices.updateOne(
        { userId, installationId },
        { $set: { buildNumber: 10 } },
      );
      await assert.doesNotReject(guard.canActivate(context));
      await releases.updateOne(
        { _id: release._id },
        { $set: { state: 'withdrawn' } },
      );
      await assert.rejects(
        guard.canActivate(context),
        (error) => error?.getResponse?.().code === 'SERVICE_UNAVAILABLE',
      );
      assert.equal((await jobs.findById(jobId).lean()).status, 'ready');
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);

import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { AdminAccessSchema } from '../dist/admin/admin-access.schema.js';
import { AdminAuditEventSchema } from '../dist/admin/admin-audit.schema.js';
import { AdminOperationSchema } from '../dist/admin/admin-operation.schema.js';
import { AdminAuditService } from '../dist/admin/admin-audit.service.js';
import { AdminOperationsService } from '../dist/admin/admin-operations.service.js';
import { ReleaseSchema } from '../dist/releases/release.schema.js';
import { ReleasePublicationService } from '../dist/releases/release-publication.service.js';
import { ReleasePolicyService } from '../dist/releases/release-policy.service.js';
import { AppPolicySchema } from '../dist/app-policy/app-policy.schema.js';
import { AppPolicyService } from '../dist/app-policy/app-policy.service.js';
import { defaultPolicy } from '../dist/app-policy/access-policy.js';

test(
  'publication fences policy races, rolls back audit failure and withdraws without erasing history',
  { timeout: 30000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
      connection = await createConnection(mongoUri).asPromise();
      connection.options = { ...connection.options, sanitizeFilter: true };
      const access = connection.model('AdminAccess', AdminAccessSchema),
        events = connection.model('AdminAuditEvent', AdminAuditEventSchema),
        receipts = connection.model('AdminOperation', AdminOperationSchema);
      const releases = connection.model('Release', ReleaseSchema),
        policies = connection.model('AppPolicy', AppPolicySchema);
      await Promise.all(
        [access, events, receipts, releases, policies].map((m) => m.init()),
      );
      const actors = ['owner-a', 'owner-b'].map((uid) => ({
        uid,
        verifiedEmail: `${uid}@example.invalid`,
        role: 'owner',
        accessRevision: 0,
        permissions: [],
        authTimeSec: 1,
      }));
      await access.create(
        actors.map((a) => ({
          uid: a.uid,
          verifiedEmail: a.verifiedEmail,
          role: a.role,
          active: true,
        })),
      );
      const prior = defaultPolicy();
      prior.requireVerifiedEmail = true;
      await policies.create(prior);
      const drafts = await releases.create(
        [12, 13].map((buildNumber) => ({
          platform: 'android',
          source: 'google_play',
          versionName: `1.${buildNumber}`,
          buildNumber,
          changelogEn: 'Fixture notes',
          storeUrl:
            'https://play.google.com/store/apps/details?id=com.example.fixture',
          createdBy: actors[0].uid,
        })),
      );
      const config = new ConfigService({
        APP_UPDATES_ENABLED: true,
        APK_EXPECTED_PACKAGE_ID: 'com.example.fixture',
        IOS_APP_STORE_ID: '123456',
      });
      const operations = new AdminOperationsService(
        connection,
        access,
        receipts,
        new AdminAuditService(events),
      );
      const publication = new ReleasePublicationService(
        policies,
        releases,
        operations,
        config,
      );
      const selections = drafts.map((r) => ({
        android: {
          minimumBuild: 10,
          directReleaseId: null,
          storeReleaseId: r._id.toString(),
          source: 'google_play',
        },
        ios: { minimumBuild: null, storeReleaseId: null },
      }));
      const preview = await publication.preview(selections[0]);
      assert.equal(preview.valid, true);
      assert.ok(preview.examples.some((x) => x.decision === 'required'));
      assert.equal(await events.countDocuments(), 0);
      assert.equal((await policies.findById('global')).revision, 0);
      const bodies = selections.map((policy) => ({
        policy,
        expectedRevision: 0,
        expectedReleaseRevision: 0,
        operationId: randomUUID(),
        reason: 'Publish fixture',
        storeAvailabilityConfirmed: true,
      }));
      await assert.rejects(
        publication.mutate(actors[0], drafts[0]._id.toString(), 'publish', {
          ...bodies[0],
          operationId: randomUUID(),
          storeAvailabilityConfirmed: false,
        }),
      );
      const results = await Promise.allSettled(
        drafts.map((r, i) =>
          publication.mutate(actors[i], r._id.toString(), 'publish', bodies[i]),
        ),
      );
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
      const winner = results.findIndex((r) => r.status === 'fulfilled'),
        loser = 1 - winner;
      assert.equal(await events.countDocuments(), 1);
      assert.equal((await policies.findById('global')).revision, 1);
      assert.equal(
        (await policies.findById('global')).requireVerifiedEmail,
        true,
      );
      const replay = await publication.mutate(
        actors[winner],
        drafts[winner]._id.toString(),
        'publish',
        bodies[winner],
      );
      assert.equal(replay.policyRevision, 1);
      assert.equal(await events.countDocuments(), 1);
      const policiesService = new AppPolicyService(policies),
        snapshots = new ReleasePolicyService(policiesService, releases, config);
      const snapshot = await snapshots.snapshot('android', 'play');
      assert.equal(snapshot.target.source, 'google_play');
      await assert.rejects(
        publication.mutate(
          actors[winner],
          drafts[winner]._id.toString(),
          'publish',
          {
            ...bodies[winner],
            expectedRevision: 0,
            expectedReleaseRevision: 0,
            operationId: randomUUID(),
            policy: {
              ...selections[winner],
              android: { ...selections[winner].android, minimumBuild: 9 },
            },
          },
        ),
        (error) => error.getResponse().code === 'REVISION_CONFLICT',
      );
      await assert.rejects(
        publication.mutate(
          actors[winner],
          drafts[winner]._id.toString(),
          'publish',
          {
            ...bodies[winner],
            expectedRevision: 1,
            expectedReleaseRevision: 1,
            operationId: randomUUID(),
            policy: {
              ...selections[winner],
              android: { ...selections[winner].android, minimumBuild: 9 },
            },
          },
        ),
      );
      assert.equal((await policies.findById('global')).revision, 1);
      const failOperations = new AdminOperationsService(
        connection,
        access,
        receipts,
        {
          record: async () => {
            throw new Error('fixture audit failure');
          },
        },
      );
      const failing = new ReleasePublicationService(
        policies,
        releases,
        failOperations,
        config,
      );
      await assert.rejects(
        failing.mutate(actors[loser], drafts[loser]._id.toString(), 'publish', {
          ...bodies[loser],
          expectedRevision: 1,
          operationId: randomUUID(),
        }),
      );
      assert.equal((await releases.findById(drafts[loser]._id)).state, 'draft');
      assert.equal((await policies.findById('global')).revision, 1);
      const direct = await releases.create({
        platform: 'android',
        source: 'direct_apk',
        versionName: '1.20',
        buildNumber: 20,
        changelogEn: 'Fixture direct',
        storeUrl: null,
        state: 'published',
        artifactState: 'verified',
        createdBy: actors[0].uid,
        artifact: {
          key: 'fixture/private.apk',
          etag: '"fixture-version"',
          bytes: 1,
          sha256Hex: 'a'.repeat(64),
          signerSha256Hex: 'b'.repeat(64),
          packageId: 'com.example.fixture',
          minimumSdk: 26,
        },
      });
      const invalidDirect = {
        android: {
          minimumBuild: 10,
          directReleaseId: direct._id.toString(),
          storeReleaseId: null,
          source: 'direct_apk',
        },
        ios: { minimumBuild: null, storeReleaseId: null },
      };
      await assert.rejects(
        publication.preview(invalidDirect),
        (error) => error.response?.code === 'INVALID_REQUEST',
      );
      for (const operation of ['publish', 'withdraw']) {
        await assert.rejects(
          publication.mutate(actors[winner], direct._id.toString(), operation, {
            [operation === 'publish' ? 'policy' : 'replacementPolicy']:
              selections[winner],
            expectedRevision: 1,
            expectedReleaseRevision: 0,
            operationId: randomUUID(),
            reason: 'Retired direct rows are read-only',
            ...(operation === 'publish'
              ? { storeAvailabilityConfirmed: true }
              : {}),
          }),
          (error) => error.response?.code === 'INVALID_REQUEST',
        );
      }
      assert.equal((await releases.findById(direct._id)).revision, 0);
      assert.equal((await policies.findById('global')).revision, 1);
      const empty = {
        android: {
          minimumBuild: null,
          directReleaseId: null,
          storeReleaseId: null,
          source: 'google_play',
        },
        ios: { minimumBuild: null, storeReleaseId: null },
      };
      await publication.mutate(
        actors[winner],
        drafts[winner]._id.toString(),
        'withdraw',
        {
          expectedRevision: 1,
          expectedReleaseRevision: 1,
          replacementPolicy: empty,
          operationId: randomUUID(),
          reason: 'Withdraw fixture',
        },
      );
      assert.equal(
        (await releases.findById(drafts[winner]._id)).state,
        'withdrawn',
      );
      assert.equal(await releases.countDocuments(), 3);
      assert.equal((await policies.findById('global')).revision, 2);
      assert.equal((await snapshots.snapshot('android', 'play')).target, null);
      assert.equal(await events.countDocuments(), 2);
      // Read mappings and iOS actions must not rewrite a stranded historical Android policy.
      const historicalAndroid = {
        minimumBuild: 10,
        releaseSelection: {
          source: 'direct_apk',
          directReleaseId: direct._id.toString(),
          storeReleaseId: null,
        },
      };
      await policies.updateOne(
        { _id: 'global' },
        {
          $set: {
            'platforms.android': historicalAndroid,
            'platforms.macos': { minimumBuild: 5 },
          },
        },
      );
      const current = await publication.current();
      assert.deepEqual(current.android, {
        minimumBuild: 10,
        source: 'google_play',
        directReleaseId: null,
        storeReleaseId: null,
      });
      assert.deepEqual(
        (await policies.findById('global').lean()).platforms.android,
        historicalAndroid,
      );
      await assert.rejects(
        snapshots.snapshot('android', 'play'),
        (error) => error.response?.code === 'DEPENDENCY_UNAVAILABLE',
      );
      const ios = await releases.create({
        platform: 'ios',
        source: 'app_store',
        versionName: '1.0',
        buildNumber: 12,
        changelogEn: 'iOS release',
        storeUrl: 'https://apps.apple.com/app/id123456',
        createdBy: actors[0].uid,
      });
      const iosSelection = {
        android: current.android,
        ios: { minimumBuild: 10, storeReleaseId: ios._id.toString() },
      };
      const iosPreview = await publication.preview(iosSelection);
      assert.equal(iosPreview.valid, true);
      assert.ok(
        iosPreview.examples.every((example) => example.platform === 'ios'),
      );
      const androidChanged = {
        ...iosSelection,
        android: { ...iosSelection.android, minimumBuild: 11 },
      };
      assert.equal((await publication.preview(androidChanged)).valid, false);
      const iosRequest = {
        policy: iosSelection,
        expectedRevision: 2,
        expectedReleaseRevision: 0,
        operationId: randomUUID(),
        reason: 'Publish iOS while Android awaits Play',
        storeAvailabilityConfirmed: true,
      };
      await assert.rejects(
        publication.mutate(actors[0], ios._id.toString(), 'publish', {
          ...iosRequest,
          operationId: randomUUID(),
          policy: androidChanged,
        }),
        (error) => error.response?.code === 'INVALID_UPDATE_POLICY',
      );
      const iosPublished = await publication.mutate(
        actors[0],
        ios._id.toString(),
        'publish',
        iosRequest,
      );
      assert.equal(iosPublished.release.state, 'published');
      assert.deepEqual(
        (await policies.findById('global').lean()).platforms.android,
        historicalAndroid,
      );
      assert.deepEqual(
        (await policies.findById('global').lean()).platforms.macos,
        { minimumBuild: 5 },
      );
      assert.equal(
        (await snapshots.snapshot('ios', 'app_store')).target.buildNumber,
        12,
      );
      await assert.rejects(
        snapshots.snapshot('android', 'play'),
        (error) => error.response?.code === 'DEPENDENCY_UNAVAILABLE',
      );
      const iosReplacement = {
        android: current.android,
        ios: { minimumBuild: null, storeReleaseId: null },
      };
      assert.equal((await publication.preview(iosReplacement)).valid, true);
      await publication.mutate(actors[0], ios._id.toString(), 'withdraw', {
        replacementPolicy: iosReplacement,
        expectedRevision: 3,
        expectedReleaseRevision: 1,
        operationId: randomUUID(),
        reason: 'Withdraw iOS only',
      });
      assert.deepEqual(
        (await policies.findById('global').lean()).platforms.android,
        historicalAndroid,
      );
      assert.deepEqual(
        (await policies.findById('global').lean()).platforms.macos,
        { minimumBuild: 5 },
      );
      const playRequest = {
        policy: iosReplacement,
        expectedRevision: 4,
        expectedReleaseRevision: 0,
        operationId: randomUUID(),
        reason: 'Android needs a real Play target',
        storeAvailabilityConfirmed: true,
      };
      await assert.rejects(
        publication.mutate(
          actors[0],
          drafts[loser]._id.toString(),
          'publish',
          playRequest,
        ),
        (error) => error.response?.code === 'INVALID_UPDATE_POLICY',
      );
      const playSelection = {
        ...iosReplacement,
        android: {
          ...current.android,
          storeReleaseId: drafts[loser]._id.toString(),
        },
      };
      assert.equal((await publication.preview(playSelection)).valid, true);
      assert.ok(
        (await publication.preview(playSelection)).examples.every(
          (example) => example.distribution !== 'direct',
        ),
      );
      await publication.mutate(
        actors[0],
        drafts[loser]._id.toString(),
        'publish',
        { ...playRequest, operationId: randomUUID(), policy: playSelection },
      );
      assert.equal(
        (await snapshots.snapshot('android', 'play')).minimumBuild,
        10,
      );
      assert.deepEqual(
        (await policies.findById('global').lean()).platforms.macos,
        { minimumBuild: 5 },
      );
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);

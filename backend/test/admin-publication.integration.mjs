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
        RELEASE_LANDING_BASE_URL: 'https://example.invalid/api/v1',
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
          versionId: 'fixture-version',
          bytes: 1,
          sha256Hex: 'a'.repeat(64),
          signerSha256Hex: 'b'.repeat(64),
          packageId: 'com.example.fixture',
          minimumSdk: 26,
        },
      });
      const strandedPlay = {
        android: {
          minimumBuild: 10,
          directReleaseId: direct._id.toString(),
          storeReleaseId: null,
          source: 'direct_apk',
        },
        ios: { minimumBuild: null, storeReleaseId: null },
      };
      assert.equal((await publication.preview(strandedPlay)).valid, false);
      await assert.rejects(
        publication.mutate(actors[winner], direct._id.toString(), 'publish', {
          policy: strandedPlay,
          expectedRevision: 1,
          expectedReleaseRevision: 0,
          operationId: randomUUID(),
          reason: 'Cannot strand Play',
          storeAvailabilityConfirmed: false,
        }),
      );
      await assert.rejects(
        publication.mutate(
          actors[winner],
          drafts[winner]._id.toString(),
          'withdraw',
          {
            replacementPolicy: strandedPlay,
            expectedRevision: 1,
            expectedReleaseRevision: 1,
            operationId: randomUUID(),
            reason: 'Cannot strand Play',
          },
        ),
      );
      assert.equal((await policies.findById('global')).revision, 1);
      const empty = {
        android: {
          minimumBuild: null,
          directReleaseId: null,
          storeReleaseId: null,
          source: 'direct_apk',
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
      assert.equal(
        (await snapshots.snapshot('android', 'direct')).target,
        null,
      );
      assert.equal(await events.countDocuments(), 2);
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);

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
import { ReleaseDraftsService } from '../dist/releases/release-drafts.service.js';
import { ReleasePolicyService } from '../dist/releases/release-policy.service.js';
import { AppPolicySchema } from '../dist/app-policy/app-policy.schema.js';
import { AppPolicyService } from '../dist/app-policy/app-policy.service.js';
import { defaultPolicy } from '../dist/app-policy/access-policy.js';
import { presentPolicy } from '../dist/app-policy/app-policy.presenter.js';

test(
  'draft versions advance atomically and leave existing update policy unchanged',
  { timeout: 30000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
      connection = await createConnection(mongoUri).asPromise();
      const access = connection.model('AdminAccess', AdminAccessSchema),
        events = connection.model('AdminAuditEvent', AdminAuditEventSchema);
      const receipts = connection.model('AdminOperation', AdminOperationSchema),
        releases = connection.model('Release', ReleaseSchema);
      const policies = connection.model('AppPolicy', AppPolicySchema);
      await Promise.all(
        [access, events, receipts, releases, policies].map((m) => m.init()),
      );
      const actor = {
        uid: 'fixture-owner',
        role: 'owner',
        verifiedEmail: 'owner@example.invalid',
        accessRevision: 0,
        permissions: [],
        authTimeSec: 1,
      };
      await access.create({
        uid: actor.uid,
        role: actor.role,
        verifiedEmail: actor.verifiedEmail,
        active: true,
      });
      const before = defaultPolicy();
      before.requireVerifiedEmail = true;
      await policies.create(before);
      const operations = new AdminOperationsService(
        connection,
        access,
        receipts,
        new AdminAuditService(events),
      );
      const config = new ConfigService({
        APP_UPDATES_ENABLED: true,
        APK_EXPECTED_PACKAGE_ID: 'com.example.fixture',
      });
      const drafts = new ReleaseDraftsService(releases, operations, config),
        policy = new AppPolicyService(policies);
      assert.deepEqual(
        await drafts.proposal({
          platform: 'android',
          source: 'google_play',
        }),
        {
          platform: 'android',
          source: 'google_play',
          current: { versionName: '0.1.0', buildNumber: 1 },
          suggested: { versionName: '0.1.1', buildNumber: 2 },
        },
      );
      const request = {
        platform: 'android',
        source: 'google_play',
        versionName: '1.2',
        buildNumber: 12,
        changelogEn: 'Initial fixture',
        storeUrl:
          'https://play.google.com/store/apps/details?id=com.example.fixture',
        operationId: randomUUID(),
        reason: 'Fixture release',
      };
      await assert.rejects(
        drafts.create(actor, {
          ...request,
          versionName: '0.2.0',
          buildNumber: 1,
          operationId: randomUUID(),
        }),
        (error) => error?.response?.code === 'REVISION_CONFLICT',
      );
      await assert.rejects(
        drafts.create(actor, {
          ...request,
          versionName: '0.1.0',
          buildNumber: 2,
          operationId: randomUUID(),
        }),
        (error) => error?.response?.code === 'REVISION_CONFLICT',
      );
      const draft = await drafts.create(actor, request);
      assert.equal(draft.state, 'draft');
      assert.deepEqual(
        await drafts.proposal({
          platform: 'android',
          source: 'google_play',
        }),
        {
          platform: 'android',
          source: 'google_play',
          current: { versionName: '1.2', buildNumber: 12 },
          suggested: { versionName: '1.2.1', buildNumber: 13 },
        },
      );
      assert.deepEqual(await policy.current(), before);
      assert.deepEqual(await drafts.create(actor, request), draft);
      assert.equal(await releases.countDocuments(), 1);
      assert.equal(await events.countDocuments(), 1);
      assert.equal(JSON.stringify(draft).includes('createdBy'), false);
      await assert.rejects(
        drafts.create(actor, { ...request, operationId: randomUUID() }),
      );
      const updated = await drafts.edit(actor, draft.id, {
        expectedRevision: 0,
        operationId: randomUUID(),
        reason: 'Clarify notes',
        changelogEn: 'Improved notes',
      });
      assert.equal(updated.revision, 1);
      assert.deepEqual(await policy.current(), before);
      await assert.rejects(
        drafts.edit(actor, draft.id, {
          expectedRevision: 0,
          operationId: randomUUID(),
          reason: 'Stale edit',
          changelogEn: 'Stale',
        }),
      );
      await releases.updateOne(
        { _id: draft.id },
        { $set: { state: 'published' } },
      );
      await policies.updateOne(
        { _id: 'global' },
        {
          $set: {
            'platforms.android.releaseSelection': {
              source: 'google_play',
              directReleaseId: null,
              storeReleaseId: draft.id,
            },
            'platforms.android.minimumBuild': 10,
          },
        },
      );
      const snapshot = await new ReleasePolicyService(
        policy,
        releases,
        config,
      ).snapshot('android', 'play');
      assert.equal(snapshot.target.buildNumber, 12);
      assert.equal(snapshot.minimumBuild, 10);
      assert.equal(
        presentPolicy(await policy.current()).requireVerifiedEmail,
        true,
      );
      assert.equal(
        'releaseSelection' in
          presentPolicy(await policy.current()).platforms.android,
        false,
      );
      await assert.rejects(
        drafts.edit(actor, draft.id, {
          expectedRevision: 1,
          operationId: randomUUID(),
          reason: 'Published edit',
          changelogEn: 'Cannot edit',
        }),
      );
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);

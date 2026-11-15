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
import { operationFingerprint } from '../dist/admin/admin-audit-query.js';
import { AppPolicySchema } from '../dist/app-policy/app-policy.schema.js';
import { defaultPolicy } from '../dist/app-policy/access-policy.js';
import { ReleaseSchema } from '../dist/releases/release.schema.js';
import { ReleaseDraftsService } from '../dist/releases/release-drafts.service.js';
import { ReleasePublicationService } from '../dist/releases/release-publication.service.js';

test(
  'pre-retirement edit and withdrawal receipt replays read direct history without database writes',
  { timeout: 30000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
      connection = await createConnection(mongoUri, {
        monitorCommands: true,
      }).asPromise();
      const access = connection.model('AdminAccess', AdminAccessSchema);
      const events = connection.model('AdminAuditEvent', AdminAuditEventSchema);
      const receipts = connection.model('AdminOperation', AdminOperationSchema);
      const policies = connection.model('AppPolicy', AppPolicySchema);
      const releases = connection.model('Release', ReleaseSchema);
      const models = [access, events, receipts, policies, releases];
      await Promise.all(models.map((model) => model.init()));
      const actor = {
        uid: 'legacy-owner',
        role: 'owner',
        verifiedEmail: 'legacy@example.invalid',
        accessRevision: 0,
        permissions: [],
        authTimeSec: 1,
      };
      await access.create({
        uid: actor.uid,
        verifiedEmail: actor.verifiedEmail,
        role: actor.role,
        active: true,
        authorizationFence: 2,
      });
      const policy = defaultPolicy();
      policy.platforms.android.releaseSelection.source = 'google_play';
      policy.revision = 1;
      await policies.create(policy);
      const release = await releases.create({
        platform: 'android',
        source: 'direct_apk',
        versionName: '0.9.0',
        buildNumber: 9,
        changelogEn: 'Notes after the historical edit',
        storeUrl: null,
        createdBy: actor.uid,
        state: 'withdrawn',
        revision: 2,
      });
      const id = release._id.toString();
      const edit = {
        expectedRevision: 0,
        operationId: randomUUID(),
        reason: 'Historical edit',
        changelogEn: release.changelogEn,
      };
      const withdraw = {
        expectedRevision: 0,
        expectedReleaseRevision: 1,
        operationId: randomUUID(),
        reason: 'Historical cutover to Play',
        replacementPolicy: {
          android: {
            minimumBuild: null,
            source: 'google_play',
            directReleaseId: null,
            storeReleaseId: null,
          },
          ios: { minimumBuild: null, storeReleaseId: null },
        },
      };
      // Seed the successful receipts/audit that the former supported implementation produced.
      for (const [method, action, request] of [
        ['PATCH', 'edit', edit],
        ['POST', 'withdraw', withdraw],
      ]) {
        const route = `${method} /admin/releases/${id}${action === 'edit' ? '' : '/withdraw'}`;
        const command = {
          route,
          request: { ...request },
          action: `releases.${action}`,
          resourceType: 'release',
          reason: request.reason,
        };
        await receipts.create({
          actorUid: actor.uid,
          operationId: request.operationId,
          route,
          requestHash: operationFingerprint(command),
          status: 'succeeded',
          resourceId: id,
          revision: 1,
        });
        await events.create({
          actorUid: actor.uid,
          action: command.action,
          resourceType: 'release',
          resourceId: id,
          operationId: request.operationId,
          reason: request.reason,
          previousRevision: 0,
          nextRevision: 1,
          outcome: 'succeeded',
        });
      }
      const operations = new AdminOperationsService(
        connection,
        access,
        receipts,
        new AdminAuditService(events),
      );
      const config = new ConfigService({
        APK_EXPECTED_PACKAGE_ID: 'com.example.fixture',
      });
      const drafts = new ReleaseDraftsService(releases, operations, config);
      const publication = new ReleasePublicationService(
        policies,
        releases,
        operations,
        config,
      );
      const snapshot = () =>
        Promise.all(
          models.map((model) => model.find().sort({ _id: 1 }).lean()),
        );
      const before = await snapshot();
      const writes = [];
      const observe = ({ commandName }) => {
        if (
          ['insert', 'update', 'delete', 'findAndModify', 'bulkWrite'].includes(
            commandName,
          )
        )
          writes.push(commandName);
      };
      const client = connection.getClient();
      client.on('commandStarted', observe);
      try {
        const edited = await drafts.edit(actor, id, { ...edit });
        assert.equal(edited.source, 'direct_apk');
        assert.equal(edited.state, 'withdrawn');
        assert.equal(edited.revision, 2);
        const withdrawn = await publication.mutate(actor, id, 'withdraw', {
          ...withdraw,
        });
        assert.equal(withdrawn.release.source, 'direct_apk');
        assert.equal(withdrawn.release.revision, 2);
        assert.equal(withdrawn.policyRevision, 1);
        await assert.rejects(
          drafts.edit(actor, id, {
            ...edit,
            changelogEn: 'Changed replay body',
          }),
          (error) => error.response?.code === 'REVISION_CONFLICT',
        );
        assert.deepEqual(writes, []);
      } finally {
        client.off('commandStarted', observe);
      }
      assert.deepEqual(await snapshot(), before);
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);

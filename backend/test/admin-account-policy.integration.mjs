import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ConfigService } from '@nestjs/config';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import {
  AccountPolicy,
  AccountPolicyOverride,
  AccountPolicyOverrideSchema,
  AccountPolicySchema,
  DEFAULT_ACCOUNT_POLICY_VALUES,
} from '../dist/admin-settings/account-policy.schema.js';
import { AccountPolicyService } from '../dist/admin-settings/account-policy.service.js';
import {
  ProcessingAdmissionFence,
  ProcessingAdmissionFenceSchema,
} from '../dist/admin-settings/processing-settings.schema.js';
import { AdminAccessSchema } from '../dist/admin/admin-access.schema.js';
import { AdminAuditEventSchema } from '../dist/admin/admin-audit.schema.js';
import { AdminOperationSchema } from '../dist/admin/admin-operation.schema.js';
import { AdminAuditService } from '../dist/admin/admin-audit.service.js';
import { AdminOperationsService } from '../dist/admin/admin-operations.service.js';
import { User, UserSchema } from '../dist/users/user.schema.js';

const actor = {
  uid: 'account-policy-owner',
  verifiedEmail: 'account-policy-owner@example.invalid',
  role: 'owner',
  permissions: [],
  accessRevision: 0,
  authTimeSec: Math.floor(Date.now() / 1000),
};

const policyCommand = (expectedRevision, monthlyProcessingSeconds) => ({
  ...DEFAULT_ACCOUNT_POLICY_VALUES,
  monthlyProcessingSeconds,
  acceptNewJobs: true,
  maintenanceMessageEn: '',
  maintenanceMessageAr: null,
  expectedRevision,
  operationId: randomUUID(),
  reason: 'Account policy integration review',
});

const outcomeCodes = (results) =>
  results
    .map((result) =>
      result.status === 'fulfilled'
        ? 'fulfilled'
        : (result.reason?.getResponse?.().code ?? result.reason?.message),
    )
    .sort();

test(
  'account policy and one account override are revisioned, fenced, and audited',
  { timeout: 60000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
      connection = await createConnection(mongoUri, {
        bufferCommands: false,
      }).asPromise();
      connection.options = { ...connection.options, sanitizeFilter: true };

      const policies = connection.model(
        AccountPolicy.name,
        AccountPolicySchema,
      );
      const overrides = connection.model(
        AccountPolicyOverride.name,
        AccountPolicyOverrideSchema,
      );
      const fences = connection.model(
        ProcessingAdmissionFence.name,
        ProcessingAdmissionFenceSchema,
      );
      const users = connection.model(User.name, UserSchema);
      const accesses = connection.model('AdminAccess', AdminAccessSchema);
      const events = connection.model('AdminAuditEvent', AdminAuditEventSchema);
      const receipts = connection.model('AdminOperation', AdminOperationSchema);
      await Promise.all(
        [policies, overrides, fences, users, accesses, events, receipts].map(
          (model) => model.init(),
        ),
      );
      await accesses.create({
        uid: actor.uid,
        verifiedEmail: actor.verifiedEmail,
        role: actor.role,
        active: true,
      });
      const accountId = new Types.ObjectId();
      const otherAccountId = new Types.ObjectId();
      const now = new Date();
      await users.create({
        _id: accountId,
        firebaseUid: 'account-policy-user',
        email: 'account-policy-user@example.invalid',
        emailVerified: true,
        displayName: 'Account Policy User',
        nameSource: 'email_prefix',
        providerIds: ['password'],
        status: 'active',
        sessionsRevokedAfterSec: 0,
        profileSyncedAt: now,
        lastSeenAt: now,
      });
      await users.create({
        _id: otherAccountId,
        firebaseUid: 'account-policy-other-user',
        email: 'account-policy-other-user@example.invalid',
        emailVerified: true,
        displayName: 'Other Account Policy User',
        nameSource: 'email_prefix',
        providerIds: ['password'],
        status: 'active',
        sessionsRevokedAfterSec: 0,
        profileSyncedAt: now,
        lastSeenAt: now,
      });
      const operations = new AdminOperationsService(
        connection,
        accesses,
        receipts,
        new AdminAuditService(events),
      );
      const config = new ConfigService({ AUDIO_PROCESSING_ENABLED: true });
      const service = new AccountPolicyService(
        policies,
        overrides,
        fences,
        users,
        operations,
        config,
      );

      const globalRace = await Promise.allSettled([
        service.update(actor, policyCommand(0, 7_200)),
        service.update(actor, policyCommand(0, 10_800)),
      ]);
      assert.deepEqual(outcomeCodes(globalRace), [
        'REVISION_CONFLICT',
        'fulfilled',
      ]);
      const global = await service.current();
      assert.equal(global.revision, 1);
      assert.ok(
        [7_200, 10_800].includes(global.values.monthlyProcessingSeconds),
      );
      assert.equal(global.linkImportEnabled, false);
      assert.deepEqual(global.linkImportDisabledUserIds, []);
      const selectedUserIds = [
        String(accountId),
        String(otherAccountId),
      ].sort();
      const visibilityUpdate = await service.update(actor, {
        ...policyCommand(1, global.values.monthlyProcessingSeconds),
        linkImportEnabled: true,
        linkImportDisabledCountries: ['US', 'EG'],
        linkImportDisabledUserIds: [...selectedUserIds].reverse(),
      });
      assert.equal(visibilityUpdate.revision, 2);
      assert.deepEqual(visibilityUpdate.linkImportDisabledCountries, [
        'EG',
        'US',
      ]);
      assert.equal(visibilityUpdate.linkImportForcedOff, true);
      assert.deepEqual(
        visibilityUpdate.linkImportDisabledUserIds,
        selectedUserIds,
      );
      assert.equal(
        (await policies.findById('standard').lean()).linkImportEnabled,
        true,
      );
      assert.deepEqual(
        (await policies.findById('standard').lean()).linkImportDisabledUserIds,
        selectedUserIds,
      );
      config.set('URL_IMPORT_ENABLED', true);
      const selectedPolicy = await service.publicPolicy(
        '2',
        '1',
        'GB',
        String(accountId),
      );
      assert.equal(selectedPolicy.linkImportVisible, false);
      assert.equal(selectedPolicy.linkImportReason, 'user_hidden');
      assert.equal('linkImportDisabledUserIds' in selectedPolicy, false);
      assert.equal(
        JSON.stringify(selectedPolicy).includes(String(otherAccountId)),
        false,
      );
      assert.equal(
        (await service.publicPolicy('2', '1', 'GB')).linkImportVisible,
        true,
      );
      // Existing exclusions can survive deletion and be cleared using the same policy write.
      await users.deleteOne({ _id: otherAccountId });
      const legacyUpdate = await service.update(
        actor,
        policyCommand(2, global.values.monthlyProcessingSeconds),
      );
      assert.equal(legacyUpdate.revision, 3);
      assert.equal(legacyUpdate.linkImportEnabled, true);
      assert.deepEqual(legacyUpdate.linkImportDisabledCountries, ['EG', 'US']);
      assert.deepEqual(legacyUpdate.linkImportDisabledUserIds, selectedUserIds);
      for (const [userIds, code] of [
        [[String(new Types.ObjectId())], 'RESOURCE_NOT_FOUND'],
        [[String(accountId), String(accountId)], 'INVALID_REQUEST'],
        [['ABCDEFABCDEFABCDEFABCDEF'], 'INVALID_REQUEST'],
        [[`${String(accountId)}\n`], 'INVALID_REQUEST'],
        [[null], 'INVALID_REQUEST'],
      ]) {
        await assert.rejects(
          service.update(actor, {
            ...policyCommand(3, global.values.monthlyProcessingSeconds),
            linkImportDisabledUserIds: userIds,
          }),
          (error) => error.getResponse().code === code,
        );
      }
      assert.equal((await service.current()).revision, 3);
      const restoreCommand = {
        ...policyCommand(3, global.values.monthlyProcessingSeconds),
        linkImportDisabledUserIds: [],
      };
      const restored = await service.update(actor, restoreCommand);
      assert.equal(restored.revision, 4);
      assert.deepEqual(restored.linkImportDisabledUserIds, []);
      assert.deepEqual(await service.update(actor, restoreCommand), restored);
      assert.equal((await service.current()).revision, 4);
      assert.equal(
        (await service.publicPolicy('2', '1', 'GB', String(accountId)))
          .linkImportVisible,
        true,
      );
      assert.equal(
        (await service.publicPolicy('2', '1', 'EG', String(accountId)))
          .linkImportReason,
        'country_hidden',
      );
      await assert.rejects(
        service.update(actor, {
          ...policyCommand(2, global.values.monthlyProcessingSeconds),
          linkImportEnabled: false,
        }),
        (error) => error.getResponse().code === 'REVISION_CONFLICT',
      );

      const created = await service.putOverride(actor, accountId, {
        values: {
          monthlyProcessingSeconds: 3_600,
          monthlyUploadGrants: 300,
          monthlyEstimatedDownloadBytes: 12_000_000_000,
          maxRetainedOutputBytes: 2_000_000_000,
          signedUrlTtlSeconds: 300,
        },
        expiresAt: null,
        expectedRevision: 0,
        operationId: randomUUID(),
        reason: 'Initial reviewed account replacement',
      });
      assert.equal(created.revision, 1);
      assert.equal(created.values.monthlyProcessingSeconds, 3_600);
      assert.equal(created.values.monthlyUploadGrants, 300);
      assert.equal(
        created.values.monthlyEstimatedDownloadBytes,
        12_000_000_000,
      );
      assert.equal(created.values.maxRetainedOutputBytes, 2_000_000_000);
      assert.equal(created.values.signedUrlTtlSeconds, 300);
      assert.equal((await service.currentOverride(accountId)).revision, 1);

      await assert.rejects(
        service.putOverride(actor, accountId, {
          values: { dailyUploadGrants: 400, monthlyUploadGrants: 200 },
          expiresAt: null,
          expectedRevision: 1,
          operationId: randomUUID(),
          reason: 'Invalid cross-field replacement must not be stored',
        }),
        (error) => error.getResponse().code === 'INVALID_REQUEST',
      );

      const expiresAt = new Date(Date.now() + 86_400_000);
      const overrideRace = await Promise.allSettled([
        service.putOverride(actor, accountId, {
          values: { monthlyProcessingSeconds: 1 },
          expiresAt: expiresAt.toISOString(),
          expectedRevision: 1,
          operationId: randomUUID(),
          reason: 'Reviewed lower account replacement',
        }),
        service.putOverride(actor, accountId, {
          values: { monthlyProcessingSeconds: 14_400 },
          expiresAt: expiresAt.toISOString(),
          expectedRevision: 1,
          operationId: randomUUID(),
          reason: 'Reviewed higher account replacement',
        }),
      ]);
      assert.deepEqual(outcomeCodes(overrideRace), [
        'REVISION_CONFLICT',
        'fulfilled',
      ]);
      const currentOverride = await service.currentOverride(accountId);
      assert.equal(currentOverride.revision, 2);
      assert.ok(
        [1, 14_400].includes(currentOverride.values.monthlyProcessingSeconds),
      );
      assert.equal(
        (await service.effective(accountId, new Date(expiresAt.getTime() - 1)))
          .source,
        'account_override',
      );
      assert.equal(
        (await service.effective(accountId, expiresAt)).source,
        'global',
      );

      await assert.rejects(
        service.putOverride(actor, new Types.ObjectId(), {
          values: { monthlyProcessingSeconds: 7_200 },
          expiresAt: null,
          expectedRevision: 0,
          operationId: randomUUID(),
          reason: 'Missing account should not create an override',
        }),
        (error) => error.getResponse().code === 'RESOURCE_NOT_FOUND',
      );
      assert.equal(
        await service.deleteOverride(actor, accountId, {
          expectedRevision: 2,
          operationId: randomUUID(),
          reason: 'Return account to the standard policy',
        }),
        null,
      );
      assert.equal(await service.currentOverride(accountId), null);
      await assert.rejects(
        service.deleteOverride(actor, accountId, {
          expectedRevision: 2,
          operationId: randomUUID(),
          reason: 'A duplicate clear must not silently succeed',
        }),
        (error) => error.getResponse().code === 'REVISION_CONFLICT',
      );

      const successfulEvents = await events.find().lean();
      assert.equal(successfulEvents.length, 7);
      assert.ok(
        successfulEvents.some((event) =>
          event.processingChanges?.some(
            (change) =>
              change.field === 'linkImportDisabledUserIds' &&
              change.after === selectedUserIds.join(','),
          ),
        ),
      );
      assert.deepEqual(
        new Set(successfulEvents.map((event) => event.resourceType)),
        new Set(['account_policy', 'account_policy_override']),
      );
      assert.ok(
        successfulEvents.every(
          (event) =>
            event.reason &&
            event.actorUid === actor.uid &&
            event.processingChanges?.length,
        ),
      );
      assert.equal(await policies.countDocuments(), 1);
      assert.equal(await overrides.countDocuments(), 0);
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);

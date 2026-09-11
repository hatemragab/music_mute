import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createConnection } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { AdminAccessSchema } from '../dist/admin/admin-access.schema.js';
import { AdminAuditEventSchema } from '../dist/admin/admin-audit.schema.js';
import { AdminOperationSchema } from '../dist/admin/admin-operation.schema.js';
import { AdminAuditService } from '../dist/admin/admin-audit.service.js';
import { AdminOperationsService } from '../dist/admin/admin-operations.service.js';
import { ReleaseSchema } from '../dist/releases/release.schema.js';
import { ReleaseUploadSchema } from '../dist/releases/release-upload.schema.js';
import { ReleaseUploadService } from '../dist/releases/release-upload.service.js';
import { ApkVerificationError } from '../dist/releases/apk-verifier.service.js';

test(
  'APK reservations and verification completions remain audited, selected, version-pinned and fenced',
  { timeout: 60000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    const gates = [];
    const running = [];
    try {
      const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
      connection = await createConnection(mongoUri).asPromise();
      const access = connection.model('AdminAccess', AdminAccessSchema),
        events = connection.model('AdminAuditEvent', AdminAuditEventSchema),
        receipts = connection.model('AdminOperation', AdminOperationSchema),
        releases = connection.model('Release', ReleaseSchema),
        uploads = connection.model('ReleaseUpload', ReleaseUploadSchema);
      await Promise.all([
        access.init(),
        events.init(),
        receipts.init(),
        releases.init(),
        uploads.init(),
      ]);
      const actor = {
        uid: 'fixture-release-owner',
        verifiedEmail: 'owner@example.invalid',
        role: 'owner',
        permissions: [],
        accessRevision: 0,
        authTimeSec: Math.floor(Date.now() / 1000),
      };
      await access.create({
        uid: actor.uid,
        verifiedEmail: actor.verifiedEmail,
        role: actor.role,
        active: true,
      });
      const audit = new AdminAuditService(events),
        operations = new AdminOperationsService(
          connection,
          access,
          receipts,
          audit,
        );
      const bytes = 32,
        sha256Hex = 'a'.repeat(64);
      let latestVersion = 'immutable-v1',
        pinError = null,
        verifyError = null,
        verifierCalls = 0,
        verifyHandler = null;
      const downloads = [];
      const storage = {
        grant: async () => ({
          url: 'https://example.invalid/private-fixture-grant',
          fields: { signature: 'fixture-ephemeral-signature' },
          expiresAt: new Date(Date.now() + 900000).toISOString(),
        }),
        pin: async (_reservation, pinned) => {
          if (pinError) throw pinError;
          return pinned ?? latestVersion;
        },
        download: async (_reservation, version) => {
          downloads.push(version);
        },
      };
      const metadata = {
        packageId: 'com.example.fixture',
        minimumSdk: 26,
        signerSha256Hex: 'b'.repeat(64),
      };
      const verifier = {
        verify: async (input) => {
          verifierCalls++;
          await input.download(
            '/unused-synthetic-path',
            new AbortController().signal,
          );
          if (verifyHandler) await verifyHandler();
          if (verifyError) throw verifyError;
          return metadata;
        },
      };
      const service = new ReleaseUploadService(
        releases,
        uploads,
        operations,
        storage,
        verifier,
      );
      let build = 1;
      const draft = () =>
        releases.create({
          platform: 'android',
          source: 'direct_apk',
          versionName: '1.0',
          buildNumber: build++,
          changelogEn: 'Fixture release',
          createdBy: actor.uid,
          artifactState: 'awaiting_upload',
        });
      const reserve = (release, revision = 0) =>
        service.reserve(actor, release._id.toString(), {
          bytes,
          sha256Hex,
          expectedRevision: revision,
          operationId: randomUUID(),
        });
      const complete = (release, reservation, operationId = randomUUID()) =>
        service.complete(actor, release._id.toString(), reservation.uploadId, {
          operationId,
        });
      const release = await draft(),
        reservation = await reserve(release);
      const entered = Promise.withResolvers(),
        gate = Promise.withResolvers();
      gates.push(gate);
      verifyHandler = async () => {
        entered.resolve();
        await gate.promise;
      };
      const operationId = randomUUID(),
        first = complete(release, reservation, operationId);
      running.push(first);
      await entered.promise;
      assert.equal(
        (await service.read(release._id.toString(), reservation.uploadId))
          .artifactState,
        'verifying',
      );
      latestVersion = 'replacement-v2';
      assert.equal(
        (await complete(release, reservation, operationId)).artifactState,
        'verifying',
      );
      assert.equal(verifierCalls, 1);
      gate.resolve();
      assert.equal((await first).artifactState, 'verified');
      assert.equal(
        (await complete(release, reservation, operationId)).artifactState,
        'verified',
      );
      assert.equal(verifierCalls, 1);
      const stored = await releases.findById(release._id).lean();
      assert.equal(stored.artifact.versionId, 'immutable-v1');
      assert.deepEqual(downloads, ['immutable-v1']);
      assert.equal(
        await events.countDocuments({ resourceId: reservation.uploadId }),
        3,
      );
      assert.equal(await receipts.countDocuments(), 3);
      for (const collection of [events, receipts]) {
        const serialized = JSON.stringify(await collection.find().lean());
        assert.equal(serialized.includes('fixture-ephemeral-signature'), false);
        assert.equal(serialized.includes('https://'), false);
        assert.equal(serialized.includes('app-releases/'), false);
      }
      verifyHandler = null;
      // Completed read-back still binds the original operation ID to its route/request.
      const anotherCompleted = await draft();
      const anotherReservation = await reserve(anotherCompleted);
      await complete(anotherCompleted, anotherReservation);
      await assert.rejects(
        complete(anotherCompleted, anotherReservation, operationId),
        (error) => error.getResponse().code === 'REVISION_CONFLICT',
      );
      const replaced = await draft(),
        oldReservation = await reserve(replaced),
        newReservation = await reserve(replaced, 1);
      await assert.rejects(
        complete(replaced, oldReservation),
        (error) => error.getStatus() === 409,
      );
      assert.equal(
        (await complete(replaced, newReservation)).artifactState,
        'verified',
      );
      const wrongSigner = await draft(),
        wrongReservation = await reserve(wrongSigner);
      verifyError = new ApkVerificationError('APK_SIGNER_UNTRUSTED');
      assert.equal(
        (await complete(wrongSigner, wrongReservation)).artifactState,
        'rejected',
      );
      assert.equal(
        (await releases.findById(wrongSigner._id).lean()).artifact,
        null,
      );
      verifyError = null;
      const wrongSize = await draft(),
        sizeReservation = await reserve(wrongSize);
      pinError = new ApkVerificationError('APK_SIZE_MISMATCH');
      const sizeResult = await complete(wrongSize, sizeReservation);
      assert.equal(sizeResult.artifactState, 'rejected');
      assert.equal(sizeResult.code, 'APK_SIZE_MISMATCH');
      pinError = null;
      const stale = await draft(),
        staleReservation = await reserve(stale);
      const staleEntered = Promise.withResolvers(),
        staleGate = Promise.withResolvers();
      gates.push(staleGate);
      let firstVerification = true;
      verifyHandler = async () => {
        if (firstVerification) {
          firstVerification = false;
          staleEntered.resolve();
          await staleGate.promise;
        }
      };
      const oldCompletion = complete(stale, staleReservation);
      running.push(oldCompletion);
      await staleEntered.promise;
      await uploads.updateOne(
        { _id: staleReservation.uploadId },
        { $set: { verificationDeadline: new Date(Date.now() - 1) } },
      );
      const recovered = await complete(stale, staleReservation);
      assert.equal(recovered.artifactState, 'verified');
      staleGate.resolve();
      await assert.rejects(oldCompletion, (error) => error.getStatus() === 409);
      assert.equal(
        (await releases.findById(stale._id).lean()).artifactState,
        'verified',
      );
      verifyHandler = null;
      const rollback = await draft(),
        rollbackReservation = await reserve(rollback);
      const failingAudit = {
        record: async (event, session) => {
          if (event.action === 'releases.upload.verified')
            throw new Error('Synthetic audit failure');
          return audit.record(event, session);
        },
      };
      const failing = new ReleaseUploadService(
        releases,
        uploads,
        new AdminOperationsService(connection, access, receipts, failingAudit),
        storage,
        verifier,
      );
      await assert.rejects(
        failing.complete(
          actor,
          rollback._id.toString(),
          rollbackReservation.uploadId,
          { operationId: randomUUID() },
        ),
      );
      const unfinished = await releases.findById(rollback._id).lean();
      assert.equal(unfinished.artifactState, 'verifying');
      assert.equal(unfinished.artifact, null);
    } finally {
      gates.forEach((gate) => gate.resolve());
      await Promise.allSettled(running);
      await connection?.close();
      await fixture.stop();
    }
  },
);

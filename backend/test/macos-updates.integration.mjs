import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createConnection } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { AdminAccessSchema } from '../dist/admin/admin-access.schema.js';
import { AdminAuditEventSchema } from '../dist/admin/admin-audit.schema.js';
import { AdminOperationSchema } from '../dist/admin/admin-operation.schema.js';
import { AdminAuditService } from '../dist/admin/admin-audit.service.js';
import { AdminOperationsService } from '../dist/admin/admin-operations.service.js';
import {
  MacosUpdateSchema,
  MacosUpdateConfigurationSchema,
} from '../dist/macos-updates/macos-update.schema.js';
import { MacosUpdateService } from '../dist/macos-updates/macos-update.service.js';
import {
  macosArchiveName,
  SPARKLE_SIGN_WARNING,
} from '../dist/macos-updates/macos-appcast.js';

test(
  'macOS channel uses real schema/indexes and audited atomic release selection with immutable recovery',
  { timeout: 60000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
      connection = await createConnection(mongoUri).asPromise();
      connection.options = { ...connection.options, sanitizeFilter: true };
      const access = connection.model('AdminAccess', AdminAccessSchema),
        events = connection.model('AdminAuditEvent', AdminAuditEventSchema),
        receipts = connection.model('AdminOperation', AdminOperationSchema),
        releases = connection.model('MacosUpdate', MacosUpdateSchema),
        configurations = connection.model(
          'MacosUpdateConfiguration',
          MacosUpdateConfigurationSchema,
        );
      await Promise.all(
        [access, events, receipts, releases, configurations].map((model) =>
          model.init(),
        ),
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
      const audit = new AdminAuditService(events),
        operations = new AdminOperationsService(
          connection,
          access,
          receipts,
          audit,
        );
      const grants = [],
        checks = [],
        downloads = [];
      const storage = {
        async grant(release) {
          grants.push(release.key);
          return {
            method: 'PUT',
            url: 'https://fixture.invalid/upload',
            headers: {
              'Content-Type': 'application/octet-stream',
              'If-None-Match': '*',
            },
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          };
        },
        async verify(release) {
          checks.push(release.key);
          return '"immutable-fixture"';
        },
        async download(release) {
          downloads.push(release.key);
          return 'https://fixture.invalid/download';
        },
      };
      const service = new MacosUpdateService(
        releases,
        configurations,
        operations,
        storage,
        new ConfigService({ PUBLIC_SITE_ORIGIN: 'https://example.invalid' }),
      );
      const key = generateKeyPairSync('ed25519'),
        publicEdKey = key.publicKey
          .export({ type: 'spki', format: 'der' })
          .subarray(-32)
          .toString('base64');
      assert.equal((await service.readConfiguration()).configured, false);
      await service.configure(actor, {
        expectedRevision: 0,
        publicEdKey,
        operationId: randomUUID(),
        reason: 'Set fixture trust key',
      });
      function createInput(build) {
        const content = Buffer.from(`Synthetic fixture installer ${build}`),
          sha256Hex = createHash('sha256').update(content).digest('hex'),
          archiveName = macosArchiveName('1.2.3', build, sha256Hex),
          signature = sign(null, content, key.privateKey).toString('base64');
        const prefix = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>${SPARKLE_SIGN_WARNING}<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0"><channel>\n<title>MusicMute updates</title>\n<item><title>MusicMute 1.2.3</title><sparkle:version>${build}</sparkle:version><sparkle:shortVersionString>1.2.3</sparkle:shortVersionString><sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion><sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements><enclosure url="https://example.invalid/macos-updates/artifacts/${archiveName}" length="${content.length}" type="application/octet-stream" sparkle:edSignature="${signature}"></enclosure></item>\n</channel></rss>`;
        const feed = Buffer.from(
          `${prefix}<!-- sparkle-signatures:\nedSignature: ${sign(null, Buffer.from(prefix), key.privateKey).toString('base64')}\nlength: ${Buffer.byteLength(prefix)}\n-->\n\n`,
        );
        return {
          archiveName,
          bytes: content.length,
          sha256Hex,
          appcastBase64: feed.toString('base64'),
          operationId: randomUUID(),
          reason: 'New fixture update',
        };
      }
      const inputs = [createInput('42'), createInput('43')],
        records = [];
      for (const input of inputs) {
        const draft = await service.create(actor, input);
        assert.equal(draft.release.state, 'draft');
        records.push(draft.release);
        assert.equal(
          (await service.create(actor, input)).release.id,
          draft.release.id,
        );
        await assert.rejects(
          service.create(actor, { ...input, operationId: randomUUID() }),
          (error) => error.response?.code === 'REVISION_CONFLICT',
        );
        const upload = {
          operationId: randomUUID(),
          expectedRevision: 0,
          reason: 'Recover saved upload',
        };
        assert.equal(
          (await service.upload(actor, draft.release.id, upload)).release
            .revision,
          1,
        );
        assert.equal(
          (await service.upload(actor, draft.release.id, upload)).release
            .revision,
          1,
        );
        const completion = { operationId: randomUUID() };
        assert.equal(
          (await service.complete(actor, draft.release.id, completion))
            .revision,
          2,
        );
        assert.equal(
          (await service.complete(actor, draft.release.id, completion))
            .revision,
          2,
        );
        assert.equal((await service.create(actor, input)).grant, null);
      }
      assert.equal(checks.length, 2);
      assert.equal(await releases.countDocuments(), 2);
      await assert.rejects(
        service.configure(actor, {
          expectedRevision: 1,
          publicEdKey: Buffer.alloc(32, 1).toString('base64'),
          operationId: randomUUID(),
          reason: 'Rotate fixture trust',
        }),
        (error) => error.response?.code === 'REVISION_CONFLICT',
      );
      assert.equal((await service.readConfiguration()).revision, 1);
      const auditRecord = audit.record.bind(audit);
      audit.record = async () => {
        throw new Error('Fixture audit failure');
      };
      await assert.rejects(
        service.mutate(actor, records[0].id, 'publish', {
          operationId: randomUUID(),
          reason: 'Test audit rollback',
          expectedRevision: 2,
          expectedConfigurationRevision: 1,
        }),
      );
      audit.record = auditRecord;
      assert.equal(await service.appcast(), null);
      assert.equal((await service.detail(records[0].id)).state, 'draft');
      const publications = records.map(() => ({
        operationId: randomUUID(),
        reason: 'Race fixture selection',
        expectedRevision: 2,
        expectedConfigurationRevision: 1,
      }));
      const results = await Promise.allSettled(
        records.map((record, index) =>
          service.mutate(actor, record.id, 'publish', publications[index]),
        ),
      );
      assert.equal(
        results.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      const winner = results.findIndex(
          (result) => result.status === 'fulfilled',
        ),
        loser = 1 - winner;
      assert.equal(
        (await service.readConfiguration()).selectedReleaseId,
        records[winner].id,
      );
      assert.deepEqual(
        await service.appcast(),
        Buffer.from(inputs[winner].appcastBase64, 'base64'),
      );
      assert.equal(
        (
          await service.mutate(
            actor,
            records[winner].id,
            'publish',
            publications[winner],
          )
        ).release.state,
        'published',
      );
      await assert.rejects(
        service.download(records[loser].archiveName),
        (error) => error.response?.code === 'RESOURCE_NOT_FOUND',
      );
      await service.mutate(actor, records[winner].id, 'withdraw', {
        operationId: randomUUID(),
        reason: 'Stop fixture advertising',
        expectedRevision: 3,
        expectedConfigurationRevision: 2,
      });
      assert.equal(await service.appcast(), null);
      assert.equal(
        await service.download(records[winner].archiveName),
        'https://fixture.invalid/download',
      );
      assert.equal(downloads.length, 1);
      assert.ok(grants.length >= 4);
      assert.equal(
        (await service.detail(records[winner].id)).artifactState,
        'verified',
      );
      assert.ok(
        (await releases.findById(records[winner].id).lean())
          .publishedAt instanceof Date,
      );
      assert.equal(
        await events.countDocuments({ action: 'macos_updates.publish' }),
        1,
      );
      assert.equal(
        await events.countDocuments({ action: 'macos_updates.withdraw' }),
        1,
      );
      const page = await service.list({ limit: '1' });
      assert.equal(page.items.length, 1);
      assert.ok(page.nextCursor);
      assert.equal(
        (await service.list({ limit: '1', cursor: page.nextCursor })).items
          .length,
        1,
      );
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);

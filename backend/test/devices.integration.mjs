import 'reflect-metadata';
import { accountFixture } from './helpers/account-fixture.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';

test(
  'real Mongo installation ownership, revisions, concurrent transitions and bounded history',
  { timeout: 30000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
      connection = await createConnection(mongoUri, {
        sanitizeFilter: true,
        bufferCommands: false,
      }).asPromise();
      const { Device, DeviceSchema } =
        await import('../dist/devices/device.schema.js');
      const { DeviceInstallationOwner, DeviceInstallationOwnerSchema } =
        await import('../dist/devices/device-installation-owner.schema.js');
      const { DeviceInstallationOwnersService } =
        await import('../dist/devices/device-installation-owners.service.js');
      const { DevicesService } =
        await import('../dist/devices/devices.service.js');
      const model = connection.model(Device.name, DeviceSchema);
      const ownershipModel = connection.model(
        DeviceInstallationOwner.name,
        DeviceInstallationOwnerSchema,
      );
      await Promise.all([model.init(), ownershipModel.init()]);
      const ownership = new DeviceInstallationOwnersService(ownershipModel);

      const owner = new Types.ObjectId().toString();
      const other = new Types.ObjectId().toString();
      const { access } = await accountFixture(connection, [owner, other]);
      const service = new DevicesService(model, ownership, access);
      const report = {
        installationId: 'd7ea7de6-52e9-4b96-8834-3b517941bdb0',
        platform: 'ios',
        appVersion: '1.0',
        buildNumber: 1,
        metadataRevision: 1,
        osVersion: '26.0',
      };
      const initial = await Promise.all(
        Array.from({ length: 20 }, () => service.sync(owner, 100, report)),
      );
      assert.equal(await model.countDocuments(), 1);
      assert.equal(initial[0].versionHistory.length, 1);
      await service.sync(other, 101, report);
      assert.equal(
        await ownership.isCurrentOwner(
          new Types.ObjectId(other),
          report.installationId,
        ),
        true,
      );
      assert.equal(
        await ownership.isCurrentOwner(
          new Types.ObjectId(owner),
          report.installationId,
        ),
        false,
      );
      await assert.rejects(
        service.sync(owner, 100, report),
        (e) => e.getResponse?.().code === 'DEVICE_REPORT_CONFLICT',
      );
      await service.sync(owner, 102, report);
      const unicodeReport = {
        ...report,
        installationId: '5e1776df-9aa5-4986-b19e-8e7339b5b1da',
        appVersion: '🎵'.repeat(32),
        osVersion: '📱'.repeat(64),
        deviceModel: '🎧'.repeat(100),
      };
      const unicodeDevice = await service.sync(owner, 100, unicodeReport);
      assert.equal(unicodeDevice.appVersion, unicodeReport.appVersion);
      assert.equal(unicodeDevice.osVersion, unicodeReport.osVersion);
      assert.equal(unicodeDevice.deviceModel, unicodeReport.deviceModel);
      assert.equal(
        unicodeDevice.versionHistory[0].appVersion,
        unicodeReport.appVersion,
      );
      assert.equal(await model.countDocuments(), 3);
      const next = { ...report, metadataRevision: 2, buildNumber: 2 };
      const updates = await Promise.all(
        Array.from({ length: 20 }, () => service.sync(owner, 102, next)),
      );
      assert.ok(updates.every((item) => item.versionHistory.length === 2));
      const stale = await service.sync(owner, 99, report);
      assert.equal(stale.buildNumber, 2);
      assert.equal(stale.lastAuthenticatedAtSec, 102);
      await assert.rejects(
        service.sync(owner, 102, { ...next, appVersion: 'different' }),
        (e) => e.status === 409,
      );
      await assert.rejects(
        service.sync(owner, 102, { ...next, platform: 'android' }),
        (e) => e.status === 409,
      );
      const rollback = await service.sync(owner, 102, {
        ...report,
        metadataRevision: 3,
      });
      assert.deepEqual(
        rollback.versionHistory.map((e) => e.buildNumber),
        [1, 2, 1],
      );
      const seen = rollback.lastSeenAt.getTime();
      assert.equal(
        (
          await service.sync(owner, 102, { ...report, metadataRevision: 3 })
        ).lastSeenAt.getTime(),
        seen,
      );
      await model.updateOne(
        { _id: rollback._id },
        { $set: { lastSeenAt: new Date(Date.now() - 600000) } },
      );
      assert.ok(
        (
          await service.sync(owner, 102, { ...report, metadataRevision: 3 })
        ).lastSeenAt.getTime() >
          Date.now() - 5000,
      );
      for (let revision = 4; revision <= 25; revision++)
        await service.sync(owner, 102, {
          ...report,
          metadataRevision: revision,
          buildNumber: revision,
        });
      const final = await service.findOwned(owner, report.installationId);
      assert.equal(final.versionHistory.length, 20);
      assert.equal(final.versionHistory[0].metadataRevision, 6);
      assert.equal(
        (await service.findOwned(other, report.installationId)).buildNumber,
        1,
      );
      const firstPage = await service.listOwned(owner, { limit: 1 });
      assert.equal(firstPage.items.length, 1);
      assert.ok(firstPage.nextCursor);
      const secondPage = await service.listOwned(owner, {
        limit: 1,
        before: firstPage.nextCursor,
      });
      assert.equal(secondPage.items.length, 1);
      assert.equal(secondPage.nextCursor, null);
      assert.notEqual(
        firstPage.items[0]._id.toString(),
        secondPage.items[0]._id.toString(),
      );
      await assert.rejects(
        service.sync(other, 102, report),
        (e) => e.getResponse?.().code === 'DEVICE_REPORT_CONFLICT',
      );
      assert.equal(
        await ownership.isCurrentOwner(
          new Types.ObjectId(owner),
          report.installationId,
        ),
        false,
      );
      assert.equal(
        await ownership.isCurrentOwner(
          new Types.ObjectId(other),
          report.installationId,
        ),
        false,
      );
      await service.sync(owner, 103, report);
      assert.equal(
        await ownership.isCurrentOwner(
          new Types.ObjectId(owner),
          report.installationId,
        ),
        true,
      );
      const ownershipIndexes = await ownershipModel.listIndexes();
      assert.ok(
        ownershipIndexes.every(
          (index) => index.expireAfterSeconds === undefined,
        ),
      );
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);

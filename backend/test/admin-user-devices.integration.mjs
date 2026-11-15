import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';

test(
  'admin device history is user scoped, paginated, read only and retains hidden installations',
  { timeout: 30000 },
  async (t) => {
    const fixture = await IsolatedServices.create();
    t.after(() => fixture.stop());
    const { mongoUri } = await fixture.startDatabases({ replicaSet: true });
    const connection = await createConnection(mongoUri, {
      sanitizeFilter: true,
      bufferCommands: false,
    }).asPromise();
    t.after(() => connection.close());
    const [
      { User, UserSchema },
      { Device, DeviceSchema },
      { DeviceInstallationOwner, DeviceInstallationOwnerSchema },
      { DeviceInstallationOwnersService },
      { DevicesService },
      { AdminUserDevicesService },
    ] = await Promise.all([
      import('../dist/users/user.schema.js'),
      import('../dist/devices/device.schema.js'),
      import('../dist/devices/device-installation-owner.schema.js'),
      import('../dist/devices/device-installation-owners.service.js'),
      import('../dist/devices/devices.service.js'),
      import('../dist/admin-users/admin-user-devices.service.js'),
    ]);
    const users = connection.model(User.name, UserSchema);
    const devices = connection.model(Device.name, DeviceSchema);
    const installationOwners = connection.model(
      DeviceInstallationOwner.name,
      DeviceInstallationOwnerSchema,
    );
    await Promise.all([
      users.init(),
      devices.init(),
      installationOwners.init(),
    ]);

    const userId = new Types.ObjectId();
    const otherId = new Types.ObjectId();
    const emptyId = new Types.ObjectId();
    const now = new Date('2026-10-09T10:00:00.000Z');
    const authenticatedAtSec = Math.floor(now.getTime() / 1000);
    await users.create(
      [userId, otherId, emptyId].map((id, index) => ({
        _id: id,
        firebaseUid: `admin-devices-${index}`,
        displayName: `Device Fixture ${index}`,
        nameSource: 'numeric_alias',
        providerIds: ['password'],
        status: 'active',
        sessionsRevokedAfterSec: 100,
        profileSyncedAt: now,
        lastSeenAt: now,
      })),
    );
    const hiddenInstallationId = 'd7ea7de6-52e9-4b96-8834-3b517941bdb0';
    const visibleInstallationId = '5e1776df-9aa5-4986-b19e-8e7339b5b1da';
    const unknownInstallationId = 'f09d48ad-c982-47c6-9bbd-dd248916b031';
    const base = {
      userId,
      platform: 'web',
      deviceModel: null,
      osVersion: 'Browser',
      appVersion: '1.2.0',
      buildNumber: 12,
      metadataRevision: 20,
      firstSeenAt: new Date('2026-09-01T10:00:00.000Z'),
      lastSeenAt: now,
      lastAuthenticatedAtSec: authenticatedAtSec,
      historyHiddenAt: null,
      location: null,
      versionHistory: Array.from({ length: 20 }, (_, index) => ({
        appVersion: '1.2.0',
        buildNumber: index + 1,
        metadataRevision: index + 1,
        observedAt: now,
      })),
    };
    await devices.create([
      {
        ...base,
        _id: new Types.ObjectId('64b000000000000000000003'),
        installationId: hiddenInstallationId,
        platform: 'ios',
        osVersion: '26.0',
        deviceModel: 'iPhone 17 Pro',
        historyHiddenAt: now,
        location: {
          country: 'EG',
          continent: 'AF',
          region: 'Cairo',
          regionCode: 'C',
          city: 'Cairo',
          postalCode: '11511',
          metroCode: null,
          timezone: 'Africa/Cairo',
          latitude: '30.0444',
          longitude: '31.2357',
          source: 'cloudflare',
          observedAt: now,
        },
      },
      {
        ...base,
        _id: new Types.ObjectId('64b000000000000000000002'),
        installationId: visibleInstallationId,
      },
      {
        ...base,
        _id: new Types.ObjectId('64b000000000000000000001'),
        installationId: unknownInstallationId,
        lastAuthenticatedAtSec: 0,
      },
      {
        ...base,
        _id: new Types.ObjectId('64b000000000000000000004'),
        userId: otherId,
        installationId: hiddenInstallationId,
      },
    ]);
    await installationOwners.create([
      {
        _id: hiddenInstallationId,
        userId: otherId,
        authTimeSec: authenticatedAtSec,
        revision: 1,
        claimedAt: now,
        ambiguousAt: null,
      },
      {
        _id: visibleInstallationId,
        userId,
        authTimeSec: authenticatedAtSec,
        revision: 1,
        claimedAt: now,
        ambiguousAt: null,
      },
    ]);
    const ownership = new DeviceInstallationOwnersService(installationOwners);
    const deviceSessions = new DevicesService(devices, ownership, {});
    const adminDevices = new AdminUserDevicesService(
      users,
      devices,
      deviceSessions,
    );
    const baseline = JSON.stringify(
      await devices.find().sort({ _id: -1 }).lean(),
    );

    const first = await adminDevices.list(userId.toHexString(), { limit: 1 });
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].installationId, hiddenInstallationId);
    assert.equal(first.items[0].sessionStatus, 'signed_out');
    assert.equal(first.items[0].location.country, 'EG');
    assert.equal(first.items[0].location.city, 'Cairo');
    assert.equal(first.items[0].location.latitude, '30.0444');
    assert.equal(first.items[0].lastAuthenticatedAt, now.toISOString());
    assert.equal(
      first.items[0].historyHiddenAt.toISOString(),
      now.toISOString(),
    );
    assert.equal(first.items[0].versionHistory.length, 20);
    assert.equal('userId' in first.items[0], false);
    assert.equal('_id' in first.items[0], false);
    assert.equal('lastAuthenticatedAtSec' in first.items[0], false);
    assert.ok(first.nextCursor);
    assert.ok(Number.isFinite(Date.parse(first.asOf)));

    const second = await adminDevices.list(userId.toHexString(), {
      limit: 1,
      before: first.nextCursor,
    });
    assert.equal(second.items[0].installationId, visibleInstallationId);
    assert.equal(second.items[0].sessionStatus, 'unknown');
    assert.equal(second.items[0].location, null);
    assert.equal(second.items[0].deviceModel, null);
    assert.equal(second.items[0].historyHiddenAt, null);
    assert.ok(second.nextCursor);
    const third = await adminDevices.list(userId.toHexString(), {
      limit: 1,
      before: second.nextCursor,
    });
    assert.equal(third.items[0].installationId, unknownInstallationId);
    assert.equal(third.items[0].sessionStatus, 'signed_out');
    assert.equal(third.items[0].lastAuthenticatedAt, null);
    assert.equal(third.nextCursor, null);
    assert.equal(
      (await deviceSessions.listOwned(userId.toHexString(), {})).items.length,
      2,
    );
    assert.equal(
      JSON.stringify(await devices.find().sort({ _id: -1 }).lean()),
      baseline,
    );

    const other = await adminDevices.list(otherId.toHexString(), { limit: 50 });
    assert.equal(other.items.length, 1);
    assert.equal(other.items[0].installationId, hiddenInstallationId);
    assert.equal(other.items[0].historyHiddenAt, null);
    const empty = await adminDevices.list(emptyId.toHexString(), {});
    assert.deepEqual(empty.items, []);
    assert.equal(empty.nextCursor, null);
    await assert.rejects(
      adminDevices.list(new Types.ObjectId().toHexString(), { limit: 20 }),
      (error) => error.getResponse().code === 'RESOURCE_NOT_FOUND',
    );
    await users.updateOne(
      { _id: userId },
      { $set: { sessionsRevokedAfterSec: authenticatedAtSec } },
    );
    assert.ok(
      (
        await adminDevices.list(userId.toHexString(), { limit: 50 })
      ).items.every((device) => device.sessionStatus === 'signed_out'),
    );
  },
);

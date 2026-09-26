import { accountFixture } from './helpers/account-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose, { createConnection } from 'mongoose';
import { Device, DeviceSchema } from '../dist/devices/device.schema.js';
import {
  DeviceInstallationOwner,
  DeviceInstallationOwnerSchema,
} from '../dist/devices/device-installation-owner.schema.js';
import { DeviceInstallationOwnersService } from '../dist/devices/device-installation-owners.service.js';
import { DevicesService } from '../dist/devices/devices.service.js';
import {
  PushInstallation,
  PushInstallationSchema,
} from '../dist/notifications/push-installation.schema.js';
import { PushRegistrationsService } from '../dist/notifications/push-registration.service.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { User, UserSchema } from '../dist/users/user.schema.js';
import { IsolatedServices } from './helpers/isolated-services.mjs';

const installA = 'd7ea7de6-52e9-4b96-8834-3b517941bdb0';
const installB = '75dcab60-447a-4a44-b116-2dd3e1945d90';
const installC = '33e91b43-a505-4bbb-b4a9-7bf42916c6ed';
const installWeb = 'f09d48ad-c982-47c6-9bbd-dd248916b031';
const installD = '1ec036f6-03d4-49e0-88d6-bb67abe57c88';

test('push bindings survive rotation, account switches, logout and opt-out without destination confusion', async (t) => {
  mongoose.set('sanitizeFilter', true);
  const isolated = await IsolatedServices.create();
  t.after(() => isolated.stop());
  const { mongoUri } = await isolated.startDatabases({ replicaSet: true });
  const connection = await createConnection(mongoUri).asPromise();
  t.after(() => connection.close());
  const users = connection.model(User.name, UserSchema);
  const devices = connection.model(Device.name, DeviceSchema);
  const installationOwners = connection.model(
    DeviceInstallationOwner.name,
    DeviceInstallationOwnerSchema,
  );
  const registrations = connection.model(
    PushInstallation.name,
    PushInstallationSchema,
  );
  await Promise.all([
    users.init(),
    devices.init(),
    installationOwners.init(),
    registrations.init(),
  ]);
  const ownerService = new DeviceInstallationOwnersService(installationOwners);
  const service = new PushRegistrationsService(
    registrations,
    devices,
    users,
    new ProcessingTransactions(connection),
    ownerService,
  );
  const now = new Date();
  const createUser = (firebaseUid) =>
    users.create({
      firebaseUid,
      email: `${firebaseUid}@fixture.invalid`,
      emailVerified: true,
      displayName: firebaseUid,
      nameSource: 'email_prefix',
      providerIds: ['password'],
      status: 'active',
      sessionsRevokedAfterSec: 0,
      profileSyncedAt: now,
      lastSeenAt: now,
    });
  const owner = await createUser('push-owner');
  const other = await createUser('push-other');
  const createDevice = (userId, installationId, platform = 'ios') =>
    devices.create({
      userId,
      installationId,
      platform,
      appVersion: '1.0',
      buildNumber: 1,
      metadataRevision: 1,
      osVersion: '26.0',
      firstSeenAt: now,
      lastSeenAt: now,
      lastAuthenticatedAtSec: 100,
      versionHistory: [],
    });
  await Promise.all([
    createDevice(owner._id, installA),
    createDevice(owner._id, installC),
    createDevice(owner._id, installD),
    createDevice(other._id, installA),
    createDevice(other._id, installB),
    createDevice(other._id, installC),
    createDevice(owner._id, installWeb, 'web'),
  ]);
  await Promise.all([
    ownerService.claim(owner._id.toHexString(), installA, 100),
    ownerService.claim(other._id.toHexString(), installB, 100),
    ownerService.claim(owner._id.toHexString(), installC, 100),
    ownerService.claim(owner._id.toHexString(), installD, 100),
    ownerService.claim(owner._id.toHexString(), installWeb, 100),
  ]);

  await assert.rejects(
    service.register(owner, installWeb, 'fixture-web-push-token', 100),
    (error) => error.getResponse?.().code === 'DEVICE_SYNC_REQUIRED',
  );

  const staleAfterSwitch = await service.register(
    owner,
    installD,
    'fixture-token-before-account-switch',
    100,
  );
  const { access } = await accountFixture(connection);
  const deviceService = new DevicesService(devices, ownerService, access);
  await deviceService.sync(other._id.toHexString(), 101, {
    installationId: installD,
    platform: 'ios',
    appVersion: '1.0',
    buildNumber: 1,
    metadataRevision: 1,
    osVersion: '26.0',
  });
  await assert.rejects(
    deviceService.sync(owner._id.toHexString(), 100, {
      installationId: installD,
      platform: 'ios',
      appVersion: '1.0',
      buildNumber: 1,
      metadataRevision: 1,
      osVersion: '26.0',
    }),
    (error) => error.getResponse?.().code === 'DEVICE_REPORT_CONFLICT',
  );
  assert.equal(
    (
      await service.eligibleFor(owner._id.toHexString(), {
        registrationId: staleAfterSwitch._id.toHexString(),
        bindingRevision: staleAfterSwitch.bindingRevision,
      })
    ).length,
    0,
  );
  await assert.rejects(
    service.register(owner, installD, 'fixture-token-from-stale-account', 102),
    (error) => error.getResponse?.().code === 'DEVICE_SYNC_REQUIRED',
  );

  const first = await service.register(owner, installA, 'fixture-token-a', 100);
  assert.equal(first.bindingRevision, 1);
  const privateProjection = await registrations
    .findOne({ installationId: installA })
    .lean();
  assert.equal('token' in privateProjection, false);
  assert.equal('tokenHash' in privateProjection, false);
  assert.equal((await service.eligibleFor(owner._id.toHexString())).length, 1);
  const rotated = await service.register(
    owner,
    installA,
    'fixture-token-b',
    100,
  );
  assert.equal(rotated.bindingRevision, 2);

  await deviceService.sync(other._id.toHexString(), 101, {
    installationId: installA,
    platform: 'ios',
    appVersion: '1.0',
    buildNumber: 1,
    metadataRevision: 1,
    osVersion: '26.0',
  });
  const switched = await service.register(
    other,
    installA,
    'fixture-token-c',
    101,
  );
  assert.equal(switched.bindingRevision, 3);
  assert.equal((await service.eligibleFor(owner._id.toHexString())).length, 0);
  assert.equal((await service.eligibleFor(other._id.toHexString())).length, 1);

  await service.register(other, installB, 'fixture-token-c', 100);
  assert.equal(
    (await registrations.find({ active: true }).select('+token').lean()).filter(
      (registration) => registration.token === 'fixture-token-c',
    ).length,
    1,
  );
  assert.equal(
    (await registrations.findOne({ installationId: installA }).lean()).active,
    false,
  );

  await users.updateOne(
    { _id: other._id },
    { $set: { sessionsRevokedAfterSec: 100 } },
  );
  assert.equal((await service.eligibleFor(other._id.toHexString())).length, 0);
  const refreshed = await service.register(
    other,
    installB,
    'fixture-token-c',
    101,
  );
  assert.ok(refreshed.bindingRevision > 1);
  assert.equal((await service.eligibleFor(other._id.toHexString())).length, 1);

  const rotatedAgain = await service.register(
    other,
    installB,
    'fixture-token-d',
    102,
  );
  assert.equal(
    (
      await service.eligibleFor(other._id.toHexString(), {
        registrationId: rotatedAgain._id.toHexString(),
        bindingRevision: rotatedAgain.bindingRevision,
      })
    ).length,
    1,
  );
  assert.equal(
    (
      await service.eligibleFor(other._id.toHexString(), {
        registrationId: refreshed._id.toHexString(),
        bindingRevision: refreshed.bindingRevision,
      })
    ).length,
    0,
  );
  assert.equal(
    await service.deactivateIfCurrent(
      other._id.toHexString(),
      installB,
      refreshed._id.toHexString(),
      refreshed.bindingRevision,
    ),
    false,
  );
  assert.equal(
    await service.deactivateIfCurrent(
      other._id.toHexString(),
      installB,
      rotatedAgain._id.toHexString(),
      rotatedAgain.bindingRevision,
    ),
    true,
  );
  const reactivated = await service.register(
    other,
    installB,
    'fixture-token-e',
    103,
  );
  // A delayed logout captured the old revision before a newer registration won.
  await service.deactivate(
    other._id.toHexString(),
    installB,
    rotatedAgain.bindingRevision,
  );
  const afterDelayedLogout = await registrations
    .findOne({ installationId: installB })
    .lean();
  assert.equal(afterDelayedLogout.active, true);
  assert.equal(afterDelayedLogout.bindingRevision, reactivated.bindingRevision);
  assert.equal(afterDelayedLogout.deactivatedAt, null);
  await service.deactivate(
    other._id.toHexString(),
    installB,
    reactivated.bindingRevision,
  );
  await service.deactivate(
    other._id.toHexString(),
    installB,
    reactivated.bindingRevision,
  );
  const currentOptOut = await registrations
    .findOne({ installationId: installB })
    .lean();
  assert.equal(currentOptOut.active, false);
  assert.equal(currentOptOut.bindingRevision, reactivated.bindingRevision + 1);
  const binding = await service.register(
    other,
    installB,
    'fixture-token-current',
    104,
  );
  const beforeOptOut = binding.bindingRevision;

  await service.deactivate(other._id.toHexString(), installB, beforeOptOut);
  await service.deactivate(other._id.toHexString(), installB, beforeOptOut);
  const optedOut = await registrations
    .findOne({ installationId: installB })
    .select('+token +tokenHash')
    .lean();
  assert.equal(optedOut.active, false);
  assert.equal(optedOut.bindingRevision, beforeOptOut + 1);
  assert.ok(optedOut.token);
  assert.equal(
    await registrations.countDocuments({ installationId: installB }),
    1,
  );

  await service.register(other, installB, 'fixture-token-f', 104);
  await Promise.allSettled([
    service.register(owner, installC, 'fixture-race-owner', 100),
    service.register(other, installC, 'fixture-race-other', 102),
  ]);
  assert.equal(
    await registrations.countDocuments({ installationId: installC }),
    1,
  );
  assert.ok(
    (await registrations.findOne({ installationId: installC }).lean())
      .bindingRevision >= 1,
  );

  await deviceService.sync(owner._id.toHexString(), 105, {
    installationId: installA,
    platform: 'ios',
    appVersion: '1.0',
    buildNumber: 1,
    metadataRevision: 1,
    osVersion: '26.0',
  });
  await service.register(owner, installA, 'fixture-page-a', 105);
  await service.register(owner, installC, 'fixture-page-c', 100);
  const snapshotAt = new Date();
  const firstPage = await service.eligiblePage(owner._id.toHexString(), {
    changedBefore: snapshotAt,
    limit: 1,
  });
  assert.equal(firstPage.items.length, 0);
  assert.ok(firstPage.nextCursor);
  const secondPage = await service.eligiblePage(owner._id.toHexString(), {
    changedBefore: snapshotAt,
    throughId: firstPage.throughId,
    afterId: firstPage.nextCursor,
    limit: 1,
  });
  assert.equal(secondPage.items.length, 1);
  assert.ok(secondPage.nextCursor);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await service.register(owner, installC, 'fixture-page-c-rotated', 100);
  const thirdPage = await service.eligiblePage(owner._id.toHexString(), {
    changedBefore: snapshotAt,
    throughId: firstPage.throughId,
    afterId: secondPage.nextCursor,
    limit: 1,
  });
  assert.equal(thirdPage.items.length, 0);
  assert.equal(thirdPage.nextCursor, null);

  await users.updateOne({ _id: other._id }, { $set: { status: 'disabled' } });
  assert.equal((await service.eligibleFor(other._id.toHexString())).length, 0);

  const indexes = await registrations.listIndexes();
  assert.ok(indexes.every((index) => index.expireAfterSeconds === undefined));
  assert.ok(
    indexes.some(
      (index) =>
        index.name === 'push_active_token_hash_unique' && index.unique === true,
    ),
  );
});

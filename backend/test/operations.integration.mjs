import 'reflect-metadata';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnection, Types } from 'mongoose';
import { IsolatedServices } from './helpers/isolated-services.mjs';

test(
  'auth operations inspect and apply indexes, CAS policy, and count versions',
  { timeout: 30000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    try {
      const { mongoUri, redisPort } = await fixture.startDatabases();
      connection = await createConnection(mongoUri, {
        autoCreate: false,
        autoIndex: false,
        sanitizeFilter: true,
        bufferCommands: false,
      }).asPromise();
      const { inspectAuthIndexes, applyAuthIndexes } =
        await import('../dist/operations/auth-indexes.js');
      const { getDeviceStatistics } =
        await import('../dist/operations/device-statistics.js');
      const { PolicyCommand } =
        await import('../dist/operations/policy-command.js');
      const { AppPolicy, AppPolicySchema } =
        await import('../dist/app-policy/app-policy.schema.js');
      const { AppPolicyService } =
        await import('../dist/app-policy/app-policy.service.js');

      const runCli = async (...arguments_) => {
        const child = fixture.spawn(
          process.execPath,
          ['dist/operations/cli.js', ...arguments_],
          {
            MONGODB_URI: mongoUri,
            REDIS_URL: `redis://127.0.0.1:${redisPort}/0`,
          },
        );
        const [code] = await once(child, 'exit');
        assert.equal(code, 0, child.output);
        return JSON.parse(child.output);
      };

      const cliInspection = await runCli('indexes', '--dry-run');
      assert.equal(cliInspection.missing.length, 4);
      assert.deepEqual(await connection.db.listCollections().toArray(), []);
      const emptyStatistics = await runCli('stats', '--days', '30');
      assert.deepEqual(emptyStatistics.totals, {
        installations: 0,
        users: 0,
      });
      assert.deepEqual(await connection.db.listCollections().toArray(), []);

      const absent = await inspectAuthIndexes(connection);
      assert.equal(absent.ready, false);
      assert.deepEqual(
        absent.missing.map((index) => index.name),
        [
          'users_firebase_uid_unique',
          'devices_owner_installation_unique',
          'devices_owner_cursor',
          'devices_recent_versions',
        ],
      );

      await connection.db
        .collection('users')
        .insertMany([
          { firebaseUid: 'duplicate-uid' },
          { firebaseUid: 'duplicate-uid' },
        ]);
      const duplicateInspection = await inspectAuthIndexes(connection);
      assert.deepEqual(
        duplicateInspection.duplicates.find(
          (item) => item.collection === 'users',
        ),
        {
          collection: 'users',
          indexName: 'users_firebase_uid_unique',
          groups: 1,
          documents: 2,
        },
      );
      await assert.rejects(
        applyAuthIndexes(connection),
        /AUTH_INDEX_DUPLICATES/,
      );
      assert.equal(
        (await connection.db.collection('users').listIndexes().toArray()).some(
          (index) => index.name === 'users_firebase_uid_unique',
        ),
        false,
      );

      await connection.db.collection('users').deleteMany({});
      const applied = await applyAuthIndexes(connection);
      assert.deepEqual(applied.applied, [
        'users_firebase_uid_unique',
        'devices_owner_installation_unique',
        'devices_owner_cursor',
        'devices_recent_versions',
      ]);
      assert.equal((await inspectAuthIndexes(connection)).ready, true);
      await connection.db
        .collection('users')
        .insertOne({ firebaseUid: 'unique-fixture' });
      await assert.rejects(
        connection.db
          .collection('users')
          .insertOne({ firebaseUid: 'unique-fixture' }),
        (error) => error.code === 11000,
      );

      const policyModel = connection.model(AppPolicy.name, AppPolicySchema);
      const policy = new PolicyCommand(new AppPolicyService(policyModel));
      const preview = await policy.setPolicy(
        { requireVerifiedEmail: true },
        0,
        false,
      );
      assert.equal(preview.current.requireVerifiedEmail, false);
      assert.equal(preview.next.requireVerifiedEmail, true);
      assert.equal(await policyModel.countDocuments(), 0);
      const updated = await policy.setPolicy(
        { requireVerifiedEmail: true },
        0,
        true,
      );
      assert.equal(updated.next.revision, 1);
      assert.equal(await policyModel.countDocuments(), 1);
      await assert.rejects(
        policy.setPolicy({ requireVerifiedEmail: false }, 0, true),
        (error) => error.status === 409,
      );

      const firstUser = new Types.ObjectId();
      const secondUser = new Types.ObjectId();
      const recent = new Date();
      const old = new Date(recent.getTime() - 60 * 86_400_000);
      await connection.db.collection('user_devices').insertMany([
        {
          userId: firstUser,
          installationId: 'first',
          platform: 'ios',
          appVersion: '1.2.0',
          buildNumber: 12,
          lastSeenAt: recent,
        },
        {
          userId: firstUser,
          installationId: 'second',
          platform: 'ios',
          appVersion: '1.2.0',
          buildNumber: 12,
          lastSeenAt: recent,
        },
        {
          userId: secondUser,
          installationId: 'third',
          platform: 'android',
          appVersion: '1.1.0',
          buildNumber: 11,
          lastSeenAt: recent,
        },
        {
          userId: new Types.ObjectId(),
          installationId: 'old',
          platform: 'android',
          appVersion: '1.0.0',
          buildNumber: 1,
          lastSeenAt: old,
        },
      ]);
      const statistics = await getDeviceStatistics(connection, {
        since: new Date(recent.getTime() - 30 * 86_400_000),
      });
      assert.deepEqual(statistics.totals, { installations: 3, users: 2 });
      assert.equal(statistics.groups.length, 2);
      assert.deepEqual(
        statistics.groups.find((group) => group.platform === 'ios'),
        {
          platform: 'ios',
          appVersion: '1.2.0',
          buildNumber: 12,
          installations: 2,
          users: 1,
        },
      );
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);

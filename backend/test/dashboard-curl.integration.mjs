import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'mongoose';
import {
  IsolatedServices,
  freePort,
  until,
} from './helpers/isolated-services.mjs';

const databasePrefix = 'musicmute_dashboard_curl_';

test(
  'curl exercises every dashboard route and the connected workflow against owned local MongoDB data',
  { timeout: 60000 },
  async () => {
    const services = await IsolatedServices.create();
    const requestedDatabase =
      process.env.DASHBOARD_CURL_DATABASE ??
      `${databasePrefix}${randomUUID().replaceAll('-', '')}`;
    assert.match(requestedDatabase, /^musicmute_dashboard_curl_[a-z0-9_]+$/);
    const mongoUri = `mongodb://127.0.0.1:27017/${requestedDatabase}?replicaSet=rs0`;
    const database = await createConnection(mongoUri, {
      bufferCommands: false,
      serverSelectionTimeoutMS: 5000,
    }).asPromise();
    try {
      const hello = await database.db.admin().command({ hello: 1 });
      assert.equal(hello.isWritablePrimary, true);
      assert.equal(hello.setName, 'rs0');
      const existing = await database.db
        .admin()
        .listDatabases({ nameOnly: true });
      assert.equal(
        existing.databases.some(({ name }) => name === requestedDatabase),
        false,
        `Refusing to reuse existing database ${requestedDatabase}`,
      );
      const redisPort = await freePort();
      const redis = services.spawn(
        process.env.REDIS_BINARY || 'redis-server',
        [
          '--bind',
          '127.0.0.1',
          '--port',
          String(redisPort),
          '--save',
          '',
          '--appendonly',
          'no',
        ],
        {},
        services.directory,
      );
      await until(() => {
        if (redis.failure || redis.exitCode !== null)
          throw new Error('Owned Redis fixture failed to start');
        return redis.output.includes('Ready to accept connections');
      }, 'owned Redis fixture');
      const child = services.spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL('./helpers/dashboard-runtime.mjs', import.meta.url),
          ),
        ],
        {
          MONGODB_URI: mongoUri,
          REDIS_URL: `redis://127.0.0.1:${redisPort}`,
          AUDIO_PROCESSING_ENABLED: 'true',
          APP_UPDATES_ENABLED: 'true',
          APK_EXPECTED_PACKAGE_ID: 'com.example.fixture',
          RELEASE_LANDING_BASE_URL: 'https://example.invalid/',
          RATE_LIMIT: '10000',
          ADMIN_SENSITIVE_OPERATIONS_PER_MINUTE: '30',
          DASHBOARD_HTTP_CLIENT: 'curl',
          DASHBOARD_PROBE_ALL_ROUTES: '1',
        },
        services.directory,
      );
      await until(
        () =>
          child.exitCode !== null || child.signalCode !== null || child.failure,
        'curl dashboard workflow',
        45000,
      );
      assert.equal(child.exitCode, 0, child.output);
      assert.match(
        child.output,
        /DASHBOARD_CURL_OK probes=59 requests=27 auditedEvents=10/,
      );
      const collections = await database.db
        .listCollections({}, { nameOnly: true })
        .toArray();
      const documentCounts = await Promise.all(
        collections.map(({ name }) =>
          database.db.collection(name).countDocuments(),
        ),
      );
      const documents = documentCounts.reduce((sum, count) => sum + count, 0);
      assert.ok(collections.length >= 10);
      assert.ok(documents >= 10);
      console.log(
        `DASHBOARD_CURL_DATABASE_OK collections=${collections.length} documents=${documents}`,
      );
      console.log(
        child.output
          .split('\n')
          .find((line) => line.startsWith('DASHBOARD_CURL_OK')),
      );
    } finally {
      if (process.env.DASHBOARD_KEEP_FIXTURE_DB !== '1')
        await database.dropDatabase();
      await database.close();
      await services.stop();
    }
  },
);

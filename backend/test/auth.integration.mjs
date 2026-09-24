import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from 'mongoose';
import {
  IsolatedServices,
  assertLoopbackUrl,
  freePort,
  until,
} from './helpers/isolated-services.mjs';

test(
  'compiled API with isolated Firebase Auth, MongoDB and shared Redis',
  { timeout: 120000 },
  async () => {
    const fixture = await IsolatedServices.create();
    let connection;
    try {
      const databases = await fixture.startDatabases({ replicaSet: true });
      const { authHost, authOrigin } = await fixture.startAuthEmulator();
      assertLoopbackUrl(authOrigin);
      const rest = async (action, body) => {
        const response = await fetch(
          `${authOrigin}/identitytoolkit.googleapis.com/v1/accounts:${action}?key=fixture-key`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
          },
        );
        assert.equal(response.status, 200, `Emulator ${action} failed`);
        return response.json();
      };
      const credentials = {
        email: 'owner@fixture.invalid',
        password: 'Isolated-password-901',
        returnSecureToken: true,
      };
      const one = await rest('signUp', credentials);
      const two = await rest('signInWithPassword', credentials);
      let other = await rest('signUp', {
        ...credentials,
        email: 'other@fixture.invalid',
      });
      const environment = {
        MONGODB_URI: databases.mongoUri,
        REDIS_URL: `redis://127.0.0.1:${databases.redisPort}/0`,
        FIREBASE_AUTH_EMULATOR_HOST: authHost,
        RATE_LIMIT: '1000',
        AUTH_UID_PER_MINUTE: '1000',
        PROFILE_UID_PER_MINUTE: '100',
        PROFILE_IP_PER_MINUTE: '100',
        DEVICE_UID_PER_MINUTE: '100',
        LOGOUT_UID_PER_HOUR: '100',
      };
      const startApi = async (overrides = {}, entry = 'dist/main.js') => {
        const port = await freePort();
        const child = fixture.spawn(process.execPath, [path.resolve(entry)], {
          ...environment,
          ...overrides,
          PORT: String(port),
        });
        const origin = `http://127.0.0.1:${port}`;
        await until(async () => {
          if (child.failure || child.exitCode !== null)
            throw new Error('Compiled auth API failed to start');
          try {
            return (
              await fetch(`${origin}/api/v1/health/live`, {
                signal: AbortSignal.timeout(500),
              })
            ).ok;
          } catch {
            return false;
          }
        }, 'compiled auth API startup');
        return { child, origin };
      };
      let apiOne = await startApi();
      const apiTwo = await startApi({
        PUBLIC_SUPPORT_EMAIL: 'support@fixture.invalid',
        PUBLIC_DEVELOPER_NAME: 'Fixture Developer',
        PUBLIC_DELETION_TIMEFRAME: 'Fixture timeframe',
        PUBLIC_RETENTION_NOTICE: 'Fixture retention',
      });
      assert.equal(
        (await fetch(`${apiOne.origin}/delete-account`)).status,
        503,
      );
      const publicPage = await fetch(`${apiTwo.origin}/delete-account`);
      assert.equal(publicPage.status, 200);
      assert.match(await publicPage.text(), /mailto:support@fixture.invalid/);
      assert.equal((await fetch(`${apiTwo.origin}/privacy`)).status, 200);
      const call = async (
        api,
        route,
        { token, method = 'GET', body, expected = 200, headers = {} } = {},
      ) => {
        const response = await fetch(`${api.origin}/api/v1${route}`, {
          method,
          headers: {
            ...headers,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, expected, `API ${method} ${route}`);
        return expected === 204 ? null : response.json();
      };
      const firstReport = {
        installationId: '0e47b60a-4835-4cc3-a5b9-2d64d48f8c19',
        platform: 'android',
        appVersion: '0.1.0',
        buildNumber: 1,
        metadataRevision: 1,
        osVersion: '16',
      };
      const runPolicy = async (patch, revision, apply = true) => {
        const file = path.join(fixture.directory, 'operator-policy.json');
        await writeFile(file, JSON.stringify(patch));
        const child = fixture.spawn(
          process.execPath,
          [
            path.resolve('dist/operations/cli.js'),
            'policy',
            apply ? '--apply' : '--dry-run',
            '--file',
            file,
            '--expected-revision',
            String(revision),
          ],
          environment,
        );
        await until(
          () => child.exitCode !== null || child.failure,
          'isolated policy command',
        );
        assert.equal(child.exitCode, 0, 'Isolated policy command succeeded');
      };
      const secondReport = {
        ...firstReport,
        installationId: 'dfd179c2-1685-432f-9659-7f069b270d01',
        platform: 'ios',
        osVersion: '26.0',
      };
      const first = await call(apiOne, '/auth/session', {
        token: one.idToken,
        method: 'POST',
        body: firstReport,
      });
      const second = await call(apiTwo, '/auth/session', {
        token: two.idToken,
        method: 'POST',
        body: secondReport,
      });
      assert.equal(first.user.id, second.user.id);
      assert.equal(first.user.emailVerified, false);
      assert.equal(first.access.allowed, true);
      assert.equal(
        (await call(apiOne, '/users/me/devices', { token: one.idToken })).items
          .length,
        2,
      );
      const { installationId, ...metadata } = firstReport;
      const updated = await call(
        apiOne,
        `/users/me/devices/${installationId}`,
        {
          token: one.idToken,
          method: 'PUT',
          body: { ...metadata, buildNumber: 2, metadataRevision: 2 },
        },
      );
      assert.equal(updated.buildNumber, 2);
      assert.equal(updated.versionHistory.length, 2);
      const probe = await startApi({}, 'test/helpers/processing-api.mjs');
      const installationHeader = {
        'X-Installation-Id': firstReport.installationId,
      };
      await call(probe, '/integration-processing', {
        token: one.idToken,
        headers: installationHeader,
      });
      await runPolicy({ requireVerifiedEmail: true }, 0, false);
      assert.equal((await call(apiOne, '/app-policy')).revision, 0);
      await runPolicy({ requireVerifiedEmail: true }, 0);
      assert.equal((await call(apiOne, '/app-policy')).revision, 1);
      const verificationRequired = await call(
        probe,
        '/integration-processing',
        { token: one.idToken, headers: installationHeader, expected: 403 },
      );
      assert.equal(verificationRequired.code, 'EMAIL_VERIFICATION_REQUIRED');
      await call(apiOne, '/users/me', { token: one.idToken });
      // A later authenticated account switch must outrank the old installation owner.
      await delay(1100);
      other = await rest('signInWithPassword', {
        ...credentials,
        email: 'other@fixture.invalid',
      });
      await call(apiTwo, '/auth/session', {
        token: other.idToken,
        method: 'POST',
        body: firstReport,
      });
      assert.equal(
        (await call(apiTwo, '/users/me/devices', { token: other.idToken }))
          .items.length,
        1,
      );
      assert.equal(
        (await call(apiTwo, '/users/me/devices', { token: other.idToken }))
          .items[0].buildNumber,
        1,
      );
      await call(apiOne, '/auth/verification-email', {
        token: one.idToken,
        method: 'POST',
        body: {},
        expected: 202,
      });
      await call(apiTwo, '/auth/verification-email', {
        token: two.idToken,
        method: 'POST',
        body: {},
        expected: 429,
      });
      await fixture.stopChild(apiOne.child);
      apiOne = await startApi();
      await call(apiOne, '/auth/verification-email', {
        token: one.idToken,
        method: 'POST',
        body: {},
        expected: 429,
      });
      const oobResponse = await fetch(
        `${authOrigin}/emulator/v1/projects/demo-musicmute/oobCodes`,
        { signal: AbortSignal.timeout(5000) },
      );
      assert.equal(oobResponse.status, 200);
      const codes = (await oobResponse.json()).oobCodes;
      const verification = codes.find(
        (item) =>
          item.requestType === 'VERIFY_EMAIL' &&
          item.email === credentials.email,
      );
      assert.ok(verification, 'Emulator verification action exists');
      await rest('update', { oobCode: verification.oobCode });
      // Firebase auth_time has second precision. Returning to the original
      // account must be strictly newer than the intervening owner's sign-in.
      await delay(1100);
      const refreshed = await rest('signInWithPassword', credentials);
      const profile = await call(apiOne, '/auth/profile-sync', {
        token: refreshed.idToken,
        method: 'POST',
        body: {},
      });
      assert.equal(profile.user.emailVerified, true);
      await call(probe, '/integration-processing', {
        token: refreshed.idToken,
        headers: installationHeader,
      });
      await call(apiOne, `/users/me/devices/${installationId}`, {
        token: refreshed.idToken,
        method: 'PUT',
        body: { ...metadata, buildNumber: 3, metadataRevision: 3 },
      });
      await call(probe, '/integration-processing', {
        token: refreshed.idToken,
        headers: installationHeader,
      });
      await call(apiTwo, '/auth/verification-email', {
        token: refreshed.idToken,
        method: 'POST',
        body: {},
        expected: 200,
      });
      await call(apiOne, '/auth/password-reset', {
        method: 'POST',
        body: { email: 'unknown@fixture.invalid' },
        expected: 202,
      });
      await call(apiTwo, '/auth/password-reset', {
        method: 'POST',
        body: { email: 'unknown@fixture.invalid' },
        expected: 429,
      });
      connection = await createConnection(databases.mongoUri, {
        sanitizeFilter: true,
        bufferCommands: false,
      }).asPromise();
      await call(apiOne, '/auth/logout-all', {
        token: refreshed.idToken,
        method: 'POST',
        body: {},
        expected: 204,
      });
      for (const session of [one, two, refreshed])
        await call(apiTwo, '/users/me', {
          token: session.idToken,
          expected: 401,
        });
      assert.equal(
        await connection.collection('user_devices').countDocuments(),
        3,
      );
      await delay(1100);
      const fresh = await rest('signInWithPassword', credentials);
      await call(apiOne, '/users/me', { token: fresh.idToken });
      const deletionIdentity = await rest('signUp', {
        ...credentials,
        email: 'deletion@fixture.invalid',
      });
      const deletionAccount = await call(apiOne, '/auth/session', {
        token: deletionIdentity.idToken,
        method: 'POST',
        body: {
          ...firstReport,
          installationId: '96025b70-64ab-4b2c-a18c-f74e43f7574f',
        },
      });
      await call(apiOne, '/users/me', { method: 'DELETE', expected: 401 });
      await call(apiOne, '/users/me', {
        token: deletionIdentity.idToken,
        method: 'DELETE',
        body: { userId: first.user.id },
        expected: 400,
      });
      const deletionReceipt = await call(apiOne, '/users/me', {
        token: deletionIdentity.idToken,
        method: 'DELETE',
        body: {},
        expected: 202,
      });
      assert.equal(deletionReceipt.status, 'accepted');
      assert.match(deletionReceipt.requestId, /^[0-9a-f-]{36}$/);
      const deletingProfile = await connection
        .collection('users')
        .findOne({ firebaseUid: deletionIdentity.localId });
      assert.equal(deletingProfile.status, 'deleting');
      assert.equal(deletingProfile._id.toString(), deletionAccount.user.id);
      const fencedResponse = await fetch(`${apiOne.origin}/api/v1/users/me`, {
        headers: { Authorization: `Bearer ${deletionIdentity.idToken}` },
      });
      assert.ok([401, 403].includes(fencedResponse.status));
      // Isolate this phase's security keys while exercising two real API processes.
      await fixture.stopChild(apiOne.child);
      await fixture.stopChild(apiTwo.child);
      await fixture.stopChild(probe.child);
      const sharedLimits = {
        RATE_LIMIT: '3',
        RATE_LIMIT_HASH_SECRET: 'isolated-second-phase-shared-secret-000001',
      };
      let limitedOne = await startApi(sharedLimits);
      const limitedTwo = await startApi(sharedLimits);
      await call(limitedOne, '/app-policy');
      await call(limitedTwo, '/app-policy');
      await call(limitedOne, '/app-policy');
      await call(limitedTwo, '/app-policy', { expected: 429 });
      await fixture.stopChild(limitedOne.child);
      limitedOne = await startApi(sharedLimits);
      await call(limitedOne, '/app-policy', { expected: 429 });
      await fixture.stopChild(databases.redis, 'SIGKILL');
      await call(limitedOne, '/app-policy', { expected: 503 });
      // Exceed the old three-attempt retry window before bringing Redis back.
      await delay(1500);
      const restartedRedis = databases.startRedis();
      await until(
        () => restartedRedis.output.includes('Ready to accept connections'),
        'owned Redis restart',
      );
      await until(
        async () => {
          try {
            const response = await fetch(
              `${limitedOne.origin}/api/v1/app-policy`,
              { signal: AbortSignal.timeout(5000) },
            );
            return response.status === 429;
          } catch {
            return false;
          }
        },
        'same API reconnects and preserves acknowledged security limits',
        15000,
      );
    } finally {
      await connection?.close();
      await fixture.stop();
    }
  },
);

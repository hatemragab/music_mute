import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '../dist/auth/auth.guard.js';
import { WorkerAuthGuard } from '../dist/worker-fleet/auth/worker-auth.guard.js';
import {
  WORKER_CREDENTIAL_KIND,
  WORKER_ROUTE,
} from '../dist/worker-fleet/auth/worker-auth.decorators.js';
import { AUTH_OPERATION } from '../dist/auth/auth.decorators.js';
import { Redis } from 'ioredis';
import { RateBudgetService } from '../dist/rate-limits/rate-budget.service.js';
import { RedisThrottlerStorage } from '../dist/rate-limits/redis-throttler.storage.js';
import { securityRedisProvider } from '../dist/rate-limits/security-redis.provider.js';
import { IsolatedServices, until } from './helpers/isolated-services.mjs';

let fixture;
let redisPort;
let databases;
const clients = [];

function client() {
  const redis = new Redis({
    host: '127.0.0.1',
    port: redisPort,
    connectTimeout: 2000,
    commandTimeout: 2000,
    maxRetriesPerRequest: 1,
  });
  redis.on('error', () => undefined);
  clients.push(redis);
  return redis;
}

before(async () => {
  fixture = await IsolatedServices.create();
  databases = await fixture.startDatabases();
  ({ redisPort } = databases);
  const redis = client();
  await redis.flushdb();
});

after(async () => {
  await Promise.allSettled(
    clients.map(async (redis) => {
      if (redis.status !== 'end') await redis.quit();
    }),
  );
  await fixture.stop();
});

test('shares rolling rate budgets atomically through Redis', async (t) => {
  await t.test(
    'isolates authenticated readers sharing an IP and preserves creation budget',
    async () => {
      const read = () => {};
      const create = () => {};
      Reflect.defineMetadata(AUTH_OPERATION, 'processing-read', read);
      Reflect.defineMetadata(AUTH_OPERATION, 'processing-create', create);
      const identity = (uid) => ({ uid, authTimeSec: 100 });
      const guard = new AuthGuard(
        new Reflector(),
        {
          verifySignature: async (uid) => identity(uid),
          verifySession: async (uid) => identity(uid),
        },
        {
          findByFirebaseUid: async () => ({
            _id: 'fixture-account-id',
            status: 'active',
            sessionsRevokedAfterSec: 0,
          }),
        },
        new RateBudgetService(client()),
        {
          bucket: (scope, uid) => `fixture:{project}:job-read:${scope}:${uid}`,
        },
        new ConfigService({
          PROCESSING_READ_UID_PER_MINUTE: 2,
          PROCESSING_CREATE_UID_PER_MINUTE: 1,
        }),
        { assertAllowed: async () => undefined },
      );
      const invoke = (uid, handler) => {
        const req = {
          headers: { authorization: `Bearer ${uid}` },
          rawHeaders: [],
          ip: '192.0.2.1',
        };
        return guard.canActivate({
          getHandler: () => handler,
          getClass: () => class {},
          switchToHttp: () => ({
            getRequest: () => req,
            getResponse: () => ({ setHeader() {} }),
          }),
        });
      };
      assert.equal(await invoke('reader-a', read), true);
      assert.equal(await invoke('reader-a', read), true);
      await assert.rejects(
        invoke('reader-a', read),
        (error) => error.getStatus() === 429,
      );
      assert.equal(await invoke('reader-b', read), true);
      assert.equal(await invoke('reader-a', create), true);
      await assert.rejects(
        invoke('reader-a', create),
        (error) => error.getStatus() === 429,
      );
    },
  );

  await t.test(
    'shares counters across service instances and API restarts',
    async () => {
      const firstClient = client();
      const first = new RateBudgetService(firstClient);
      const second = new RateBudgetService(client());
      const bucket = [
        { key: 'fixture:{project}:shared', limit: 1, windowMs: 60_000 },
      ];

      assert.deepEqual(await first.reserve(bucket), {
        allowed: true,
        retryAfterSeconds: 0,
      });
      assert.equal((await second.reserve(bucket)).allowed, false);

      await firstClient.quit();
      const afterRestart = new RateBudgetService(client());
      assert.equal((await afterRestart.reserve(bucket)).allowed, false);
    },
  );

  await t.test(
    'limits one authenticated worker across guard instances',
    async () => {
      const credential = Buffer.alloc(32, 6).toString('base64url');
      const machine = {
        findOne: () => ({
          maxTimeMS: () => ({
            lean: async () => ({ _id: 'shared-worker', status: 'active' }),
          }),
        }),
      };
      const config = new ConfigService({ WORKER_MACHINE_PER_MINUTE: 1 });
      const keys = {
        bucket: (scope, id) => `fixture:{project}:worker:${scope}:${id}`,
      };
      const workerGuard = () =>
        new WorkerAuthGuard(
          new Reflector(),
          {},
          {},
          machine,
          new RateBudgetService(client()),
          keys,
          config,
        );
      class WorkerEndpoint {
        status() {}
      }
      Reflect.defineMetadata(WORKER_ROUTE, true, WorkerEndpoint);
      Reflect.defineMetadata(WORKER_CREDENTIAL_KIND, 'machine', WorkerEndpoint);
      const retryHeaders = [];
      const invoke = (guard) => {
        return guard.canActivate({
          getHandler: () => WorkerEndpoint.prototype.status,
          getClass: () => WorkerEndpoint,
          switchToHttp: () => ({
            getRequest: () => ({
              headers: { authorization: `Bearer ${credential}` },
              rawHeaders: ['Authorization', `Bearer ${credential}`],
            }),
            getResponse: () => ({
              setHeader: (name, value) => retryHeaders.push([name, value]),
            }),
          }),
        });
      };
      const results = await Promise.allSettled([
        invoke(workerGuard()),
        invoke(workerGuard()),
      ]);
      assert.equal(
        results.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      const rejected = results.find((result) => result.status === 'rejected');
      assert.equal(rejected.reason.getStatus(), 429);
      assert.ok(
        retryHeaders.some(
          ([name, value]) => name === 'Retry-After' && value > 0,
        ),
      );
    },
  );

  await t.test(
    'limits unknown worker credentials before MongoDB across instances',
    async () => {
      let lookups = 0;
      const machine = {
        findOne: () => {
          lookups += 1;
          return { maxTimeMS: () => ({ lean: async () => null }) };
        },
      };
      class WorkerEndpoint {
        status() {}
      }
      Reflect.defineMetadata(WORKER_ROUTE, true, WorkerEndpoint);
      Reflect.defineMetadata(WORKER_CREDENTIAL_KIND, 'machine', WorkerEndpoint);
      const credential = Buffer.alloc(32, 8).toString('base64url');
      const guard = () =>
        new WorkerAuthGuard(
          new Reflector(),
          {},
          {},
          machine,
          new RateBudgetService(client()),
          {
            bucket: (scope, id) =>
              `fixture:{project}:unknown-worker:${scope}:${id}`,
          },
          new ConfigService({ WORKER_PREAUTH_IP_PER_MINUTE: 1 }),
        );
      const invoke = (workerGuard) =>
        workerGuard.canActivate({
          getHandler: () => WorkerEndpoint.prototype.status,
          getClass: () => WorkerEndpoint,
          switchToHttp: () => ({
            getRequest: () => ({
              headers: { authorization: `Bearer ${credential}` },
              rawHeaders: ['Authorization', `Bearer ${credential}`],
              ip: '198.51.100.8',
            }),
            getResponse: () => ({ setHeader() {} }),
          }),
        });
      await assert.rejects(
        invoke(guard()),
        (error) => error.getStatus() === 401,
      );
      await assert.rejects(
        invoke(guard()),
        (error) => error.getStatus() === 429,
      );
      assert.equal(lookups, 1);
    },
  );

  await t.test(
    'does not consume another bucket when a reservation is refused',
    async () => {
      const budgets = new RateBudgetService(client());
      const full = {
        key: 'fixture:{project}:full',
        limit: 1,
        windowMs: 60_000,
      };
      const available = {
        key: 'fixture:{project}:available',
        limit: 1,
        windowMs: 60_000,
      };

      assert.equal((await budgets.reserve([full])).allowed, true);
      assert.equal((await budgets.reserve([available, full])).allowed, false);
      assert.equal((await budgets.reserve([available])).allowed, true);
    },
  );

  await t.test(
    'allows exactly 200 of 201 concurrent reservations',
    async () => {
      const budgets = new RateBudgetService(client());
      const attempts = await Promise.all(
        Array.from({ length: 201 }, () =>
          budgets.reserve([
            {
              key: 'fixture:{project}:verification',
              limit: 200,
              windowMs: 86_400_000,
            },
          ]),
        ),
      );

      assert.equal(attempts.filter((result) => result.allowed).length, 200);
      assert.ok(
        attempts.find((result) => !result.allowed).retryAfterSeconds > 0,
      );
    },
  );

  await t.test(
    'expires rolling reservations based on Redis server time',
    async () => {
      const budgets = new RateBudgetService(client());
      const bucket = [
        { key: 'fixture:{project}:rolling', limit: 1, windowMs: 100 },
      ];

      assert.equal((await budgets.reserve(bucket)).allowed, true);
      assert.equal((await budgets.reserve(bucket)).allowed, false);
      await delay(150);
      assert.equal((await budgets.reserve(bucket)).allowed, true);
    },
  );

  await t.test('expires a shared project pause', async () => {
    const first = new RateBudgetService(client());
    const second = new RateBudgetService(client());
    const key = 'fixture:{project}:pause';

    await first.pause(key, 100);
    assert.equal(await second.isPaused(key), true);
    await delay(150);
    assert.equal(await second.isPaused(key), false);
  });

  await t.test(
    'keeps the route counter TTL separate from its block duration',
    async () => {
      const first = new RedisThrottlerStorage(client());
      const second = new RedisThrottlerStorage(client());
      const key = 'fixture:{project}:api';

      assert.equal(
        (await first.increment(key, 1000, 2, 5000, 'default')).isBlocked,
        false,
      );
      assert.equal(
        (await second.increment(key, 1000, 2, 5000, 'default')).isBlocked,
        false,
      );
      const blocked = await first.increment(key, 1000, 2, 5000, 'default');
      assert.equal(blocked.isBlocked, true);
      assert.ok(blocked.timeToBlockExpire >= 4);
      assert.equal(
        (await second.increment(key, 1000, 2, 5000, 'default')).isBlocked,
        true,
      );
    },
  );

  await t.test(
    'fails closed during an outage and reconnects the provider in the same process',
    async () => {
      const providerClient = securityRedisProvider.useFactory(
        new ConfigService({
          REDIS_URL: `redis://127.0.0.1:${redisPort}/0`,
        }),
      );
      clients.push(providerClient);
      const budgets = new RateBudgetService(providerClient);
      assert.equal(
        (
          await budgets.reserve([
            {
              key: 'fixture:{project}:provider-before-outage',
              limit: 1,
              windowMs: 60_000,
            },
          ])
        ).allowed,
        true,
      );

      await fixture.stopChild(databases.redis, 'SIGKILL');
      await assert.rejects(
        budgets.reserve([
          {
            key: 'fixture:{project}:provider-during-outage',
            limit: 1,
            windowMs: 60_000,
          },
        ]),
        (error) => error?.getStatus?.() === 503,
      );

      const restartedRedis = databases.startRedis();
      await until(
        () => restartedRedis.output.includes('Ready to accept connections'),
        'restarted Redis readiness',
      );
      await until(
        () => providerClient.status === 'ready',
        'security Redis provider reconnection',
      );
      assert.equal(
        (
          await budgets.reserve([
            {
              key: 'fixture:{project}:provider-after-outage',
              limit: 1,
              windowMs: 60_000,
            },
          ])
        ).allowed,
        true,
      );
    },
  );
});

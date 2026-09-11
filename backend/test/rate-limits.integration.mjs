import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigService } from '@nestjs/config';
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

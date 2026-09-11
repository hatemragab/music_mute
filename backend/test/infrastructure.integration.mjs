import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import {
  IsolatedServices,
  freePort,
  until,
} from './helpers/isolated-services.mjs';

test(
  'API uses authenticated external Redis and recovers from dependency outages',
  { timeout: 90000 },
  async () => {
    const services = await IsolatedServices.create();
    const originalEnvironment = process.env;
    let probe;
    try {
      const password = 'isolated-redis-password:@1234';
      const databases = await services.startDatabases({
        redisPassword: password,
      });
      const apiPort = await freePort();
      const environment = services.environment({
        MONGODB_URI: databases.mongoUri,
        REDIS_URL: `redis://default:${encodeURIComponent(password)}@127.0.0.1:${databases.redisPort}/2`,
        PORT: String(apiPort),
        RATE_LIMIT: '1000',
      });
      process.env = environment;
      const { AppModule } = await import('../dist/app.module.js');
      const { StorageClient } =
        await import('../dist/infrastructure/storage.module.js');
      const { SECURITY_REDIS } =
        await import('../dist/rate-limits/security-redis.provider.js');
      probe = await NestFactory.createApplicationContext(AppModule, {
        logger: false,
        abortOnError: false,
      });
      const redis = probe.get(SECURITY_REDIS);
      assert.equal(await redis.ping(), 'PONG');
      assert.equal(redis.options.db, 2);
      assert.equal(await probe.get(StorageClient).config.region(), 'us-east-1');
      await redis.set('isolated:restart-probe', 'retained', 'EX', 120);

      const endpoint = (name) =>
        `http://127.0.0.1:${apiPort}/api/v1/health/${name}`;
      const ready = async () => {
        try {
          return (
            await fetch(endpoint('ready'), {
              signal: AbortSignal.timeout(1000),
            })
          ).ok;
        } catch {
          return false;
        }
      };
      let api = services.spawn(process.execPath, ['dist/main.js'], environment);
      await until(ready, 'compiled API readiness');
      await services.stopChild(api, 'SIGKILL');
      api = services.spawn(process.execPath, ['dist/main.js'], environment);
      await until(ready, 'API readiness after restart');
      assert.equal(await redis.get('isolated:restart-probe'), 'retained');

      await services.stopChild(databases.redis, 'SIGKILL');
      const unavailable = await fetch(endpoint('ready'), {
        signal: AbortSignal.timeout(7000),
      });
      assert.equal(unavailable.status, 503);
      assert.deepEqual(await unavailable.json(), {
        statusCode: 503,
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service unavailable',
      });
      assert.equal((await fetch(endpoint('live'))).status, 200);
      databases.startRedis();
      await until(ready, 'API reconnects after external Redis restarts');
      assert.equal(await redis.get('isolated:restart-probe'), 'retained');
      assert.ok(!api.output.includes(password));
      assert.ok(!api.output.includes(environment.REDIS_URL));

      await services.stopChild(databases.mongo);
      const databaseUnavailable = await fetch(endpoint('ready'), {
        signal: AbortSignal.timeout(7000),
      });
      assert.equal(databaseUnavailable.status, 503);
      assert.equal((await fetch(endpoint('live'))).status, 200);
    } finally {
      await probe?.close();
      await services.stop();
      process.env = originalEnvironment;
    }
  },
);

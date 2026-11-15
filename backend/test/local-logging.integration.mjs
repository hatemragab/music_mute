import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  IsolatedServices,
  freePort,
  until,
} from './helpers/isolated-services.mjs';

test(
  'compiled local API delivers redacted HTTP, MongoDB and Redis observations after idle and sink restart',
  { timeout: 90000 },
  async () => {
    const services = await IsolatedServices.create();
    const records = [];
    const forwardKey =
      process.env.MUSICMUTE_LOG_TEST_FORWARD === '1'
        ? JSON.parse(
            await readFile(
              resolve('../.runtime/local-logging/keys.json'),
              'utf8',
            ),
          ).keys.backend
        : undefined;
    let forwarded = 0;
    let collector;
    try {
      const databases = await services.startDatabases({ replicaSet: true });
      const apiPort = await freePort();
      const collectorPort = await freePort();
      const key = randomUUID();
      const startCollector = async () => {
        collector = createServer((request, response) => {
          assert.equal(request.headers['x-musicmute-log-key'], key);
          assert.equal(request.url, '/ingest/backend');
          let body = '';
          request.on('data', (chunk) => {
            body += chunk;
            assert.ok(body.length <= 65536);
          });
          request.on('end', async () => {
            if (records.length < 5000) records.push(JSON.parse(body));
            if (forwardKey) {
              const result = await fetch(
                'http://127.0.0.1:19740/ingest/backend',
                {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    'x-musicmute-log-key': forwardKey,
                  },
                  body,
                },
              );
              assert.ok(
                result.ok,
                'real local collector accepted synthetic backend activity',
              );
              await result.arrayBuffer();
              forwarded++;
            }
            response.writeHead(202).end();
          });
        });
        collector.listen(collectorPort, '127.0.0.1');
        await once(collector, 'listening');
      };
      await startCollector();
      const environment = services.environment({
        APP_ENV: 'local',
        NODE_ENV: 'development',
        MONGODB_URI: databases.mongoUri,
        REDIS_URL: `redis://127.0.0.1:${databases.redisPort}/0`,
        PORT: String(apiPort),
        MUSICMUTE_LOG_ENABLED: '1',
        MUSICMUTE_LOG_PAYLOADS: '1',
        MUSICMUTE_LOG_CONSOLE: '0',
        MUSICMUTE_LOG_ENDPOINT: `http://127.0.0.1:${collectorPort}/ingest/backend`,
        MUSICMUTE_LOG_KEY: key,
        MUSICMUTE_LOG_CAPTURE_ID: 'isolated-logging-fixture',
      });
      // A private fixture cwd prevents loading the developer's .env.local or data.
      const api = services.spawn(
        process.execPath,
        [resolve('dist/main.js')],
        environment,
        services.directory,
      );
      const endpoint = `http://127.0.0.1:${apiPort}`;
      await until(async () => {
        try {
          return (await fetch(`${endpoint}/health/ready`)).ok;
        } catch {
          return false;
        }
      }, 'compiled local API ready');
      const requestId = randomUUID();
      const secret = 'SYNTHETIC_CREDENTIAL_MUST_NOT_REACH_CAPTURE';
      const response = await fetch(
        `${endpoint}/synthetic-log-fixture?password=${secret}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-request-id': requestId,
            authorization: `Bearer ${secret}`,
          },
          body: JSON.stringify({
            password: secret,
            nested: [{ api_key: secret }],
            safe: 'synthetic-local-activity',
          }),
        },
      );
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('x-request-id'), requestId);
      await response.arrayBuffer();
      await until(
        () =>
          records.some(
            (record) =>
              record.requestId === requestId && record.name === 'http.request',
          ),
        'redacted correlated HTTP event',
      );
      assert.ok(
        records.some(
          (record) =>
            record.name === 'mongodb.command' && record.phase === 'completed',
        ),
      );
      assert.ok(records.some((record) => record.name === 'redis.command'));
      const http = records.find(
        (record) =>
          record.requestId === requestId && record.name === 'http.request',
      );
      assert.equal(http.status, 404);
      assert.equal(http.data.request.body.safe, 'synthetic-local-activity');
      assert.equal(http.data.request.body.password, '[REDACTED]');
      assert.ok(!JSON.stringify(records).includes(secret));
      assert.ok(!JSON.stringify(records).includes(key));

      await delay(2500);
      const idleRequestId = randomUUID();
      const start = performance.now();
      await (
        await fetch(`${endpoint}/health/live`, {
          headers: { 'x-request-id': idleRequestId },
        })
      ).arrayBuffer();
      await until(
        () =>
          records.some(
            (record) =>
              record.requestId === idleRequestId &&
              record.name === 'http.request',
          ),
        'fresh event after idle',
        2000,
      );
      const idleLatencyMs = Math.round(performance.now() - start);
      assert.ok(idleLatencyMs < 2000);

      await new Promise((resolveClose) => collector.close(resolveClose));
      const restartRequestId = randomUUID();
      await (
        await fetch(`${endpoint}/health/live`, {
          headers: { 'x-request-id': restartRequestId },
        })
      ).arrayBuffer();
      await delay(200);
      await startCollector();
      await until(
        () =>
          records.some(
            (record) =>
              record.requestId === restartRequestId &&
              record.name === 'http.request',
          ),
        'bounded delivery recovers after collector restart',
      );
      assert.ok(!api.output.includes(secret));
      const categories = [
        ...new Set(records.map((record) => record.category)),
      ].sort();
      console.log(
        JSON.stringify({
          proof: 'isolated-compiled-api-local-logging',
          categories,
          idleLatencyMs,
          records: records.length,
          forwarded,
          capture: 'in-memory-test-collector',
          realCredentialsOrServices: false,
        }),
      );
    } finally {
      await services.stop();
      if (collector?.listening)
        await new Promise((resolveClose) => collector.close(resolveClose));
    }
  },
);

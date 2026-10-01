import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { getConnectionToken } from '@nestjs/mongoose';
import { IsolatedServices, until } from './helpers/isolated-services.mjs';
import { spawnSync } from 'node:child_process';

test('fatal diagnostic survives process exit without swallowing exceptions or rejections', () => {
  for (const [origin, code] of [
    [
      'uncaughtException',
      'setImmediate(() => { throw new Error("synthetic failure"); });',
    ],
    ['unhandledRejection', 'Promise.reject(new Error("synthetic failure"));'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { installFatalDiagnostics } from './dist/observability/fatal-errors.js';
      installFatalDiagnostics();
      ${code}
    `,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, APP_ENV: 'test', SENTRY_ENABLED: 'false' },
      },
    );
    assert.equal(result.status, 1);
    const event = result.stderr
      .split('\n')
      .find((line) => line.startsWith('{"event":"backend-fatal"'));
    assert.ok(event);
    assert.equal(JSON.parse(event).origin, origin);
    assert.equal(event.includes('synthetic failure'), false);
  }
});

test(
  'enabled import processor boots through Nest and stops cleanly',
  { timeout: 90000 },
  async () => {
    const services = await IsolatedServices.create();
    const originalEnvironment = process.env;
    let app;
    try {
      const databases = await services.startDatabases({ replicaSet: true });
      process.env = services.environment({
        MONGODB_URI: databases.mongoUri,
        REDIS_URL: `redis://127.0.0.1:${databases.redisPort}/3`,
        URL_IMPORT_ENABLED: 'false',
        URL_IMPORT_PROCESSOR_ENABLED: 'true',
        URL_IMPORT_CONCURRENCY: '20',
        URL_IMPORT_REQUESTS_PER_SECOND: '5',
        URL_IMPORT_TEMP_ROOT: join(services.directory, 'imports'),
        AUDIO_ACQUISITION_API_URL: 'http://127.0.0.1:9/',
        AUDIO_ACQUISITION_API_KEY: randomUUID(),
      });
      const { AppModule } = await import('../dist/app.module.js');
      const { ImportProcessor } =
        await import('../dist/url-imports/import-processor.js');
      const { IMPORT_QUEUE } =
        await import('../dist/url-imports/imports.service.js');
      const { ImportRuntime } =
        await import('../dist/url-imports/import-runtime.js');
      const { RealtimeFeedService } =
        await import('../dist/realtime/realtime-feed.service.js');
      app = await NestFactory.createApplicationContext(AppModule, {
        logger: false,
        abortOnError: false,
      });
      const queue = app.get(getQueueToken(IMPORT_QUEUE));
      const processor = app.get(ImportProcessor);
      assert.equal(await queue.getGlobalConcurrency(), 20);
      assert.deepEqual(await queue.getGlobalRateLimit(), {
        max: 5,
        duration: 1000,
      });
      assert.equal(processor.worker.isRunning(), true);
      assert.equal(processor.worker.concurrency, 20);
      const runtime = app.get(ImportRuntime);
      const feed = app.get(RealtimeFeedService);
      assert.equal(
        runtime.feed,
        feed,
        'imports and realtime share one feed instance',
      );
      await until(
        () => feed.healthy && !runtime.maintenance,
        'shared feed ready',
      );
      let wakeups = 0;
      const enqueue = runtime.enqueueSharedImports.bind(runtime);
      runtime.enqueueSharedImports = async () => {
        wakeups++;
        await enqueue();
      };
      const db = app.get(getConnectionToken());
      const session = await db.startSession();
      const start = performance.now();
      try {
        await session.withTransaction(() =>
          db.collection('shared_media_sources').insertOne(
            {
              _id: randomUUID(),
              state: 'ready',
            },
            { session },
          ),
        );
      } finally {
        await session.endSession();
      }
      await until(
        () => wakeups > 0,
        'committed shared source wakes import maintenance',
        5000,
      );
      assert.ok(
        performance.now() - start < 5000,
        'does not wait for the 30-second recovery cycle',
      );
      await app.close();
      app = undefined;
      assert.equal(processor.shutdown.signal.aborted, true);
      assert.equal(processor.worker.isRunning(), false);
    } finally {
      await app?.close();
      await services.stop();
      process.env = originalEnvironment;
    }
  },
);

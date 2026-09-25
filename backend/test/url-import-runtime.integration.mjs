import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { IsolatedServices } from './helpers/isolated-services.mjs';

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
        URL_IMPORT_CONCURRENCY: '1',
        URL_IMPORT_TEMP_ROOT: join(services.directory, 'imports'),
        YTDLP_API_URL: 'http://127.0.0.1:9/',
        YTDLP_API_KEY: randomUUID(),
      });
      const { AppModule } = await import('../dist/app.module.js');
      const { ImportProcessor } =
        await import('../dist/url-imports/import-processor.js');
      const { IMPORT_QUEUE } =
        await import('../dist/url-imports/imports.service.js');
      app = await NestFactory.createApplicationContext(AppModule, {
        logger: false,
        abortOnError: false,
      });
      const queue = app.get(getQueueToken(IMPORT_QUEUE));
      const processor = app.get(ImportProcessor);
      assert.equal(await queue.getGlobalConcurrency(), 1);
      assert.equal(processor.worker.isRunning(), true);
      assert.equal(processor.worker.concurrency, 1);
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

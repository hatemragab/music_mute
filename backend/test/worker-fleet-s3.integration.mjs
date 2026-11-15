import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { IsolatedServices, until } from './helpers/isolated-services.mjs';

const requiredEnvironment = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'S3_BUCKET',
];

test(
  'compiled API and worker runtime complete one-PUT transfers against real S3',
  { timeout: 300_000 },
  async () => {
    for (const key of requiredEnvironment)
      assert.ok(process.env[key], `Missing required environment key: ${key}`);

    const services = await IsolatedServices.create();
    try {
      const { mongoUri, redisPort } = await services.startDatabases({
        replicaSet: true,
      });
      const child = services.spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL('./helpers/worker-fleet-runtime.mjs', import.meta.url),
          ),
        ],
        {
          MONGODB_URI: mongoUri,
          REDIS_URL: `redis://127.0.0.1:${redisPort}/0`,
          AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
          AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
          ...(process.env.AWS_SESSION_TOKEN
            ? { AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN }
            : {}),
          AWS_REGION: process.env.AWS_REGION,
          S3_BUCKET: process.env.S3_BUCKET,
          AUDIO_PROCESSING_ENABLED: 'true',
          RATE_LIMIT: '10000',
          AUTH_UID_PER_MINUTE: '10000',
          PROCESSING_CREATE_UID_PER_MINUTE: '10000',
          PROCESSING_GRANT_UID_PER_MINUTE: '10000',
          PROCESSING_MUTATION_UID_PER_MINUTE: '10000',
          WORKER_INTEGRATION_STORAGE: 's3',
          WORKER_INTEGRATION_RUN_ID: randomUUID(),
          WORKER_INTEGRATION_INPUT_BYTES: '65536',
        },
        services.directory,
      );
      await until(
        () =>
          child.exitCode !== null || child.signalCode !== null || child.failure,
        'worker fleet real S3 integration workflow',
        270_000,
      );
      assert.equal(child.exitCode, 0, child.output);
      assert.match(
        child.output,
        /WORKER_FLEET_INTEGRATION_OK storage=s3 platform=simulated status=ready ownership=pass recovery=pass cancellation=pass security=pass/,
      );
      assert.match(child.output, /WORKER_FLEET_S3_CLEANUP_OK deleted=4/);
    } finally {
      await services.stop();
    }
  },
);

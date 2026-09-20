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
  'WORKER_INTEGRATION_MACHINE_ID',
  'WORKER_INTEGRATION_WORKER_ID',
  'WORKER_INTEGRATION_GPU_ID',
  'WORKER_INTEGRATION_CREDENTIAL_DIGEST',
  'WORKER_INTEGRATION_INPUT_PATH',
];

test(
  'installed macOS service completes a CoreML job through local API and real S3',
  { timeout: 20 * 60_000 },
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
          PROCESSING_READ_UID_PER_MINUTE: '10000',
          PROCESSING_CREATE_UID_PER_MINUTE: '10000',
          PROCESSING_GRANT_UID_PER_MINUTE: '10000',
          PROCESSING_MUTATION_UID_PER_MINUTE: '10000',
          WORKER_INTEGRATION_STORAGE: 's3',
          WORKER_INTEGRATION_EXTERNAL: 'true',
          WORKER_INTEGRATION_EXTERNAL_PLATFORM: 'darwin-arm64',
          WORKER_INTEGRATION_RUN_ID: randomUUID(),
          WORKER_INTEGRATION_PORT: '3100',
          WORKER_INTEGRATION_MACHINE_ID:
            process.env.WORKER_INTEGRATION_MACHINE_ID,
          WORKER_INTEGRATION_WORKER_ID:
            process.env.WORKER_INTEGRATION_WORKER_ID,
          WORKER_INTEGRATION_GPU_ID: process.env.WORKER_INTEGRATION_GPU_ID,
          WORKER_INTEGRATION_CREDENTIAL_DIGEST:
            process.env.WORKER_INTEGRATION_CREDENTIAL_DIGEST,
          WORKER_INTEGRATION_INPUT_PATH:
            process.env.WORKER_INTEGRATION_INPUT_PATH,
        },
        services.directory,
      );
      await until(
        () =>
          child.output.includes('WORKER_FLEET_EXTERNAL_JOB_QUEUED') ||
          child.exitCode !== null ||
          child.signalCode !== null ||
          child.failure,
        'external macOS worker integration readiness',
        120_000,
      );
      assert.equal(child.exitCode, null, child.output);
      assert.match(child.output, /WORKER_FLEET_EXTERNAL_JOB_QUEUED port=3100/);
      console.log('WORKER_FLEET_MACOS_SERVICE_READY port=3100');

      await until(
        () =>
          child.exitCode !== null || child.signalCode !== null || child.failure,
        'external macOS worker integration completion',
        17 * 60_000,
      );
      assert.equal(child.exitCode, 0, child.output);
      assert.match(
        child.output,
        /WORKER_FLEET_INTEGRATION_OK storage=s3 platform=macos-coreml-service status=ready/,
      );
      assert.match(child.output, /WORKER_FLEET_S3_CLEANUP_OK deleted=2/);
    } finally {
      await services.stop();
    }
  },
);

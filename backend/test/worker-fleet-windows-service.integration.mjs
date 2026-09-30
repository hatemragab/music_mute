import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { IsolatedServices, until } from './helpers/isolated-services.mjs';

const requiredEnvironment = [
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
  'STORAGE_REGION',
  'STORAGE_BUCKET',
  'STORAGE_ENDPOINT',
  'WORKER_INTEGRATION_MACHINE_ID',
  'WORKER_INTEGRATION_WORKER_ID',
  'WORKER_INTEGRATION_GPU_ID',
  'WORKER_INTEGRATION_CREDENTIAL_DIGEST',
  'WORKER_INTEGRATION_INPUT_PATH',
];

test(
  'installed Windows service completes a DirectML job through local API and real R2',
  {
    timeout: 20 * 60_000,
    skip: process.env.MUSICMUTE_R2_INTEGRATION !== 'true',
  },
  async () => {
    for (const key of requiredEnvironment)
      assert.ok(process.env[key], `Missing required environment key: ${key}`);

    assert.match(
      process.env.STORAGE_BUCKET,
      /^music-mute-test-[a-z0-9-]+$/,
      'Use a dedicated R2 integration test bucket',
    );
    assert.match(
      process.env.STORAGE_ENDPOINT,
      /^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com\/?$/,
      'Use an R2 account endpoint',
    );
    assert.equal(process.env.STORAGE_REGION, 'auto');
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
          STORAGE_ACCESS_KEY_ID: process.env.STORAGE_ACCESS_KEY_ID,
          STORAGE_SECRET_ACCESS_KEY: process.env.STORAGE_SECRET_ACCESS_KEY,
          STORAGE_REGION: process.env.STORAGE_REGION,
          STORAGE_BUCKET: process.env.STORAGE_BUCKET,
          STORAGE_PROVIDER: 'r2',
          STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT,
          AUDIO_PROCESSING_ENABLED: 'true',
          RATE_LIMIT: '10000',
          AUTH_UID_PER_MINUTE: '10000',
          PROCESSING_READ_UID_PER_MINUTE: '10000',
          PROCESSING_CREATE_UID_PER_MINUTE: '10000',
          PROCESSING_GRANT_UID_PER_MINUTE: '10000',
          PROCESSING_MUTATION_UID_PER_MINUTE: '10000',
          WORKER_INTEGRATION_STORAGE: 'r2',
          WORKER_INTEGRATION_EXTERNAL: 'true',
          WORKER_INTEGRATION_EXTERNAL_PLATFORM: 'windows-amd64',
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
        'external Windows worker integration readiness',
        120_000,
      );
      assert.equal(child.exitCode, null, child.output);
      assert.match(child.output, /WORKER_FLEET_EXTERNAL_JOB_QUEUED port=3100/);
      console.log('WORKER_FLEET_WINDOWS_SERVICE_READY port=3100');

      await until(
        () =>
          child.exitCode !== null || child.signalCode !== null || child.failure,
        'external Windows worker integration completion',
        17 * 60_000,
      );
      assert.equal(child.exitCode, 0, child.output);
      assert.match(
        child.output,
        /WORKER_FLEET_INTEGRATION_OK storage=r2 platform=windows-directml-service status=ready/,
      );
      assert.match(child.output, /WORKER_FLEET_R2_CLEANUP_OK deleted=2/);
    } finally {
      await services.stop();
    }
  },
);

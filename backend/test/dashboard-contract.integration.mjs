import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  IsolatedServices,
  freePort,
  until,
} from './helpers/isolated-services.mjs';

test(
  'compiled dashboard modules execute one connected administrative workflow and plain main starts',
  { timeout: 60000 },
  async () => {
    const services = await IsolatedServices.create();
    try {
      const { mongoUri, redisPort } = await services.startDatabases({
        replicaSet: true,
      });
      const redisUrl = `redis://127.0.0.1:${redisPort}`;
      const environment = {
        MONGODB_URI: mongoUri,
        REDIS_URL: redisUrl,
        AUDIO_PROCESSING_ENABLED: 'true',
        APP_UPDATES_ENABLED: 'true',
        APK_EXPECTED_PACKAGE_ID: 'com.example.fixture',
        RELEASE_LANDING_BASE_URL: 'https://example.invalid/',
        ADMIN_SENSITIVE_OPERATIONS_PER_MINUTE: '30',
        ...(process.env.DASHBOARD_CAPTURE_CONTRACTS === '1'
          ? { DASHBOARD_CAPTURE_CONTRACTS: '1' }
          : {}),
      };
      const child = services.spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL('./helpers/dashboard-runtime.mjs', import.meta.url),
          ),
        ],
        environment,
        services.directory,
      );
      await until(
        () =>
          child.exitCode !== null || child.signalCode !== null || child.failure,
        'dashboard workflow process',
        40000,
      );
      assert.equal(child.exitCode, 0, child.output);
      assert.match(child.output, /DASHBOARD_RUNTIME_OK/);
      console.log(
        child.output
          .split('\n')
          .find((line) => line.startsWith('DASHBOARD_RUNTIME_OK')),
      );
      if (process.env.DASHBOARD_CAPTURE_CONTRACTS === '1')
        console.log(
          child.output
            .split('\n')
            .find((line) => line.startsWith('DASHBOARD_CONTRACT_SNAPSHOTS=')),
        );
      const port = await freePort();
      const main = services.spawn(
        process.execPath,
        [fileURLToPath(new URL('../dist/main.js', import.meta.url))],
        {
          ...environment,
          AUDIO_PROCESSING_ENABLED: 'false',
          PORT: String(port),
        },
        services.directory,
      );
      await until(
        async () => {
          if (main.exitCode !== null || main.failure)
            throw new Error('Compiled main exited before readiness');
          try {
            return (
              (
                await fetch(`http://127.0.0.1:${port}/health/ready`, {
                  signal: AbortSignal.timeout(2000),
                })
              ).status === 200
            );
          } catch {
            return false;
          }
        },
        'plain compiled main readiness',
        15000,
      );
      assert.equal(
        (await fetch(`http://127.0.0.1:${port}/health/live`)).status,
        200,
      );
    } finally {
      await services.stop();
    }
  },
);

import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { IsolatedServices, until } from './helpers/isolated-services.mjs';

test(
  'compiled API and worker runtime complete the authoritative job flow',
  {
    timeout:
      process.env.WORKER_INTEGRATION_REAL_GPU === 'true' ? 180_000 : 120_000,
  },
  async () => {
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
          AUDIO_PROCESSING_ENABLED: 'true',
          RATE_LIMIT: '10000',
          AUTH_UID_PER_MINUTE: '10000',
          PROCESSING_CREATE_UID_PER_MINUTE: '10000',
          PROCESSING_GRANT_UID_PER_MINUTE: '10000',
          PROCESSING_MUTATION_UID_PER_MINUTE: '10000',
          NUMBA_CACHE_DIR: `${services.directory}/numba-cache`,
          ...Object.fromEntries(
            [
              'WORKER_INTEGRATION_REAL_GPU',
              'WORKER_INTEGRATION_INPUT_PATH',
              'WORKER_INTEGRATION_INPUT_DURATION_SECONDS',
              'WORKER_INTEGRATION_PYTHON',
              'WORKER_INTEGRATION_MODEL_CACHE',
              'WORKER_INTEGRATION_FFMPEG',
              'WORKER_INTEGRATION_FFPROBE',
              'WORKER_INTEGRATION_ENGINE',
            ]
              .filter((name) => process.env[name] !== undefined)
              .map((name) => [name, process.env[name]]),
          ),
        },
        services.directory,
      );
      await until(
        () =>
          child.exitCode !== null || child.signalCode !== null || child.failure,
        'worker fleet integration workflow',
        process.env.WORKER_INTEGRATION_REAL_GPU === 'true' ? 150_000 : 90_000,
      );
      assert.equal(child.exitCode, 0, child.output);
      assert.match(
        child.output,
        /WORKER_FLEET_INTEGRATION_OK storage=fixture platform=simulated status=ready ownership=pass recovery=pass cancellation=pass security=pass/,
      );
      if (process.env.WORKER_INTEGRATION_REAL_GPU === 'true') {
        assert.match(child.output, /WORKER_FLEET_REAL_GPU_OK/);
        assert.match(child.output, /WORKER_FLEET_REAL_GPU_STAGES/);
        for (const line of child.output.split('\n'))
          if (line.startsWith('WORKER_FLEET_REAL_GPU_')) console.log(line);
      }
    } finally {
      await services.stop();
    }
  },
);

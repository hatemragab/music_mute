import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from 'mongoose';
import { Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { pairedWorkerFixture } from './helpers/paired-worker-fixture.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { WorkerEventSchema } from '../dist/worker-events/worker-event.schema.js';
import { WorkerEventsService } from '../dist/worker-events/worker-events.service.js';
import {
  InstallationEventsController,
  PermanentWorkerEventsController,
} from '../dist/worker-events/worker-events.controller.js';
import { InstallationPairingService } from '../dist/worker-installations/installation-pairing.service.js';
import { InstallationLimitsService } from '../dist/worker-installations/installation-limits.service.js';
import { WorkerInstallationsController } from '../dist/worker-installations/worker-installations.controller.js';
import { WorkerUpdateController } from '../dist/worker-releases/worker-releases.controller.js';
import { WorkerRolloutsService } from '../dist/worker-releases/worker-rollouts.service.js';
import { tokenDigest } from '../dist/worker-installations/installation-secrets.js';
import { WorkerRegistryService } from '../dist/worker/worker-registry.service.js';
import { WorkerIdentityService } from '../dist/worker/worker-identity.service.js';
import { WorkerAuthGuard } from '../dist/worker/worker-auth.guard.js';
import { RateBudgetService } from '../dist/rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../dist/rate-limits/rate-limit-keys.js';
import { configureHttp } from '../dist/http/configure-http.js';

function client(settings) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.MUSICMUTE_TEST_PYTHON ?? 'python3',
      [
        '-I',
        '-B',
        fileURLToPath(
          new URL('./helpers/worker-spool-client.py', import.meta.url),
        ),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.stdout.on('data', (data) => {
      stdout += data;
      if (stdout.length > 65536) child.kill('SIGKILL');
    });
    child.stderr.on('data', (data) => {
      stderr += data;
      if (stderr.length > 65536) child.kill('SIGKILL');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0)
        return reject(new Error(`Spool fixture exited ${code}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(settings));
  });
}

test(
  'Python spool retries accepted setup event after restart under permanent auth',
  { timeout: 60000 },
  async (t) => {
    const native = await IsolatedServices.create();
    t.after(() => native.stop());
    const services = await native.startDatabases({ replicaSet: true });
    const db = await createConnection(services.mongoUri).asPromise();
    t.after(() => db.close());
    const redis = new Redis(`redis://127.0.0.1:${services.redisPort}`, {
      maxRetriesPerRequest: 0,
    });
    t.after(() => redis.disconnect());
    for (const { name, schema } of PROCESSING_MODELS) db.model(name, schema);
    const events = db.model('WorkerEvent', WorkerEventSchema);
    await Promise.all(Object.values(db.models).map((model) => model.init()));
    const worker = await pairedWorkerFixture(db);
    const setupToken = randomBytes(32).toString('hex');
    await db
      .model('WorkerInstallation')
      .updateOne(
        { _id: worker.installationId },
        { $set: { tokenSha256: tokenDigest(setupToken) } },
      );
    const config = new ConfigService({
      RATE_LIMIT_HASH_SECRET: randomBytes(32).toString('hex'),
      FIREBASE_PROJECT_ID: 'isolated-worker-spool',
      AUDIO_PROCESSING_ENABLED: false,
      BODY_LIMIT_BYTES: 1048576,
      CORS_ORIGINS: '',
      WORKER_EVENTS_SETUP_BYTES_PER_DAY: 2097152,
      WORKER_EVENTS_WORKER_BYTES_PER_DAY: 20971520,
      WORKER_EVENTS_BATCHES_PER_MINUTE: 120,
      WORKER_EVENTS_STALE_SECONDS: 300,
    });
    const budgets = new RateBudgetService(redis),
      keys = new RateLimitKeys(config);
    const registry = new WorkerRegistryService(
      db.model('WorkerRegistration'),
      db.model('WorkerControl'),
      config,
    );
    const pairing = new InstallationPairingService(
      db,
      db.model('WorkerInstallation'),
      {},
      {},
      config,
      registry,
    );
    const ingest = new WorkerEventsService(
      db,
      events,
      pairing,
      registry,
      budgets,
      keys,
      config,
    );
    const rollouts = new WorkerRolloutsService(
      db,
      {},
      new ProcessingTransactions(db),
      {},
      config,
    );
    const module = await Test.createTestingModule({
      controllers: [
        InstallationEventsController,
        PermanentWorkerEventsController,
        WorkerInstallationsController,
        WorkerUpdateController,
      ],
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: WorkerEventsService, useValue: ingest },
        { provide: InstallationPairingService, useValue: pairing },
        {
          provide: InstallationLimitsService,
          useValue: new InstallationLimitsService(budgets, keys),
        },
        { provide: WorkerRolloutsService, useValue: rollouts },
        { provide: RateBudgetService, useValue: budgets },
        { provide: RateLimitKeys, useValue: keys },
      ],
    }).compile();
    const app = module.createNestApplication({
      bodyParser: false,
      logger: false,
    });
    configureHttp(app);
    app.useGlobalGuards(
      new WorkerAuthGuard(
        new Reflector(),
        config,
        new WorkerIdentityService(registry),
      ),
    );
    await app.listen(0, '127.0.0.1');
    t.after(() => app.close());
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'musicmute-spool-integration-')),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const settings = {
      localOrigin: await app.getUrl(),
      spoolRoot: directory,
      installationId: worker.installationId,
      eventId: randomUUID(),
      operationId: randomUUID(),
    };
    const started = Date.now();
    const first = await client({
      ...settings,
      phase: 'lost-response',
      clockSkew: 86400,
      bearer: setupToken,
    });
    assert.equal(first.state.pending, 1);
    assert.equal(first.state.lastError, 'REPORTING_UNAVAILABLE');
    assert.equal(first.payloadHashes.length, 1);
    const accepted = await events.findOne({ eventId: settings.eventId }).lean();
    assert.ok(accepted);
    assert.equal(accepted.installationId, worker.installationId);
    assert.ok(
      Date.parse(accepted.occurredAt) >= started - 3000 &&
        Date.parse(accepted.occurredAt) <= accepted.receivedAt.getTime(),
    );
    assert.equal(accepted.expiresAt - accepted.receivedAt, 30 * 86400000);
    assert.equal(accepted.details.diagnostic, '[redacted]');
    assert.ok(!JSON.stringify(accepted).includes('fixture-private'));
    await db
      .model('WorkerInstallation')
      .updateOne(
        { _id: worker.installationId },
        { $set: { tokenExpiresAt: new Date(0) } },
      );
    await delay(Math.max(0, first.state.retryAt * 1000 - Date.now()) + 100);
    const second = await client({
      ...settings,
      phase: 'restart',
      clockSkew: -86400,
      bearer: worker.rawKey,
    });
    assert.equal(second.state.pending, 0);
    assert.deepEqual(second.receipt.duplicateEventIds, [settings.eventId]);
    assert.deepEqual(second.payloadHashes, first.payloadHashes);
    assert.equal(await events.countDocuments({ eventId: settings.eventId }), 1);
    const retained = await events.findOne({ eventId: settings.eventId }).lean();
    assert.equal(+retained.expiresAt, +accepted.expiresAt);
    assert.equal(+retained.receivedAt, +accepted.receivedAt);
  },
);

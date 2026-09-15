import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createConnection, Types } from 'mongoose';
import { Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { pairedWorkerFixture } from './helpers/paired-worker-fixture.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { WorkerUpdateController } from '../dist/worker-releases/worker-releases.controller.js';
import { WorkerRolloutsService } from '../dist/worker-releases/worker-rollouts.service.js';
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
          new URL('./helpers/worker-update-client.py', import.meta.url),
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
        return reject(new Error(`Update fixture exited ${code}: ${stderr}`));
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
  'Python update client preserves retries and backend activation fences',
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
    await Promise.all(Object.values(db.models).map((model) => model.init()));
    const worker = await pairedWorkerFixture(db);
    const source = await db
      .model('WorkerRelease')
      .findOne({ buildNumber: 100 })
      .lean();
    const releaseId = randomUUID(),
      rolloutId = randomUUID(),
      artifactHash = 'b'.repeat(64);
    const artifact = {
      ...source.metadata.artifacts[0],
      releaseId,
      buildNumber: 101,
      artifactSha256: artifactHash,
      artifactBytes: 1024,
      artifactPath: `/releases/${releaseId}/linux-x64-cuda/${artifactHash}/worker.zip`,
      compatibleSources: [
        {
          profileId: worker.runtime.profileId,
          modelSha256: worker.runtime.modelSha256,
          runtimeLockSha256: worker.runtime.runtimeLockSha256,
          rollbackAllowed: true,
        },
      ],
    };
    await db.model('WorkerRelease').create({
      _id: releaseId,
      buildNumber: 101,
      state: 'published',
      metadata: { artifacts: [artifact] },
    });
    await db.model('WorkerRollout').create({
      _id: rolloutId,
      releaseId,
      workerIds: [worker.workerId],
      groupRevisions: {},
      createdAt: new Date(),
    });
    const updates = db.model('WorkerUpdatePolicy');
    await updates.create({
      _id: worker.workerId,
      revision: 1,
      rolloutId,
      target: artifact,
      minimumClaimBuild: 100,
      allowedFallbackReleaseIds: [],
      stage: 'available',
    });
    const config = new ConfigService({
      RATE_LIMIT_HASH_SECRET: randomBytes(32).toString('hex'),
      FIREBASE_PROJECT_ID: 'isolated-worker-update-client',
      AUDIO_PROCESSING_ENABLED: false,
      BODY_LIMIT_BYTES: 1048576,
      CORS_ORIGINS: '',
    });
    const budgets = new RateBudgetService(redis),
      keys = new RateLimitKeys(config);
    const registry = new WorkerRegistryService(
      db.model('WorkerRegistration'),
      db.model('WorkerControl'),
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
      controllers: [WorkerUpdateController],
      providers: [
        { provide: ConfigService, useValue: config },
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
    const settings = {
      localOrigin: await app.getUrl(),
      installationId: worker.installationId,
      bearer: worker.rawKey,
    };
    const payload = {
      policyRevision: 1,
      stage: 'downloading',
      observedBuild: 100,
      eventId: randomUUID(),
    };
    const first = await client({ ...settings, payload, loseResponse: true });
    assert.equal(first.action, 'prepare');
    assert.equal(first.lostResponse, true);
    const accepted = await updates.findById(worker.workerId).lean();
    assert.equal(accepted.stage, 'downloading');
    assert.equal(accepted.eventId, payload.eventId);
    const retried = await client({ ...settings, payload });
    assert.deepEqual(retried.receipt, { accepted: true });
    assert.deepEqual(retried.payloadHashes, first.payloadHashes);
    assert.equal(
      (await updates.findById(worker.workerId).lean()).receivedAt.getTime(),
      accepted.receivedAt.getTime(),
    );
    const changed = await client({
      ...settings,
      payload: { ...payload, stage: 'prepared' },
    });
    assert.equal(changed.errorStatus, 409);
    assert.equal(
      (await updates.findById(worker.workerId).lean()).stage,
      'downloading',
    );
    for (const stage of ['prepared', 'waiting_for_idle', 'validating']) {
      const result = await client({
        ...settings,
        payload: { ...payload, stage, eventId: randomUUID() },
      });
      assert.deepEqual(result.receipt, { accepted: true });
    }
    await updates.updateOne(
      { _id: worker.workerId },
      { $set: { paused: true } },
    );
    const activation = {
      ...payload,
      stage: 'activating',
      eventId: randomUUID(),
    };
    const paused = await client({ ...settings, payload: activation });
    assert.equal(paused.action, 'hold');
    assert.equal(paused.errorStatus, 409);
    assert.equal(
      (await updates.findById(worker.workerId).lean()).stage,
      'validating',
    );
    await updates.updateOne(
      { _id: worker.workerId },
      { $set: { paused: false, revision: 2 } },
    );
    const stale = await client({ ...settings, payload: activation });
    assert.equal(stale.policyRevision, 2);
    assert.equal(stale.errorStatus, 409);
    assert.equal(
      (await updates.findById(worker.workerId).lean()).stage,
      'validating',
    );
    const authorized = await client({
      ...settings,
      payload: { ...activation, policyRevision: 2 },
    });
    assert.deepEqual(authorized.receipt, { accepted: true });
    const unobserved = await client({
      ...settings,
      payload: {
        policyRevision: 2,
        stage: 'running',
        observedBuild: 101,
        eventId: randomUUID(),
      },
    });
    assert.equal(unobserved.errorStatus, 400);
    assert.equal(
      (await updates.findById(worker.workerId).lean()).stage,
      'activating',
    );
    await db
      .model('WorkerRuntime')
      .updateOne(
        { _id: worker.workerId },
        { $set: { 'report.workerBuild': 101 } },
      );
    const running = await client({
      ...settings,
      payload: {
        policyRevision: 2,
        stage: 'running',
        observedBuild: 101,
        eventId: randomUUID(),
      },
    });
    assert.deepEqual(running.receipt, { accepted: true });
    const runningPolicy = await updates.findById(worker.workerId).lean();
    const staleAttempt = randomUUID(),
      freshAttempt = randomUUID();
    for (const [attemptId, startedAt] of [
      [staleAttempt, new Date(runningPolicy.runningAt.getTime() - 1000)],
      [freshAttempt, new Date(runningPolicy.runningAt.getTime() + 1)],
    ]) {
      await db.model('JobAttempt').create({
        workerId: worker.workerId,
        jobId: new Types.ObjectId(),
        attemptId,
        sessionId: randomUUID(),
        generation: 1,
        startedAt,
        endedAt: startedAt,
        outcome: 'ready',
      });
    }
    const verification = {
      policyRevision: 2,
      stage: 'verified',
      observedBuild: 101,
      eventId: randomUUID(),
      processingAttemptId: staleAttempt,
    };
    const rejectedProof = await client({ ...settings, payload: verification });
    assert.equal(rejectedProof.errorStatus, 400);
    assert.equal(
      (await updates.findById(worker.workerId).lean()).stage,
      'running',
    );
    const validProof = {
      ...verification,
      eventId: randomUUID(),
      processingAttemptId: freshAttempt,
    };
    const uncertainProof = await client({
      ...settings,
      payload: validProof,
      loseResponse: true,
    });
    assert.equal(uncertainProof.lostResponse, true);
    const verificationRetry = await client({
      ...settings,
      payload: validProof,
    });
    assert.deepEqual(verificationRetry.receipt, { accepted: true });
    assert.deepEqual(
      verificationRetry.payloadHashes,
      uncertainProof.payloadHashes,
    );
    const verified = await updates.findById(worker.workerId).lean();
    assert.equal(verified.stage, 'verified');
    assert.equal(verified.verifiedAttemptId, freshAttempt);
    // Control reads and writes share this budget; clients must receive its delay.
    for (let i = 0; i < 60; i++) {
      await budgets.reserve([
        {
          key: keys.bucket('worker-update', worker.workerId),
          limit: 60,
          windowMs: 60000,
        },
      ]);
    }
    const limited = await client({ ...settings, payload: activation });
    assert.equal(limited.errorStatus, 429);
    assert.ok(limited.retryAfter > 0 && limited.retryAfter <= 60);
  },
);

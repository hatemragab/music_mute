import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { startAudioProcessingFixture } from './helpers/audio-processing-fixture.mjs';
import { WorkerRegistryService } from '../dist/worker/worker-registry.service.js';
import { WorkerIdentityService } from '../dist/worker/worker-identity.service.js';
import { WorkerAuthGuard } from '../dist/worker/worker-auth.guard.js';
import { WORKER_ONLY_ROUTE } from '../dist/worker/worker-routes.js';

test('fleet-only HTTP authority rejects obsolete credentials, protocols and ownership without creating slots', async (t) => {
  const f = await startAudioProcessingFixture(t);
  const db = f.control.db;
  const identity = f.workerIdentity;
  const before = await f.control.countDocuments();
  const oldSecret = 'isolated-environment-only-worker-secret';
  const oldDigest = createHash('sha256').update(oldSecret).digest('hex');
  const registry = new WorkerRegistryService(
    db.model('WorkerRegistration'),
    f.control,
    new ConfigService({ PROCESSING_LEASE_SECONDS: 90 }),
  );
  const handler = () => {};
  Reflect.defineMetadata(WORKER_ONLY_ROUTE, true, handler);
  const req = {
    headers: { authorization: `Bearer ${oldSecret}` },
    rawHeaders: [],
  };
  const guard = new WorkerAuthGuard(
    new Reflector(),
    new ConfigService({
      AUDIO_PROCESSING_ENABLED: true,
      PROCESSING_WORKER_KEY_SHA256: oldDigest,
    }),
    new WorkerIdentityService(registry),
  );
  await assert.rejects(
    guard.canActivate({
      getHandler: () => handler,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => req }),
    }),
    (error) => error.getStatus() === 401,
  );
  assert.equal(req.workerIdentity, undefined);
  await f
    .workerRequest(oldSecret, 'claim', { sessionId: randomUUID() })
    .expect(401);
  await f
    .workerRequest(identity.rawKey, 'runtime', {
      ...identity.runtime,
      protocolVersion: 2,
    })
    .expect(426);
  await f
    .workerRequest(identity.rawKey, 'runtime', {
      ...identity.runtime,
      installationId: randomUUID(),
    })
    .expect(403);
  await assert.rejects(
    registry.state({ ...identity, workerId: 'unregistered-worker' }),
    (error) => error.getStatus() === 401,
  );
  await assert.rejects(
    registry.state({ ...identity, installationId: randomUUID() }),
    (error) => error.getStatus() === 401,
  );
  assert.throws(
    () => registry.context(),
    (error) => error.getStatus() === 401,
  );
  assert.throws(
    () => registry.ownerId(undefined),
    (error) => error.getStatus() === 409,
  );
  const jobId = 'a'.repeat(24),
    attemptId = randomUUID(),
    sessionId = randomUUID();
  await db.collection('audio_job_attempts').insertOne({
    jobId: (await import('mongoose')).Types.ObjectId.createFromHexString(jobId),
    attemptId,
    sessionId,
    generation: 1,
  });
  await f
    .workerRequest(identity.rawKey, 'local-cleanup', {
      jobId,
      attemptId,
      sessionId,
      generation: 1,
      eventId: randomUUID(),
      localDataDeleted: true,
    })
    .expect(409);
  assert.equal(
    (await db.collection('audio_job_attempts').findOne({ attemptId })).workerId,
    undefined,
  );
  await f.control.updateOne(
    { _id: identity.workerId },
    { $set: { lastSeenAt: new Date() } },
  );
  assert.equal(
    await registry.available({
      workerId: identity.workerId,
      attemptId: randomUUID(),
      inputReservation: { durationSeconds: 10, bytes: 100 },
    }),
    true,
  );
  await db
    .collection('worker_installations')
    .updateOne(
      { _id: identity.installationId },
      { $set: { assignedWorkerId: 'another-worker' } },
    );
  assert.equal(
    await registry.available({
      workerId: identity.workerId,
      attemptId: randomUUID(),
      inputReservation: { durationSeconds: 10, bytes: 100 },
    }),
    false,
  );
  await f.workerRequest(identity.rawKey, 'identity', {}).expect(401);
  await db
    .collection('worker_installations')
    .updateOne(
      { _id: identity.installationId },
      { $set: { assignedWorkerId: identity.workerId } },
    );
  await db
    .model('WorkerRegistration')
    .updateOne({ _id: identity.workerId }, { $set: { state: 'revoked' } });
  await f.workerRequest(identity.rawKey, 'identity', {}).expect(401);
  assert.equal(await f.control.countDocuments(), before);
  assert.equal(await f.control.countDocuments({ _id: 'z440' }), 0);
  assert.equal(await f.jobs.countDocuments(), 0);
});

import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import mongoose, { createConnection } from 'mongoose';
import { Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { IsolatedServices } from './helpers/isolated-services.mjs';
import { pairedWorkerFixture } from './helpers/paired-worker-fixture.mjs';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { WorkerEventSchema } from '../dist/worker-events/worker-event.schema.js';
import { eventFingerprint } from '../dist/worker-events/worker-event-policy.js';
import { WorkerEventsService } from '../dist/worker-events/worker-events.service.js';
import { WorkerEventsQueryService } from '../dist/worker-events/worker-events-query.service.js';
import {
  InstallationEventsController,
  PermanentWorkerEventsController,
  AdminInstallationEventsController,
  AdminWorkerEventsController,
} from '../dist/worker-events/worker-events.controller.js';
import { InstallationPairingService } from '../dist/worker-installations/installation-pairing.service.js';
import { tokenDigest } from '../dist/worker-installations/installation-secrets.js';
import { WorkerRegistryService } from '../dist/worker/worker-registry.service.js';
import { WorkerIdentityService } from '../dist/worker/worker-identity.service.js';
import { WorkerAuthGuard } from '../dist/worker/worker-auth.guard.js';
import { RateBudgetService } from '../dist/rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../dist/rate-limits/rate-limit-keys.js';
import { AuthGuard } from '../dist/auth/auth.guard.js';
import { AdminGuard } from '../dist/admin/admin.guard.js';
import { AdminRateLimitService } from '../dist/admin/admin-rate-limit.service.js';
import { configureHttp } from '../dist/http/configure-http.js';
const DAY30 = 30 * 86400000;
const event = (changes = {}) => ({
  eventId: randomUUID(),
  operationId: randomUUID(),
  sequence: 1,
  category: 'installation',
  stage: 'download',
  status: 'failed',
  occurredAt: new Date(Date.now() - 1000).toISOString(),
  code: 'DOWNLOAD_FAILED',
  ...changes,
});
mongoose.set('sanitizeFilter', true);

test(
  'isolated event HTTP authority, immutable retries, expiry, privacy and atomic quotas',
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
    await Promise.all(Object.values(db.models).map((m) => m.init()));
    const worker = await pairedWorkerFixture(db),
      other = await pairedWorkerFixture(db);
    const token = randomBytes(32).toString('hex');
    await db
      .model('WorkerInstallation')
      .updateOne(
        { _id: worker.installationId },
        { $set: { tokenSha256: tokenDigest(token) } },
      );
    const config = new ConfigService({
      RATE_LIMIT_HASH_SECRET: randomBytes(32).toString('hex'),
      FIREBASE_PROJECT_ID: 'isolated-events',
      AUDIO_PROCESSING_ENABLED: true,
      PROCESSING_LEASE_SECONDS: 90,
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
    const queries = new WorkerEventsQueryService(db, events, config);
    const module = await Test.createTestingModule({
      controllers: [
        InstallationEventsController,
        PermanentWorkerEventsController,
        AdminInstallationEventsController,
        AdminWorkerEventsController,
      ],
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: WorkerEventsService, useValue: ingest },
        { provide: WorkerEventsQueryService, useValue: queries },
      ],
    }).compile();
    const app = module.createNestApplication({ bodyParser: false });
    configureHttp(app);
    const firebase = {
      verifySignature: async (token) => {
        if (!['manager', 'viewer'].includes(token))
          throw new UnauthorizedException();
        return { uid: token };
      },
      verifySession: async (token) => ({
        uid: token,
        provider: 'google.com',
        tokenEmailVerified: true,
        authTimeSec: Math.floor(Date.now() / 1000),
      }),
      getProfile: async (uid) => ({
        uid,
        email: `${uid}@example.test`,
        providerData: [
          { providerId: 'google.com', email: `${uid}@example.test` },
        ],
      }),
    };
    for (const uid of ['manager', 'viewer'])
      await db.model('AdminAccess').create({
        uid,
        verifiedEmail: `${uid}@example.test`,
        role: uid === 'manager' ? 'worker_manager' : 'viewer',
        active: true,
      });
    const reflector = new Reflector();
    app.useGlobalGuards(
      new AuthGuard(reflector, firebase, {}, budgets, keys, config),
      new AdminGuard(
        reflector,
        firebase,
        db.model('AdminAccess'),
        new AdminRateLimitService(budgets, keys, config),
        config,
      ),
      new WorkerAuthGuard(
        reflector,
        config,
        new WorkerIdentityService(registry),
      ),
    );
    await app.listen(0, '127.0.0.1');
    t.after(() => app.close());
    const http = supertest(app.getHttpServer());
    const post = (path, auth, body) =>
      http
        .post(`/api/v1/${path}`)
        .set('Authorization', `Bearer ${auth}`)
        .send(body);
    const get = (path, auth = 'manager') =>
      http.get(`/api/v1/${path}`).set('Authorization', `Bearer ${auth}`);
    const setup = `worker-installations/${worker.installationId}/events`,
      timeline = `admin/workers/${worker.workerId}/events`;
    await t.test(
      'setup/permanent scopes, privacy, stable identity and conflict rollback',
      async () => {
        const failed = event({
          details: {
            component: 'runtime',
            diagnostic:
              'Bearer synthetic-sensitive https://example.invalid/private?signature=hidden /Users/private C:\\private',
          },
        });
        const first = await post(setup, token, { events: [failed] });
        assert.equal(first.status, 201);
        assert.deepEqual(first.body.acceptedEventIds, [failed.eventId]);
        const row = await events.findOne({ eventId: failed.eventId }).lean();
        assert.equal(row.expiresAt - row.receivedAt, DAY30);
        assert.equal(row.details.diagnostic, '[redacted]');
        assert.equal(
          JSON.stringify(row).includes('synthetic-sensitive'),
          false,
        );
        await db
          .model('WorkerInstallation')
          .updateOne(
            { _id: worker.installationId },
            { $set: { tokenExpiresAt: new Date(Date.now() - 1) } },
          );
        assert.equal(
          (await post(setup, token, { events: [failed] })).status,
          401,
        );
        const retry = await post('worker/events', worker.rawKey, {
          events: [failed],
        });
        assert.equal(retry.status, 201);
        assert.deepEqual(retry.body.duplicateEventIds, [failed.eventId]);
        assert.equal(
          (
            await events.findOne({ eventId: failed.eventId })
          ).expiresAt.getTime(),
          row.expiresAt.getTime(),
        );
        const fresh = event();
        const conflict = await post('worker/events', worker.rawKey, {
          events: [
            fresh,
            { ...failed, details: { diagnostic: 'different private text' } },
          ],
        });
        assert.equal(conflict.status, 409);
        assert.equal(conflict.body.code, 'EVENT_ID_CONFLICT');
        assert.equal(
          await events.countDocuments({ eventId: fresh.eventId }),
          0,
        );
        assert.equal(
          (await post('worker/events', token, { events: [event()] })).status,
          401,
        );
        assert.equal(
          (
            await post(
              `worker-installations/${other.installationId}/events`,
              token,
              { events: [event()] },
            )
          ).status,
          401,
        );
        assert.equal((await get(timeline, worker.rawKey)).status, 401);
        assert.equal((await get(timeline, 'viewer')).status, 200);
        await db
          .model('AdminAccess')
          .updateOne({ uid: 'viewer' }, { $set: { role: 'release_manager' } });
        assert.equal((await get(timeline, 'viewer')).status, 403);
        const success = event({
          operationId: failed.operationId,
          sequence: 2,
          status: 'succeeded',
        });
        assert.equal(
          (await post('worker/events', worker.rawKey, { events: [success] }))
            .status,
          201,
        );
        const listed = await get(timeline);
        assert.equal(listed.status, 200);
        assert.equal(listed.body.items.length, 2);
        assert.ok(listed.body.items.some((x) => x.status === 'failed'));
      },
    );
    await t.test(
      'permanent reporting survives disabled processing and expired setup without relaxing authority',
      async () => {
        config.set('AUDIO_PROCESSING_ENABLED', false);
        try {
          const payload = event({ category: 'startup', stage: 'service' });
          assert.equal(
            (await post('worker/events', worker.rawKey, { events: [payload] }))
              .status,
            201,
          );
          assert.equal(
            (await post(setup, token, { events: [event()] })).status,
            401,
          );
          for (const credential of [token, 'invalid-worker-key']) {
            const rejected = event();
            assert.equal(
              (await post('worker/events', credential, { events: [rejected] }))
                .status,
              401,
            );
            assert.equal(
              await events.countDocuments({ eventId: rejected.eventId }),
              0,
            );
          }
          const missing = event();
          assert.equal(
            (
              await http
                .post('/api/v1/worker/events')
                .send({ events: [missing] })
            ).status,
            401,
          );
          assert.equal(
            await events.countDocuments({ eventId: missing.eventId }),
            0,
          );
          const revoked = await pairedWorkerFixture(db);
          await db
            .model('WorkerRegistration')
            .updateOne(
              { _id: revoked.workerId },
              { $set: { state: 'revoked' } },
            );
          const refused = event();
          assert.equal(
            (await post('worker/events', revoked.rawKey, { events: [refused] }))
              .status,
            401,
          );
          assert.equal(
            await events.countDocuments({ eventId: refused.eventId }),
            0,
          );
        } finally {
          config.set('AUDIO_PROCESSING_ENABLED', true);
        }
      },
    );
    await t.test(
      'required setup failures retain safe codes through HTTP and administrator readback',
      async () => {
        const operationId = randomUUID();
        const codes = [
          'GPU_UNAVAILABLE_IN_SERVICE',
          'PREBOOT_UNLOCK_REQUIRED',
          'CPU_ONLY_UNSUPPORTED',
          'DRIVER_ACTION_REQUIRED',
        ];
        const batch = codes.map((code, index) =>
          event({
            operationId,
            sequence: index + 1,
            category: 'startup',
            stage: 'service',
            code,
            details: { diagnostic: code },
          }),
        );
        const unsafe = event({
          operationId,
          sequence: 5,
          code: 'REPORTING_UNAVAILABLE',
          details: {
            diagnostic:
              'Bearer synthetic-private https://example.invalid/private /Users/private',
          },
        });
        assert.equal(
          (
            await post('worker/events', worker.rawKey, {
              events: [...batch, unsafe],
            })
          ).status,
          201,
        );
        const page = await get(`${timeline}?operationId=${operationId}`);
        assert.equal(page.status, 200);
        assert.equal(page.body.items.length, 5);
        for (const code of codes)
          assert.equal(
            page.body.items.find((row) => row.code === code).details.diagnostic,
            code,
          );
        assert.equal(
          page.body.items.find((row) => row.eventId === unsafe.eventId).details
            .diagnostic,
          '[redacted]',
        );
        assert.equal(
          JSON.stringify(page.body).includes('synthetic-private'),
          false,
        );
      },
    );
    await t.test(
      'actual wire bytes with whitespace, exact limit and chunked bodies',
      async () => {
        const raw = JSON.stringify({ events: [event()] });
        const padded = raw + ' '.repeat(65536 - Buffer.byteLength(raw));
        assert.equal(
          (
            await http
              .post('/api/v1/worker/events')
              .set('Authorization', `Bearer ${worker.rawKey}`)
              .set('Content-Type', 'application/json')
              .send(padded)
          ).status,
          201,
        );
        assert.equal(
          (
            await http
              .post('/api/v1/worker/events')
              .set('Authorization', `Bearer ${worker.rawKey}`)
              .set('Content-Type', 'application/json')
              .send(padded + ' ')
          ).status,
          413,
        );
        const status = await new Promise((resolve, reject) => {
          const req = request(
            {
              host: '127.0.0.1',
              port: app.getHttpServer().address().port,
              path: '/api/v1/worker/events',
              method: 'POST',
              headers: {
                Authorization: `Bearer ${worker.rawKey}`,
                'Content-Type': 'application/json',
                'Transfer-Encoding': 'chunked',
              },
            },
            (res) => {
              res.resume();
              res.on('end', () => resolve(res.statusCode));
            },
          );
          req.on('error', reject);
          req.write(padded);
          req.end(' ');
        });
        assert.equal(status, 413);
      },
    );
    await t.test(
      'bounded batches, exact expiry, delayed TTL and no resurrection after deletion',
      async () => {
        const maximum = await post('worker/events', worker.rawKey, {
          events: Array.from({ length: 50 }, () => event()),
        });
        assert.equal(maximum.status, 201);
        assert.equal(maximum.body.acceptedEventIds.length, 50);
        assert.equal(
          (
            await post('worker/events', worker.rawKey, {
              events: Array.from({ length: 51 }, () => event()),
            })
          ).status,
          400,
        );
        const future = await post('worker/events', worker.rawKey, {
          events: [
            event({ occurredAt: new Date(Date.now() + 60000).toISOString() }),
          ],
        });
        assert.equal(future.status, 400);
        assert.equal(future.body.code, 'EVENT_CLOCK_AHEAD');
        assert.ok(future.body.serverTime);
        const rolledBack = event();
        const futureBatch = await post('worker/events', worker.rawKey, {
          events: [
            rolledBack,
            event({ occurredAt: new Date(Date.now() + 60000).toISOString() }),
          ],
        });
        assert.equal(futureBatch.body.code, 'EVENT_CLOCK_AHEAD');
        assert.equal(
          await events.countDocuments({ eventId: rolledBack.eventId }),
          0,
        );
        const old = event({
          occurredAt: new Date(Date.now() - DAY30).toISOString(),
        });
        assert.equal(
          (await post('worker/events', worker.rawKey, { events: [old] })).body
            .code,
          'EVENT_TOO_OLD',
        );
        const kept = event();
        assert.equal(
          (await post('worker/events', worker.rawKey, { events: [kept] }))
            .status,
          201,
        );
        // Isolated test owns this TTL index; remove it to prove read-time expiry.
        await events.collection.dropIndex('expiresAt_1');
        const receivedAt = new Date(Date.now() - DAY30),
          expiresAt = new Date(receivedAt.getTime() + DAY30);
        await events.updateOne(
          { eventId: kept.eventId },
          { $set: { receivedAt, expiresAt } },
        );
        const duplicate = await post('worker/events', worker.rawKey, {
          events: [kept],
        });
        assert.equal(duplicate.status, 201);
        assert.deepEqual(duplicate.body.duplicateEventIds, [kept.eventId]);
        const listed = await get(timeline);
        assert.ok(!listed.body.items.some((x) => x.eventId === kept.eventId));
        // Real accepted old record has occurredAt <= its original receipt.
        const ancient = event({
          occurredAt: new Date(Date.now() - DAY30 - 1000).toISOString(),
        });
        await events.collection.insertOne({
          ...ancient,
          installationId: worker.installationId,
          receivedAt,
          expiresAt,
          payloadFingerprint: eventFingerprint(
            ancient,
            config.getOrThrow('RATE_LIMIT_HASH_SECRET'),
          ),
        });
        assert.deepEqual(
          (await post('worker/events', worker.rawKey, { events: [ancient] }))
            .body.duplicateEventIds,
          [ancient.eventId],
        );
        await events.deleteOne({ eventId: ancient.eventId });
        assert.equal(
          (await post('worker/events', worker.rawKey, { events: [ancient] }))
            .body.code,
          'EVENT_TOO_OLD',
        );
      },
    );
    await t.test(
      'concurrent identical retries admit exactly one immutable event',
      async () => {
        const payload = event();
        const replies = await Promise.all(
          Array.from({ length: 4 }, () =>
            post('worker/events', worker.rawKey, { events: [payload] }),
          ),
        );
        assert.ok(replies.every((reply) => reply.status === 201));
        assert.equal(
          replies.flatMap((reply) => reply.body.acceptedEventIds).length,
          1,
        );
        assert.equal(
          replies.flatMap((reply) => reply.body.duplicateEventIds).length,
          3,
        );
        assert.equal(
          await events.countDocuments({ eventId: payload.eventId }),
          1,
        );
      },
    );
    await t.test(
      'owner scoped filtered cursor pages and stale summary independent of filters',
      async () => {
        const operationId = randomUUID();
        const batch = [
          event({ operationId, sequence: 1 }),
          event({ operationId, sequence: 2 }),
          event({ operationId, sequence: 3 }),
        ];
        assert.equal(
          (await post('worker/events', worker.rawKey, { events: batch }))
            .status,
          201,
        );
        const first = await get(
          `${timeline}?operationId=${operationId}&limit=2`,
        );
        assert.equal(first.body.items.length, 2);
        assert.ok(first.body.nextCursor);
        const next = await get(
          `${timeline}?operationId=${operationId}&limit=2&cursor=${first.body.nextCursor}`,
        );
        assert.equal(next.body.items.length, 1);
        assert.ok(
          !first.body.items.some((a) =>
            next.body.items.some((b) => a.eventId === b.eventId),
          ),
        );
        assert.equal(
          (await get(`admin/workers/${other.workerId}/events`)).body.items
            .length,
          0,
        );
        assert.equal(
          (
            await get(
              `admin/worker-installations/${other.installationId}/events?cursor=${first.body.nextCursor}`,
            )
          ).status,
          400,
        );
        const progress = event({ status: 'progress' });
        assert.equal(
          (await post('worker/events', other.rawKey, { events: [progress] }))
            .status,
          201,
        );
        await events.updateOne(
          { eventId: progress.eventId },
          { $set: { receivedAt: new Date(Date.now() - 300000) } },
        );
        const interrupted = await get(
          `admin/workers/${other.workerId}/events?status=failed`,
        );
        assert.equal(interrupted.body.items.length, 0);
        assert.equal(
          interrupted.body.reporting.status,
          'reporting_interrupted',
        );
        assert.equal(interrupted.body.reporting.outcome, 'unknown');
      },
    );
    await t.test(
      'concurrent weighted admission is bounded and rejected multi-budget calls consume nothing',
      async () => {
        const rate = keys.bucket('event-test-rate', randomUUID()),
          bytes = keys.bucket('event-test-bytes', randomUUID());
        const bucket = [
          { key: rate, weight: 1, limit: 100, windowMs: 60000 },
          { key: bytes, weight: 40, limit: 100, windowMs: 60000 },
        ];
        const decisions = await Promise.all(
          Array.from({ length: 10 }, () => budgets.reserveWeighted(bucket)),
        );
        assert.equal(decisions.filter((x) => x.allowed).length, 2);
        assert.equal(await redis.get(rate), '2');
        assert.equal(await redis.get(bytes), '80');
        const separate = keys.bucket('event-test-unused', randomUUID());
        assert.equal(
          (
            await budgets.reserveWeighted([
              { key: separate, weight: 1, limit: 10, windowMs: 60000 },
              { key: bytes, weight: 40, limit: 100, windowMs: 60000 },
            ])
          ).allowed,
          false,
        );
        assert.equal(await redis.exists(separate), 0);
        config.set('WORKER_EVENTS_WORKER_BYTES_PER_DAY', 1);
        const limited = await post('worker/events', worker.rawKey, {
          events: [event()],
        });
        assert.equal(limited.status, 429);
        assert.ok(Number(limited.headers['retry-after']) > 0);
        config.set('WORKER_EVENTS_WORKER_BYTES_PER_DAY', 20971520);
      },
    );
    await t.test(
      'revocation and binding changes deny writes even after guard authentication',
      async () => {
        await db
          .model('WorkerRegistration')
          .updateOne({ _id: other.workerId }, { $set: { state: 'revoked' } });
        assert.equal(
          (await post('worker/events', other.rawKey, { events: [event()] }))
            .status,
          401,
        );
        await assert.rejects(
          () => ingest.ingestWorker(other, { events: [event()] }, 400),
          (e) => e.getStatus() === 401,
        );
      },
    );
    await t.test(
      'revocation winning after snapshot authentication aborts persistence',
      async () => {
        const candidate = await pairedWorkerFixture(db);
        const original = registry.state.bind(registry);
        let unblock, observed;
        const ready = new Promise((resolve) => {
          observed = resolve;
        });
        const gate = new Promise((resolve) => {
          unblock = resolve;
        });
        registry.state = async (...args) => {
          const state = await original(...args);
          if (args[1]) {
            observed();
            await gate;
          }
          return state;
        };
        const payload = event();
        config.set('AUDIO_PROCESSING_ENABLED', false);
        const pending = post('worker/events', candidate.rawKey, {
          events: [payload],
        }).then((response) => response);
        await ready;
        const session = await db.startSession();
        try {
          await session.withTransaction(async () => {
            await db
              .model('WorkerRegistration')
              .updateOne(
                { _id: candidate.workerId },
                { $set: { state: 'revoked' } },
                { session },
              );
            await db
              .model('WorkerControl')
              .updateOne(
                { _id: candidate.workerId },
                { $inc: { controlRevision: 1 } },
                { session },
              );
          });
        } finally {
          await session.endSession();
          unblock();
        }
        assert.equal((await pending).status, 401);
        config.set('AUDIO_PROCESSING_ENABLED', true);
        registry.state = original;
        assert.equal(
          await events.countDocuments({ eventId: payload.eventId }),
          0,
        );
      },
    );
    await t.test(
      'setup revocation after transactional authentication prevents writes',
      async () => {
        const candidate = await pairedWorkerFixture(db),
          setupToken = randomBytes(32).toString('hex');
        await db
          .model('WorkerInstallation')
          .updateOne(
            { _id: candidate.installationId },
            { $set: { tokenSha256: tokenDigest(setupToken) } },
          );
        const original = pairing.authenticate.bind(pairing);
        let unblock, observed;
        const ready = new Promise((resolve) => {
          observed = resolve;
        });
        const gate = new Promise((resolve) => {
          unblock = resolve;
        });
        pairing.authenticate = async (...args) => {
          const row = await original(...args);
          if (args[2]) {
            observed();
            await gate;
          }
          return row;
        };
        const payload = event();
        const pending = ingest.ingestSetup(
          candidate.installationId,
          `Bearer ${setupToken}`,
          { events: [payload] },
          400,
        );
        await ready;
        await db
          .model('WorkerInstallation')
          .updateOne(
            { _id: candidate.installationId },
            { $set: { revoked: true } },
          );
        unblock();
        await assert.rejects(
          () => pending,
          (e) => e.getStatus() === 401,
        );
        pairing.authenticate = original;
        assert.equal(
          await events.countDocuments({ eventId: payload.eventId }),
          0,
        );
      },
    );
    await t.test(
      'unchanged progress is throttled, terminal failures and identical retry survive',
      async () => {
        const progress = event({ status: 'progress' });
        const first = await post('worker/events', worker.rawKey, {
          events: [progress],
        });
        assert.equal(first.status, 201);
        assert.equal(
          (await post('worker/events', worker.rawKey, { events: [progress] }))
            .status,
          201,
        );
        const repeat = event({
          ...progress,
          eventId: randomUUID(),
          sequence: 2,
        });
        const limited = await post('worker/events', worker.rawKey, {
          events: [repeat],
        });
        assert.equal(limited.status, 429);
        assert.ok(Number(limited.headers['retry-after']) > 0);
        assert.equal(
          (
            await post('worker/events', worker.rawKey, {
              events: [
                event({ ...repeat, eventId: randomUUID(), status: 'failed' }),
              ],
            })
          ).status,
          201,
        );
      },
    );
    await t.test(
      'late lower-sequence progress cannot replace terminal reporting outcome',
      async () => {
        const operationId = randomUUID();
        const terminal = event({
          operationId,
          sequence: 10,
          status: 'succeeded',
        });
        assert.equal(
          (await post('worker/events', worker.rawKey, { events: [terminal] }))
            .status,
          201,
        );
        const late = event({ operationId, sequence: 2, status: 'progress' });
        assert.equal(
          (await post('worker/events', worker.rawKey, { events: [late] }))
            .status,
          201,
        );
        const summary = await get(`${timeline}?status=failed`);
        assert.equal(summary.body.reporting.outcome, 'succeeded');
        assert.equal(summary.body.reporting.operationId, operationId);
        assert.equal(
          summary.body.reporting.scope,
          'most_recently_reported_operation',
        );
      },
    );
    await t.test(
      'Redis unavailability fails closed without persistence',
      async () => {
        redis.disconnect();
        const failed = event();
        assert.equal(
          (await post('worker/events', worker.rawKey, { events: [failed] }))
            .status,
          503,
        );
        assert.equal(
          await events.countDocuments({ eventId: failed.eventId }),
          0,
        );
      },
    );
  },
);

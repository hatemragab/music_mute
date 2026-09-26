import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection, Schema, Types } from 'mongoose';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { IsolatedServices, until } from './helpers/isolated-services.mjs';
import { RealtimeFeedService } from '../dist/realtime/realtime-feed.service.js';
import { RealtimeSocketService } from '../dist/realtime/realtime-socket.service.js';
import { RealtimeAuthService } from '../dist/realtime/realtime-auth.service.js';
import { RealtimeResourcesService } from '../dist/realtime/realtime-resources.service.js';
import { QueueProjectionService } from '../dist/realtime/queue-projection.service.js';
import { WebSocket } from 'ws';

// Owned loopback infrastructure only. Real Mongo transactions/change streams, Redis,
// tickets, authorization registry and socket transport; Firebase is a local double.
test(
  'two independent API feeds push committed queue changes and fence access',
  { timeout: 60000 },
  async () => {
    const services = await IsolatedServices.create();
    const close = [];
    try {
      const { mongoUri, redisPort } = await services.startDatabases({
        replicaSet: true,
      });
      const db = await createConnection(mongoUri).asPromise();
      close.push(() => db.close());
      const redis = new Redis(`redis://127.0.0.1:${redisPort}`);
      close.push(() => redis.quit());
      const model = (name, collection, stringId = false) =>
        db.model(
          name,
          new Schema(stringId ? { _id: String } : {}, {
            strict: false,
            collection,
          }),
        );
      const jobs = model('FixtureJob', 'audio_jobs');
      const users = model('FixtureUser', 'users');
      const reservations = model(
        'FixtureReservation',
        'processing_reservations',
      );
      const machines = model('FixtureMachine', 'worker_machines', true);
      const slots = model('FixtureSlot', 'worker_slots');
      const fleet = model('FixtureFleet', 'worker_fleet_policies', true);
      const admins = model('FixtureAdmin', 'admin_access');
      const owner = new Types.ObjectId(),
        other = new Types.ObjectId();
      await users.collection.insertMany(
        [owner, other].map((_id) => ({
          _id,
          firebaseUid: String(_id),
          status: 'active',
          sessionsRevokedAfterSec: 0,
        })),
      );
      const queued = [other, owner].map((userId, index) => ({
        _id: new Types.ObjectId(),
        userId,
        status: 'queued',
        deletedAt: null,
        queuedAt: new Date(Date.now() - 2000 + index),
        currentExecution: null,
        inputObject: { key: 'fixture-only' },
        recipeSnapshot: { recipeId: 'kim-vocals-v2' },
        retryEligibility: {
          eligible: true,
          attemptsRemaining: 3,
          nextAttemptAt: null,
        },
        attemptNumber: 0,
        admissionSnapshot: {
          maxProcessingJobs: 1,
          maxInfrastructureAttempts: 3,
        },
      }));
      await jobs.collection.insertMany(queued);
      await reservations.collection.insertMany(
        queued.map((j) => ({
          _id: j._id,
          accountId: j.userId,
          state: 'reserved',
        })),
      );
      await machines.collection.insertOne({
        _id: 'machine',
        status: 'active',
        policyRevision: 1,
        appliedRevision: 1,
        lastSeenAt: new Date(),
        currentSession: { sessionId: 'session', incarnation: 'one' },
      });
      await slots.collection.insertOne({
        machineId: 'machine',
        slotIndex: 0,
        sessionId: 'session',
        incarnation: 'one',
        state: 'busy',
        allowedRecipeIds: ['kim-vocals-v2'],
      });
      await fleet.collection.insertOne({
        _id: 'worker-fleet',
        revision: 1,
        acceptClaims: true,
        recipes: [
          { recipeId: 'kim-vocals-v2', enabled: true, maxSlotsPerMachine: 1 },
        ],
      });
      const config = new ConfigService({
        AUDIO_PROCESSING_ENABLED: true,
        CORS_ORIGINS: '',
        TRUST_PROXY: false,
      });
      const firebase = {
        verifySignature: async (uid) => ({
          uid,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
        getProfile: async (uid) => ({ uid, disabled: false }),
      };
      const auth = new RealtimeAuthService(
        redis,
        config,
        firebase,
        users,
        admins,
      );
      const identity = {
        uid: String(owner),
        authTimeSec: Math.floor(Date.now() / 1000),
      };
      const mint = () =>
        auth.mint(
          {
            headers: {},
            identity,
            bearer: String(owner),
            user: { _id: owner },
          },
          'owner',
        );
      const clients = [];
      for (let index = 0; index < 2; index++) {
        const feed = new RealtimeFeedService(db);
        feed.onModuleInit();
        close.push(() => feed.onModuleDestroy());
        await until(() => feed.healthy, 'change feed ready');
        const queues = new QueueProjectionService(
          jobs,
          users,
          reservations,
          machines,
          slots,
          fleet,
          { global: async () => ({ acceptNewJobs: true }) },
          config,
          feed,
        );
        queues.onModuleInit();
        close.push(() => queues.onModuleDestroy());
        const reads = {
          detail: async (userId, id) => {
            const job = await jobs
              .findOne({ _id: id, userId: new Types.ObjectId(userId) })
              .lean();
            if (!job) {
              const { NotFoundException } = await import('@nestjs/common');
              throw new NotFoundException();
            }
            return {
              id: String(job._id),
              status: job.status,
              fixtureRevision: job.fixtureRevision ?? 0,
            };
          },
        };
        const resources = new RealtimeResourcesService(
          reads,
          {},
          {},
          {},
          {},
          {},
          {},
          {},
          {},
          {},
          {},
          queues,
        );
        const transport = new RealtimeSocketService(
          auth,
          feed,
          resources,
          { reserve: async () => ({ allowed: true }) },
          { bucket: (a, b) => `${a}:${b}` },
          config,
          redis,
        );
        const server = createServer();
        transport.attach(server);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        close.push(async () => {
          await transport.onModuleDestroy();
          await new Promise((resolve) => server.close(resolve));
        });
        const grant = await mint();
        const url = `ws://127.0.0.1:${server.address().port}/realtime/socket`;
        const socket = new WebSocket(url, [
          grant.protocol,
          `ticket.${grant.ticket}`,
        ]);
        const frames = [];
        socket.on('message', (data) => frames.push(JSON.parse(String(data))));
        await until(
          () => frames.some((f) => f.type === 'ready'),
          'socket ready',
        );
        socket.send(
          JSON.stringify({
            type: 'subscribe',
            subscription_id: 'mine',
            resource: 'job',
            params: { id: String(queued[1]._id) },
          }),
        );
        await until(
          () => frames.some((f) => f.data?.queue?.position === 2),
          'real queue projection',
        );
        clients.push({ socket, frames, feed, url, grant });
      }
      // Bounded local baseline: six connections (the distributed account limit),
      // two feed/transport instances and 202 eligible queued jobs. No production SLA.
      const extraJobs = Array.from({ length: 200 }, () => ({
        ...queued[0],
        _id: new Types.ObjectId(),
        queuedAt: new Date(),
      }));
      await jobs.collection.insertMany(extraJobs);
      await reservations.collection.insertMany(
        extraJobs.map((job) => ({
          _id: job._id,
          accountId: job.userId,
          state: 'reserved',
        })),
      );
      const observers = [...clients];
      for (let index = 0; index < 4; index++) {
        const grant = await mint();
        const socket = new WebSocket(clients[index % 2].url, [
          grant.protocol,
          `ticket.${grant.ticket}`,
        ]);
        const frames = [];
        socket.on('message', (data) => frames.push(JSON.parse(String(data))));
        await until(
          () => frames.some((frame) => frame.type === 'ready'),
          'load socket ready',
        );
        socket.send(
          JSON.stringify({
            type: 'subscribe',
            subscription_id: 'mine',
            resource: 'job',
            params: { id: String(queued[1]._id) },
          }),
        );
        await until(
          () => frames.some((frame) => frame.data?.queue?.position === 2),
          'load snapshot',
        );
        observers.push({ socket, frames });
      }
      const overLimitGrant = await mint();
      const overLimit = new WebSocket(clients[0].url, [
        overLimitGrant.protocol,
        `ticket.${overLimitGrant.ticket}`,
      ]);
      overLimit.on('error', () => {});
      const status = await new Promise((resolve) =>
        overLimit.once('unexpected-response', (_request, response) => {
          response.resume();
          overLimit.terminate();
          resolve(response.statusCode);
        }),
      );
      assert.equal(status, 429);
      const latencies = [];
      for (let revision = 1; revision <= 8; revision++) {
        const started = performance.now();
        await jobs.collection.updateOne(
          { _id: queued[1]._id },
          { $set: { fixtureRevision: revision } },
        );
        await until(
          () =>
            observers.every((observer) =>
              observer.frames.some(
                (frame) => frame.data?.fixture_revision === revision,
              ),
            ),
          'six-socket committed update',
          5000,
        );
        latencies.push(Math.round(performance.now() - started));
      }
      latencies.sort((a, b) => a - b);
      console.log(
        `REALTIME_LOCAL_BASELINE sockets=6 feeds=2 queued=202 writes=8 p95_ms=${latencies.at(-1)}`,
      );
      assert.ok(
        latencies.at(-1) < 3000,
        'bounded fixture propagation should remain below three seconds',
      );
      await Promise.all(
        observers.slice(2).map(async (observer) => {
          const ended = once(observer.socket, 'close');
          observer.socket.close();
          await ended;
        }),
      );
      const session = await db.startSession();
      session.startTransaction();
      await jobs.collection.updateOne(
        { _id: queued[0]._id },
        { $set: { status: 'cancelled' } },
        { session },
      );
      await session.abortTransaction();
      await session.endSession();
      await delay(1200);
      for (const c of clients)
        assert.equal(
          c.frames.filter((f) => f.type === 'snapshot').at(-1).data.queue
            .position,
          2,
        );
      await jobs.collection.updateOne(
        { _id: queued[0]._id },
        { $set: { status: 'cancelled' } },
      );
      for (const c of clients)
        await until(
          () => c.frames.some((f) => f.data?.queue?.position === 1),
          'committed change reaches both API feeds',
        );
      const c = clients[0];
      c.socket.send(
        JSON.stringify({
          type: 'subscribe',
          subscription_id: 'foreign',
          resource: 'job',
          params: { id: String(queued[0]._id) },
        }),
      );
      c.socket.send(
        JSON.stringify({
          type: 'subscribe',
          subscription_id: 'admin',
          resource: 'admin.health',
          params: {},
        }),
      );
      await until(
        () =>
          c.frames.some(
            (f) => f.subscription_id === 'foreign' && f.status === 404,
          ) &&
          c.frames.some(
            (f) => f.subscription_id === 'admin' && f.status === 403,
          ),
        'owner and permission fencing',
      );
      const replay = new WebSocket(c.url, [
        c.grant.protocol,
        `ticket.${c.grant.ticket}`,
      ]);
      const rejected = new Promise((resolve) =>
        replay.once('unexpected-response', (_request, response) => {
          response.resume();
          replay.terminate();
          resolve(response.statusCode);
        }),
      );
      replay.on('error', () => {});
      assert.equal(await rejected, 401);
      // Close the real Mongo cursor: clients must leave live state and reconnect
      // with an authorized complete snapshot rather than trusting missed events.
      const lost = once(c.socket, 'close');
      await c.feed.stream.close();
      assert.equal((await lost)[0], 1013);
      await until(() => c.feed.healthy, 'feed recovery');
      const freshGrant = await mint();
      const recovered = new WebSocket(c.url, [
        freshGrant.protocol,
        `ticket.${freshGrant.ticket}`,
      ]);
      const recoveredFrames = [];
      recovered.on('message', (data) =>
        recoveredFrames.push(JSON.parse(String(data))),
      );
      await until(
        () => recoveredFrames.some((f) => f.type === 'ready'),
        'recovered connection',
      );
      recovered.send(
        JSON.stringify({
          type: 'subscribe',
          subscription_id: 'mine',
          resource: 'job',
          params: { id: String(queued[1]._id) },
        }),
      );
      await until(
        () => recoveredFrames.some((f) => f.data?.queue?.position === 1),
        'fresh snapshot after feed loss',
      );
      c.socket = recovered;
      const closed = clients.map((c) => once(c.socket, 'close'));
      await users.collection.updateOne(
        { _id: owner },
        { $set: { status: 'suspended' } },
      );
      for (const result of await Promise.all(closed))
        assert.equal(result[0], 4001);
    } finally {
      for (const cleanup of close.reverse()) await cleanup();
      await services.stop();
    }
  },
);

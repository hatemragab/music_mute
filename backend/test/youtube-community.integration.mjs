import 'reflect-metadata';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createConnection, Types } from 'mongoose';
import { jobError } from '../dist/jobs/job-errors.js';
import { LocalMediaValidationService } from '../dist/local-media-syncs/local-media-validation.service.js';
import { PROCESSING_MODELS } from '../dist/processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../dist/processing/processing-transactions.js';
import { RateBudgetService } from '../dist/rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../dist/rate-limits/rate-limit-keys.js';
import { SharedMediaCatalogService } from '../dist/shared-media/shared-media-catalog.service.js';
import { SharedMediaService } from '../dist/shared-media/shared-media.service.js';
import {
  communitySourceKey,
  sharedSourceKey,
} from '../dist/shared-media/shared-media-key.js';
import { MediaImportSchema } from '../dist/url-imports/media-import.schema.js';
import { User, UserSchema } from '../dist/users/user.schema.js';
import { YouTubeCommunityService } from '../dist/youtube-community/youtube-community.service.js';
import {
  YouTubeGuestSession,
  YouTubeGuestSessionSchema,
  YouTubeContribution,
  YouTubeContributionSchema,
  YouTubeContributionLease,
  YouTubeContributionLeaseSchema,
  YouTubeCommunityBudget,
  YouTubeCommunityBudgetSchema,
  YouTubeCommunityCleanup,
  YouTubeCommunityCleanupSchema,
} from '../dist/youtube-community/youtube-community.schema.js';
import { YOUTUBE_COMMUNITY_PROFILE_ID } from '../dist/youtube-community/youtube-community.types.js';
import { IsolatedServices } from './helpers/isolated-services.mjs';

const execute = promisify(execFile);
const digest = (bytes) => createHash('sha256').update(bytes).digest('base64');
const errorCode = (error) => error?.getResponse?.().code;
const aliases = [
  'https://www.youtube.com/watch?v=bZxrIoCPsOc&list=RDbZxrIoCPsOc&start_radio=1',
  'https://youtu.be/bZxrIoCPsOc?si=RLbbOevlM4lBmXHi',
  'https://music.youtube.com/watch?v=bZxrIoCPsOc&feature=share',
];
const canonical = 'https://www.youtube.com/watch?v=bZxrIoCPsOc';
const guestModels = [
  { name: YouTubeGuestSession.name, schema: YouTubeGuestSessionSchema },
  { name: YouTubeContribution.name, schema: YouTubeContributionSchema },
  {
    name: YouTubeContributionLease.name,
    schema: YouTubeContributionLeaseSchema,
  },
  { name: YouTubeCommunityBudget.name, schema: YouTubeCommunityBudgetSchema },
  { name: YouTubeCommunityCleanup.name, schema: YouTubeCommunityCleanupSchema },
];

test('guest YouTube pair is single-flight, privately validated, durable and reusable without account effects', async (t) => {
  const native = await IsolatedServices.create();
  let connection, redis, first, second;
  t.after(async () => {
    first?.onModuleDestroy();
    second?.onModuleDestroy();
    await redis?.quit();
    await connection?.close();
    await native.stop();
  });
  const { mongoUri, redisPort } = await native.startDatabases({
    replicaSet: true,
  });
  connection = await createConnection(mongoUri).asPromise();
  for (const { name, schema } of [...PROCESSING_MODELS, ...guestModels])
    connection.model(name, schema);
  connection.model('MediaImport', MediaImportSchema);
  connection.model(User.name, UserSchema);
  await Promise.all(
    Object.values(connection.models).map((model) => model.init()),
  );
  const model = (name) => connection.model(name);
  redis = new Redis({ host: '127.0.0.1', port: redisPort, lazyConnect: true });
  await redis.connect();
  const { stdout: found } = await execute('which', [
    process.env.FFPROBE_BINARY || 'ffprobe',
  ]);
  const ffprobe = found.trim();
  const config = new ConfigService({
    STORAGE_BUCKET: 'synthetic-youtube-community',
    URL_IMPORT_FFPROBE_PATH: ffprobe,
    FIREBASE_PROJECT_ID: 'demo-youtube-community',
    RATE_LIMIT_HASH_SECRET: 'isolated-youtube-community-hash-secret-0001',
    AUDIO_PROCESSING_ENABLED: false,
    URL_IMPORT_ENABLED: false,
  });
  const audioPath = join(native.directory, 'synthetic.mp3');
  await execute(join(dirname(ffprobe), 'ffmpeg'), [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-b:a',
    '160k',
    audioPath,
  ]);
  const audio = await readFile(audioPath);
  const { stdout: probe } = await execute(ffprobe, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    audioPath,
  ]);
  const declaration = {
    extension: 'mp3',
    contentType: 'audio/mpeg',
    bytes: audio.length,
    sha256: digest(audio),
    durationSeconds: Number(JSON.parse(probe).format.duration),
  };
  const objects = new Map();
  const copies = [];
  const deleted = [];
  const grants = [];
  let gets = 0;
  let heads = 0;
  let loseCopy = false;
  let validations = 0;
  const storage = {
    createWorkerOutputGrant: async (reservation, expiresAt) => {
      // The exact cleanup intent must be committed before any client capability.
      const cleanup = await model(YouTubeCommunityCleanup.name)
        .findOne({ key: reservation.key })
        .lean();
      assert.ok(cleanup);
      grants.push(reservation.key);
      return {
        method: 'PUT',
        url: `https://fixture.invalid/upload/${grants.length}`,
        headers: {
          'Content-Type': reservation.contentType,
          'If-None-Match': '*',
          'x-amz-checksum-sha256': reservation.sha256,
        },
        expiresAt: expiresAt.toISOString(),
      };
    },
    findUploadedObject: async (reservation, etag) => {
      heads++;
      const found = objects.get(reservation.key);
      if (!found) return null;
      assert.equal(found.identity.bytes, reservation.bytes);
      assert.equal(found.identity.sha256, reservation.sha256);
      assert.equal(found.identity.contentType, reservation.contentType);
      if (etag && found.identity.etag !== etag)
        throw jobError('UPLOAD_NOT_READY');
      return found.identity;
    },
    copyObject: async (source, key) => {
      const original = objects.get(source.key);
      assert.ok(original);
      assert.deepEqual(original.identity, source);
      assert.equal(
        objects.has(key),
        false,
        'conditional copy cannot replace a shared object',
      );
      const intent = await model('SharedMediaArtifact').findById(key).lean();
      assert.ok(intent, 'the durable immutable object intent precedes COPY');
      assert.equal(intent.object, null);
      const identity = { ...source, key, etag: `"copy-${copies.length + 1}"` };
      copies.push(key);
      objects.set(key, { identity, bytes: original.bytes });
      if (loseCopy && key.includes('/output/')) {
        loseCopy = false;
        throw new Error('synthetic lost COPY response');
      }
      return identity;
    },
    createMediaGrant: async (identity, purpose, filename) => {
      assert.deepEqual(objects.get(identity.key)?.identity, identity);
      assert.equal(purpose, 'play');
      assert.match(identity.key, /^shared\/url\//);
      assert.ok(['original.mp3', 'vocals.mp3'].includes(filename));
      return {
        url: `https://fixture.invalid/private/${encodeURIComponent(identity.key)}`,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
    },
    deleteObject: async (key) => {
      assert.match(
        key,
        /^quarantine\/youtube\/[a-f0-9]{24}\/(?:input\/source\.[a-z0-9]+|output\/vocals\.mp3)$/,
      );
      deleted.push(key);
      objects.delete(key);
    },
  };
  const rawStorage = {
    send: async (command) => {
      gets++;
      const object = objects.get(command.input.Key);
      assert.ok(object);
      assert.equal(command.input.IfMatch, object.identity.etag);
      return { Body: Readable.from([object.bytes]) };
    },
  };
  const realValidation = new LocalMediaValidationService(rawStorage, config);
  const validation = {
    validate: (...args) => {
      validations++;
      return realValidation.validate(...args);
    },
  };
  const transactions = new ProcessingTransactions(connection);
  const catalog = new SharedMediaCatalogService(
    model('SharedMediaSource'),
    model('SharedMediaResult'),
    model('SharedMediaArtifact'),
    storage,
    transactions,
    {
      derive: async () => {
        throw new Error(
          'guest full playback must not run derivative processing',
        );
      },
    },
  );
  const shared = new SharedMediaService(
    model('SharedMediaSource'),
    model('SharedMediaResult'),
    model('MediaImport'),
    model('Job'),
    storage,
    transactions,
    model('SharedMediaArtifact'),
    catalog,
  );
  await shared.initialize();
  const rate = new RateBudgetService(redis);
  const keys = new RateLimitKeys(config);
  const makeService = () =>
    new YouTubeCommunityService(
      model(YouTubeGuestSession.name),
      model(YouTubeContribution.name),
      model(YouTubeContributionLease.name),
      model(YouTubeCommunityBudget.name),
      model(YouTubeCommunityCleanup.name),
      new ProcessingTransactions(connection),
      rate,
      keys,
      storage,
      validation,
      shared,
      connection,
      model('ProcessingAdmissionFence'),
    );
  first = makeService();
  second = makeService();
  await first.onModuleInit();
  await second.onModuleInit();
  const sessions = await Promise.all(
    Array.from({ length: 7 }, (_, index) =>
      first.issueSession(`192.0.2.${index + 1}`),
    ),
  );
  const guests = await Promise.all(
    sessions.map((session, index) =>
      first.authenticate(session.token, `192.0.2.${index + 1}`, false),
    ),
  );
  const dto = (url = canonical, requestId = randomUUID()) => ({
    url,
    requestId,
    profileId: YOUTUBE_COMMUNITY_PROFILE_ID,
  });
  const upload = async (contributionId, data = audio) => {
    const stored = await model(YouTubeContribution.name)
      .findById(contributionId)
      .lean();
    for (const artifact of [stored.original, stored.vocals]) {
      assert.ok(artifact);
      assert.equal(
        objects.has(artifact.key),
        false,
        'immutable PUT cannot replace donor bytes',
      );
      assert.equal(artifact.bytes, data.length);
      assert.equal(artifact.sha256, digest(data));
      objects.set(artifact.key, {
        bytes: data,
        identity: {
          key: artifact.key,
          contentType: artifact.contentType,
          bytes: data.length,
          sha256: digest(data),
          etag: `"put-${objects.size + 1}"`,
        },
      });
    }
    return stored;
  };
  let producer, producerGuest, producerDto, ready;

  await t.test(
    'aliases and concurrent backend replicas elect one guest before any local work',
    async () => {
      const submissions = guests.slice(0, 5).map((guest, index) => ({
        guest,
        dto: dto(aliases[index % aliases.length]),
        service: index % 2 ? first : second,
      }));
      const results = await Promise.all(
        submissions.map(({ guest, dto, service }) =>
          service.create(guest, dto),
        ),
      );
      assert.equal(results.filter((result) => result.producer).length, 1);
      const producerIndex = results.findIndex((result) => result.producer);
      producer = results[producerIndex];
      producerGuest = submissions[producerIndex].guest;
      producerDto = submissions[producerIndex].dto;
      assert.equal(producer.state, 'preparing');
      assert.equal(
        results.filter((result) => result.state === 'waiting').length,
        4,
      );
      assert.equal(await model(YouTubeContribution.name).countDocuments(), 5);
      assert.equal(await model('SharedMediaSource').countDocuments(), 1);
      assert.equal(await model('SharedMediaResult').countDocuments(), 1);
      assert.equal(
        (await model('SharedMediaSource').findOne())._id,
        communitySourceKey(canonical),
      );
      const repeated = await second.create(producerGuest, {
        ...producerDto,
        url: aliases[1],
      });
      assert.equal(repeated.contributionId, producer.contributionId);
      assert.equal(grants.length, 0);
      assert.equal(validations, 0);
      assert.equal(copies.length, 0);
      const claim = await transactions.run(async (session) => {
        await model('ProcessingAdmissionFence').updateOne(
          { _id: 'url-import-admission' },
          { $inc: { revision: 1 } },
          { session },
        );
        return shared.claim(
          canonical,
          'youtube',
          new Types.ObjectId(),
          false,
          session,
        );
      });
      assert.equal(claim.waitingForCommunity, true);
      assert.equal(claim.sourceKey, communitySourceKey(canonical));
      assert.equal(
        await model('SharedMediaSource').findById(sharedSourceKey(canonical)),
        null,
        'a waiting cloud import does not acquire an independent source',
      );
      const snapshot = await first.snapshot('bZxrIoCPsOc');
      assert.deepEqual(Object.keys(snapshot), [
        'videoId',
        'state',
        'expiresAt',
      ]);
      assert.equal(snapshot.state, 'preparing');
      assert.equal(snapshot.expiresAt, producer.leaseExpiresAt);
    },
  );

  await t.test(
    'guest ownership, immutable declarations and pair budgets fence grants',
    async () => {
      const stranger = guests.find(
        (guest) => !guest._id.equals(producerGuest._id),
      );
      await assert.rejects(
        first.get(stranger, producer.contributionId),
        (error) => errorCode(error) === 'YOUTUBE_CONTRIBUTION_NOT_FOUND',
      );
      await assert.rejects(
        first.complete(stranger, producer.contributionId),
        (error) => errorCode(error) === 'YOUTUBE_CONTRIBUTION_NOT_FOUND',
      );
      await assert.rejects(
        first.create(producerGuest, {
          ...producerDto,
          url: 'https://youtu.be/abcdefghijk',
        }),
        (error) => errorCode(error) === 'IDEMPOTENCY_CONFLICT',
      );
      await first.renewLease(producerGuest, producer.contributionId);
      const body = {
        requestId: producerDto.requestId,
        original: declaration,
        vocals: declaration,
      };
      const before = await first.grants(
        producerGuest,
        producer.contributionId,
        body,
      );
      const stored = await model(YouTubeContribution.name)
        .findById(producer.contributionId)
        .lean();
      const again = await second.grants(
        producerGuest,
        producer.contributionId,
        body,
      );
      assert.equal(before.state, 'awaiting_upload');
      assert.deepEqual(
        again.uploadGrants.original.headers,
        before.uploadGrants.original.headers,
      );
      assert.equal(
        (
          await model(YouTubeContribution.name).findById(
            producer.contributionId,
          )
        ).grantCount,
        1,
      );
      assert.equal(
        (
          await model(YouTubeCommunityBudget.name).findById(
            'contribution:global:lifetime',
          )
        ).reservedBytes,
        2 * audio.length,
      );
      assert.match(
        stored.original.key,
        new RegExp(
          `^quarantine/youtube/${producer.contributionId}/input/source.mp3$`,
        ),
      );
      assert.match(
        stored.vocals.key,
        new RegExp(
          `^quarantine/youtube/${producer.contributionId}/output/vocals.mp3$`,
        ),
      );
      await assert.rejects(
        first.grants(producerGuest, producer.contributionId, {
          ...body,
          vocals: { ...declaration, bytes: declaration.bytes + 1 },
        }),
        (error) => errorCode(error) === 'IDEMPOTENCY_CONFLICT',
      );
      assert.equal(
        (
          await model(YouTubeCommunityBudget.name).findById(
            'contribution:global:lifetime',
          )
        ).reservedBytes,
        2 * audio.length,
      );
      await assert.rejects(
        first.complete(producerGuest, producer.contributionId),
        (error) => errorCode(error) === 'UPLOAD_NOT_READY',
      );
      assert.equal(validations, 0);
      await upload(producer.contributionId);
    },
  );

  await t.test(
    'real full decode validates the pair and HEAD recovers uncertain shared COPY once',
    async () => {
      loseCopy = true;
      await assert.rejects(
        first.complete(producerGuest, producer.contributionId),
        (error) => errorCode(error) === 'SERVICE_UNAVAILABLE',
      );
      assert.equal(copies.length, 2);
      assert.equal(
        (
          await model(YouTubeContribution.name).findById(
            producer.contributionId,
          )
        ).state,
        'awaiting_upload',
      );
      assert.equal(
        (await model('SharedMediaResult').findOne()).state,
        'processing',
      );
      assert.equal(await shared.lookupReady(canonical, false), null);
      const recovered = await second.complete(
        producerGuest,
        producer.contributionId,
      );
      assert.equal(recovered.state, 'ready');
      assert.equal(recovered.producer, false);
      assert.equal(
        copies.length,
        2,
        'confirmed immutable COPY outcomes are recovered by HEAD, never copied again',
      );
      assert.equal(validations, 2);
      assert.equal(gets, 4);
      ready = await shared.lookupReady(canonical, false);
      assert.equal(ready.provenance, 'community_contributed');
      assert.equal(ready.sourceIdentityVerified, false);
      assert.equal(ready.recipeSnapshot.trimEnabled, false);
      assert.equal(
        await model('SharedMediaArtifact').countDocuments({
          object: { $ne: null },
        }),
        2,
      );
      assert.equal((await model('SharedMediaSource').findOne()).state, 'ready');
      assert.equal(deleted.length, 0);
    },
  );

  await t.test(
    'all guest readers and cloud cache claims reuse the same private identities',
    async () => {
      const before = {
        validations,
        gets,
        copies: copies.length,
        grants: grants.length,
        contributions: await model(YouTubeContribution.name).countDocuments(),
      };
      for (const [index, guest] of guests.entries()) {
        const delivery = await (index % 2 ? first : second).delivery(
          guest,
          aliases[index % aliases.length],
        );
        assert.equal(delivery.videoId, 'bZxrIoCPsOc');
        assert.equal(delivery.provenance, 'community_contributed');
        assert.equal(delivery.sourceIdentityVerified, false);
        assert.deepEqual(delivery.original.declaration, declaration);
        assert.deepEqual(delivery.vocals.declaration, declaration);
        assert.ok(
          delivery.original.grant.url.includes(
            encodeURIComponent(ready.inputObject.key),
          ),
        );
        assert.ok(
          delivery.vocals.grant.url.includes(
            encodeURIComponent(ready.outputObject.key),
          ),
        );
      }
      const repeated = await second.create(guests[6], dto(aliases[1]));
      assert.equal(repeated.state, 'ready');
      assert.equal(repeated.producer, false);
      assert.equal(repeated.contributionId, null);
      const cached = await transactions.run(async (session) => {
        await model('ProcessingAdmissionFence').updateOne(
          { _id: 'url-import-admission' },
          { $inc: { revision: 1 } },
          { session },
        );
        return shared.claim(
          canonical,
          'youtube',
          new Types.ObjectId(),
          false,
          session,
          true,
        );
      });
      assert.equal(cached.cached, true);
      assert.equal(cached.sourceKey, ready.sourceKey);
      assert.equal(cached.resultKey, ready.resultKey);
      assert.equal(validations, before.validations);
      assert.equal(gets, before.gets);
      assert.equal(copies.length, before.copies);
      assert.equal(grants.length, before.grants);
      assert.equal(
        await model(YouTubeContribution.name).countDocuments(),
        before.contributions,
      );
    },
  );

  await t.test(
    'completion response loss and guest session expiry leave accepted shared media intact',
    async () => {
      // Simulate the final owned receipt update being lost after catalog publication.
      await model(YouTubeContribution.name).updateOne(
        { _id: producer.contributionId },
        {
          $set: {
            state: 'awaiting_upload',
            producer: true,
            leaseExpiresAt: new Date(Date.now() + 600_000),
          },
        },
      );
      const before = { validations, gets, copies: copies.length };
      const replay = await first.complete(
        producerGuest,
        producer.contributionId,
      );
      assert.equal(replay.state, 'ready');
      assert.equal(replay.producer, false);
      const receipt = await model(YouTubeContribution.name)
        .findById(producer.contributionId)
        .lean();
      assert.equal(receipt.state, 'ready');
      assert.equal(
        receipt.producer,
        false,
        'ready recovery closes the old producer pending slot',
      );
      assert.deepEqual({ validations, gets, copies: copies.length }, before);
      await model(YouTubeGuestSession.name).updateOne(
        { _id: producerGuest._id },
        { $set: { revokedAt: new Date() } },
      );
      const donorSession =
        sessions[
          guests.findIndex((guest) => guest._id.equals(producerGuest._id))
        ];
      await assert.rejects(
        first.authenticate(donorSession.token, undefined, false),
        (error) => errorCode(error) === 'UNAUTHENTICATED',
      );
      await assert.rejects(
        first.delivery(producerGuest, canonical),
        (error) => errorCode(error) === 'UNAUTHENTICATED',
      );
      const viewer = guests.find(
        (guest) => !guest._id.equals(producerGuest._id),
      );
      assert.equal(
        (await second.delivery(viewer, canonical)).videoId,
        'bZxrIoCPsOc',
      );
      assert.deepEqual(await shared.lookupReady(canonical, false), ready);
      for (const name of [
        'User',
        'Job',
        'LocalMediaSync',
        'MediaImport',
        'AccountUsagePeriod',
        'AccountDailyUsagePeriod',
        'ProcessingReservation',
        'UploadGrantReceipt',
        'DownloadGrantReceipt',
        'ServiceUsagePeriod',
        'NotificationOutbox',
      ])
        assert.equal(
          await model(name).countDocuments(),
          0,
          `guest cache work never creates ${name}`,
        );
    },
  );

  await t.test(
    'failed preparation and expired producers release only their own reservation',
    async () => {
      const guest = guests.find(
        (guest) => !guest._id.equals(producerGuest._id),
      );
      const url = 'https://youtu.be/abcdefghijk';
      const record = await first.create(guest, dto(url));
      assert.equal(record.producer, true);
      const failed = await first.fail(guest, record.contributionId);
      assert.equal(failed.state, 'failed');
      assert.equal(
        (await model('SharedMediaSource').findById(communitySourceKey(url)))
          .state,
        'failed',
      );
      const next = await second.create(guest, dto(url));
      assert.equal(next.producer, true);
      assert.notEqual(next.contributionId, record.contributionId);
      await model(YouTubeContribution.name).updateOne(
        { _id: next.contributionId },
        { $set: { leaseExpiresAt: new Date(0) } },
      );
      await second.maintenance();
      assert.equal(
        (await model(YouTubeContribution.name).findById(next.contributionId))
          .state,
        'expired',
      );
      assert.equal(
        (await model('SharedMediaSource').findById(communitySourceKey(url)))
          .state,
        'failed',
      );
      assert.deepEqual(await shared.lookupReady(canonical, false), ready);
    },
  );

  await t.test(
    'offline prepared bytes reclaim an expired lease and wait behind an active replacement',
    async () => {
      const donors = guests.filter(
        (guest) => !guest._id.equals(producerGuest._id),
      );
      const url = 'https://youtu.be/prepared001';
      const body = dto(url);
      const old = await first.create(donors[0], body);
      await model(YouTubeContribution.name).updateOne(
        { _id: old.contributionId },
        { $set: { leaseExpiresAt: new Date(0) } },
      );
      await first.maintenance();
      assert.equal(
        (await model(YouTubeContribution.name).findById(old.contributionId))
          .state,
        'expired',
      );
      const replacement = await second.create(donors[1], dto(url));
      assert.equal(replacement.producer, true);
      const declarations = {
        requestId: body.requestId,
        original: declaration,
        vocals: declaration,
      };
      const before = {
        grants: grants.length,
        validations,
        copies: copies.length,
      };
      const waiting = await first.grants(
        donors[0],
        old.contributionId,
        declarations,
      );
      assert.equal(waiting.state, 'waiting');
      assert.equal(waiting.producer, false);
      assert.equal(waiting.uploadGrants, null);
      assert.deepEqual(
        { grants: grants.length, validations, copies: copies.length },
        before,
      );
      await second.fail(donors[1], replacement.contributionId);
      const recovered = await first.grants(
        donors[0],
        old.contributionId,
        declarations,
      );
      assert.equal(recovered.state, 'awaiting_upload');
      assert.equal(recovered.producer, true);
      assert.equal(recovered.contributionId, old.contributionId);
      const current = await model(YouTubeContribution.name)
        .findById(old.contributionId)
        .lean();
      assert.equal(current.producer, true);
      assert.equal(current.grantCount, 1);
      await upload(old.contributionId);
      const accepted = await second.complete(donors[0], old.contributionId);
      assert.equal(accepted.state, 'ready');
      assert.equal(copies.length, before.copies + 2);
      assert.deepEqual(await shared.lookupReady(canonical, false), ready);
    },
  );

  await t.test(
    'background publication permits one next preparation across concurrent backend replicas',
    async () => {
      const session = await first.issueSession('192.0.2.101');
      const guest = await first.authenticate(
        session.token,
        '192.0.2.101',
        false,
      );
      const oldBody = dto('https://youtu.be/bgprepare00');
      const old = await first.create(guest, oldBody);
      await model(YouTubeContribution.name).updateOne(
        { _id: old.contributionId },
        { $set: { leaseExpiresAt: new Date(0) } },
      );
      await first.maintenance();
      const pendingBody = dto('https://youtu.be/bgprepare01');
      const pending = await first.create(guest, pendingBody);
      await first.grants(guest, pending.contributionId, {
        requestId: pendingBody.requestId,
        original: declaration,
        vocals: declaration,
      });
      const bodies = [
        dto('https://youtu.be/bgprepare02'),
        dto('https://youtu.be/bgprepare03'),
      ];
      const results = await Promise.allSettled([
        first.create(guest, bodies[0]),
        second.create(guest, bodies[1]),
      ]);
      const accepted = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const denied = results.filter((result) => result.status === 'rejected');
      assert.equal(accepted.length, 1);
      assert.equal(denied.length, 1);
      assert.equal(errorCode(denied[0].reason), 'YOUTUBE_COMMUNITY_CAPACITY');
      assert.equal(accepted[0].value.state, 'preparing');
      const rejectedIndex = results.findIndex(
        (result) => result.status === 'rejected',
      );
      assert.equal(
        await model('SharedMediaSource').findById(
          communitySourceKey(bodies[rejectedIndex].url),
        ),
        null,
        'capacity rejection rolls back the tentative shared source reservation',
      );
      const reclaimed = await second.grants(guest, old.contributionId, {
        requestId: oldBody.requestId,
        original: declaration,
        vocals: declaration,
      });
      assert.equal(reclaimed.state, 'awaiting_upload');
      assert.equal(reclaimed.contributionId, old.contributionId);
      assert.equal(
        (
          await model(YouTubeContribution.name).findById(
            accepted[0].value.contributionId,
          )
        ).state,
        'preparing',
      );
      for (const contribution of [old, pending, accepted[0].value])
        await first.fail(guest, contribution.contributionId);
    },
  );

  await t.test(
    'a full publication backlog rejects new work without blocking exact grant replay',
    async () => {
      const session = await first.issueSession('192.0.2.102');
      const guest = await first.authenticate(
        session.token,
        '192.0.2.102',
        false,
      );
      const pending = [];
      for (let index = 0; index < 4; index++) {
        const body = dto(`https://youtu.be/bgbacklog0${index}`);
        const view = await first.create(guest, body);
        const declarations = {
          requestId: body.requestId,
          original: declaration,
          vocals: declaration,
        };
        await first.grants(guest, view.contributionId, declarations);
        pending.push({ body, view, declarations });
      }
      const nextBody = dto('https://youtu.be/bgbacklog04');
      await assert.rejects(
        second.create(guest, nextBody),
        (error) => errorCode(error) === 'YOUTUBE_COMMUNITY_CAPACITY',
      );
      assert.equal(
        await model('SharedMediaSource').findById(
          communitySourceKey(nextBody.url),
        ),
        null,
      );
      const before = await model(YouTubeCommunityBudget.name)
        .find()
        .sort({ _id: 1 })
        .lean();
      const replay = await second.create(guest, pending[0].body);
      assert.equal(replay.contributionId, pending[0].view.contributionId);
      await second.grants(
        guest,
        replay.contributionId,
        pending[0].declarations,
      );
      assert.equal(
        (await model(YouTubeContribution.name).findById(replay.contributionId))
          .grantCount,
        1,
      );
      assert.deepEqual(
        await model(YouTubeCommunityBudget.name).find().sort({ _id: 1 }).lean(),
        before,
        'replay must not consume the permanent or daily byte budget again',
      );
      await first.fail(guest, replay.contributionId);
      const next = await second.create(guest, nextBody);
      assert.equal(next.state, 'preparing');
      for (const entry of pending.slice(1))
        await first.fail(guest, entry.view.contributionId);
      await second.fail(guest, next.contributionId);
    },
  );

  await t.test(
    'publication recovery and fresh preparation atomically compete for the last backlog slot',
    async () => {
      const session = await first.issueSession('192.0.2.103');
      const guest = await first.authenticate(
        session.token,
        '192.0.2.103',
        false,
      );
      const oldBody = dto('https://youtu.be/bgraceold00');
      const old = await first.create(guest, oldBody);
      await model(YouTubeContribution.name).updateOne(
        { _id: old.contributionId },
        { $set: { leaseExpiresAt: new Date(0) } },
      );
      await first.maintenance();
      for (let index = 0; index < 3; index++) {
        const body = dto(`https://youtu.be/bgracepub0${index}`);
        const view = await first.create(guest, body);
        await first.grants(guest, view.contributionId, {
          requestId: body.requestId,
          original: declaration,
          vocals: declaration,
        });
      }
      const nextBody = dto('https://youtu.be/bgracenew00');
      const beforeValidation = validations;
      const results = await Promise.allSettled([
        first.grants(guest, old.contributionId, {
          requestId: oldBody.requestId,
          original: declaration,
          vocals: declaration,
        }),
        second.create(guest, nextBody),
      ]);
      assert.equal(
        results.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      const denied = results.find((result) => result.status === 'rejected');
      assert.equal(errorCode(denied.reason), 'YOUTUBE_COMMUNITY_CAPACITY');
      const active = await model(YouTubeContribution.name)
        .find({
          guestSessionId: guest._id,
          producer: true,
          state: { $in: ['preparing', 'awaiting_upload', 'validating'] },
          leaseExpiresAt: { $gt: new Date() },
          expiresAt: { $gt: new Date() },
        })
        .lean();
      assert.equal(active.length, 4);
      assert.equal(validations, beforeValidation);
      if (results[0].status === 'rejected') {
        const stored = await model(YouTubeContribution.name)
          .findById(old.contributionId)
          .lean();
        assert.equal(stored.state, 'expired');
        assert.equal(stored.declarationHash, null);
        assert.equal(stored.producer, false);
      } else {
        assert.equal(results[0].value.state, 'awaiting_upload');
        assert.equal(
          await model('SharedMediaSource').findById(
            communitySourceKey(nextBody.url),
          ),
          null,
        );
      }
      for (const contribution of active)
        await first.fail(guest, contribution._id.toHexString());
    },
  );

  await t.test(
    'cloud and guest admission share one atomic source producer during a race',
    async () => {
      const guest = guests.find(
        (guest) => !guest._id.equals(producerGuest._id),
      );
      const url = 'https://www.youtube.com/watch?v=crossflow01';
      const [local, cloud] = await Promise.all([
        first.create(guest, dto(url)),
        transactions.run(async (session) => {
          await model('ProcessingAdmissionFence').updateOne(
            { _id: 'url-import-admission' },
            { $inc: { revision: 1 } },
            { session },
          );
          return shared.claim(
            url,
            'youtube',
            new Types.ObjectId(),
            false,
            session,
          );
        }),
      ]);
      const sourceKeys = [sharedSourceKey(url), communitySourceKey(url)];
      assert.equal(
        await model('SharedMediaSource').countDocuments({
          _id: { $in: sourceKeys },
        }),
        1,
      );
      if (local.producer) {
        assert.equal(cloud.waitingForCommunity, true);
        assert.equal(cloud.sourceKey, communitySourceKey(url));
        await first.fail(guest, local.contributionId);
      } else {
        assert.equal(local.state, 'waiting');
        assert.equal(cloud.sourceKey, sharedSourceKey(url));
        assert.equal((await first.snapshot('crossflow01')).state, 'preparing');
        await model('SharedMediaSource').updateOne(
          { _id: cloud.sourceKey },
          { $set: { state: 'failed' } },
        );
      }
    },
  );

  await t.test(
    'trusted original can be delivered without vocals under an owned producer lease',
    async () => {
      const url = 'https://www.youtube.com/watch?v=original001';
      const key = sharedSourceKey(url),
        generation = randomUUID();
      const identity = {
        key: `shared/url/${key}/${generation}/input/source.mp3`,
        bytes: declaration.bytes,
        sha256: declaration.sha256,
        contentType: declaration.contentType,
        etag: '"trusted-original"',
      };
      objects.set(identity.key, { identity, bytes: audio });
      await model('SharedMediaSource').create({
        _id: key,
        sourceUrl: url,
        provider: 'youtube',
        generation,
        state: 'ready',
        provenance: 'trusted',
        input: declaration,
        inputObject: identity,
        inputKey: identity.key,
        producerImportId: new Types.ObjectId(),
        acquiredAt: new Date(),
      });
      const guest = guests.find(
        (guest) => !guest._id.equals(producerGuest._id),
      );
      const view = await first.create(guest, dto(url));
      assert.equal(view.producer, true);
      assert.equal(view.state, 'preparing');
      const result = await second.sourceDelivery(guest, view.contributionId);
      assert.equal(result.videoId, 'original001');
      assert.equal(result.provenance, 'trusted');
      assert.equal(result.sourceIdentityVerified, true);
      assert.equal(result.original.declaration.sha256, declaration.sha256);
      assert.equal('vocals' in result, false);
      await assert.rejects(
        second.sourceDelivery(
          await first.authenticate(
            (await first.issueSession('192.0.2.123')).token,
            '192.0.2.123',
          ),
          view.contributionId,
        ),
        (error) => errorCode(error) === 'YOUTUBE_CONTRIBUTION_NOT_FOUND',
      );
      await first.fail(guest, view.contributionId);
      await assert.rejects(
        second.sourceDelivery(guest, view.contributionId),
        (error) =>
          [
            'YOUTUBE_CONTRIBUTION_EXPIRED',
            'YOUTUBE_CONTRIBUTION_CONFLICT',
          ].includes(errorCode(error)),
      );
    },
  );

  await t.test(
    'quarantine cleanup is durable and never deletes the accepted shared pair',
    async () => {
      const tasks = await model(YouTubeCommunityCleanup.name)
        .find({ contributionId: producer.contributionId })
        .lean();
      assert.equal(tasks.length, 2);
      assert.ok(
        tasks.every((task) => task.nextAt.getTime() > Date.now()),
        'active upload grants settle before deletion',
      );
      await model(YouTubeCommunityCleanup.name).updateMany(
        { contributionId: producer.contributionId },
        { $set: { nextAt: new Date(0) } },
      );
      await second.maintenance();
      assert.equal(deleted.length, 2);
      assert.ok(objects.has(ready.inputObject.key));
      assert.ok(objects.has(ready.outputObject.key));
      assert.equal(
        await model(YouTubeCommunityCleanup.name).countDocuments({
          contributionId: producer.contributionId,
          state: 'settle',
        }),
        2,
      );
      await model(YouTubeCommunityCleanup.name).updateMany(
        { contributionId: producer.contributionId },
        { $set: { nextAt: new Date(0) } },
      );
      await first.maintenance();
      assert.equal(deleted.length, 4);
      assert.equal(
        await model(YouTubeCommunityCleanup.name).countDocuments({
          contributionId: producer.contributionId,
          state: 'done',
        }),
        2,
      );
      assert.ok(objects.has(ready.inputObject.key));
      assert.ok(objects.has(ready.outputObject.key));
    },
  );
  t.diagnostic(
    JSON.stringify({
      fixture: 'guest-community-real-mongo-redis-synthetic-audio',
      guests: await model(YouTubeGuestSession.name).countDocuments(),
      validations,
      validation_object_reads: gets,
      storage_head_checks: heads,
      immutable_shared_copies: copies.length,
      quarantine_deletions: deleted.length,
      account_jobs: await model('Job').countDocuments(),
    }),
  );
});

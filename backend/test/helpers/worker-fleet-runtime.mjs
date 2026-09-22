import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { assertLoopbackUrl } from './isolated-services.mjs';

assertLoopbackUrl(process.env.MONGODB_URI);
assertLoopbackUrl(process.env.REDIS_URL);

const { AppModule } = await import('../../dist/app.module.js');
const { configureHttp } = await import('../../dist/http/configure-http.js');
const { FirebaseIdentityService } =
  await import('../../dist/auth/firebase-identity.service.js');
const { StoragePreflightService } =
  await import('../../dist/storage/storage-preflight.service.js');
const { StorageTransfersService } =
  await import('../../dist/storage/storage-transfers.service.js');
const { WorkerRecoveryService } =
  await import('../../dist/worker-fleet/leases/worker-recovery.service.js');
const { WorkerControlPlaneClient } =
  await import('../../../worker/dist/src/runtime/control-plane-client.js');
const { WorkerTransferClient } =
  await import('../../../worker/dist/src/runtime/transfers.js');
const { WorkerRuntime } =
  await import('../../../worker/dist/src/runtime/worker-runtime.js');

const useRealS3 = process.env.WORKER_INTEGRATION_STORAGE === 's3';
const externalService = process.env.WORKER_INTEGRATION_EXTERNAL === 'true';
if (externalService && !useRealS3)
  throw new Error('External worker integration requires real S3');
const externalPlatform =
  process.env.WORKER_INTEGRATION_EXTERNAL_PLATFORM ?? 'windows-amd64';
if (
  externalService &&
  !['darwin-arm64', 'windows-amd64'].includes(externalPlatform)
)
  throw new Error('External worker integration platform is unsupported');
const externalMac = externalPlatform === 'darwin-arm64';
const externalProvider = externalMac ? 'mps' : 'directml';
const externalPlatformMarker = externalMac
  ? 'macos-mps-service'
  : 'windows-directml-service';
const runId = process.env.WORKER_INTEGRATION_RUN_ID ?? 'fixture';
if (!/^[a-z0-9-]{1,64}$/.test(runId))
  throw new Error('Invalid worker integration run ID');
const userToken = `worker-integration-${runId}`;
const userUid = `worker-integration-${runId}`;
const installationId = randomUUID();
const machineId = externalService
  ? process.env.WORKER_INTEGRATION_MACHINE_ID
  : randomUUID();
const workerId = externalService
  ? process.env.WORKER_INTEGRATION_WORKER_ID
  : randomUUID();
const gpuId = externalService
  ? process.env.WORKER_INTEGRATION_GPU_ID
  : 'fixture-gpu-0';
for (const [label, value] of [
  ['machine ID', machineId],
  ['worker ID', workerId],
  ['GPU ID', gpuId],
])
  if (!value || value.length > 200)
    throw new Error(`Invalid external worker ${label}`);
const machineCredential = randomBytes(32).toString('base64url');
const machineCredentialDigest = externalService
  ? process.env.WORKER_INTEGRATION_CREDENTIAL_DIGEST
  : createHash('sha256').update(machineCredential).digest('hex');
if (!/^[a-f0-9]{64}$/.test(machineCredentialDigest ?? ''))
  throw new Error('Invalid external worker credential digest');
const requestedInputBytes = Number(
  process.env.WORKER_INTEGRATION_INPUT_BYTES ?? 36,
);
if (
  !Number.isSafeInteger(requestedInputBytes) ||
  requestedInputBytes < 1 ||
  requestedInputBytes > 1_048_576
)
  throw new Error('Invalid worker integration input size');
const inputPath = process.env.WORKER_INTEGRATION_INPUT_PATH;
const input = externalService
  ? await readFile(inputPath ?? '')
  : Buffer.alloc(requestedInputBytes, 0x5a);
if (input.length < 1 || input.length > 30_000_000)
  throw new Error('Invalid external worker input');
const inputExtension = externalService
  ? extname(inputPath ?? '')
      .slice(1)
      .toLowerCase()
  : 'mp3';
const inputContentTypes = { m4a: 'audio/mp4', mp3: 'audio/mpeg' };
const inputContentType = inputContentTypes[inputExtension];
if (!inputContentType) throw new Error('Unsupported external worker input');
const inputDurationSeconds = externalService ? 10 : 1;
const output = Buffer.from('musicmute-worker-integration-output');
const transferTimeoutMs = useRealS3 ? 120_000 : 10_000;
const digestBase64 = (value) =>
  createHash('sha256').update(value).digest('base64');

const profile = {
  uid: userUid,
  email: `${userUid}@fixture.invalid`,
  emailVerified: true,
  disabled: false,
  providerData: [{ providerId: 'password' }],
};
const firebase = {
  verifySignature: async (token) => {
    if (token !== userToken) throw new Error('Fixture token rejected');
    return { uid: userUid };
  },
  verifySession: async (token) => {
    if (token !== userToken) throw new Error('Fixture token rejected');
    return {
      uid: userUid,
      provider: 'password',
      tokenEmailVerified: true,
      authTimeSec: Math.floor(Date.now() / 1000),
    };
  },
  getProfile: async () => profile,
  getProfileByEmail: async () => profile,
  revokeSessions: async () => undefined,
};

class VersionedObjectFixture {
  constructor() {
    this.objects = new Map();
    this.grants = new Map();
    this.origin = '';
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  async start() {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const address = this.server.address();
    assert.ok(address && typeof address === 'object');
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  async close() {
    await new Promise((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  uploadGrant(reservation) {
    const token = randomUUID();
    this.grants.set(token, { type: 'upload', reservation });
    return {
      url: `${this.origin}/objects/${token}`,
      method: 'PUT',
      headers: {
        'Content-Type': reservation.contentType,
        'If-None-Match': '*',
        'x-amz-checksum-sha256': reservation.sha256,
      },
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  }

  downloadGrant(object) {
    const token = randomUUID();
    this.grants.set(token, { type: 'download', object });
    return {
      url: `${this.origin}/objects/${token}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  }

  async createInputGrant(job) {
    return this.uploadGrant(job.inputReservation);
  }

  async verifyInput(job) {
    const object = this.latest(job.inputReservation.key);
    this.assertObject(job.inputReservation, object);
    return this.identity(object);
  }

  async createDownloadGrant(object) {
    this.assertObject(object, this.version(object.key, object.versionId));
    return this.downloadGrant(object);
  }

  async createMediaGrant(object) {
    return this.createDownloadGrant(object);
  }

  async createWorkerOutputGrant(reservation) {
    return this.uploadGrant(reservation);
  }

  async createWorkerInstallationUploadGrant(reservation) {
    return this.uploadGrant(reservation);
  }

  async findUploadedVersion(reservation) {
    const object = this.latest(reservation.key);
    if (!object) return null;
    this.assertObject(reservation, object);
    return this.identity(object);
  }

  async verifyUploadedVersion(reservation, versionId) {
    const object = this.version(reservation.key, versionId);
    this.assertObject(reservation, object);
    return this.identity(object);
  }

  async isPinnedObjectAvailable(object) {
    try {
      this.assertObject(object, this.version(object.key, object.versionId));
      return true;
    } catch {
      return false;
    }
  }

  async deleteVersionsForKey(key) {
    this.objects.delete(key);
    return true;
  }

  async sweepVersionsForKey(key) {
    const deleted = this.objects.get(key)?.size ?? 0;
    this.objects.delete(key);
    return { complete: true, deleted };
  }

  latest(key) {
    const versions = this.objects.get(key);
    return versions ? ([...versions.values()].at(-1) ?? null) : null;
  }

  version(key, versionId) {
    return this.objects.get(key)?.get(versionId) ?? null;
  }

  identity(object) {
    assert.ok(object);
    const { key, versionId, bytes, sha256, contentType } = object;
    return { key, versionId, bytes, sha256, contentType };
  }

  assertObject(reservation, object) {
    assert.ok(object, `Missing object ${reservation.key}`);
    assert.equal(object.key, reservation.key);
    assert.equal(object.bytes, reservation.bytes);
    assert.equal(object.sha256, reservation.sha256);
    assert.equal(object.contentType, reservation.contentType);
    if (reservation.versionId)
      assert.equal(object.versionId, reservation.versionId);
  }

  async handle(request, response) {
    try {
      const token = new URL(request.url ?? '/', this.origin).pathname
        .split('/')
        .at(-1);
      const grant = token ? this.grants.get(token) : null;
      if (!grant) return this.send(response, 404);
      if (grant.type === 'download') {
        if (request.method !== 'GET') return this.send(response, 405);
        const object = this.version(grant.object.key, grant.object.versionId);
        this.assertObject(grant.object, object);
        response.writeHead(200, {
          'Content-Type': object.contentType,
          'Content-Length': object.bytes,
          'Content-Encoding': 'identity',
          'Cache-Control': 'no-store',
        });
        response.end(object.body);
        return;
      }
      if (request.method !== 'PUT') return this.send(response, 405);
      const reservation = grant.reservation;
      if (
        request.headers['content-type'] !== reservation.contentType ||
        request.headers['if-none-match'] !== '*' ||
        request.headers['x-amz-checksum-sha256'] !== reservation.sha256 ||
        this.objects.has(reservation.key)
      )
        return this.send(response, 412);
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        const value = Buffer.from(chunk);
        bytes += value.length;
        if (bytes > reservation.bytes) return this.send(response, 413);
        chunks.push(value);
      }
      const body = Buffer.concat(chunks);
      if (
        bytes !== reservation.bytes ||
        digestBase64(body) !== reservation.sha256
      )
        return this.send(response, 422);
      const versionId = randomUUID();
      const object = { ...reservation, versionId, body };
      this.objects.set(reservation.key, new Map([[versionId, object]]));
      response.writeHead(200, { 'x-amz-version-id': versionId });
      response.end();
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: String(error) }));
    }
  }

  send(response, status) {
    response.writeHead(status);
    response.end();
  }
}

class FixtureChild {
  constructor() {
    this.processing = false;
  }

  async request(_command, payload) {
    this.processing = true;
    const recipe = payload.recipe;
    const outputPath = join(
      String(payload.attemptDirectory),
      'output',
      'vocals.mp3',
    );
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, output, { mode: 0o600 });
    this.processing = false;
    return {
      protocolVersion: 1,
      type: 'result',
      requestId: randomUUID(),
      incarnation: randomUUID(),
      sentAt: new Date().toISOString(),
      payload: {
        attemptId: payload.attemptId,
        outputPath,
        bytes: output.length,
        sha256: digestBase64(output),
        contentType: 'audio/mpeg',
        measuredOutputDurationSeconds: 1,
        recipeId: recipe.recipeId,
        recipeRevision: recipe.recipeRevision,
        recipeDigest: recipe.recipeDigest,
        modelDigest: recipe.modelDigest,
        trimEnabled: recipe.trimEnabled,
        denoiseEnabled: recipe.denoiseEnabled,
        outputFormat: recipe.outputFormat,
        outputBitrateKbps: recipe.outputBitrateKbps,
      },
    };
  }

  terminateActive() {
    this.processing = false;
  }

  isProcessing() {
    return this.processing;
  }
}

async function cleanupS3Objects(application) {
  const jobs = application.get(getModelToken('Job'));
  const attempts = application.get(getModelToken('WorkerAttempt'));
  const [jobDocuments, attemptDocuments] = await Promise.all([
    jobs.find({}).select({ inputReservation: 1, outputObject: 1 }).lean(),
    attempts.find({}).select({ outputReservation: 1, outputObject: 1 }).lean(),
  ]);
  const keys = new Set();
  for (const document of [...jobDocuments, ...attemptDocuments]) {
    for (const value of [
      document.inputReservation?.key,
      document.outputReservation?.key,
      document.outputObject?.key,
    ])
      if (typeof value === 'string') keys.add(value);
  }
  const safeKey =
    /^users\/[a-f0-9]{24}\/jobs\/[a-f0-9]{24}\/(?:input\/[a-f0-9-]+\.[a-z0-9]{1,8}|attempts\/[a-f0-9-]+\/vocals\.mp3)$/;
  const transfers = application.get(StorageTransfersService);
  let deleted = 0;
  for (const key of keys) {
    if (!safeKey.test(key))
      throw new Error('Refusing unsafe worker integration S3 cleanup key');
    for (let pass = 0; pass < 20; pass += 1) {
      const sweep = await transfers.sweepVersionsForKey(key);
      deleted += sweep.deleted;
      if (sweep.complete && sweep.deleted === 0) break;
      if (pass === 19)
        throw new Error('Worker integration cleanup exceeded bounded passes');
    }
  }
  return deleted;
}

const storage = useRealS3 ? null : new VersionedObjectFixture();
await storage?.start();
const root = await mkdtemp(join(tmpdir(), 'musicmute-worker-integration-'));
let app;
try {
  let moduleBuilder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(FirebaseIdentityService)
    .useValue(firebase);
  if (storage) {
    moduleBuilder = moduleBuilder
      .overrideProvider(StoragePreflightService)
      .useValue({ assertReady: async () => undefined })
      .overrideProvider(StorageTransfersService)
      .useValue(storage);
  }
  const module = await moduleBuilder.compile();
  app = module.createNestApplication({ logger: false });
  configureHttp(app);
  const listenPort = externalService
    ? Number(process.env.WORKER_INTEGRATION_PORT ?? 3100)
    : 0;
  if (!Number.isSafeInteger(listenPort) || listenPort < 0 || listenPort > 65535)
    throw new Error('Invalid worker integration port');
  await app.listen(listenPort, externalService ? '0.0.0.0' : '127.0.0.1');
  const baseUrl = externalService
    ? `http://127.0.0.1:${listenPort}/api/v1`
    : `${await app.getUrl()}/api/v1`;
  const api = async (method, route, body, { worker, expected = 200 } = {}) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${worker ?? userToken}`,
        ...(worker ? {} : { 'X-Installation-Id': installationId }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(transferTimeoutMs),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${route}: ${text}`);
    return text ? JSON.parse(text) : null;
  };

  const device = {
    installationId,
    platform: 'android',
    appVersion: '0.1.0',
    buildNumber: 1,
    metadataRevision: 1,
    osVersion: '16',
    deviceModel: 'Worker integration fixture',
  };
  await api('POST', '/auth/session', device);

  const created = await api(
    'POST',
    '/jobs',
    {
      policyVersion: 2,
      preparationProfileId: 'preserve-or-aac-lc-256-v1',
      source: 'audio_file',
      requestId: randomUUID(),
      input: {
        extension: inputExtension,
        contentType: inputContentType,
        bytes: input.length,
        durationSeconds: inputDurationSeconds,
        sha256: digestBase64(input),
      },
      sourceTitle: 'Worker integration fixture',
      sourceKind: 'file',
    },
    { expected: 201 },
  );
  assert.equal(created.status, 'awaiting_upload');
  const uploaded = await fetch(created.upload.url, {
    method: created.upload.method,
    headers: created.upload.headers,
    body: input,
    signal: AbortSignal.timeout(transferTimeoutMs),
  });
  assert.equal(uploaded.status, 200);
  assert.ok(uploaded.headers.get('x-amz-version-id'));
  const queued = await api('POST', `/jobs/${created.id}/upload-complete`, {});
  assert.equal(queued.status, 'queued');

  const machines = app.get(getModelToken('WorkerMachine'));
  await machines.create({
    _id: machineId,
    credentialDigest: machineCredentialDigest,
    credentialRevision: 1,
    status: 'active',
    label: 'Integration machine',
    groupId: null,
    policyRevision: 0,
    approvedCapabilities: [
      {
        platform: externalService ? externalPlatform : 'darwin-arm64',
        provider: externalService ? externalProvider : 'mps',
        gpuId,
        recipeIds: ['kim-vocals-v2'],
        maxSlots: 1,
      },
    ],
    hardwareReport: {
      os: externalService && !externalMac ? 'Windows' : 'macOS',
      osBuild: 'fixture',
      architecture: externalService && !externalMac ? 'amd64' : 'arm64',
      cpu: 'Fixture CPU',
      memoryBytes: 16_000_000_000,
      gpus: [
        {
          id: gpuId,
          name: externalService
            ? externalMac
              ? 'Apple M4 Pro'
              : 'Radeon RX 580'
            : 'Fixture GPU',
          driverVersion: 'fixture',
          memoryBytes: null,
        },
      ],
    },
    runtimeIdentity: {
      workerVersion: 'integration',
      protocolVersion: 1,
      manifestDigest: 'a'.repeat(64),
      modelDigest:
        'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b',
      providerRuntimeVersion: 'fixture',
    },
    currentSession: null,
    supervisorGeneration: 0,
    desiredRevision: 0,
    appliedRevision: 0,
    acknowledgedDiagnosticSequence: 0,
    lastSeenAt: null,
    revokedAt: null,
    revision: 0,
  });

  if (externalService) {
    console.log(
      `WORKER_FLEET_EXTERNAL_JOB_QUEUED port=${listenPort} job=${created.id}`,
    );
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      const state = await api('GET', `/jobs/${created.id}`);
      if (state.status === 'ready') break;
      if (['failed', 'cancelled'].includes(state.status))
        throw new Error(`External worker job ended as ${state.status}`);
      await delay(5_000);
    }
  } else {
    const child = new FixtureChild();
    const supervisor = {
      start: async () => undefined,
      stop: async () => undefined,
      child: () => child,
      restart: async () => child,
    };
    const runtime = new WorkerRuntime(
      {
        machineId,
        slots: [
          {
            workerId,
            gpuId,
            slotIndex: 0,
            recipeIds: ['kim-vocals-v2'],
            provider: 'mps',
          },
        ],
        workRoot: join(root, 'attempts'),
        modelCacheRoot: join(root, 'models'),
        ffmpegPath: '/usr/bin/false',
        ffprobePath: '/usr/bin/false',
        resources: { assertAvailable: async () => undefined },
      },
      new WorkerControlPlaneClient({
        baseUrl,
        credential: machineCredential,
        allowInsecureLoopback: true,
      }),
      new WorkerTransferClient({ allowInsecureLoopback: true }),
      supervisor,
    );
    await runtime.start();
    try {
      await runtime.reconcileOnce();
      await runtime.waitForIdle();
    } finally {
      await runtime.stop();
    }
  }

  const completed = await api('GET', `/jobs/${created.id}`);
  assert.equal(completed.status, 'ready');
  const download = await api('POST', `/jobs/${created.id}/download-url`, {
    artifact: 'output',
    requestId: randomUUID(),
  });
  const downloaded = await fetch(download.url, {
    signal: AbortSignal.timeout(transferTimeoutMs),
  });
  assert.equal(downloaded.status, 200);
  const downloadedOutput = Buffer.from(await downloaded.arrayBuffer());
  if (externalService) {
    assert.ok(downloadedOutput.length > 1_000);
    assert.match(downloaded.headers.get('content-type') ?? '', /^audio\/mpeg/);
  } else {
    assert.deepEqual(downloadedOutput, output);
  }

  const attempts = app.get(getModelToken('WorkerAttempt'));
  const slots = app.get(getModelToken('WorkerSlot'));
  const jobs = app.get(getModelToken('Job'));
  const usage = app.get(getModelToken('ProcessingReservation'));
  const notifications = app.get(getModelToken('NotificationOutbox'));
  assert.equal(await attempts.countDocuments({ jobId: created.id }), 1);
  assert.equal(
    await attempts.countDocuments({ jobId: created.id, state: 'succeeded' }),
    1,
  );
  assert.equal(await slots.countDocuments({ _id: workerId, state: 'idle' }), 1);
  assert.equal(
    await usage.countDocuments({ _id: created.id, state: 'used' }),
    1,
  );
  assert.equal(await notifications.countDocuments({ jobId: created.id }), 1);

  if (!externalService) {
    const createQueuedJob = async (label) => {
      const body = Buffer.from(`musicmute-${label}`);
      const job = await api(
        'POST',
        '/jobs',
        {
          policyVersion: 2,
          preparationProfileId: 'preserve-or-aac-lc-256-v1',
          source: 'audio_file',
          requestId: randomUUID(),
          input: {
            extension: 'mp3',
            contentType: 'audio/mpeg',
            bytes: body.length,
            durationSeconds: 1,
            sha256: digestBase64(body),
          },
          sourceTitle: label,
          sourceKind: 'file',
        },
        { expected: 201 },
      );
      const put = await fetch(job.upload.url, {
        method: job.upload.method,
        headers: job.upload.headers,
        body,
        signal: AbortSignal.timeout(transferTimeoutMs),
      });
      assert.equal(put.status, 200);
      const queuedJob = await api(
        'POST',
        `/jobs/${job.id}/upload-complete`,
        {},
      );
      assert.equal(queuedJob.status, 'queued');
      return job;
    };
    const seedMachine = async (label) => {
      const id = randomUUID();
      const credential = randomBytes(32).toString('base64url');
      const gpuId = `${label}-gpu`;
      const slotId = randomUUID();
      await machines.create({
        _id: id,
        credentialDigest: createHash('sha256').update(credential).digest('hex'),
        credentialRevision: 1,
        status: 'active',
        label,
        groupId: null,
        policyRevision: 0,
        approvedCapabilities: [
          {
            platform: 'windows-amd64',
            provider: 'directml',
            gpuId,
            recipeIds: ['kim-vocals-v2'],
            maxSlots: 1,
          },
        ],
        hardwareReport: {
          os: 'Windows',
          osBuild: 'fixture',
          architecture: 'amd64',
          cpu: 'Fixture CPU',
          memoryBytes: 16_000_000_000,
          gpus: [
            {
              id: gpuId,
              name: 'Fixture GPU',
              driverVersion: 'fixture',
              memoryBytes: 8_000_000_000,
            },
          ],
        },
        runtimeIdentity: {
          workerVersion: 'integration',
          protocolVersion: 1,
          manifestDigest: 'a'.repeat(64),
          modelDigest:
            'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b',
          providerRuntimeVersion: 'fixture',
        },
        currentSession: null,
        supervisorGeneration: 0,
        desiredRevision: 0,
        appliedRevision: 0,
        acknowledgedDiagnosticSequence: 0,
        lastSeenAt: null,
        revokedAt: null,
        revision: 0,
      });
      const sessionId = randomUUID();
      const incarnation = randomUUID();
      await api(
        'POST',
        '/worker/v1/session',
        { sessionId, incarnation },
        { worker: credential, expected: 201 },
      );
      await api(
        'POST',
        '/worker/v1/slots',
        {
          workerId: slotId,
          sessionId,
          incarnation,
          gpuId,
          slotIndex: 0,
          recipeIds: ['kim-vocals-v2'],
        },
        { worker: credential, expected: 201 },
      );
      return { id, credential, gpuId, slotId, sessionId, incarnation };
    };
    const claimBody = (machine) => ({
      requestId: randomUUID(),
      workerId: machine.slotId,
      sessionId: machine.sessionId,
      incarnation: machine.incarnation,
      gpuId: machine.gpuId,
      slotIndex: 0,
      appliedPolicyRevision: 0,
    });
    const ownership = (machine) => ({
      requestId: randomUUID(),
      workerId: machine.slotId,
      sessionId: machine.sessionId,
      incarnation: machine.incarnation,
    });

    const machineA = await seedMachine('Race machine A');
    const machineB = await seedMachine('Race machine B');
    const racedJob = await createQueuedJob('Worker ownership race');
    const claimA = claimBody(machineA);
    const claimB = claimBody(machineB);
    const raced = await Promise.all([
      api('POST', '/worker/v1/claims', claimA, {
        worker: machineA.credential,
        expected: 201,
      }),
      api('POST', '/worker/v1/claims', claimB, {
        worker: machineB.credential,
        expected: 201,
      }),
    ]);
    const winnerIndex = raced.findIndex((result) => result.claim !== null);
    assert.notEqual(winnerIndex, -1);
    assert.equal(raced.filter((result) => result.claim !== null).length, 1);
    const winner = winnerIndex === 0 ? machineA : machineB;
    const loser = winnerIndex === 0 ? machineB : machineA;
    const winnerClaimBody = winnerIndex === 0 ? claimA : claimB;
    const winnerClaim = raced[winnerIndex].claim;
    const replay = await api('POST', '/worker/v1/claims', winnerClaimBody, {
      worker: winner.credential,
      expected: 201,
    });
    assert.equal(replay.claim.attemptId, winnerClaim.attemptId);
    assert.equal(replay.claim.replayed, true);

    const forged = await api(
      'POST',
      `/worker/v1/attempts/${winnerClaim.attemptId}/input-grant`,
      ownership(loser),
      { worker: loser.credential, expected: 409 },
    );
    assert.equal(forged.code, 'WORKER_CONFLICT');
    const cancelled = await api('POST', `/jobs/${racedJob.id}/cancel`, {});
    assert.equal(cancelled.status, 'cancelled');
    const staleAfterCancel = await api(
      'POST',
      `/worker/v1/attempts/${winnerClaim.attemptId}/input-grant`,
      ownership(winner),
      { worker: winner.credential, expected: 409 },
    );
    assert.equal(staleAfterCancel.code, 'WORKER_CONFLICT');
    assert.equal(
      await attempts.countDocuments({
        _id: winnerClaim.attemptId,
        state: 'cancelled',
      }),
      1,
    );

    const recoveryJob = await createQueuedJob('Worker lease recovery');
    const recoveryClaimBody = claimBody(winner);
    const recoveryClaimResponse = await api(
      'POST',
      '/worker/v1/claims',
      recoveryClaimBody,
      { worker: winner.credential, expected: 201 },
    );
    assert.ok(recoveryClaimResponse.claim);
    const recoveryClaim = recoveryClaimResponse.claim;
    const expiredAt = new Date(Date.now() - 1_000);
    await attempts.updateOne(
      { _id: recoveryClaim.attemptId },
      { $set: { leaseExpiresAt: expiredAt } },
    );
    await jobs.updateOne(
      {
        _id: recoveryJob.id,
        'currentExecution.attemptId': recoveryClaim.attemptId,
      },
      { $set: { 'currentExecution.leaseExpiresAt': expiredAt } },
    );
    const recovery = app.get(WorkerRecoveryService);
    assert.equal(await recovery.recoverOne(new Date()), true);
    assert.equal(
      await attempts.countDocuments({
        _id: recoveryClaim.attemptId,
        state: 'lost',
      }),
      1,
    );
    assert.equal(
      await jobs.countDocuments({ _id: recoveryJob.id, status: 'queued' }),
      1,
    );
    assert.equal(
      await slots.countDocuments({ _id: winner.slotId, state: 'idle' }),
      1,
    );
    const staleAfterRecovery = await api(
      'POST',
      `/worker/v1/attempts/${recoveryClaim.attemptId}/input-grant`,
      ownership(winner),
      { worker: winner.credential, expected: 409 },
    );
    assert.equal(staleAfterRecovery.code, 'WORKER_CONFLICT');

    await machines.updateOne(
      { _id: loser.id },
      { $set: { status: 'revoked', revokedAt: new Date() } },
    );
    const revoked = await api(
      'POST',
      '/worker/v1/session',
      { sessionId: randomUUID(), incarnation: randomUUID() },
      { worker: loser.credential, expected: 401 },
    );
    assert.equal(revoked.code, 'WORKER_UNAUTHENTICATED');
  }
  console.log(
    `WORKER_FLEET_INTEGRATION_OK storage=${useRealS3 ? 's3' : 'fixture'} platform=${externalService ? externalPlatformMarker : 'simulated'} status=ready ownership=${externalService ? 'not-run' : 'pass'} recovery=${externalService ? 'not-run' : 'pass'} cancellation=${externalService ? 'not-run' : 'pass'} security=${externalService ? 'not-run' : 'pass'}`,
  );
} finally {
  if (useRealS3 && app) {
    const deleted = await cleanupS3Objects(app);
    console.log(`WORKER_FLEET_S3_CLEANUP_OK deleted=${deleted}`);
  }
  await app?.close();
  await storage?.close();
  await rm(root, { recursive: true, force: true });
}

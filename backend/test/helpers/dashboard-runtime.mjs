import 'reflect-metadata';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { Test } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { assertLoopbackUrl } from './isolated-services.mjs';

// The parent starts this process in an owned empty directory with a fresh,
// allowlisted environment. No developer dotenv or credential file is read.
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
const { ReleaseArtifactStorageService } =
  await import('../../dist/releases/release-artifact-storage.service.js');
const { ApkVerifierService } =
  await import('../../dist/releases/apk-verifier.service.js');
const { WorkerCoordinatorService } =
  await import('../../dist/worker/worker-coordinator.service.js');
const { authError } = await import('../../dist/auth/auth.errors.js');

const useCurl = process.env.DASHBOARD_HTTP_CLIENT === 'curl';
const probeAllRoutes = process.env.DASHBOARD_PROBE_ALL_ROUTES === '1';
const serveForBrowser = process.env.DASHBOARD_SERVE_FOR_BROWSER === '1';
const requestedPort = process.env.DASHBOARD_SERVE_PORT
  ? Number(process.env.DASHBOARD_SERVE_PORT)
  : 0;
assert.ok(
  Number.isInteger(requestedPort) &&
    requestedPort >= 0 &&
    requestedPort <= 65535,
  'DASHBOARD_SERVE_PORT must be a valid TCP port',
);
const curlStatusMarker = '__MUSICMUTE_CURL_STATUS__';
const curlTypeMarker = '__MUSICMUTE_CURL_TYPE__';
const execFileAsync = promisify(execFile);

async function curlResponse(method, url, body, token) {
  const args = [
    '--silent',
    '--show-error',
    '--include',
    '--connect-timeout',
    '2',
    '--max-time',
    '15',
    '--request',
    method,
    '--write-out',
    `\n${curlStatusMarker}%{http_code}\n${curlTypeMarker}%{content_type}`,
  ];
  if (token) args.push('--header', `Authorization: Bearer ${token}`);
  if (body !== undefined) {
    args.push('--header', 'Content-Type: application/json');
    args.push('--data-binary', JSON.stringify(body));
  }
  args.push('--url', url);
  const { stdout: output } = await execFileAsync('/usr/bin/curl', args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 20000,
  });
  const statusStart = output.lastIndexOf(`\n${curlStatusMarker}`);
  const typeStart = output.lastIndexOf(`\n${curlTypeMarker}`);
  assert.ok(statusStart > 0 && typeStart > statusStart);
  const rawResponse = output.slice(0, statusStart);
  const status = Number(
    output.slice(statusStart + curlStatusMarker.length + 1, typeStart),
  );
  const contentType = output
    .slice(typeStart + curlTypeMarker.length + 1)
    .trim();
  const headerEnd = rawResponse.indexOf('\r\n\r\n');
  assert.ok(headerEnd > 0);
  const headerLines = rawResponse.slice(0, headerEnd).split('\r\n');
  const headers = new Map();
  for (const line of headerLines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0)
      headers.set(
        line.slice(0, colon).trim().toLowerCase(),
        line.slice(colon + 1).trim(),
      );
  }
  if (contentType) headers.set('content-type', contentType);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    text: async () => rawResponse.slice(headerEnd + 4),
  };
}

const routeInventory = probeAllRoutes
  ? JSON.parse(
      readFileSync(
        new URL('../fixtures/dashboard-contracts/routes.json', import.meta.url),
        'utf8',
      ),
    )
  : null;
const routeEndpoint = (route) =>
  route.path
    .replace(':operationId', '2bd185fb-d2d7-4c1e-82a8-63cfb6a7ed29')
    .replace(':uploadId', 'bbbbbbbbbbbbbbbbbbbbbbbb')
    .replace(':uid', 'synthetic-target-uid')
    .replace(
      ':id',
      route.path.startsWith('/admin/workers/')
        ? 'fixture-worker'
        : 'aaaaaaaaaaaaaaaaaaaaaaaa',
    );

const profile = (uid) => ({
  uid,
  email: `${uid}@example.invalid`,
  emailVerified: true,
  disabled: false,
  displayName: 'Fixture administrator',
  providerData: [{ providerId: 'google.com', email: `${uid}@example.invalid` }],
});
const uidFor = (token) => {
  if (!['owner-fixture', 'support-fixture', 'ordinary-fixture'].includes(token))
    throw authError('UNAUTHENTICATED');
  return token;
};
const firebase = {
  verifySignature: async (token) => ({ uid: uidFor(token) }),
  verifySession: async (token) => ({
    uid: uidFor(token),
    provider: 'google.com',
    tokenEmailVerified: true,
    authTimeSec: Math.floor(Date.now() / 1000),
  }),
  getProfile: async (uid) => profile(uid),
  getProfileByEmail: async (email) => profile(email.split('@')[0]),
};
const grant = () => ({
  url: 'https://example.invalid/fixture-signed-grant',
  expiresAt: new Date(Date.now() + 300000).toISOString(),
});
const storage = {
  createDownloadGrant: async () => grant(),
  createMediaGrant: async () => grant(),
  isPinnedObjectAvailable: async () => true,
  deleteVersionsForKey: async () => true,
};
const builder = Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(FirebaseIdentityService)
  .useValue(firebase)
  .overrideProvider(StoragePreflightService)
  .useValue({ assertReady: async () => undefined })
  .overrideProvider(StorageTransfersService)
  .useValue(storage)
  .overrideProvider(ReleaseArtifactStorageService)
  .useValue({
    grant: async () => ({ ...grant(), fields: { fixture: 'synthetic' } }),
    pin: async () => 'fixture-apk-version',
    download: async () => undefined,
  })
  .overrideProvider(ApkVerifierService)
  .useValue({
    verify: async () => ({
      packageId: 'com.example.fixture',
      minimumSdk: 26,
      signerSha256Hex: 'b'.repeat(64),
    }),
  });
let app;
try {
  const module = await builder.compile();
  app = module.createNestApplication({ logger: false });
  configureHttp(app);
  await app.listen(requestedPort, '127.0.0.1');
  const base = `${await app.getUrl()}/api/v1`;
  const db = app.get(getConnectionToken());
  const accesses = app.get(getModelToken('AdminAccess'));
  await accesses.create({
    uid: 'owner-fixture',
    verifiedEmail: 'owner-fixture@example.invalid',
    role: 'owner',
    active: true,
  });
  const model = (name) => app.get(getModelToken(name));
  const command = (extra = {}) => ({
    operationId: randomUUID(),
    reason: 'Owned dashboard integration fixture',
    ...extra,
  });
  let requests = 0;
  const successfulOperations = new Set();
  const snapshots = [];
  async function api(
    method,
    path,
    body,
    token = 'owner-fixture',
    status = method === 'POST' ? 201 : 200,
  ) {
    const options = {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      signal: AbortSignal.timeout(15000),
    };
    if (body !== undefined) {
      assert.notEqual(method, 'GET');
      options.body = JSON.stringify(body);
    }
    const response = useCurl
      ? await curlResponse(method, `${base}${path}`, body, token)
      : await fetch(`${base}${path}`, options);
    const text = await response.text();
    const value = response.headers
      .get('content-type')
      ?.includes('application/json')
      ? JSON.parse(text)
      : text;
    assert.equal(
      response.status,
      status,
      `${method} ${path}: ${response.status} ${value?.code ?? ''}`,
    );
    if (path.startsWith('/admin/'))
      assert.equal(response.headers.get('cache-control'), 'no-store');
    requests++;
    if (response.ok && typeof value === 'object')
      snapshots.push({ method, path: path.split('?')[0], response: value });
    if (response.ok && body?.operationId)
      successfulOperations.add(body.operationId);
    return value;
  }
  let curlProbes = 0;
  if (routeInventory) {
    assert.equal(useCurl, true);
    for (const route of routeInventory.routes) {
      const response = await curlResponse(
        route.method,
        `${base}${routeEndpoint(route)}`,
        route.requestBody ?? undefined,
        '',
      );
      assert.equal(
        response.status,
        401,
        `${route.method} ${route.path} must reject anonymous curl`,
      );
      assert.equal(response.headers.get('cache-control'), 'no-store');
      curlProbes++;
    }
  }
  await api('GET', '/admin/session', undefined, '', 401);
  await api('GET', '/admin/session', undefined, 'ordinary-fixture', 403);
  assert.equal((await api('GET', '/admin/session')).role, 'owner');
  const support = await api(
    'POST',
    '/admin/access',
    command({
      verifiedEmail: 'support-fixture@example.invalid',
      role: 'support',
    }),
  );
  assert.equal(support.role, 'support');
  assert.equal(
    (await api('GET', '/admin/session', undefined, 'support-fixture')).role,
    'support',
  );
  const worker = await api(
    'POST',
    '/admin/workers',
    command({ id: 'fixture-worker', label: 'Fixture worker' }),
  );
  assert.equal(worker.rawKey.length, 64);
  await api(
    'POST',
    '/admin/workers',
    command({ id: 'forbidden-worker', label: 'Forbidden' }),
    'support-fixture',
    403,
  );
  const users = model('User'),
    jobs = model('Job');
  const userId = new Types.ObjectId(),
    jobId = new Types.ObjectId();
  const seededAt = new Date();
  await users.collection.insertMany([
    {
      _id: userId,
      firebaseUid: 'fixture-user',
      status: 'active',
      email: 'user@example.invalid',
      displayName: 'Fixture user',
      adminRevision: 0,
      createdAt: seededAt,
      updatedAt: seededAt,
    },
    {
      _id: new Types.ObjectId(),
      firebaseUid: 'fixture-user-secondary',
      status: 'active',
      email: 'secondary@example.invalid',
      displayName: 'Secondary fixture user',
      adminRevision: 0,
      createdAt: seededAt,
      updatedAt: seededAt,
    },
  ]);
  const input = {
    key: `private/${jobId}/input.mp3`,
    versionId: 'fixture-input-version',
    contentType: 'audio/mpeg',
    bytes: 42,
    sha256: Buffer.alloc(32).toString('base64'),
  };
  await jobs.create({
    _id: jobId,
    userId,
    requestId: randomUUID(),
    requestHash: 'a'.repeat(64),
    status: 'queued',
    queuedAt: new Date(),
    queueOrder: 1n,
    processingAccumulatedMs: 0,
    inputReservation: {
      key: input.key,
      extension: 'mp3',
      contentType: input.contentType,
      bytes: input.bytes,
      durationSeconds: 1,
      sha256: input.sha256,
    },
    inputObject: input,
  });
  const identity = {
    workerId: 'fixture-worker',
    mode: 'fleet',
    keySha256: createHash('sha256').update(worker.rawKey).digest('hex'),
  };
  const assignment = await app
    .get(WorkerCoordinatorService)
    .claim(randomUUID(), identity);
  assert.equal(assignment.jobId, jobId.toString());
  const beforeDrain = await api('GET', '/admin/workers/fixture-worker');
  await api(
    'POST',
    '/admin/workers/fixture-worker/drain',
    command({ expectedRevision: beforeDrain.revision }),
  );
  const draining = await api('GET', '/admin/workers/fixture-worker');
  assert.equal(draining.state, 'draining');
  assert.equal(draining.activeJobId, jobId.toString());
  await api(
    'POST',
    '/admin/workers/fixture-worker/release-stopped',
    command({
      expectedRevision: draining.revision,
      jobId: assignment.jobId,
      attemptId: assignment.attemptId,
      sessionId: assignment.sessionId,
      generation: assignment.generation,
      stoppedAt: new Date().toISOString(),
      stopEvidence:
        'Owned fixture worker process terminated; PID 4321 verified exited.',
    }),
  );
  assert.equal((await jobs.findById(jobId)).status, 'queued');
  const released = await api('GET', '/admin/workers/fixture-worker');
  assert.equal(released.slotState, 'idle');
  assert.equal(released.assignment, null);
  const suspended = await api(
    'POST',
    `/admin/users/${userId}/suspend-processing`,
    command({ expectedRevision: 0 }),
    'support-fixture',
  );
  assert.equal(suspended.processingSuspended, true);
  const media = await api(
    'POST',
    `/admin/jobs/${jobId}/media-grants`,
    command({ asset: 'input', purpose: 'play' }),
    'support-fixture',
  );
  assert.equal(media.bytes, 42);
  assert.equal(media.contentType, 'audio/mpeg');
  assert.ok(media.url);
  await api('GET', `/admin/jobs/${jobId}`, undefined, 'support-fixture');
  const draft = await api(
    'POST',
    '/admin/releases',
    command({
      platform: 'android',
      source: 'direct_apk',
      versionName: '1.0.0',
      buildNumber: 2,
      changelogEn: 'Fixture release notes',
      storeUrl: null,
    }),
  );
  const upload = await api('POST', `/admin/releases/${draft.id}/uploads`, {
    operationId: randomUUID(),
    expectedRevision: draft.revision,
    bytes: 32,
    sha256Hex: 'a'.repeat(64),
  });
  await api(
    'POST',
    `/admin/releases/${draft.id}/uploads/${upload.uploadId}/complete`,
    { operationId: randomUUID() },
  );
  const verified = await api('GET', `/admin/releases/${draft.id}`);
  assert.equal(verified.artifactState, 'verified');
  const policy = await api('GET', '/admin/update-policy');
  const selection = {
    android: {
      minimumBuild: null,
      directReleaseId: draft.id,
      storeReleaseId: null,
      source: 'direct_apk',
    },
    ios: { minimumBuild: null, storeReleaseId: null },
  };
  const published = await api(
    'POST',
    `/admin/releases/${draft.id}/publish`,
    command({
      policy: selection,
      expectedRevision: policy.revision,
      expectedReleaseRevision: verified.revision,
      storeAvailabilityConfirmed: false,
    }),
  );
  assert.equal(published.release.state, 'published');
  const withdrawal = await api(
    'POST',
    `/admin/releases/${draft.id}/withdraw`,
    command({
      replacementPolicy: {
        ...selection,
        android: { ...selection.android, directReleaseId: null },
      },
      expectedRevision: published.policyRevision,
      expectedReleaseRevision: published.release.revision,
    }),
  );
  assert.equal(withdrawal.release.state, 'withdrawn');
  const from = new Date(Date.now() - 86400000).toISOString(),
    to = new Date(Date.now() + 1000).toISOString();
  const dateQuery = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const overview = await api('GET', `/admin/overview?${dateQuery}`);
  assert.equal(overview.counts.submitted, 1);
  for (const path of [
    '/admin/access',
    '/admin/workers',
    '/admin/jobs',
    '/admin/users',
    '/admin/releases',
    '/admin/settings/processing',
    '/admin/health',
    '/admin/alerts',
  ])
    await api('GET', path);
  await api('GET', `/admin/jobs/${jobId}/attempts`);
  await api('GET', `/admin/users/${userId}`);
  await api(
    'GET',
    `/admin/operations/${successfulOperations.values().next().value}`,
  );
  const csv = await api('GET', `/admin/exports/jobs.csv?${dateQuery}`);
  assert.ok(csv.includes(jobId.toString()));
  assert.equal(csv.includes(input.key), false);
  assert.equal(csv.includes('user@example.invalid'), false);
  const audit = await api('GET', `/admin/audit?${dateQuery}`);
  assert.ok(audit.items.length >= successfulOperations.size);
  const recordedEvents = await model('AdminAuditEvent').find().lean();
  const recordedOperations = await model('AdminOperation').find().lean();
  for (const operationId of successfulOperations) {
    assert.equal(
      recordedOperations.find((row) => row.operationId === operationId)?.status,
      'succeeded',
    );
    assert.ok(
      recordedEvents.some(
        (row) => row.operationId === operationId && row.outcome === 'succeeded',
      ),
    );
  }
  assert.ok(
    recordedEvents.some(
      (row) =>
        row.exportMetadata?.dataset === 'jobs' &&
        row.exportMetadata.rowCount === 1,
    ),
  );
  const persisted = JSON.stringify([recordedEvents, recordedOperations]);
  assert.equal(persisted.includes(worker.rawKey), false);
  assert.equal(persisted.includes(media.url), false);
  assert.equal(persisted.includes(input.key), false);
  assert.equal(
    await model('WorkerRegistration').countDocuments({
      _id: 'forbidden-worker',
    }),
    0,
  );
  assert.equal(
    await db.collection('audio_job_attempts').countDocuments({ jobId }),
    1,
  );
  console.log(
    `DASHBOARD_RUNTIME_OK requests=${requests} auditedEvents=${await model('AdminAuditEvent').countDocuments()}`,
  );
  if (useCurl)
    console.log(
      `DASHBOARD_CURL_OK probes=${curlProbes} requests=${requests} auditedEvents=${await model('AdminAuditEvent').countDocuments()}`,
    );
  if (process.env.DASHBOARD_CAPTURE_CONTRACTS === '1') {
    const normalized = JSON.stringify(snapshots, (key, value) => {
      if (key === 'rawKey') return '<one-time-fixture-key>';
      if (typeof value !== 'string') return value;
      return value
        .replace(
          /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
          '00000000-0000-4000-8000-000000000001',
        )
        .replace(/[0-9a-f]{24}/g, '000000000000000000000001')
        .replace(
          /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
          '2026-01-01T00:00:00.000Z',
        );
    });
    console.log(`DASHBOARD_CONTRACT_SNAPSHOTS=${normalized}`);
  }
  if (serveForBrowser) {
    console.log(`DASHBOARD_BROWSER_READY ${base}`);
    await new Promise(() => undefined);
  }
} finally {
  await app?.close();
}

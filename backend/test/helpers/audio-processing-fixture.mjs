import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import process from 'node:process';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { IsolatedServices, assertLoopbackUrl } from './isolated-services.mjs';

const workerSecret =
  'musicmute-fixture-worker-secret-2026-09-09-do-not-use-in-production';
const managedEnvironmentKeys = [
  'APP_ENV',
  'NODE_ENV',
  'HOST',
  'PORT',
  'MONGODB_URI',
  'REDIS_URL',
  'AWS_REGION',
  'S3_BUCKET',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_WEB_API_KEY',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'RATE_LIMIT_HASH_SECRET',
  'AUDIO_PROCESSING_ENABLED',
  'PROCESSING_WORKER_KEY_SHA256',
  'PROCESSING_LEASE_SECONDS',
  'PROCESSING_URL_SECONDS',
  'PROCESSING_OUTPUT_MAX_BYTES',
  'CORS_ORIGINS',
  'TRUST_PROXY',
  'RATE_LIMIT',
  'RATE_TTL_MS',
  'AUTH_UID_PER_MINUTE',
  'PROFILE_UID_PER_MINUTE',
  'PROFILE_IP_PER_MINUTE',
  'DEVICE_UID_PER_MINUTE',
  'LOGOUT_UID_PER_HOUR',
  'BODY_LIMIT_BYTES',
  'FIREBASE_SERVICE_ACCOUNT_BASE64',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
];

let fixtureLock = Promise.resolve();

async function acquireFixtureLock() {
  const previous = fixtureLock;
  let release;
  fixtureLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}

function installFixtureEnvironment(configuration) {
  const previous = new Map(
    managedEnvironmentKeys.map((key) => [
      key,
      {
        present: Object.hasOwn(process.env, key),
        value: process.env[key],
      },
    ]),
  );
  for (const key of managedEnvironmentKeys) delete process.env[key];
  for (const [key, value] of Object.entries(configuration))
    process.env[key] = String(value);
  return () => {
    for (const key of managedEnvironmentKeys) delete process.env[key];
    for (const [key, entry] of previous)
      if (entry.present) process.env[key] = entry.value;
  };
}

function sessionReport(installationId) {
  return {
    installationId,
    platform: 'ios',
    appVersion: '1.0.0',
    buildNumber: 1,
    metadataRevision: 1,
    osVersion: '26.0',
    deviceModel: 'Audio processing fixture',
  };
}

function createFakeStorage(jobError) {
  const objects = new Map();
  const calls = [];
  const deletedKeys = [];
  const failures = new Map();
  const run = async (operation, action) => {
    calls.push(operation);
    const failure = failures.get(operation);
    if (failure) {
      failures.delete(operation);
      throw failure;
    }
    return action();
  };
  const reservationFor = (job, output = false) => {
    const reservation = output ? job.outputReservation : job.inputReservation;
    if (!reservation) throw new TypeError('Fixture reservation is required');
    return reservation;
  };
  const grantFor = (reservation) => ({
    url: 'https://fixture.invalid/upload',
    fields: {
      key: reservation.key,
      'Content-Type': reservation.contentType,
      'x-amz-checksum-sha256': reservation.sha256,
    },
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  });
  const find = (reservation) => objects.get(reservation.key) ?? null;
  const verify = (reservation) => {
    const identity = find(reservation);
    if (!identity) throw jobError('UPLOAD_NOT_READY');
    return identity;
  };
  const transferProvider = {
    createInputGrant: (job) =>
      run('createInputGrant', () => grantFor(reservationFor(job))),
    verifyInput: (job) => run('verifyInput', () => verify(reservationFor(job))),
    createOutputGrant: (job) =>
      run('createOutputGrant', () => grantFor(reservationFor(job, true))),
    verifyOutput: (job) =>
      run('verifyOutput', () => verify(reservationFor(job, true))),
    findOutput: (job) =>
      run('findOutput', () => find(reservationFor(job, true))),
    createDownloadGrant: (identity) =>
      run('createDownloadGrant', () => ({
        url: `https://fixture.invalid/download/${encodeURIComponent(identity.key)}`,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      })),
    deleteVersionsForKey: (key) =>
      run('deleteVersionsForKey', () => {
        deletedKeys.push(key);
        objects.delete(key);
        return true;
      }),
  };
  const preflightProvider = {
    assertReady: () => run('assertReady', () => undefined),
  };
  return {
    objects,
    calls,
    deletedKeys,
    providers: {
      transfers: transferProvider,
      preflight: preflightProvider,
    },
    put(reservation, overrides = {}) {
      const identity = {
        key: reservation.key,
        versionId: `fixture-${randomUUID()}`,
        bytes: reservation.bytes,
        sha256: reservation.sha256,
        contentType: reservation.contentType,
        ...overrides,
      };
      objects.set(identity.key, identity);
      return identity;
    },
    remove(key) {
      objects.delete(key);
    },
    failNext(operation, error = new Error('Fixture provider failure')) {
      failures.set(operation, error);
    },
  };
}

export async function startAudioProcessingFixture(t) {
  const releaseLock = await acquireFixtureLock();
  const services = await IsolatedServices.create();
  let app;
  let restoreEnvironment;
  let stopped = false;
  const cleanup = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await app?.close();
    } finally {
      try {
        restoreEnvironment?.();
      } finally {
        try {
          await services.stop();
        } finally {
          releaseLock();
        }
      }
    }
  };
  t.after(cleanup);

  try {
    const databases = await services.startDatabases({ replicaSet: true });
    const auth = await services.startAuthEmulator();
    assertLoopbackUrl(databases.mongoUri);
    assertLoopbackUrl(auth.authOrigin);
    const configuration = {
      APP_ENV: 'test',
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 3000,
      MONGODB_URI: databases.mongoUri,
      REDIS_URL: `redis://127.0.0.1:${databases.redisPort}/0`,
      AWS_REGION: 'us-east-1',
      S3_BUCKET: 'musicmute-fixture',
      FIREBASE_PROJECT_ID: 'demo-musicmute',
      FIREBASE_WEB_API_KEY: 'fixture-api-key',
      FIREBASE_AUTH_EMULATOR_HOST: auth.authHost,
      RATE_LIMIT_HASH_SECRET: 'musicmute-audio-fixture-rate-secret-2026-09-09',
      AUDIO_PROCESSING_ENABLED: true,
      PROCESSING_WORKER_KEY_SHA256: createHash('sha256')
        .update(workerSecret)
        .digest('hex'),
      PROCESSING_LEASE_SECONDS: 90,
      PROCESSING_URL_SECONDS: 900,
      PROCESSING_OUTPUT_MAX_BYTES: 30_000_000,
      CORS_ORIGINS: '',
      TRUST_PROXY: 'false',
      RATE_LIMIT: 10_000,
      RATE_TTL_MS: 60_000,
      AUTH_UID_PER_MINUTE: 1_000,
      PROFILE_UID_PER_MINUTE: 1_000,
      PROFILE_IP_PER_MINUTE: 1_000,
      DEVICE_UID_PER_MINUTE: 1_000,
      LOGOUT_UID_PER_HOUR: 1_000,
      BODY_LIMIT_BYTES: 65_536,
    };
    restoreEnvironment = installFixtureEnvironment(configuration);

    const workingDirectory = process.cwd();
    let compiled;
    try {
      process.chdir(services.directory);
      compiled = await Promise.all([
        import('../../dist/app.module.js'),
        import('../../dist/http/configure-http.js'),
        import('../../dist/storage/storage-transfers.service.js'),
        import('../../dist/storage/storage-preflight.service.js'),
        import('../../dist/auth/firebase-identity.service.js'),
        import('../../dist/jobs/job-errors.js'),
        import('../../dist/jobs/job.schema.js'),
        import('../../dist/jobs/job-attempt.schema.js'),
        import('../../dist/jobs/job-receipt.schema.js'),
        import('../../dist/job-errors/job-error.schema.js'),
        import('../../dist/client-errors/client-error.schema.js'),
        import('../../dist/jobs/job-deletion.service.js'),
        import('../../dist/worker/worker-control.schema.js'),
        import('../../dist/auth/firebase.module.js'),
      ]);
    } finally {
      process.chdir(workingDirectory);
    }
    const [
      { AppModule },
      { configureHttp },
      { StorageTransfersService },
      { StoragePreflightService },
      { FIREBASE_AUTH },
      { jobError },
      { Job },
      { JobAttempt },
      { JobReceipt },
      { JobError },
      { ClientError },
      { JobDeletionService },
      { WorkerControl },
      { FIREBASE_MESSAGING },
    ] = compiled;
    const fakeStorage = createFakeStorage(jobError);
    const sentMessages = [];
    const fakeMessaging = {
      send: async (message) => {
        sentMessages.push(message);
        return `fixture-message-${sentMessages.length}`;
      },
    };
    const config = new ConfigService(configuration);
    let firebaseAuth;
    let models;
    let deletion;

    const startApi = async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(ConfigService)
        .useValue(config)
        .overrideProvider(StorageTransfersService)
        .useValue(fakeStorage.providers.transfers)
        .overrideProvider(StoragePreflightService)
        .useValue(fakeStorage.providers.preflight)
        .overrideProvider(FIREBASE_MESSAGING)
        .useValue(fakeMessaging)
        .compile();
      const nextApp = moduleRef.createNestApplication({
        bodyParser: false,
        logger: false,
      });
      configureHttp(nextApp);
      try {
        await nextApp.init();
      } catch (error) {
        await nextApp.close();
        throw error;
      }
      app = nextApp;
      firebaseAuth = app.get(FIREBASE_AUTH);
      deletion = app.get(JobDeletionService);
      models = {
        jobs: app.get(getModelToken(Job.name)),
        attempts: app.get(getModelToken(JobAttempt.name)),
        receipts: app.get(getModelToken(JobReceipt.name)),
        errors: app.get(getModelToken(JobError.name)),
        clientErrors: app.get(getModelToken(ClientError.name)),
        control: app.get(getModelToken(WorkerControl.name)),
      };
    };

    const emulatorRequest = async (action, body) => {
      const response = await fetch(
        `${auth.authOrigin}/identitytoolkit.googleapis.com/v1/accounts:${action}?key=fixture-api-key`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok)
        throw new Error(`Fixture Auth Emulator ${action} failed`);
      return response.json();
    };
    const suffix = randomUUID();
    const ownerEmail = `owner-${suffix}@fixture.invalid`;
    const otherEmail = `other-${suffix}@fixture.invalid`;
    const credentials = {
      password: 'Isolated-password-901',
      returnSecureToken: true,
    };
    let ownerIdentity = await emulatorRequest('signUp', {
      ...credentials,
      email: ownerEmail,
    });
    let otherIdentity = await emulatorRequest('signUp', {
      ...credentials,
      email: otherEmail,
    });
    const installationId = randomUUID();
    const otherInstallationId = randomUUID();

    const identityHeaders = (identity) => {
      if (identity === 'anonymous') return {};
      if (identity === 'worker')
        return { Authorization: `Bearer ${workerSecret}` };
      const selected = identity === 'other' ? otherIdentity : ownerIdentity;
      return {
        Authorization: `Bearer ${selected.idToken}`,
        'X-Installation-Id':
          identity === 'other' ? otherInstallationId : installationId,
      };
    };
    const request = async (method, route, body, identity = 'owner') => {
      const verb = String(method).toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(verb))
        throw new TypeError(`Unsupported fixture HTTP method: ${verb}`);
      if (!['owner', 'other', 'worker', 'anonymous'].includes(identity))
        throw new TypeError(`Unsupported fixture identity: ${identity}`);
      const path = route.startsWith('/api/v1')
        ? route
        : `/api/v1${route.startsWith('/') ? route : `/${route}`}`;
      let operation = supertest(app.getHttpServer())
        [verb.toLowerCase()](path)
        .set(identityHeaders(identity));
      if (body !== undefined) operation = operation.send(body);
      const response = await operation;
      return {
        status: response.status,
        body: response.body,
        headers: response.headers,
      };
    };

    await startApi();
    await Promise.all([
      firebaseAuth.updateUser(ownerIdentity.localId, { emailVerified: true }),
      firebaseAuth.updateUser(otherIdentity.localId, { emailVerified: true }),
    ]);
    [ownerIdentity, otherIdentity] = await Promise.all([
      emulatorRequest('signInWithPassword', {
        ...credentials,
        email: ownerEmail,
      }),
      emulatorRequest('signInWithPassword', {
        ...credentials,
        email: otherEmail,
      }),
    ]);
    for (const [identity, id] of [
      ['owner', installationId],
      ['other', otherInstallationId],
    ]) {
      const response = await request(
        'POST',
        '/auth/session',
        sessionReport(id),
        identity,
      );
      if (response.status !== 200)
        throw new Error(`Fixture failed to provision ${identity}`);
    }

    const fixture = {
      installationId,
      sentMessages,
      fakeStorage,
      request,
      async restartApi() {
        await app.close();
        app = undefined;
        await startApi();
      },
      get jobs() {
        return models.jobs;
      },
      get attempts() {
        return models.attempts;
      },
      get receipts() {
        return models.receipts;
      },
      get errors() {
        return models.errors;
      },
      get clientErrors() {
        return models.clientErrors;
      },
      get control() {
        return models.control;
      },
      get deletion() {
        return deletion;
      },
    };
    return fixture;
  } catch (error) {
    await cleanup();
    throw error;
  }
}

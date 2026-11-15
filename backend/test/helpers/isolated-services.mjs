import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from 'mongoose';

const ownedFixture = Symbol('owned-fixture');

export function assertLoopbackUrl(value) {
  const url = new URL(value);
  if (
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      'Integration services must use credential-free loopback URLs',
    );
  }
  return url;
}

export async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

export async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}

export class IsolatedServices {
  #directory;
  #children = new Set();
  #stopped = false;

  constructor(directory, token) {
    if (token !== ownedFixture)
      throw new Error('Use IsolatedServices.create()');
    this.#directory = directory;
  }

  static async create() {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'musicmute-auth-test-'),
    );
    return new IsolatedServices(directory, ownedFixture);
  }

  get directory() {
    return this.#directory;
  }

  environment(overrides = {}) {
    return {
      PATH: process.env.PATH,
      HOME: this.#directory,
      TMPDIR: this.#directory,
      LANG: 'en_US.UTF-8',
      CI: 'true',
      APP_ENV: 'test',
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      AWS_REGION: 'us-east-1',
      S3_BUCKET: 'musicmute-test',
      CORS_ORIGINS: '',
      TRUST_PROXY: 'false',
      FIREBASE_PROJECT_ID: 'demo-musicmute',
      FIREBASE_WEB_API_KEY: 'demo-musicmute-api-key',
      RATE_LIMIT_HASH_SECRET: 'isolated-test-hmac-key-never-production-0001',
      ...overrides,
    };
  }

  spawn(command, args, environment = {}, cwd = process.cwd()) {
    if (this.#stopped) throw new Error('Fixture already stopped');
    const child = spawn(command, args, {
      cwd,
      env: this.environment(environment),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#children.add(child);
    child.output = '';
    const capture = (chunk) => {
      child.output = (child.output + chunk.toString()).slice(-65536);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (error) => {
      child.failure = error;
    });
    return child;
  }

  async stopChild(child, signal = 'SIGTERM') {
    if (!this.#children.has(child))
      throw new Error('Cannot stop an unowned process');
    if (child.exitCode !== null || child.signalCode !== null || child.failure)
      return;
    const exited = once(child, 'exit');
    child.kill(signal);
    const forceStop = setTimeout(() => child.kill('SIGKILL'), 3000);
    try {
      await exited;
    } finally {
      clearTimeout(forceStop);
    }
  }

  async startDatabases({ redisPassword = '', replicaSet = false } = {}) {
    const mongoPort = await freePort();
    const redisPort = await freePort();
    const replicaSetName = 'musicmute-isolated-rs';
    await mkdir(path.join(this.#directory, 'mongo'));
    await mkdir(path.join(this.#directory, 'redis'));
    const mongo = this.spawn(process.env.MONGOD_BINARY || 'mongod', [
      '--dbpath',
      path.join(this.#directory, 'mongo'),
      '--bind_ip',
      '127.0.0.1',
      '--port',
      String(mongoPort),
      ...(replicaSet ? ['--replSet', replicaSetName] : []),
    ]);
    const config = (await readFile('test/helpers/redis.conf', 'utf8')).replace(
      'dir /data',
      `dir "${path.join(this.#directory, 'redis')}"`,
    );
    const configPath = path.join(this.#directory, 'redis.conf');
    await writeFile(configPath, config);
    const redisArgs = [
      configPath,
      '--bind',
      '127.0.0.1',
      '--port',
      String(redisPort),
      ...(redisPassword ? ['--requirepass', redisPassword] : []),
    ];
    const startRedis = () =>
      this.spawn(process.env.REDIS_BINARY || 'redis-server', redisArgs);
    const redis = startRedis();
    await until(() => {
      if (mongo.failure || redis.failure)
        throw new Error(
          'Install mongod and redis-server for isolated integration tests',
        );
      if (mongo.exitCode !== null || redis.exitCode !== null)
        throw new Error('An isolated database exited during startup');
      return (
        mongo.output.includes('Waiting for connections') &&
        redis.output.includes('Ready to accept connections')
      );
    }, 'isolated database startup');
    const standaloneMongoUri = `mongodb://127.0.0.1:${mongoPort}/musicmute_auth_test`;
    let mongoUri = standaloneMongoUri;
    if (replicaSet) {
      const bootstrap = await createConnection(standaloneMongoUri, {
        bufferCommands: false,
        directConnection: true,
        serverSelectionTimeoutMS: 5000,
      }).asPromise();
      try {
        await bootstrap.db.admin().command({
          replSetInitiate: {
            _id: replicaSetName,
            members: [{ _id: 0, host: `127.0.0.1:${mongoPort}` }],
          },
        });
        await until(async () => {
          if (mongo.failure || mongo.exitCode !== null)
            throw new Error(
              'Isolated MongoDB exited while initializing its replica set',
            );
          try {
            const hello = await bootstrap.db.admin().command({ hello: 1 });
            return hello.isWritablePrimary === true;
          } catch {
            return false;
          }
        }, 'isolated MongoDB writable primary');
      } finally {
        await bootstrap.close();
      }
      mongoUri = `${standaloneMongoUri}?replicaSet=${replicaSetName}`;
    }
    assertLoopbackUrl(mongoUri);
    return { mongo, redis, startRedis, mongoUri, redisPort };
  }

  async startAuthEmulator() {
    const authPort = await freePort();
    const hubPort = await freePort();
    const loggingPort = await freePort();
    const configPath = path.join(this.#directory, 'firebase.json');
    await writeFile(
      configPath,
      JSON.stringify({
        emulators: {
          auth: { host: '127.0.0.1', port: authPort },
          hub: { host: '127.0.0.1', port: hubPort },
          logging: { host: '127.0.0.1', port: loggingPort },
          ui: { enabled: false },
          singleProjectMode: true,
        },
      }),
    );
    const emulator = this.spawn(
      process.execPath,
      [
        path.resolve('node_modules/firebase-tools/lib/bin/firebase.js'),
        'emulators:start',
        '--only',
        'auth',
        '--project',
        'demo-musicmute',
        '--config',
        configPath,
        '--non-interactive',
      ],
      { FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true' },
      this.#directory,
    );
    await until(
      () => {
        if (emulator.failure || emulator.exitCode !== null)
          throw new Error('Isolated Firebase Auth emulator failed to start');
        return emulator.output.includes('All emulators ready');
      },
      'isolated Auth emulator startup',
      30000,
    );
    return {
      emulator,
      authPort,
      authHost: `127.0.0.1:${authPort}`,
      authOrigin: `http://127.0.0.1:${authPort}`,
    };
  }

  async stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    try {
      for (const child of this.#children) await this.stopChild(child);
    } finally {
      await rm(this.#directory, { recursive: true, force: true });
    }
  }
}

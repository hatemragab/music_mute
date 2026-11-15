import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'node:events';
import { Types } from 'mongoose';
import type { Redis } from 'ioredis';
import type { AuthRequest } from '../auth/auth-request.js';
import type { Response } from 'express';
import {
  LocalDiagnostics,
  diagnosticError,
  localDiagnostics,
  redactDiagnostic,
} from './local-diagnostics.js';
import { localHttpDiagnostics } from './local-http-diagnostics.js';
import { observeRedisClient } from './local-service-diagnostics.js';

const config = (values: Record<string, unknown> = {}) =>
  new ConfigService({
    APP_ENV: 'local',
    NODE_ENV: 'development',
    MUSICMUTE_LOG_ENABLED: '1',
    MUSICMUTE_LOG_PAYLOADS: '1',
    ...values,
  });
const tick = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  localDiagnostics.configure(config({ MUSICMUTE_LOG_ENABLED: '0' }));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('local diagnostic privacy and bounds', () => {
  it('redacts nested credentials, headers, connection URLs, JWTs and encoded JSON', () => {
    const secret = 'SYNTHETIC_CREDENTIAL_NEVER_RETAIN';
    const result = redactDiagnostic({
      password: secret,
      children: [{ Authorization: `Bearer ${secret}` }],
      mongo: `mongodb://user:${secret}@127.0.0.1/db`,
      grant: `https://example.test/object?X-Amz-Signature=${secret}&unusual=${secret}`,
      nested: JSON.stringify({ api_key: secret }),
      encoded: Buffer.from(JSON.stringify({ token: secret })).toString(
        'base64',
      ),
      message: `password=${secret}`,
      [`password=${secret}`]: 'value',
      privateKey: `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----`,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain('REDACTED');
  });

  it('bounds oversized snapshots, preserves native scalars and avoids getters', () => {
    const getter = vi.fn(() => 'DO_NOT_CALL');
    const object = {
      id: new Types.ObjectId('507f1f77bcf86cd799439011'),
      when: new Date('2026-10-18T00:00:00Z'),
      integer: 9n,
      bytes: Buffer.from('PRIVATE'),
      list: Array.from({ length: 200 }, () => 1),
      huge: 'x'.repeat(9000),
    };
    Object.defineProperty(object, 'getter', { get: getter, enumerable: true });
    const result = redactDiagnostic(object) as Record<string, unknown>;
    expect(result.id).toBe('507f1f77bcf86cd799439011');
    expect(result.integer).toBe('9');
    expect(result.huge).toEqual({ $omitted: 'string-limit' });
    expect(result.bytes).toEqual({ $omitted: 'binary', bytes: 7 });
    expect(result.getter).toEqual({ $omitted: 'accessor' });
    expect(result.list).toHaveLength(101);
    expect(getter).not.toHaveBeenCalled();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(JSON.stringify(redactDiagnostic(cycle))).toContain(
      'circular-reference',
    );
    expect(
      diagnosticError(
        Object.assign(new Error('mongodb://private'), {
          code: 112,
          name: 'MongoServerError',
        }),
      ),
    ).toMatchObject({
      name: 'MongoServerError',
      code: 112,
      message: { $omitted: 'error-message-and-stack' },
    });
  });
});

describe('local diagnostic controls and delivery', () => {
  it('cannot enable collection in release/test modes or to a non-loopback endpoint', () => {
    for (const settings of [
      { APP_ENV: 'production', NODE_ENV: 'production' },
      { APP_ENV: 'test', NODE_ENV: 'test' },
      { NODE_ENV: 'production' },
      { MUSICMUTE_LOG_ENABLED: 'false' },
      { MUSICMUTE_LOG_ENDPOINT: 'https://example.test/ingest/backend' },
      { MUSICMUTE_LOG_ENDPOINT: 'http://127.0.0.1:19740/other' },
    ]) {
      const deliver = vi.fn().mockResolvedValue(undefined);
      const logger = new LocalDiagnostics(deliver);
      logger.configure(config(settings));
      logger.event({ category: 'test', name: 'test', summary: 'test' });
      expect(deliver).not.toHaveBeenCalled();
    }
  });

  it('respects independent payload and console controls', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const logger = new LocalDiagnostics(deliver);
    logger.configure(
      config({ MUSICMUTE_LOG_PAYLOADS: '0', MUSICMUTE_LOG_CONSOLE: '0' }),
    );
    logger.event({
      category: 'test',
      name: 'test',
      summary: 'test',
      data: logger.snapshot({ value: 'private' }),
    });
    await tick();
    expect(stdout).not.toHaveBeenCalled();
    expect(JSON.parse(deliver.mock.calls[0][2]).data).toEqual({
      $omitted: 'payload-capture-disabled',
    });
  });

  it('retains request/account identity independently across awaits and background work', async () => {
    const records: Record<string, unknown>[] = [];
    const logger = new LocalDiagnostics(async (_endpoint, _key, body) => {
      records.push(JSON.parse(body));
    });
    logger.configure(config());
    await Promise.all(
      ['account-one', 'account-two'].map((userId) =>
        logger.run({ userId, requestId: userId }, async () => {
          await tick();
          await tick();
          logger.event({
            category: 'test',
            name: userId,
            summary: 'parallel operation',
          });
        }),
      ),
    );
    await tick();
    expect(
      records.map((record) => [record.name, record.userId, record.requestId]),
    ).toEqual([
      ['account-one', 'account-one', 'account-one'],
      ['account-two', 'account-two', 'account-two'],
    ]);
    expect(logger.context.getStore()).toBeUndefined();
  });

  it('bounds pressure, reserves warnings by eviction and retries sink failures without throwing', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const records: string[] = [];
    const logger = new LocalDiagnostics(async (_endpoint, _key, body) => {
      records.push(body);
      await stalled;
    });
    logger.configure(config());
    for (let index = 0; index < 600; index++)
      logger.event({
        category: 'test',
        name: 'pressure',
        summary: 'bounded test',
      });
    logger.event({
      category: 'test',
      name: 'warning',
      summary: 'warning retained',
      level: 'warn',
    });
    expect(logger.status()).toMatchObject({
      pending: 256,
      active: 2,
      dropped: 343,
    });
    release();
    await vi.runAllTimersAsync();
    expect(
      records.some((record) => JSON.parse(record).name === 'warning'),
    ).toBe(true);
    const failure = new LocalDiagnostics(async () => {
      throw new Error('private collector failure');
    });
    failure.configure(config());
    expect(() =>
      failure.event({
        category: 'test',
        name: 'sink',
        summary: 'failure does not escape',
      }),
    ).not.toThrow();
    await vi.runAllTimersAsync();
    expect(failure.status()).toMatchObject({
      failed: 3,
      dropped: 1,
      pending: 0,
      active: 0,
    });
  });
});

describe('HTTP and Redis observations', () => {
  it('records a single aborted response with its request ID without buffering streams', () => {
    localDiagnostics.configure(config());
    const record = vi
      .spyOn(localDiagnostics, 'event')
      .mockImplementation(() => undefined);
    const request = {
      method: 'POST',
      adminRequestId: 'req',
      headers: {},
      params: {},
      query: {},
      is: () => false,
      get: () => undefined,
    } as unknown as AuthRequest;
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableFinished: false,
      json: vi.fn(),
      getHeaders: () => ({}),
    }) as unknown as Response;
    const next = vi.fn();
    localHttpDiagnostics(request, response, next);
    response.emit('close');
    response.emit('finish');
    expect(next).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0]).toMatchObject({
      requestId: 'req',
      phase: 'aborted',
      result: 'aborted',
    });
  });

  it('preserves Redis promise identity, errors and commands while omitting positional secrets', async () => {
    localDiagnostics.configure(config());
    const record = vi
      .spyOn(localDiagnostics, 'event')
      .mockImplementation(() => undefined);
    const failure = Object.assign(new Error('password=PRIVATE_MARKER'), {
      code: 'ECONNRESET',
    });
    const original = Promise.reject(failure);
    const redis = Object.assign(new EventEmitter(), {
      sendCommand: vi.fn(() => original),
    }) as unknown as Redis;
    const command = { name: 'set', args: ['secret-key', 'PRIVATE_MARKER'] };
    observeRedisClient(redis);
    const result = redis.sendCommand(
      command as Parameters<Redis['sendCommand']>[0],
    );
    expect(result).toBe(original);
    await expect(result).rejects.toBe(failure);
    await tick();
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0]).toMatchObject({
      category: 'cache',
      operation: 'set',
      result: 'failed',
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain('PRIVATE_MARKER');
  });
});

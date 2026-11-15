import type { Connection } from 'mongoose';
import type { Redis } from 'ioredis';
import type { WebSocket, RawData } from 'ws';
import { randomUUID } from 'node:crypto';
import {
  diagnosticError,
  localDiagnostics,
  type DiagnosticContext,
} from './local-diagnostics.js';

const observedMongo = new WeakSet<Connection>();
const observedRedis = new WeakSet<Redis>();
const observedSockets = new WeakSet<WebSocket>();

export function observeMongoConnection(connection: Connection): void {
  if (!localDiagnostics.isEnabled || observedMongo.has(connection)) return;
  observedMongo.add(connection);
  const pending = new Map<
    number,
    { context: DiagnosticContext; operation: string; spanId: string }
  >();
  const client = connection.getClient();
  client.on('commandStarted', (event) => {
    if (pending.size >= 512) {
      pending.delete(pending.keys().next().value!);
      localDiagnostics.event({
        category: 'logging',
        name: 'mongodb.observation-pressure',
        summary: 'MongoDB pending observation limit reached',
        level: 'warn',
        data: { $omitted: 'oldest-command-correlation', limit: 512 },
      });
    }
    const context = { ...localDiagnostics.context.getStore() };
    const spanId = randomUUID();
    pending.set(event.requestId, {
      context,
      operation: event.commandName,
      spanId,
    });
    localDiagnostics.event({
      ...context,
      spanId,
      category: 'database',
      name: 'mongodb.command',
      summary: 'MongoDB client command started',
      operation: event.commandName,
      phase: 'started',
      data: {
        database: event.databaseName,
        command: /^(?:sasl|authenticate|hello)/i.test(event.commandName)
          ? { $omitted: 'authentication-command' }
          : localDiagnostics.snapshot(event.command),
      },
    });
  });
  client.on('commandSucceeded', (event) => {
    const started = pending.get(event.requestId);
    pending.delete(event.requestId);
    localDiagnostics.event({
      ...started?.context,
      spanId: started?.spanId,
      category: 'database',
      name: 'mongodb.command',
      summary: 'MongoDB client command succeeded',
      operation: event.commandName,
      phase: 'completed',
      result: 'succeeded',
      durationMs: event.duration,
      data: {
        response: /^(?:sasl|authenticate|hello)/i.test(event.commandName)
          ? { $omitted: 'authentication-command' }
          : localDiagnostics.snapshot(event.reply),
      },
    });
  });
  client.on('commandFailed', (event) => {
    const started = pending.get(event.requestId);
    pending.delete(event.requestId);
    localDiagnostics.event({
      ...started?.context,
      spanId: started?.spanId,
      category: 'database',
      name: 'mongodb.command',
      summary: 'MongoDB client command failed',
      level: 'error',
      operation: event.commandName,
      phase: 'completed',
      result: 'failed',
      durationMs: event.duration,
      data: { error: diagnosticError(event.failure) },
    });
  });
  for (const phase of [
    'connected',
    'disconnected',
    'reconnected',
    'error',
  ] as const)
    connection.on(phase, () => {
      if (phase === 'disconnected') pending.clear();
      localDiagnostics.event({
        category: 'database',
        name: 'mongodb.connection',
        summary: 'MongoDB client connection state',
        level: phase === 'error' ? 'error' : 'info',
        phase,
      });
    });
}

export function observeRedisClient(redis: Redis, identity = 'security'): Redis {
  if (!localDiagnostics.isEnabled || observedRedis.has(redis)) return redis;
  observedRedis.add(redis);
  const original = redis.sendCommand;
  redis.sendCommand = function (command, stream) {
    const started = performance.now();
    const context = { ...localDiagnostics.context.getStore() };
    const spanId = randomUUID();
    const operation = command.name;
    const finish = (result: 'succeeded' | 'failed', response: unknown) => {
      localDiagnostics.event({
        ...context,
        spanId,
        category: 'cache',
        name: 'redis.command',
        summary: 'Redis client command completed',
        operation,
        level: result === 'failed' ? 'error' : 'debug',
        phase: 'completed',
        result,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        data: {
          client: identity,
          // Redis/Lua values have positional credential semantics; do not guess which
          // opaque strings are safe. Native command outcome/timing remains available.
          arguments: {
            $omitted: 'positional-redis-command-contents',
            count: command.args.length,
          },
          ...(result === 'failed'
            ? { error: diagnosticError(response) }
            : {
                response: {
                  $omitted: 'positional-redis-response',
                  type: typeof response,
                  ...(Array.isArray(response)
                    ? { count: response.length }
                    : {}),
                },
              }),
        },
      });
    };
    try {
      const result = original.call(this, command, stream);
      void Promise.resolve(result).then(
        (value: unknown) => finish('succeeded', value),
        (error: unknown) => finish('failed', error),
      );
      return result;
    } catch (error) {
      finish('failed', error);
      throw error;
    }
  };
  for (const phase of [
    'connect',
    'ready',
    'close',
    'reconnecting',
    'end',
    'error',
  ] as const)
    redis.on(phase, () =>
      localDiagnostics.event({
        category: 'cache',
        name: 'redis.connection',
        summary: 'Redis client connection state',
        level: phase === 'error' ? 'error' : 'info',
        phase,
        data: { client: identity },
      }),
    );
  return redis;
}

/** Server sends prove a local send attempt, never client receipt or processing. */
export function observeWebSocket(
  socket: WebSocket,
  context: DiagnosticContext,
  transport: string,
): void {
  if (!localDiagnostics.isEnabled || observedSockets.has(socket)) return;
  observedSockets.add(socket);
  const connectionId = randomUUID();
  const event = (phase: string, data?: unknown) =>
    localDiagnostics.event({
      ...context,
      category: 'realtime',
      name: 'websocket.frame',
      summary: 'Server WebSocket observation',
      phase,
      data: { transport, connectionId, ...(data as object) },
    });
  event('connected');
  socket.on('message', (data: RawData, binary: boolean) =>
    event('received', {
      frame: binary
        ? {
            $omitted: 'binary-frame',
            bytes: Buffer.byteLength(data.toString()),
          }
        : localDiagnostics.snapshot(data.toString()),
    }),
  );
  socket.on('close', (code) => event('closed', { code }));
  socket.on('error', () =>
    event('failed', { $omitted: 'arbitrary-websocket-error' }),
  );
  const originalSend = socket.send;
  socket.send = function (this: WebSocket, ...args: unknown[]) {
    const frame = args[0];
    event('send-attempt', {
      frame:
        typeof frame === 'string'
          ? localDiagnostics.snapshot(frame)
          : { $omitted: 'binary-or-stream-frame' },
      result: 'local-send-attempt',
    });
    return Reflect.apply(originalSend, this, args);
  };
}

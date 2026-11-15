import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { WorkerHintService } from './worker-hint.service.js';

class FakeRedis extends EventEmitter {
  readonly values = new Map<string, string>();
  subscriber: FakeRedis | null = null;
  status = 'ready';

  duplicate() {
    this.subscriber = new FakeRedis();
    return this.subscriber;
  }

  async subscribe() {
    return 1;
  }

  async set(key: string, value: string) {
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }

  async getdel(key: string) {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }

  async publish(channel: string, message: string) {
    this.subscriber?.emit('message', channel, message);
    return 1;
  }

  async quit() {
    this.status = 'end';
    return 'OK';
  }

  disconnect() {
    this.status = 'end';
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const operation of cleanup.splice(0).reverse()) await operation();
});

describe('worker hint websocket', () => {
  it('uses an authenticated one-use ticket and broadcasts only bounded hints', async () => {
    const redis = new FakeRedis();
    const service = new WorkerHintService(redis as unknown as Redis);
    await service.onModuleInit();
    const server = createServer();
    service.attach(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    cleanup.push(async () => {
      await service.onModuleDestroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const port = (server.address() as AddressInfo).port;
    const ticket = await service.mintTicket(
      '32410a14-e85a-4a1d-bb99-61fa54b07eaa',
    );
    const url = `ws://127.0.0.1:${port}${ticket.path}?ticket=${ticket.ticket}`;
    const socket = new WebSocket(url);
    cleanup.push(async () => socket.close());
    await once(socket, 'open');

    const message = once(socket, 'message');
    await service.publish('work_available');
    const [payload] = await message;
    expect(JSON.parse(payload.toString())).toMatchObject({
      type: 'work_available',
      revision: 1,
    });

    const replay = new WebSocket(url);
    replay.on('error', () => undefined);
    const [, response] = await once(replay, 'unexpected-response');
    expect((response as { statusCode: number }).statusCode).toBe(401);
    (response as { destroy(): void }).destroy();
  });
});

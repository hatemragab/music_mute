import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  WorkerHintService,
  workerSocketClientIp,
} from './worker-hint.service.js';

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
  it('uses the same one-hop proxy identity as HTTP without trusting it when disabled', () => {
    const request = {
      socket: { remoteAddress: '172.18.0.2' },
      headers: { 'x-forwarded-for': '192.0.2.3, 198.51.100.8' },
    };
    expect(workerSocketClientIp(request as never, true)).toBe('198.51.100.8');
    expect(workerSocketClientIp(request as never, false)).toBe('172.18.0.2');
    request.headers['x-forwarded-for'] = 'spoofed-address';
    expect(workerSocketClientIp(request as never, true)).toBe('172.18.0.2');
  });

  it('uses an authenticated one-use ticket and broadcasts only bounded hints', async () => {
    const redis = new FakeRedis();
    const reserve = vi.fn(async () => ({
      allowed: true,
      retryAfterSeconds: 0,
    }));
    const service = new WorkerHintService(
      redis as unknown as Redis,
      { reserve } as never,
      {
        bucket: (scope: string, identifier: string) => `${scope}:${identifier}`,
      } as never,
      { get: () => 'false' } as never,
    );
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
    const url = `ws://127.0.0.1:${port}${ticket.path}`;
    const protocols = ['musicmute.worker-hint.v1', `ticket.${ticket.ticket}`];
    const socket = new WebSocket(url, protocols);
    cleanup.push(async () => socket.close());
    await once(socket, 'open');

    const message = once(socket, 'message');
    await service.publish('work_available');
    const [payload] = await message;
    expect(JSON.parse(payload.toString())).toMatchObject({
      type: 'work_available',
      revision: 1,
    });

    const replay = new WebSocket(url, protocols);
    replay.on('error', () => undefined);
    const [, response] = await once(replay, 'unexpected-response');
    expect((response as { statusCode: number }).statusCode).toBe(401);
    (response as { destroy(): void }).destroy();
    expect(reserve).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'worker-socket-machine:32410a14-e85a-4a1d-bb99-61fa54b07eaa',
        }),
      ]),
    );

    const query = new WebSocket(`${url}?ticket=${ticket.ticket}`, protocols);
    query.on('error', () => undefined);
    const [, queryResponse] = await once(query, 'unexpected-response');
    expect((queryResponse as { statusCode: number }).statusCode).toBe(401);
    (queryResponse as { destroy(): void }).destroy();

    const browser = new WebSocket(url, protocols, {
      origin: 'https://untrusted.example',
    });
    browser.on('error', () => undefined);
    const [, browserResponse] = await once(browser, 'unexpected-response');
    expect((browserResponse as { statusCode: number }).statusCode).toBe(401);
    (browserResponse as { destroy(): void }).destroy();

    const limitedTicket = await service.mintTicket('machine-2');
    reserve.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 19 });
    const limited = new WebSocket(
      `ws://127.0.0.1:${port}${limitedTicket.path}`,
      ['musicmute.worker-hint.v1', `ticket.${limitedTicket.ticket}`],
    );
    limited.on('error', () => undefined);
    const [, limitedResponse] = await once(limited, 'unexpected-response');
    expect((limitedResponse as { statusCode: number }).statusCode).toBe(429);
    expect(
      (limitedResponse as { headers: Record<string, string> }).headers[
        'retry-after'
      ],
    ).toBe('19');
    (limitedResponse as { destroy(): void }).destroy();

    const unknown = new WebSocket(`ws://127.0.0.1:${port}/unknown`, protocols);
    unknown.on('error', () => undefined);
    const [, unknownResponse] = await once(unknown, 'unexpected-response');
    expect((unknownResponse as { statusCode: number }).statusCode).toBe(404);
    (unknownResponse as { destroy(): void }).destroy();
  });
});

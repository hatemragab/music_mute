import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { RateBudgetService } from '../rate-limits/rate-budget.service.js';
import type { RateLimitKeys } from '../rate-limits/rate-limit-keys.js';
import type {
  RealtimeFeedService,
  RealtimeFeedEvent,
} from '../realtime/realtime-feed.service.js';
import type { YouTubeCommunityService } from './youtube-community.service.js';
import { YouTubeCommunitySocketService } from './youtube-community-socket.service.js';

const token = 'a'.repeat(43);
const videoId = 'bZxrIoCPsOc';
const fixtures: { service: YouTubeCommunitySocketService; server: Server }[] =
  [];
async function fixture() {
  const listeners = new Set<(event: RealtimeFeedEvent) => void>();
  const feed = {
    healthy: true,
    subscribe: (listener: (event: RealtimeFeedEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const community = {
    authenticate: vi.fn(async (value: string) => {
      if (value !== token) throw new Error('Unauthenticated');
      return { _id: 'guest-fixture' };
    }),
    snapshot: vi.fn(async () => ({
      videoId,
      state: 'preparing',
      expiresAt: null as string | null,
    })),
  };
  const budgets = {
    reserve: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  };
  const redis = { eval: vi.fn(async () => 1), zrem: vi.fn(async () => 1) };
  const service = new YouTubeCommunitySocketService(
    community as unknown as YouTubeCommunityService,
    feed as unknown as RealtimeFeedService,
    budgets as unknown as RateBudgetService,
    {
      bucket: (...parts: string[]) => parts.join(':'),
    } as unknown as RateLimitKeys,
    { get: () => '0' } as unknown as ConfigService,
    redis as unknown as Redis,
  );
  const server = createServer();
  service.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  fixtures.push({ service, server });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing address');
  const url = `ws://127.0.0.1:${address.port}/youtube-community-realtime`;
  const connect = async () => {
    const socket = new WebSocket(url);
    await once(socket, 'open');
    return socket;
  };
  return {
    url,
    connect,
    community,
    budgets,
    redis,
    feed,
    emit: (event: RealtimeFeedEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}
afterEach(async () => {
  for (const { service, server } of fixtures.splice(0)) {
    service.onModuleDestroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
function authenticate(socket: WebSocket) {
  socket.send(
    JSON.stringify({ type: 'authenticate', token, video_id: videoId }),
  );
}
describe('guest YouTube full snapshots', () => {
  it('authenticates in a frame and sends fresh complete snapshots on committed changes', async () => {
    const f = await fixture();
    const socket = await f.connect();
    const first = once(socket, 'message');
    authenticate(socket);
    expect(JSON.parse(String((await first)[0]))).toEqual({
      type: 'snapshot',
      video_id: videoId,
      state: 'preparing',
      expires_at: null,
      sequence: 1,
    });
    f.community.snapshot.mockResolvedValue({
      videoId,
      state: 'ready',
      expiresAt: null,
    });
    const second = once(socket, 'message');
    f.emit({ healthy: true, collection: 'shared_media_results' });
    const text = String((await second)[0]);
    expect(JSON.parse(text)).toMatchObject({ state: 'ready', sequence: 2 });
    expect(text).not.toContain(token);
    expect(text).not.toContain('guest-fixture');
    expect(f.community.authenticate.mock.calls.length).toBeGreaterThanOrEqual(
      5,
    );
    socket.close();
  });
  it('fails closed on wrong tokens and rejects an extra source URL field', async () => {
    const f = await fixture();
    for (const command of [
      { type: 'authenticate', token: 'bad', video_id: videoId },
      {
        type: 'authenticate',
        token,
        video_id: videoId,
        url: 'https://example.invalid',
      },
    ]) {
      const socket = await f.connect();
      const close = once(socket, 'close');
      socket.send(JSON.stringify(command));
      expect((await close)[0]).toBe(1008);
    }
    expect(f.community.snapshot).not.toHaveBeenCalled();
  });
  it('closes on feed loss and revalidates authorization after asynchronous reads', async () => {
    const f = await fixture();
    const socket = await f.connect();
    const first = once(socket, 'message');
    authenticate(socket);
    await first;
    const close = once(socket, 'close');
    f.feed.healthy = false;
    f.emit({ healthy: false });
    expect((await close)[0]).toBe(1013);
    f.feed.healthy = true;
    const other = await f.connect();
    f.community.snapshot.mockImplementation(async () => {
      f.community.authenticate.mockRejectedValue(new Error('Revoked'));
      return { videoId, state: 'ready', expiresAt: null };
    });
    const denied = once(other, 'close');
    authenticate(other);
    expect((await denied)[0]).toBe(1013);
  });
  it('enforces shared connection leases before any snapshot', async () => {
    const f = await fixture();
    f.redis.eval.mockResolvedValue(0);
    const socket = await f.connect();
    const close = once(socket, 'close');
    authenticate(socket);
    expect((await close)[0]).toBe(1008);
    expect(f.community.snapshot).not.toHaveBeenCalled();
    expect(f.redis.eval.mock.calls[0]).toBeDefined();
  });
  it('re-reads a lease that expires during authorization instead of sending stale state', async () => {
    const f = await fixture();
    const expiresAt = Date.now() + 1000;
    f.community.snapshot
      .mockResolvedValueOnce({
        videoId,
        state: 'preparing',
        expiresAt: new Date(expiresAt).toISOString(),
      })
      .mockResolvedValue({ videoId, state: 'missing', expiresAt: null });
    const clock = vi.spyOn(Date, 'now');
    let authenticationCount = 0;
    f.community.authenticate.mockImplementation(async () => {
      if (++authenticationCount === 3) clock.mockReturnValue(expiresAt + 1);
      return { _id: 'guest-fixture' };
    });
    try {
      const socket = await f.connect();
      const first = once(socket, 'message');
      authenticate(socket);
      expect(JSON.parse(String((await first)[0]))).toMatchObject({
        state: 'missing',
        expires_at: null,
        sequence: 1,
      });
      expect(f.community.snapshot).toHaveBeenCalledTimes(2);
      socket.close();
    } finally {
      clock.mockRestore();
    }
  });
  it('fails closed if a refreshed snapshot remains expired', async () => {
    const f = await fixture();
    f.community.snapshot.mockResolvedValue({
      videoId,
      state: 'preparing',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const socket = await f.connect();
    const close = once(socket, 'close');
    const message = vi.fn();
    socket.on('message', message);
    authenticate(socket);
    expect((await close)[0]).toBe(1013);
    expect(message).not.toHaveBeenCalled();
    expect(f.community.snapshot).toHaveBeenCalledTimes(2);
  });
  it('rejects query capabilities and browser origins before authentication', async () => {
    const f = await fixture();
    for (const [url, headers] of [
      [`${f.url}?token=synthetic`, {}],
      [f.url, { Origin: 'https://untrusted.invalid' }],
    ] as const) {
      const socket = new WebSocket(url, { headers });
      const rejected = new Promise<number>((resolve) =>
        socket.once('unexpected-response', (_req, response) => {
          response.resume();
          socket.terminate();
          resolve(response.statusCode ?? 0);
        }),
      );
      socket.on('error', () => undefined);
      expect(await rejected).toBe(403);
    }
    expect(f.community.authenticate).not.toHaveBeenCalled();
  });
});

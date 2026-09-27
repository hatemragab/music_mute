import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  RealtimeSocketService,
  refreshesOnHeartbeat,
} from './realtime-socket.service.js';
import type { RealtimeFeedEvent } from './realtime-feed.service.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  let feedListener: (event: RealtimeFeedEvent) => void = () => {};
  const feed = {
    healthy: true,
    subscribe: (listener: typeof feedListener) => {
      feedListener = listener;
      return () => {
        feedListener = () => {};
      };
    },
  };
  const principal = { audience: 'owner', identity: { uid: 'fixture' } };
  const auth = {
    consume: vi.fn(async () => principal),
    validate: vi.fn(async () => {}),
  };
  const resources = {
    read: vi.fn(async (): Promise<unknown> => ({
      status: 'queued',
      displayName: 'Fixture',
    })),
  };
  const redis = {
    eval: vi.fn(async () => 1),
    zrem: vi.fn(async () => 1),
    zadd: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
  };
  const service = new RealtimeSocketService(
    auth as never,
    feed as never,
    resources as never,
    { reserve: async () => ({ allowed: true }) } as never,
    { bucket: (a: string, b: string) => `${a}:${b}` } as never,
    { get: () => '0' } as never,
    redis as never,
  );
  const server = createServer();
  service.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    await service.onModuleDestroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const socket = new WebSocket(
    `ws://127.0.0.1:${(server.address() as AddressInfo).port}/realtime/socket`,
    ['musicmute.realtime.v1', `ticket.${'a'.repeat(43)}`],
  );
  const messages: Array<Record<string, unknown>> = [];
  socket.on('message', (value) => messages.push(JSON.parse(value.toString())));
  await vi.waitFor(() => expect(messages[0]?.type).toBe('ready'));
  return {
    socket,
    messages,
    auth,
    resources,
    redis,
    feed,
    change: (collection = 'audio_jobs') =>
      feedListener({ healthy: true, collection }),
    outage: () => feedListener({ healthy: false }),
  };
}

const subscribe = JSON.stringify({
  type: 'subscribe',
  subscription_id: 'detail',
  resource: 'job',
  params: { id: 'fixture' },
});

it('periodically refreshes only views with time or probe driven changes', () => {
  expect(refreshesOnHeartbeat('admin.health')).toBe(true);
  expect(refreshesOnHeartbeat('admin.workers')).toBe(true);
  expect(refreshesOnHeartbeat('usage')).toBe(true);
  expect(refreshesOnHeartbeat('job')).toBe(true);
  expect(refreshesOnHeartbeat('job', { status: 'processing' })).toBe(true);
  expect(refreshesOnHeartbeat('job', { status: 'ready' })).toBe(false);
  expect(
    refreshesOnHeartbeat('jobs', {
      items: [{ status: 'ready' }, { status: 'cancelled' }],
    }),
  ).toBe(false);
  expect(
    refreshesOnHeartbeat('admin.jobs', {
      items: [{ status: 'ready' }, { status: 'interrupted' }],
    }),
  ).toBe(true);
  expect(refreshesOnHeartbeat('policy')).toBe(false);
});

it('sends complete snake_case snapshots and coalesces committed changes', async () => {
  const f = await fixture();
  expect(f.resources.read).not.toHaveBeenCalled();
  f.socket.send(subscribe);
  await vi.waitFor(() => expect(f.messages[1]?.type).toBe('snapshot'));
  expect(f.messages[1]).toMatchObject({
    sequence: 1,
    data: { display_name: 'Fixture', status: 'queued' },
  });
  f.resources.read.mockResolvedValue({ status: 'ready' });
  f.change();
  f.change();
  f.change();
  await vi.waitFor(
    () =>
      expect(f.messages[2]).toMatchObject({
        sequence: 2,
        data: { status: 'ready' },
      }),
    { timeout: 2000 },
  );
  expect(f.resources.read).toHaveBeenCalledTimes(2);
});

it('fences an in-flight read after unsubscribe', async () => {
  const f = await fixture();
  let resolve!: (value: unknown) => void;
  f.resources.read.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.socket.send(subscribe);
  await vi.waitFor(() => expect(f.resources.read).toHaveBeenCalledOnce());
  f.socket.send(
    JSON.stringify({ type: 'unsubscribe', subscription_id: 'detail' }),
  );
  // Round-trip an invalid command after unsubscribe to prove the server processed both.
  const closed = once(f.socket, 'close');
  f.socket.send('{"type":"invalid"}');
  await closed;
  resolve({ status: 'ready' });
  await new Promise<void>((done) => setImmediate(done));
  expect(f.messages.filter((message) => message.type === 'snapshot')).toEqual(
    [],
  );
});

it('reruns a snapshot dirtied while its first read was pending', async () => {
  const f = await fixture();
  let resolve!: (value: unknown) => void;
  f.resources.read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.socket.send(subscribe);
  await vi.waitFor(() => expect(f.resources.read).toHaveBeenCalledOnce());
  f.change();
  f.resources.read.mockResolvedValue({ status: 'ready' });
  resolve({ status: 'queued' });
  await vi.waitFor(
    () =>
      expect(f.messages.at(-1)).toMatchObject({
        sequence: 2,
        data: { status: 'ready' },
      }),
    { timeout: 2000 },
  );
});

it('closes on feed loss instead of leaving stale data marked live', async () => {
  const f = await fixture();
  const closed = once(f.socket, 'close');
  f.outage();
  expect((await closed)[0]).toBe(1013);
  await vi.waitFor(() => expect(f.redis.zrem).toHaveBeenCalled());
});

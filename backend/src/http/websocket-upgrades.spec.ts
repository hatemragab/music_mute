import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { registerWebSocketUpgrade } from './websocket-upgrades.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const origin = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, origin };
}

async function rejection(url: string): Promise<number | undefined> {
  const socket = new WebSocket(url);
  socket.on('error', () => undefined);
  const [, response] = await once(socket, 'unexpected-response');
  response.destroy();
  return response.statusCode;
}

it('routes two independent raw WebSocket servers without competing upgrades', async () => {
  const { server, origin } = await fixture();
  for (const path of ['/worker/hints/socket', '/realtime/socket']) {
    const ws = new WebSocketServer({ noServer: true });
    const detach = registerWebSocketUpgrade(
      server,
      path,
      (req, socket, head) => {
        ws.handleUpgrade(req, socket, head, (client) => client.send(path));
      },
    );
    cleanups.push(async () => {
      detach();
      for (const client of ws.clients) client.terminate();
      await new Promise<void>((resolve) => ws.close(() => resolve()));
    });
  }
  expect(server.listenerCount('upgrade')).toBe(1);
  for (const path of ['/worker/hints/socket', '/realtime/socket']) {
    const client = new WebSocket(`${origin}${path}`);
    const [payload] = await once(client, 'message');
    expect(payload.toString()).toBe(path);
    client.terminate();
    await once(client, 'close');
  }
  expect(await rejection(`${origin}/unknown`)).toBe(404);
});

it('fails closed on handler rejection without exposing error messages', async () => {
  const { server, origin } = await fixture();
  const detach = registerWebSocketUpgrade(
    server,
    '/realtime/socket',
    async () => {
      throw new Error('private dependency detail');
    },
  );
  expect(await rejection(`${origin}/realtime/socket`)).toBe(503);
  detach();
  expect(server.listenerCount('upgrade')).toBe(0);
});

it('rejects duplicate routes and detaches only the owning registration', async () => {
  const { server } = await fixture();
  const detach = registerWebSocketUpgrade(server, '/realtime/socket', () => {});
  expect(() =>
    registerWebSocketUpgrade(server, '/realtime/socket', () => {}),
  ).toThrow('Duplicate');
  detach();
  const next = registerWebSocketUpgrade(server, '/realtime/socket', () => {});
  detach();
  expect(server.listenerCount('upgrade')).toBe(1);
  next();
  expect(server.listenerCount('upgrade')).toBe(0);
});

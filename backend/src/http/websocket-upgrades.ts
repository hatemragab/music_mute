import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

type UpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void | Promise<void>;

interface Routes {
  handlers: Map<string, UpgradeHandler>;
  listener: UpgradeHandler;
}

const servers = new WeakMap<Server, Routes>();

/** One HTTP upgrade listener prevents unrelated WS handlers rejecting each other. */
export function registerWebSocketUpgrade(
  server: Server,
  path: string,
  handler: UpgradeHandler,
): () => void {
  if (!/^\/[a-z0-9/-]+$/.test(path))
    throw new TypeError('Invalid WebSocket route');
  let routes = servers.get(server);
  if (!routes) {
    const handlers = new Map<string, UpgradeHandler>();
    const listener: UpgradeHandler = (request, socket, head) => {
      // Disconnected handshakes can fail while asynchronous authentication runs.
      socket.on('error', ignoreSocketError);
      const route = handlers.get((request.url ?? '').split('?', 1)[0]!);
      if (!route) {
        reject(socket, 404, 'Not Found');
        return;
      }
      void Promise.resolve()
        .then(() => route(request, socket, head))
        .catch(() => reject(socket, 503, 'Service Unavailable'));
    };
    routes = { handlers, listener };
    servers.set(server, routes);
    server.on('upgrade', listener);
  }
  if (routes.handlers.has(path)) throw new Error('Duplicate WebSocket route');
  routes.handlers.set(path, handler);
  return () => {
    if (routes.handlers.get(path) !== handler) return;
    routes.handlers.delete(path);
    if (routes.handlers.size === 0) {
      server.off('upgrade', routes.listener);
      servers.delete(server);
    }
  };
}

function ignoreSocketError(): void {}

function reject(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed || socket.writableEnded) return;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

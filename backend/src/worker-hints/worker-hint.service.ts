import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';
import { ConfigService } from '@nestjs/config';
import { SECURITY_REDIS } from '../rate-limits/security-redis.provider.js';
import { RateBudgetService } from '../rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../rate-limits/rate-limit-keys.js';

const SOCKET_PATH = '/worker/hints/socket';
const CHANNEL = 'musicmute:worker-hints:v1';
const TICKET_PREFIX = 'musicmute:worker-hint-ticket:v1:';
const TICKET_TTL_SECONDS = 30;
const MAX_MESSAGE_BYTES = 1024;
const MAX_SOCKETS_PER_MACHINE = 2;
const MAX_SOCKET_AGE_MS = 60 * 60 * 1000;
const HEARTBEAT_MS = 30_000;
const SOCKET_PROTOCOL = 'musicmute.worker-hint.v1';

export const WORKER_HINT_TYPES = [
  'work_available',
  'policy_changed',
  'command_available',
] as const;
export type WorkerHintType = (typeof WORKER_HINT_TYPES)[number];

interface PublishedHint {
  type: WorkerHintType;
  machineId: string | null;
  revision: number;
  sentAt: string;
}

@Injectable()
export class WorkerHintService implements OnModuleInit, OnModuleDestroy {
  private subscriber: Redis | null = null;
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  private revision = 0;
  private attached = false;

  constructor(
    @Inject(SECURITY_REDIS) private readonly redis: Redis,
    private readonly budgets: RateBudgetService,
    private readonly keys: RateLimitKeys,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (typeof this.redis.duplicate !== 'function') return;
    const subscriber = this.redis.duplicate();
    this.subscriber = subscriber;
    subscriber.on('error', () => undefined);
    await subscriber.subscribe(CHANNEL).catch(() => undefined);
    subscriber.on('message', (channel, message) => {
      if (channel !== CHANNEL) return;
      const hint = parsePublishedHint(message);
      if (hint) this.broadcast(hint);
    });
  }

  async onModuleDestroy(): Promise<void> {
    for (const clients of this.sockets.values())
      for (const socket of clients) socket.close(1001, 'server shutdown');
    this.server.close();
    try {
      if (this.subscriber?.status === 'ready') await this.subscriber.quit();
    } finally {
      this.subscriber?.disconnect(false);
    }
  }

  attach(httpServer: Server): void {
    if (this.attached) return;
    this.attached = true;
    httpServer.on('upgrade', (request, socket, head) => {
      void this.upgrade(request, socket, head);
    });
  }

  async mintTicket(machineId: string): Promise<{
    ticket: string;
    path: string;
    expiresAt: string;
  }> {
    const ticket = randomBytes(32).toString('base64url');
    const digest = createHash('sha256').update(ticket).digest('hex');
    const result = await this.redis.set(
      `${TICKET_PREFIX}${digest}`,
      machineId,
      'EX',
      TICKET_TTL_SECONDS,
      'NX',
    );
    if (result !== 'OK') throw new Error('Worker hint ticket unavailable');
    return {
      ticket,
      path: SOCKET_PATH,
      expiresAt: new Date(
        Date.now() + TICKET_TTL_SECONDS * 1_000,
      ).toISOString(),
    };
  }

  async publish(type: WorkerHintType, machineId: string | null = null) {
    const hint: PublishedHint = {
      type,
      machineId,
      revision: ++this.revision,
      sentAt: new Date().toISOString(),
    };
    await this.redis.publish(CHANNEL, JSON.stringify(hint));
  }

  private async upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if ((request.url ?? '').split('?', 1)[0] !== SOCKET_PATH) {
      rejectUpgrade(socket, 404);
      return;
    }
    const protocolHeaders = (request.rawHeaders ?? []).filter(
      (value, index) =>
        index % 2 === 0 && value.toLowerCase() === 'sec-websocket-protocol',
    ).length;
    const protocol = request.headers['sec-websocket-protocol'];
    const ticket =
      protocolHeaders === 1 && typeof protocol === 'string'
        ? new RegExp(
            `^${SOCKET_PROTOCOL},\\s*ticket\\.([A-Za-z0-9_-]{43})$`,
            'u',
          ).exec(protocol)?.[1]
        : undefined;
    if (
      request.url !== SOCKET_PATH ||
      request.headers.origin !== undefined ||
      !ticket ||
      request.method !== 'GET'
    ) {
      rejectUpgrade(socket);
      return;
    }
    const ip = workerSocketClientIp(
      request,
      this.config.get('TRUST_PROXY') === '1',
    );
    try {
      const decision = await this.budgets.reserve([
        {
          key: this.keys.bucket('worker-socket-ip', ip),
          limit: 120,
          windowMs: 60_000,
        },
        {
          key: this.keys.bucket('worker-socket-service', 'global'),
          limit: 3_000,
          windowMs: 60_000,
        },
      ]);
      if (!decision.allowed) {
        rejectUpgrade(socket, 429, decision.retryAfterSeconds);
        return;
      }
    } catch {
      rejectUpgrade(socket, 503);
      return;
    }
    const digest = createHash('sha256').update(ticket).digest('hex');
    let machineId: string | null;
    try {
      machineId = await this.redis.getdel(`${TICKET_PREFIX}${digest}`);
    } catch {
      rejectUpgrade(socket, 503);
      return;
    }
    if (!machineId) {
      rejectUpgrade(socket);
      return;
    }
    try {
      const decision = await this.budgets.reserve([
        {
          key: this.keys.bucket('worker-socket-machine', machineId),
          limit: 20,
          windowMs: 60_000,
        },
      ]);
      if (!decision.allowed) {
        rejectUpgrade(socket, 429, decision.retryAfterSeconds);
        return;
      }
    } catch {
      rejectUpgrade(socket, 503);
      return;
    }
    if ((this.sockets.get(machineId)?.size ?? 0) >= MAX_SOCKETS_PER_MACHINE) {
      rejectUpgrade(socket, 429, 30);
      return;
    }
    this.server.handleUpgrade(request, socket, head, (webSocket) =>
      this.accept(machineId!, webSocket),
    );
  }

  private accept(machineId: string, socket: WebSocket): void {
    const clients = this.sockets.get(machineId) ?? new Set<WebSocket>();
    clients.add(socket);
    this.sockets.set(machineId, clients);
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, HEARTBEAT_MS);
    const expiry = setTimeout(
      () => socket.close(1000, 'ticket expired'),
      MAX_SOCKET_AGE_MS,
    );
    socket.on('pong', () => {
      alive = true;
    });
    socket.on('message', () => socket.close(1008, 'receive only'));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearInterval(heartbeat);
      clearTimeout(expiry);
      clients.delete(socket);
      if (clients.size === 0) this.sockets.delete(machineId);
    });
  }

  private broadcast(hint: PublishedHint): void {
    const targets = hint.machineId
      ? (this.sockets.get(hint.machineId) ?? [])
      : [...this.sockets.values()].flatMap((clients) => [...clients]);
    const message = JSON.stringify({
      type: hint.type,
      revision: hint.revision,
      sentAt: hint.sentAt,
    });
    for (const socket of targets)
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }
}

export function workerSocketClientIp(
  request: IncomingMessage,
  trustProxy: boolean,
): string {
  const direct = request.socket.remoteAddress ?? 'unknown';
  if (!trustProxy) return direct;
  // Express `trust proxy = 1` uses the rightmost forwarded address: the peer
  // immediately before our one trusted reverse proxy, including Docker peers.
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string') return direct;
  const last = forwarded.split(',').at(-1)?.trim() ?? '';
  return isIP(last) ? last : direct;
}

function parsePublishedHint(value: string): PublishedHint | null {
  try {
    const parsed = JSON.parse(value) as Partial<PublishedHint>;
    if (
      !WORKER_HINT_TYPES.includes(parsed.type as WorkerHintType) ||
      (parsed.machineId !== null && typeof parsed.machineId !== 'string') ||
      !Number.isSafeInteger(parsed.revision) ||
      typeof parsed.sentAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.sentAt))
    )
      return null;
    return parsed as PublishedHint;
  } catch {
    return null;
  }
}

function rejectUpgrade(
  socket: Duplex,
  status = 401,
  retryAfter?: number,
): void {
  const reason =
    status === 429
      ? 'Too Many Requests'
      : status === 503
        ? 'Service Unavailable'
        : status === 404
          ? 'Not Found'
          : 'Unauthorized';
  const retry =
    status === 429 && retryAfter !== undefined
      ? `Retry-After: ${retryAfter}\r\n`
      : '';
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n${retry}\r\n`,
  );
}

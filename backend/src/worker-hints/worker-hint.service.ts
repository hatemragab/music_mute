import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';
import { SECURITY_REDIS } from '../rate-limits/security-redis.provider.js';

const SOCKET_PATH = '/api/v1/worker/v1/hints/socket';
const CHANNEL = 'musicmute:worker-hints:v1';
const TICKET_PREFIX = 'musicmute:worker-hint-ticket:v1:';
const TICKET_TTL_SECONDS = 30;
const MAX_MESSAGE_BYTES = 1024;

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

  constructor(@Inject(SECURITY_REDIS) private readonly redis: Redis) {}

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
    let url: URL;
    try {
      url = new URL(
        request.url ?? '',
        `http://${request.headers.host ?? 'localhost'}`,
      );
    } catch {
      return;
    }
    if (url.pathname !== SOCKET_PATH) return;
    const ticket = url.searchParams.get('ticket');
    if (
      !ticket ||
      !/^[A-Za-z0-9_-]{43}$/u.test(ticket) ||
      [...url.searchParams.keys()].some((key) => key !== 'ticket') ||
      url.searchParams.getAll('ticket').length !== 1
    ) {
      rejectUpgrade(socket);
      return;
    }
    const digest = createHash('sha256').update(ticket).digest('hex');
    let machineId: string | null;
    try {
      machineId = await this.redis.getdel(`${TICKET_PREFIX}${digest}`);
    } catch {
      rejectUpgrade(socket);
      return;
    }
    if (!machineId) {
      rejectUpgrade(socket);
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
    socket.on('message', () => socket.close(1008, 'receive only'));
    socket.on('error', () => undefined);
    socket.on('close', () => {
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

function rejectUpgrade(socket: Duplex): void {
  socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
}

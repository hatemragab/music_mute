import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { registerWebSocketUpgrade } from '../http/websocket-upgrades.js';
import { responseValue } from '../http/snake-case-wire.js';
import { RateBudgetService } from '../rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../rate-limits/rate-limit-keys.js';
import { SECURITY_REDIS } from '../rate-limits/security-redis.provider.js';
import { RealtimeFeedService } from '../realtime/realtime-feed.service.js';
import { workerSocketClientIp } from '../worker-hints/worker-hint.service.js';
import { YouTubeCommunityService } from './youtube-community.service.js';

export const YOUTUBE_COMMUNITY_REALTIME_PATH = '/youtube-community-realtime';
const RESERVE = `
for i,key in ipairs(KEYS) do
  redis.call('ZREMRANGEBYSCORE', key, '-inf', ARGV[1])
  if redis.call('ZCARD', key) >= tonumber(ARGV[i+3]) then return 0 end
end
for _,key in ipairs(KEYS) do
  redis.call('ZADD', key, ARGV[2], ARGV[3])
  redis.call('EXPIRE', key, 90)
end
return 1`;
const RENEW = `
for _,key in ipairs(KEYS) do
  if not redis.call('ZSCORE', key, ARGV[2]) then return 0 end
end
for _,key in ipairs(KEYS) do
  redis.call('ZADD', key, 'XX', ARGV[1], ARGV[2])
  redis.call('EXPIRE', key, 90)
end
return 1`;
interface Client {
  socket: WebSocket;
  token: string;
  videoId: string;
  ip: string;
  leaseId: string;
  leaseKeys: string[];
  sequence: number;
  dirty: boolean;
  reading: boolean;
  alive: boolean;
  checking: boolean;
  expiry?: NodeJS.Timeout;
}
const watched = new Set([
  'youtube_contributions',
  'youtube_contribution_leases',
  'shared_media_sources',
  'shared_media_results',
  'youtube_guest_sessions',
]);

/** Guest scopes expose only one public YouTube asset's complete state snapshot. */
@Injectable()
export class YouTubeCommunitySocketService implements OnModuleDestroy {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: 2048,
    perMessageDeflate: false,
  });
  private readonly clients = new Set<Client>();
  private readonly pending = new Set<WebSocket>();
  private detach?: () => void;
  private unsubscribe?: () => void;
  private heartbeat?: NodeJS.Timeout;
  constructor(
    private readonly community: YouTubeCommunityService,
    private readonly feed: RealtimeFeedService,
    private readonly budgets: RateBudgetService,
    private readonly keys: RateLimitKeys,
    private readonly config: ConfigService,
    @Inject(SECURITY_REDIS) private readonly redis: Redis,
  ) {}

  attach(server: Server): void {
    if (this.detach) return;
    this.detach = registerWebSocketUpgrade(
      server,
      YOUTUBE_COMMUNITY_REALTIME_PATH,
      (request, socket, head) => this.upgrade(request, socket, head),
    );
    this.unsubscribe = this.feed.subscribe((event) => {
      if (!event.healthy) {
        for (const socket of this.pending)
          socket.close(1013, 'Feed unavailable');
        for (const client of this.clients)
          client.socket.close(1013, 'Feed unavailable');
      } else if (!event.collection || watched.has(event.collection)) {
        for (const client of this.clients) this.invalidate(client);
      }
    });
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) void this.check(client);
    }, 30_000);
    this.heartbeat.unref();
  }
  private async upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const ip = workerSocketClientIp(
      request,
      this.config.get<string>('TRUST_PROXY') === '1',
    );
    // This channel is consumed by native companions. Browser pages never receive
    // guest bearers; reject query capabilities and browser-origin handshakes.
    if (
      request.url !== YOUTUBE_COMMUNITY_REALTIME_PATH ||
      request.headers.origin ||
      !this.feed.healthy
    ) {
      socket.end(
        'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    const decision = await this.budgets.reserve([
      {
        key: this.keys.bucket('youtube-socket-ip', ip),
        limit: 30,
        windowMs: 60_000,
      },
      {
        key: this.keys.bucket('youtube-socket-global', 'global'),
        limit: 1000,
        windowMs: 60_000,
      },
    ]);
    if (!decision.allowed) {
      socket.end(
        `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${decision.retryAfterSeconds}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      return;
    }
    if (!this.feed.healthy || socket.destroyed) {
      socket.destroy();
      return;
    }
    this.server.handleUpgrade(request, socket, head, (ws) =>
      this.authenticate(ws, ip),
    );
  }
  private authenticate(socket: WebSocket, ip: string): void {
    this.pending.add(socket);
    const deadline = setTimeout(
      () => socket.close(1008, 'Authentication required'),
      5000,
    );
    deadline.unref();
    let authenticating = false;
    let client: Client | undefined;
    socket.on('error', () => socket.close(1011, 'Connection failed'));
    socket.on('close', () => {
      clearTimeout(deadline);
      this.pending.delete(socket);
      if (client) {
        this.clients.delete(client);
        clearTimeout(client.expiry);
        for (const key of client.leaseKeys)
          void this.redis.zrem(key, client.leaseId).catch(() => undefined);
      }
    });
    socket.on('pong', () => {
      if (client) client.alive = true;
    });
    socket.on('message', (data, binary) => {
      if (client || authenticating || binary) {
        socket.close(1008, 'Invalid command');
        return;
      }
      authenticating = true;
      void (async () => {
        const command = JSON.parse(data.toString()) as Record<string, unknown>;
        if (
          !command ||
          typeof command !== 'object' ||
          Array.isArray(command) ||
          Object.keys(command).sort().join(',') !== 'token,type,video_id' ||
          command.type !== 'authenticate' ||
          typeof command.token !== 'string' ||
          typeof command.video_id !== 'string' ||
          !/^[A-Za-z0-9_-]{11}(?![\s\S])/.test(command.video_id)
        )
          throw new Error('Invalid command');
        const guest = await this.community.authenticate(command.token, ip);
        const leaseId = randomUUID();
        const leaseKeys = [
          this.keys.bucket('youtube-sockets-session', String(guest._id)),
          this.keys.bucket('youtube-sockets-ip', ip),
          this.keys.bucket('youtube-sockets-service', 'global'),
        ];
        if (
          Number(
            await this.redis.eval(
              RESERVE,
              leaseKeys.length,
              ...leaseKeys,
              Date.now(),
              Date.now() + 60_000,
              leaseId,
              3,
              20,
              500,
            ),
          ) !== 1
        )
          throw new Error('Connection limit');
        client = {
          socket,
          token: command.token,
          videoId: command.video_id,
          ip,
          leaseId,
          leaseKeys,
          sequence: 0,
          dirty: false,
          reading: false,
          alive: true,
          checking: false,
        };
        clearTimeout(deadline);
        this.pending.delete(socket);
        if (socket.readyState !== WebSocket.OPEN || !this.feed.healthy) {
          for (const key of leaseKeys)
            void this.redis.zrem(key, leaseId).catch(() => undefined);
          socket.close(1013, 'Feed unavailable');
          return;
        }
        this.clients.add(client);
        this.invalidate(client);
      })().catch(() => socket.close(1008, 'Authentication failed'));
    });
  }
  private invalidate(client: Client): void {
    client.dirty = true;
    if (!client.reading) void this.refresh(client);
  }
  private async refresh(client: Client): Promise<void> {
    client.reading = true;
    try {
      let retriedExpiredSnapshot = false;
      while (client.dirty && this.clients.has(client)) {
        client.dirty = false;
        await this.community.authenticate(client.token, undefined, false);
        const value = await this.community.snapshot(client.videoId);
        await this.community.authenticate(client.token, undefined, false);
        if (client.socket.readyState !== WebSocket.OPEN || !this.feed.healthy)
          return;
        const expiresAt = value.expiresAt
          ? new Date(value.expiresAt).getTime()
          : NaN;
        // Authorization can outlast the producer lease. Read its current state
        // again before sending, but fail closed if the source stays expired.
        if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
          if (retriedExpiredSnapshot) throw new Error('Expired snapshot');
          retriedExpiredSnapshot = true;
          client.dirty = true;
          continue;
        }
        retriedExpiredSnapshot = false;
        if (client.socket.bufferedAmount > 64 * 1024) {
          client.socket.close(1013, 'Slow consumer');
          return;
        }
        client.socket.send(
          JSON.stringify({
            type: 'snapshot',
            ...(responseValue(value) as object),
            sequence: ++client.sequence,
          }),
        );
        clearTimeout(client.expiry);
        if (Number.isFinite(expiresAt)) {
          client.expiry = setTimeout(
            () => this.invalidate(client),
            Math.max(1, Math.min(2_147_483_647, expiresAt - Date.now() + 10)),
          );
          client.expiry.unref();
        }
      }
    } catch {
      client.socket.close(1013, 'Snapshot unavailable');
    } finally {
      client.reading = false;
    }
  }
  private async check(client: Client): Promise<void> {
    if (client.checking) return;
    client.checking = true;
    try {
      if (!client.alive || !this.feed.healthy) {
        client.socket.terminate();
        return;
      }
      await this.community.authenticate(client.token, undefined, false);
      if (
        Number(
          await this.redis.eval(
            RENEW,
            client.leaseKeys.length,
            ...client.leaseKeys,
            Date.now() + 60_000,
            client.leaseId,
          ),
        ) !== 1
      )
        throw new Error('Connection lease expired');
      client.alive = false;
      client.socket.ping();
    } catch {
      client.socket.close(1013, 'Session unavailable');
    } finally {
      client.checking = false;
    }
  }
  onModuleDestroy(): void {
    this.detach?.();
    this.unsubscribe?.();
    clearInterval(this.heartbeat);
    for (const socket of this.pending) socket.terminate();
    for (const client of this.clients) client.socket.terminate();
    this.server.close();
  }
}

import {
  HttpException,
  Inject,
  Injectable,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';
import { responseValue } from '../http/snake-case-wire.js';
import { registerWebSocketUpgrade } from '../http/websocket-upgrades.js';
import { RateBudgetService } from '../rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../rate-limits/rate-limit-keys.js';
import { SECURITY_REDIS } from '../rate-limits/security-redis.provider.js';
import { workerSocketClientIp } from '../worker-hints/worker-hint.service.js';
import {
  REALTIME_PATH,
  REALTIME_PROTOCOL,
  RealtimeAuthService,
  type RealtimePrincipal,
} from './realtime-auth.service.js';
import { RealtimeFeedService } from './realtime-feed.service.js';
import {
  parseRealtimeCommand,
  type RealtimeSubscription,
} from './realtime-protocol.js';
import { RealtimeResourcesService } from './realtime-resources.service.js';
import { affectsRealtimeResource } from './realtime-dependencies.js';

interface Subscription {
  request: RealtimeSubscription;
  sequence: number;
  dirty: boolean;
  running: boolean;
  timer?: NodeJS.Timeout;
}
interface Client {
  socket: WebSocket;
  principal: RealtimePrincipal;
  streamId: string;
  leaseKey: string;
  alive: boolean;
  checking: boolean;
  controls: number;
  pendingReads: number;
  subscriptions: Map<string, Subscription>;
}

const RESERVE_CONNECTION = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= 6 then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], 120)
return 1`;

@Injectable()
export class RealtimeSocketService implements OnModuleDestroy {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: 8192,
    perMessageDeflate: false,
    handleProtocols: (protocols) =>
      protocols.has(REALTIME_PROTOCOL) ? REALTIME_PROTOCOL : false,
  });
  private readonly clients = new Set<Client>();
  private detach?: () => void;
  private detachFeed?: () => void;
  private heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly auth: RealtimeAuthService,
    private readonly feed: RealtimeFeedService,
    private readonly resources: RealtimeResourcesService,
    private readonly budgets: RateBudgetService,
    private readonly keys: RateLimitKeys,
    private readonly config: ConfigService,
    @Inject(SECURITY_REDIS) private readonly redis: Redis,
  ) {}

  attach(server: Server): void {
    if (this.detach) return;
    this.detach = registerWebSocketUpgrade(
      server,
      REALTIME_PATH,
      (request, socket, head) => this.upgrade(request, socket, head),
    );
    this.detachFeed = this.feed.subscribe((event) => {
      for (const client of this.clients) {
        if (!event.healthy) {
          client.socket.close(1013, 'updates unavailable');
          continue;
        }
        for (const subscription of client.subscriptions.values())
          if (
            affectsRealtimeResource(
              subscription.request.resource,
              event.collection,
            )
          )
            this.invalidate(client, subscription);
      }
    });
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) void this.check(client);
    }, 30_000);
    this.heartbeat.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.detach?.();
    this.detachFeed?.();
    clearInterval(this.heartbeat);
    for (const client of this.clients) {
      client.socket.terminate();
      this.dispose(client);
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const protocols = request.headers['sec-websocket-protocol'];
    const ticket =
      typeof protocols === 'string'
        ? /^musicmute\.realtime\.v1,\s*ticket\.([A-Za-z0-9_-]{43})$/.exec(
            protocols,
          )?.[1]
        : undefined;
    const headerCount = request.rawHeaders.filter(
      (value, index) =>
        index % 2 === 0 && value.toLowerCase() === 'sec-websocket-protocol',
    ).length;
    if (
      request.url !== REALTIME_PATH ||
      request.method !== 'GET' ||
      !ticket ||
      headerCount !== 1
    ) {
      this.reject(socket, 401);
      return;
    }
    const ip = workerSocketClientIp(
      request,
      this.config.get('TRUST_PROXY') === '1',
    );
    const budget = await this.budgets.reserve([
      { key: this.keys.bucket('realtime-ip', ip), limit: 60, windowMs: 60_000 },
      {
        key: this.keys.bucket('realtime-service', 'global'),
        limit: 3000,
        windowMs: 60_000,
      },
    ]);
    if (!budget.allowed) {
      this.reject(socket, 429);
      return;
    }
    if (!this.feed.healthy) {
      this.reject(socket, 503);
      return;
    }
    let principal: RealtimePrincipal;
    try {
      principal = await this.auth.consume(ticket, request.headers.origin);
    } catch (error) {
      this.reject(
        socket,
        error instanceof HttpException && error.getStatus() < 500 ? 401 : 503,
      );
      return;
    }
    const streamId = randomUUID();
    const leaseKey = this.keys.bucket(
      'realtime-connections',
      `${principal.audience}:${principal.identity.uid}`,
    );
    const reserved = await this.redis.eval(
      RESERVE_CONNECTION,
      1,
      leaseKey,
      Date.now(),
      Date.now() + 90_000,
      streamId,
    );
    if (reserved !== 1) {
      this.reject(socket, 429);
      return;
    }
    if (socket.destroyed || this.clients.size >= 3000) {
      await this.redis.zrem(leaseKey, streamId);
      if (!socket.destroyed) this.reject(socket, 503);
      return;
    }
    try {
      this.server.handleUpgrade(request, socket, head, (ws) => {
        const client: Client = {
          socket: ws,
          principal,
          streamId,
          leaseKey,
          alive: true,
          checking: false,
          controls: 0,
          pendingReads: 0,
          subscriptions: new Map(),
        };
        this.clients.add(client);
        ws.on('error', () => undefined);
        ws.on('pong', () => {
          client.alive = true;
        });
        ws.on('close', () => this.dispose(client));
        ws.on('message', (data, binary) => {
          if (binary || ++client.controls > 120) {
            ws.close(1008, 'invalid request');
            return;
          }
          const command = parseRealtimeCommand(data.toString());
          if (!command) {
            ws.close(1008, 'invalid request');
            return;
          }
          if (command.type === 'pong') {
            client.alive = true;
            return;
          }
          const previous = client.subscriptions.get(command.subscription_id);
          if (command.type === 'unsubscribe') {
            clearTimeout(previous?.timer);
            client.subscriptions.delete(command.subscription_id);
          } else if (command.type === 'resync') {
            if (previous) this.invalidate(client, previous);
          } else {
            if (!previous && client.subscriptions.size >= 16) {
              ws.close(1008, 'subscription limit');
              return;
            }
            clearTimeout(previous?.timer);
            const subscription: Subscription = {
              request: command,
              sequence: 0,
              dirty: true,
              running: false,
            };
            client.subscriptions.set(command.subscription_id, subscription);
            void this.flush(client, subscription);
          }
        });
        this.send(client, {
          type: 'ready',
          stream_id: streamId,
          protocol_version: 1,
          server_time: new Date().toISOString(),
        });
      });
    } catch {
      await this.redis.zrem(leaseKey, streamId);
      this.reject(socket, 503);
    }
  }

  private invalidate(client: Client, subscription: Subscription): void {
    subscription.dirty = true;
    if (subscription.running || subscription.timer) return;
    subscription.timer = setTimeout(() => {
      subscription.timer = undefined;
      void this.flush(client, subscription);
    }, 1000);
  }

  private async flush(
    client: Client,
    subscription: Subscription,
  ): Promise<void> {
    if (subscription.running || !this.current(client, subscription)) return;
    if (client.pendingReads >= 4) {
      this.invalidate(client, subscription);
      return;
    }
    client.pendingReads++;
    subscription.running = true;
    subscription.dirty = false;
    try {
      if (!this.feed.healthy) {
        client.socket.close(1013, 'updates unavailable');
        return;
      }
      await this.auth.validate(client.principal);
      const data = await this.resources.read(
        client.principal,
        subscription.request,
      );
      // Revocation or unsubscribe during the read must fence its response too.
      await this.auth.validate(client.principal);
      if (!this.current(client, subscription)) return;
      this.send(client, {
        type: 'snapshot',
        protocol_version: 1,
        stream_id: client.streamId,
        subscription_id: subscription.request.subscription_id,
        sequence: ++subscription.sequence,
        server_time: new Date().toISOString(),
        data: responseValue(data),
      });
    } catch (error) {
      if (!this.current(client, subscription)) return;
      const status = error instanceof HttpException ? error.getStatus() : 503;
      if (status === 401) {
        client.socket.close(4001, 'session expired');
        return;
      }
      const response =
        error instanceof HttpException ? error.getResponse() : null;
      const code =
        response &&
        typeof response === 'object' &&
        'code' in response &&
        typeof response.code === 'string'
          ? response.code
          : 'SERVICE_UNAVAILABLE';
      this.send(client, {
        type: 'subscription_error',
        stream_id: client.streamId,
        subscription_id: subscription.request.subscription_id,
        status,
        code,
      });
    } finally {
      client.pendingReads--;
      subscription.running = false;
      if (subscription.dirty && this.current(client, subscription))
        this.invalidate(client, subscription);
    }
  }

  private current(client: Client, subscription: Subscription): boolean {
    return (
      this.clients.has(client) &&
      client.socket.readyState === WebSocket.OPEN &&
      client.subscriptions.get(subscription.request.subscription_id) ===
        subscription
    );
  }

  private async check(client: Client): Promise<void> {
    if (client.checking) return;
    if (!client.alive) {
      client.socket.terminate();
      return;
    }
    client.checking = true;
    client.alive = false;
    client.controls = 0;
    try {
      await this.auth.validate(client.principal, true);
      const renewed = await this.redis.zadd(
        client.leaseKey,
        'XX',
        'CH',
        Date.now() + 90_000,
        client.streamId,
      );
      if (!renewed) {
        client.socket.close(1013, 'connection expired');
        return;
      }
      await this.redis.expire(client.leaseKey, 120);
      if (client.socket.readyState !== WebSocket.OPEN) return;
      client.socket.ping();
      this.send(client, {
        type: 'ping',
        server_time: new Date().toISOString(),
      });
      // These projections include wall-clock windows or dependency health, not only DB changes.
      for (const subscription of client.subscriptions.values())
        if (
          [
            'jobs',
            'job',
            'admin.jobs',
            'admin.job',
            'admin.health',
            'admin.overview',
            'admin.recoveries',
            'admin.recovery_summary',
            'admin.workers',
            'admin.worker',
            'usage',
            'policy',
          ].includes(subscription.request.resource)
        )
          this.invalidate(client, subscription);
    } catch (error) {
      client.socket.close(
        error instanceof HttpException && error.getStatus() < 500 ? 4001 : 1013,
        'session unavailable',
      );
    } finally {
      client.checking = false;
    }
  }

  private send(client: Client, value: unknown): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    const message = JSON.stringify(value);
    if (
      Buffer.byteLength(message) > 256 * 1024 ||
      client.socket.bufferedAmount > 1024 * 1024
    ) {
      client.socket.close(1013, 'snapshot capacity exceeded');
      return;
    }
    client.socket.send(message);
  }

  private dispose(client: Client): void {
    if (!this.clients.delete(client)) return;
    for (const subscription of client.subscriptions.values())
      clearTimeout(subscription.timer);
    client.subscriptions.clear();
    void this.redis
      .zrem(client.leaseKey, client.streamId)
      .catch(() => undefined);
  }

  private reject(socket: Duplex, status: number): void {
    if (socket.destroyed || socket.writableEnded) return;
    socket.end(
      `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
}

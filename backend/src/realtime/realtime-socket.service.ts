import {
  HttpException,
  Inject,
  Injectable,
  Logger,
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
import { TERMINAL_JOB_STATUSES } from '../jobs/job-lifecycle-policy.js';
import {
  REALTIME_PATH,
  REALTIME_PROTOCOL,
  RealtimeAuthService,
  type RealtimePrincipal,
} from './realtime-auth.service.js';
import { RealtimeFeedService } from './realtime-feed.service.js';
import {
  parseRealtimeCommand,
  type RealtimeResource,
  type RealtimeSubscription,
} from './realtime-protocol.js';
import { RealtimeResourcesService } from './realtime-resources.service.js';
import { affectsRealtimeResource } from './realtime-dependencies.js';
import { RealtimeSocketMetrics } from './realtime-socket-metrics.js';

interface Subscription {
  request: RealtimeSubscription;
  sequence: number;
  dirty: boolean;
  running: boolean;
  waitingForRead?: boolean;
  refreshOnHeartbeat: boolean;
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

const HEARTBEAT_REFRESH_RESOURCES = new Set<RealtimeResource>([
  // These views change from elapsed time or live probes even without a database write.
  'usage',
  'admin.overview',
  'admin.health',
  'admin.workers',
  'admin.worker',
  'admin.recoveries',
  'admin.recovery_summary',
]);

const JOB_RESOURCES = new Set<RealtimeResource>([
  'jobs',
  'job',
  'admin.jobs',
  'admin.job',
]);

function isTerminalJob(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('status' in value)) return false;
  return TERMINAL_JOB_STATUSES.includes(
    (value as { status: (typeof TERMINAL_JOB_STATUSES)[number] }).status,
  );
}

export function refreshesOnHeartbeat(
  resource: RealtimeResource,
  data?: unknown,
): boolean {
  if (HEARTBEAT_REFRESH_RESOURCES.has(resource)) return true;
  if (!JOB_RESOURCES.has(resource)) return false;
  if (data === undefined) return true;
  if (resource === 'jobs' || resource === 'admin.jobs') {
    if (!data || typeof data !== 'object' || !('items' in data)) return true;
    const items = (data as { items?: unknown }).items;
    return !Array.isArray(items) || items.some((item) => !isTerminalJob(item));
  }
  return !isTerminalJob(data);
}

@Injectable()
export class RealtimeSocketService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeSocketService.name);
  private readonly metrics = new RealtimeSocketMetrics();
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
  private metricsTimer?: NodeJS.Timeout;

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
    this.metricsTimer = setInterval(() => this.reportMetrics(), 60_000);
    this.metricsTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.detach?.();
    this.detachFeed?.();
    clearInterval(this.heartbeat);
    clearInterval(this.metricsTimer);
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
        this.metrics.accepted();
        ws.on('error', () => undefined);
        ws.on('pong', () => {
          client.alive = true;
        });
        ws.on('close', (code) => {
          this.metrics.closed(code);
          this.dispose(client);
        });
        ws.on('message', (data, binary) => {
          if (binary || ++client.controls > 512) {
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
            if (!previous && client.subscriptions.size >= 128) {
              ws.close(1008, 'subscription limit');
              return;
            }
            clearTimeout(previous?.timer);
            const subscription: Subscription = {
              request: command,
              sequence: 0,
              dirty: true,
              running: false,
              refreshOnHeartbeat: refreshesOnHeartbeat(command.resource),
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
    if (
      subscription.running ||
      subscription.timer ||
      subscription.waitingForRead
    )
      return;
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
      subscription.waitingForRead = true;
      return;
    }
    subscription.waitingForRead = false;
    client.pendingReads++;
    subscription.running = true;
    subscription.dirty = false;
    const startedAt = Date.now();
    let readFailed = true;
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
      readFailed = false;
      if (!this.current(client, subscription)) return;
      subscription.refreshOnHeartbeat = refreshesOnHeartbeat(
        subscription.request.resource,
        data,
      );
      this.send(
        client,
        {
          type: 'snapshot',
          protocol_version: 1,
          stream_id: client.streamId,
          subscription_id: subscription.request.subscription_id,
          sequence: ++subscription.sequence,
          server_time: new Date().toISOString(),
          data: responseValue(data),
        },
        true,
      );
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
      this.metrics.read(Date.now() - startedAt, readFailed);
      client.pendingReads--;
      subscription.running = false;
      if (subscription.dirty && this.current(client, subscription))
        this.invalidate(client, subscription);
      // Drain cold subscriptions without a one-second pause per batch of four.
      // Reads remain bounded; committed change invalidations still coalesce.
      for (const pending of client.subscriptions.values()) {
        if (client.pendingReads >= 4) break;
        if (pending.waitingForRead) void this.flush(client, pending);
      }
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
      for (const subscription of client.subscriptions.values())
        if (subscription.refreshOnHeartbeat)
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

  private send(client: Client, value: unknown, snapshot = false): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    const message = JSON.stringify(value);
    const bytes = Buffer.byteLength(message);
    if (bytes > 256 * 1024 || client.socket.bufferedAmount > 1024 * 1024) {
      client.socket.close(1013, 'snapshot capacity exceeded');
      return;
    }
    this.metrics.sent(bytes, client.socket.bufferedAmount, snapshot);
    client.socket.send(message);
  }

  private reportMetrics(): void {
    this.logger.log(this.metrics.drain(this.clients.size));
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
    this.metrics.rejected(status);
    socket.end(
      `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
}

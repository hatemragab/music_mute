import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { ConfigService } from '@nestjs/config';
import { fatalDiagnostic } from './fatal-errors.js';

export interface DiagnosticContext {
  requestId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  userId?: string;
  jobId?: string;
  importId?: string;
  streamId?: string;
}

type Level = 'debug' | 'info' | 'warn' | 'error';
export interface DiagnosticEvent extends DiagnosticContext {
  category: string;
  name: string;
  summary: string;
  level?: Level;
  operation?: string;
  phase?: string;
  result?: string;
  status?: number | string;
  durationMs?: number;
  method?: string;
  route?: string;
  aborted?: boolean;
  data?: unknown;
}

interface Settings {
  enabled: boolean;
  payloads: boolean;
  console: boolean;
  endpoint: string;
  key: string;
  captureId?: string;
}

const sensitiveKey =
  /password|passwd|passphrase|secret|token|authorization|cookie|api.?key|credential|private.?key|client.?secret|signed.?url|connection.?string|mongodb.?uri|redis.?url|ticket|bearer|session.?id|access.?key|verification.?code|reset.?code|recovery.?code|otp|totp|nonce|capability|signature/i;
const safeHeaderNames = new Set([
  'content-type',
  'content-length',
  'accept',
  'origin',
  'x-request-id',
]);
const omitted = (reason: string) => ({ $omitted: reason });
const enabled = (value: unknown) =>
  value === true || value === '1' || value === 'true';

/** Arbitrary error text is excluded; repository-owned sanitized code locations remain. */
export function diagnosticError(error: unknown): Record<string, unknown> {
  const candidate = error && typeof error === 'object' ? error : {};
  const value = candidate as Record<string, unknown>;
  return {
    name:
      typeof value.name === 'string' &&
      /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(value.name)
        ? value.name
        : 'Error',
    ...(typeof value.code === 'number' ||
    (typeof value.code === 'string' &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code))
      ? { code: value.code }
      : {}),
    ...('errorLabels' in candidate && Array.isArray(value.errorLabels)
      ? {
          labels: value.errorLabels
            .filter(
              (label): label is string =>
                typeof label === 'string' && /^[A-Za-z]{1,64}$/.test(label),
            )
            .slice(0, 8),
        }
      : {}),
    message: omitted('error-message-and-stack'),
    frames: fatalDiagnostic(error, 'uncaughtException').frames,
  };
}

function redactText(input: string): string | Record<string, string> {
  if (input.length > 8192) return omitted('string-limit');
  if (/-----BEGIN [\w ]*PRIVATE KEY-----/.test(input)) return '[REDACTED]';
  // Encoded JWTs and credential assignments can also appear in nested JSON strings.
  let value = input
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[REDACTED]')
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g,
      '[REDACTED]',
    )
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi,
      '$1=[REDACTED]',
    );
  value = value.replace(
    /\b(?:https?|wss?|mongodb(?:\+srv)?|rediss?):\/\/[^\s"<>]+/gi,
    (url) => {
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol))
          return '[REDACTED_CONNECTION]';
        parsed.username = '';
        parsed.password = '';
        // Signed grants can use arbitrary parameter names. Retain only parameter names.
        for (const key of parsed.searchParams.keys())
          parsed.searchParams.set(key, '[REDACTED]');
        parsed.hash = '';
        return parsed.toString();
      } catch {
        return '[REDACTED_URL]';
      }
    },
  );
  return value;
}

/** Single bounded redaction boundary used before network or console output. */
export function redactDiagnostic(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let remaining = 1200;
  const visit = (item: unknown, depth: number): unknown => {
    if (--remaining < 0) return omitted('node-limit');
    if (depth > 8) return omitted('depth-limit');
    if (item == null || typeof item === 'boolean') return item;
    if (typeof item === 'number')
      return Number.isFinite(item) ? item : String(item);
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.length <= 8192 && /^[[{]/.test(trimmed)) {
        try {
          return visit(JSON.parse(trimmed), depth + 1);
        } catch {
          /* Plain text. */
        }
      }
      // Decode only bounded base64 JSON. Other opaque encoded content is omitted.
      if (
        trimmed.length >= 24 &&
        trimmed.length <= 8192 &&
        /^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)
      ) {
        try {
          const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
          if (/^[[{]/.test(decoded.trim()))
            return {
              $encoding: 'base64-json',
              value: visit(JSON.parse(decoded), depth + 1),
            };
        } catch {
          /* Not supported JSON. */
        }
        if (trimmed.length > 128) return omitted('opaque-encoded-string');
      }
      return redactText(item);
    }
    if (typeof item !== 'object') return omitted('unsupported-type');
    if (item instanceof Error) return diagnosticError(item);
    if (item instanceof Date)
      return Number.isNaN(item.getTime())
        ? omitted('invalid-date')
        : item.toISOString();
    if (Buffer.isBuffer(item) || ArrayBuffer.isView(item))
      return { $omitted: 'binary', bytes: item.byteLength };
    if (seen.has(item)) return omitted('circular-reference');
    seen.add(item);
    // Preserve readable BSON scalar types without serializing BSON internal buffers.
    const scalar = item as {
      _bsontype?: unknown;
      toHexString?: () => string;
      toString?: () => string;
    };
    if (
      scalar._bsontype === 'ObjectId' &&
      typeof scalar.toHexString === 'function'
    )
      return scalar.toHexString();
    if (
      ['Long', 'Decimal128', 'Int32', 'Double'].includes(
        String(scalar._bsontype),
      )
    )
      return { $bsonType: scalar._bsontype, value: redactText(String(item)) };
    if (Array.isArray(item)) {
      const result = item.slice(0, 100).map((entry) => visit(entry, depth + 1));
      if (item.length > 100)
        result.push({ $omitted: 'array-limit', count: item.length - 100 });
      return result;
    }
    const result: Record<string, unknown> = {};
    let count = 0;
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(item),
    )) {
      if (++count > 100) {
        result.$omitted = 'object-key-limit';
        break;
      }
      // Never invoke getters/toJSON while observing a business object.
      const redactedKey = key.length > 256 ? '[omitted-key]' : redactText(key);
      const safeKey =
        typeof redactedKey === 'string' ? redactedKey : '[omitted-key]';
      if (
        safeKey === '__proto__' ||
        safeKey === 'constructor' ||
        safeKey === 'prototype'
      )
        continue;
      result[safeKey] = sensitiveKey.test(key)
        ? '[REDACTED]'
        : 'value' in descriptor
          ? visit(descriptor.value, depth + 1)
          : omitted('accessor');
    }
    return result;
  };
  try {
    return visit(value, 0);
  } catch {
    return omitted('redaction-failed');
  }
}

export function diagnosticHeaders(headers: Record<string, unknown>): unknown {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      safeHeaderNames.has(key.toLowerCase())
        ? value
        : omitted('header-not-allowlisted'),
    ]),
  );
}

export class LocalDiagnostics {
  readonly context = new AsyncLocalStorage<DiagnosticContext>();
  readonly instanceId = randomUUID();
  private settings: Settings = {
    enabled: false,
    payloads: false,
    console: false,
    endpoint: '',
    key: '',
  };
  private queue: { body: string; level: Level; attempts: number }[] = [];
  private active = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private lastDeliveredAt: string | null = null;
  private dropped = 0;
  private failed = 0;
  private delivered = 0;

  constructor(private readonly deliver = deliverToCollector) {}

  configure(config: Pick<ConfigService, 'get'>): void {
    const local =
      config.get('APP_ENV') === 'local' &&
      config.get('NODE_ENV') === 'development';
    const endpoint =
      config.get<string>('MUSICMUTE_LOG_ENDPOINT') ??
      'http://127.0.0.1:19740/ingest/backend';
    let safeEndpoint = false;
    try {
      const url = new URL(endpoint);
      safeEndpoint =
        url.protocol === 'http:' &&
        url.hostname === '127.0.0.1' &&
        url.pathname === '/ingest/backend' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash;
    } catch {
      /* Invalid settings disable capture. */
    }
    this.settings = {
      enabled:
        local && enabled(config.get('MUSICMUTE_LOG_ENABLED')) && safeEndpoint,
      payloads: local && enabled(config.get('MUSICMUTE_LOG_PAYLOADS')),
      console: local && enabled(config.get('MUSICMUTE_LOG_CONSOLE')),
      endpoint,
      key: config.get<string>('MUSICMUTE_LOG_KEY') ?? '',
      captureId: config.get<string>('MUSICMUTE_LOG_CAPTURE_ID'),
    };
    if (!this.settings.enabled) this.queue = [];
  }

  get isEnabled(): boolean {
    return this.settings.enabled;
  }
  snapshot(value: unknown): unknown {
    return this.settings.payloads
      ? redactDiagnostic(value)
      : omitted('payload-capture-disabled');
  }
  run<T>(context: DiagnosticContext, operation: () => T): T {
    return this.context.run(
      { ...this.context.getStore(), ...context },
      operation,
    );
  }
  status() {
    return {
      enabled: this.isEnabled,
      pending: this.queue.length,
      active: this.active,
      dropped: this.dropped,
      failed: this.failed,
      delivered: this.delivered,
      lastDeliveredAt: this.lastDeliveredAt,
    };
  }

  event(event: DiagnosticEvent): void {
    if (!this.settings.enabled) return;
    try {
      const level = event.level ?? 'info';
      const record = {
        ...this.context.getStore(),
        ...event,
        level,
        timestamp: new Date().toISOString(),
        timestampSource: 'application',
        source: 'backend',
        origin: 'application',
        service: 'musicmute-api',
        instanceId: this.instanceId,
        ...(this.settings.captureId
          ? { captureId: this.settings.captureId }
          : {}),
      };
      let body = JSON.stringify(redactDiagnostic(record));
      if (Buffer.byteLength(body) > 48 * 1024)
        body = JSON.stringify(
          redactDiagnostic({ ...record, data: omitted('record-byte-limit') }),
        );
      if (Buffer.byteLength(body) > 48 * 1024) {
        this.dropped++;
        return;
      }
      if (this.settings.console) {
        // A write is best effort; never hold up application work for a terminal pipe.
        if (!process.stdout.writableNeedDrain)
          process.stdout.write(`${body}\n`);
      }
      if (this.queue.length >= 256) {
        if (level === 'warn' || level === 'error') {
          const index = this.queue.findIndex(
            (entry) => entry.level !== 'warn' && entry.level !== 'error',
          );
          if (index < 0) {
            this.dropped++;
            return;
          }
          this.queue.splice(index, 1);
        } else {
          this.dropped++;
          return;
        }
        this.dropped++;
      }
      this.queue.push({ body, level, attempts: 0 });
      this.pump();
    } catch {
      this.dropped++;
    }
  }

  private pump(): void {
    if (this.retryTimer || !this.isEnabled) return;
    while (this.active < 2 && this.queue.length) {
      const entry = this.queue.shift()!;
      this.active++;
      void this.deliver(this.settings.endpoint, this.settings.key, entry.body)
        .then(
          () => {
            this.delivered++;
            this.lastDeliveredAt = new Date().toISOString();
          },
          () => {
            this.failed++;
            if (++entry.attempts < 3 && this.queue.length < 256)
              this.queue.unshift(entry);
            else this.dropped++;
            if (!this.retryTimer) {
              this.retryTimer = setTimeout(() => {
                this.retryTimer = undefined;
                this.pump();
              }, 500);
              this.retryTimer.unref();
            }
          },
        )
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}

function deliverToCollector(
  endpoint: string,
  key: string,
  body: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      endpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-musicmute-log-key': key,
        },
      },
      (response) => {
        response.resume();
        if (
          response.statusCode &&
          response.statusCode >= 200 &&
          response.statusCode < 300
        )
          resolve();
        else reject(new Error('Collector rejected record'));
      },
    );
    request.setTimeout(1000, () =>
      request.destroy(new Error('Collector timed out')),
    );
    request.on('error', reject);
    request.end(body);
  });
}

export const localDiagnostics = new LocalDiagnostics();

import { subscribe } from 'node:diagnostics_channel';
import { randomUUID } from 'node:crypto';
import type { ClientRequest, IncomingMessage } from 'node:http';
import {
  diagnosticError,
  diagnosticHeaders,
  localDiagnostics,
  type DiagnosticContext,
} from './local-diagnostics.js';

type Observation = {
  started: number;
  context: DiagnosticContext;
  spanId: string;
  method?: string;
  target?: string;
};
let installed = false;

/** Native diagnostics channels leave request/response streams untouched. */
export function installLocalOutboundDiagnostics(): void {
  if (installed || !localDiagnostics.isEnabled) return;
  installed = true;
  const pending = new WeakMap<object, Observation>();
  const observe = (
    name: string,
    listener: (message: Record<string, unknown>) => void,
  ) =>
    subscribe(name, (message) => {
      // Channel subscribers must never throw: Node otherwise reports an uncaught exception.
      try {
        if (
          localDiagnostics.isEnabled &&
          message &&
          typeof message === 'object'
        )
          listener(message as Record<string, unknown>);
      } catch {
        /* Logging is best effort. */
      }
    });
  const begin = (request: object, method?: string, target?: string) =>
    pending.set(request, {
      started: performance.now(),
      context: { ...localDiagnostics.context.getStore() },
      spanId: randomUUID(),
      method,
      target,
    });
  const complete = (request: object, status?: number, error?: unknown) => {
    const entry = pending.get(request);
    if (!entry) return;
    pending.delete(request);
    localDiagnostics.event({
      ...entry.context,
      spanId: entry.spanId,
      category: 'http-client',
      name: 'http-client.request',
      summary: 'Outbound HTTP client observation',
      operation: entry.method,
      phase: 'completed',
      result:
        error || (status && status >= 400) ? 'failed' : 'response-received',
      level: error || (status && status >= 500) ? 'error' : 'debug',
      status,
      durationMs: Math.round((performance.now() - entry.started) * 100) / 100,
      data: {
        target: entry.target,
        requestBody: { $omitted: 'outbound-stream-not-inspected' },
        responseBody: { $omitted: 'outbound-stream-not-inspected' },
        ...(error ? { error: diagnosticError(error) } : {}),
      },
    });
  };
  observe('undici:request:create', ({ request }) => {
    const value = request as {
      method?: string;
      origin?: string;
      path?: string;
    };
    begin(value, value.method, `${value.origin ?? ''}${value.path ?? ''}`);
  });
  observe('undici:request:headers', ({ request, response }) =>
    complete(
      request as object,
      (response as { statusCode?: number }).statusCode,
    ),
  );
  observe('undici:request:error', ({ request, error }) =>
    complete(request as object, undefined, error),
  );
  observe('http.client.request.start', ({ request }) => {
    const value = request as ClientRequest;
    // Diagnostics delivery uses native HTTP; exclude it to prevent a capture loop.
    if (value.getHeader('x-musicmute-log-key') !== undefined) return;
    begin(value, value.method, `${value.protocol}//${value.host}${value.path}`);
    localDiagnostics.event({
      category: 'http-client',
      name: 'http-client.started',
      summary: 'Outbound HTTP client request started',
      operation: value.method,
      phase: 'started',
      data: { headers: diagnosticHeaders(value.getHeaders()) },
    });
  });
  observe('http.client.response.finish', ({ request, response }) =>
    complete(request as object, (response as IncomingMessage).statusCode),
  );
  observe('http.client.request.error', ({ request, error }) =>
    complete(request as object, undefined, error),
  );
}

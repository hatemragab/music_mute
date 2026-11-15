/** Local development diagnostics. Kept self-contained for independent component packages. */
export interface LocalLogOptions {
  enabled: boolean;
  source: string;
  endpoint: string;
  key?: string;
  payloads?: boolean;
  console?: boolean;
  context?: () => Record<string, unknown>;
}
export interface LocalLogStatus {
  source: string;
  instanceId: string;
  payloads: boolean;
  enabled: boolean;
  pending: number;
  delivered: number;
  dropped: number;
  failed: number;
  omitted: number;
  lastDeliveredAt?: string;
}
const SECRET =
  /password|passwd|passphrase|secret|token|authorization|authentication|^auth$|bearer|capability|cookie|api.?key|credential|private.?key|connection.?string|signed.?url|media.?url|upload.?url|download.?url|ticket|signature|email/i;
const OMIT = (reason: string) => ({ omitted: reason });
function text(value: string): string {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value)) return "[REDACTED]";
  return value
    .slice(0, 4096)
    .replace(
      /(?:mongodb(?:\+srv)?|redis(?:s)?|mysql|postgres(?:ql)?):\/\/[^\s"'<>]+/gi,
      "[REDACTED_CONNECTION]",
    )
    .replace(/(?:Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]+/gi, "[REDACTED_AUTH]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      "[REDACTED_JWT]",
    )
    .replace(
      /((?:password|secret|token|api[_-]?key|authorization|cookie|signature)\s*[=:]\s*)[^\s&,;"'<>]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, (candidate) => {
      try {
        const url = new URL(candidate);
        const privateUrl = [...url.searchParams.keys()].some(
          (key) => SECRET.test(key) || /^x-amz-/i.test(key),
        );
        if (privateUrl) return `${url.protocol}//${url.host}/[REDACTED_URL]`;
        url.username = "";
        url.password = "";
        url.hash = "";
        for (const key of url.searchParams.keys())
          url.searchParams.set(key, "[REDACTED]");
        return url.href;
      } catch {
        return "[REDACTED_URL]";
      }
    });
}
export function redactLocalLog(value: unknown): unknown {
  let nodes = 0;
  const seen = new WeakSet<object>();
  function walk(item: unknown, depth: number, hint = ""): unknown {
    if (++nodes > 512) return OMIT("node_limit");
    if (depth > 6) return OMIT("depth_limit");
    if (item == null || typeof item === "boolean") return item;
    if (typeof item === "number")
      return Number.isFinite(item) ? item : String(item);
    if (typeof item === "bigint") return item.toString();
    if (typeof item === "string") {
      if (/^\s*(?:\[|{)/.test(item)) {
        if (item.length > 32 * 1024) return OMIT("encoded_payload_byte_limit");
        try {
          return walk(JSON.parse(item) as unknown, depth + 1);
        } catch {
          return OMIT("unparsed_structured_string");
        }
      }
      if (item.length <= 32 * 1024 && /^[A-Za-z0-9+/=_-]{16,}$/.test(item)) {
        try {
          const decoded = atob(item.replace(/-/g, "+").replace(/_/g, "/"));
          if (/^\s*(?:\[|{)/.test(decoded))
            return walk(JSON.parse(decoded) as unknown, depth + 1);
          if (
            /(?:base64|encoded)/i.test(hint) ||
            /(?:password|token|secret|cookie|authorization|private.key)/i.test(
              decoded,
            )
          )
            return OMIT("encoded_payload");
        } catch {
          if (/(?:base64|encoded)/i.test(hint)) return OMIT("encoded_payload");
        }
      }
      if (item.length > 4096)
        return { omitted: "string_limit", originalLength: item.length };
      return text(item);
    }
    if (typeof item !== "object") return OMIT("unsupported_type");
    if (item instanceof Error) {
      return {
        name: /^[A-Za-z][A-Za-z0-9]*$/.test(item.name) ? item.name : "Error",
        omitted: "untrusted_error_message_and_stack",
      };
    }
    if (item instanceof Date)
      return Number.isFinite(item.getTime())
        ? item.toISOString()
        : OMIT("invalid_date");
    if (seen.has(item)) return OMIT("circular_reference");
    seen.add(item);
    if (Array.isArray(item)) {
      const result = item.slice(0, 64).map((entry) => walk(entry, depth + 1));
      if (item.length > 64) result.push(OMIT("array_limit"));
      return result;
    }
    if (
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      return OMIT("unsupported_object");
    const result: Record<string, unknown> = Object.create(null);
    const keys = Object.keys(item);
    for (const key of keys.slice(0, 64)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      result[text(key).slice(0, 128)] = SECRET.test(key)
        ? "[REDACTED]"
        : descriptor && "value" in descriptor
          ? walk(descriptor.value, depth + 1, key)
          : OMIT("accessor");
    }
    if (keys.length > 64) result._omitted = "object_field_limit";
    return result;
  }
  try {
    return walk(value, 0);
  } catch {
    return OMIT("redaction_failed");
  }
}
export function safeLocalHeaders(
  headers: RequestInit["headers"] | undefined,
): Record<string, string> {
  const output: Record<string, string> = {};
  try {
    new Headers(headers).forEach((value, key) => {
      if (
        /^(?:content-type|content-length|accept|x-request-id|x-trace-id|retry-after|range|content-range)$/.test(
          key,
        )
      )
        output[key] = text(value);
    });
  } catch {
    output.omitted = "invalid_headers";
  }
  return output;
}
export function createLocalLogger(options: LocalLogOptions) {
  const instanceId = globalThis.crypto.randomUUID();
  const status: LocalLogStatus = {
    source: options.source,
    instanceId,
    payloads: options.payloads === true,
    enabled: options.enabled,
    pending: 0,
    delivered: 0,
    dropped: 0,
    failed: 0,
    omitted: 0,
  };
  function safeContext(): Record<string, unknown> {
    try {
      const context = redactLocalLog(options.context?.() ?? {});
      return context && typeof context === "object" && !Array.isArray(context)
        ? (context as Record<string, unknown>)
        : {};
    } catch {
      status.failed++;
      return {};
    }
  }
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    endpoint = new URL("http://127.0.0.1:19740");
    status.enabled = false;
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["/", "/ingest", "/ingest/", `/ingest/${options.source}`].includes(
      endpoint.pathname,
    )
  )
    status.enabled = false;
  const transport = globalThis.fetch.bind(globalThis);
  const queue: { body: string; urgent: boolean }[] = [];
  let active = 0;
  let stopped = false;
  function pump(): void {
    if (stopped) return;
    while (active < 2 && queue.length) {
      const entry = queue.shift()!;
      active++;
      status.pending = queue.length + active;
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (options.key) headers["x-musicmute-log-key"] = options.key;
      void transport(`${endpoint.origin}/ingest/${options.source}`, {
        method: "POST",
        headers,
        body: entry.body,
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(2000),
      })
        .then((response) => {
          if (!response.ok) throw new Error("LOG_INGRESS_REJECTED");
          status.delivered++;
          status.lastDeliveredAt = new Date().toISOString();
          void response.body?.cancel().catch(() => {});
        })
        .catch(() => {
          status.failed++;
        })
        .finally(() => {
          active--;
          status.pending = queue.length + active;
          pump();
        });
    }
  }
  function emit(
    name: string,
    data?: unknown,
    level = "info",
    fields: Record<string, unknown> = {},
  ): void {
    if (!status.enabled || stopped) return;
    try {
      // Rejection/caught values may be opaque credentials with no redaction
      // markers. Retain only Error's existing allowlisted name projection.
      const untrustedRuntimeReason =
        /^runtime\.(?:error|rejection|caught|uncaught)$/.test(name) &&
        !(data instanceof Error);
      const eventData = untrustedRuntimeReason
        ? { omitted: "untrusted_rejection_reason", type: typeof data }
        : data;
      if (untrustedRuntimeReason) status.omitted++;
      const envelope = {
        timestamp: new Date().toISOString(),
        timestampSource: "event",
        source: options.source,
        origin: "application",
        instanceId,
        level,
        category: name.split(".")[0],
        name,
        summary: name,
        ...safeContext(),
        ...(redactLocalLog(fields) as Record<string, unknown>),
        data: options.payloads
          ? redactLocalLog(eventData)
          : OMIT("payload_capture_disabled"),
      };
      let body = JSON.stringify(envelope);
      if (new TextEncoder().encode(body).length > 48 * 1024) {
        status.omitted++;
        body = JSON.stringify({ ...envelope, data: OMIT("record_byte_limit") });
      }
      if (new TextEncoder().encode(body).length > 48 * 1024) {
        status.omitted++;
        body = JSON.stringify({
          timestamp: envelope.timestamp,
          timestampSource: "event",
          source: options.source,
          origin: "application",
          instanceId,
          level,
          name: "diagnostic.oversized",
          category: "diagnostic",
          summary: "Oversized diagnostic metadata omitted",
          data: OMIT("record_byte_limit"),
        });
      }
      if (options.console)
        console.info(
          `[${options.source}] ${level} ${name}`,
          redactLocalLog(fields),
        );
      const urgent = level === "error" || level === "warn";
      if (queue.length >= 64) {
        const victim = urgent ? queue.findIndex((entry) => !entry.urgent) : -1;
        status.dropped++;
        if (victim < 0) return;
        queue.splice(victim, 1);
      }
      queue.push({ body, urgent });
      status.pending = queue.length + active;
      pump();
    } catch {
      status.failed++;
    }
  }
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (!status.enabled) return transport(input, init);
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(`${endpoint.origin}/`)) return transport(input, init);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method.toUpperCase() === "OPTIONS") return transport(input, init);
    const started = performance.now();
    const operationId =
      safeContext().operationId ?? globalThis.crypto.randomUUID();
    const fields = {
      operationId,
      operation: method,
      url: text(url),
      requestHeaders: safeLocalHeaders(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      ),
    };
    emit(
      "http.request",
      {
        body:
          typeof init?.body === "string"
            ? init.body
            : init?.body == null
              ? undefined
              : OMIT("binary_upload_or_stream"),
      },
      "debug",
      fields,
    );
    try {
      const response = await transport(input, init);
      const completed = {
        ...fields,
        status: response.status,
        result: response.ok ? "success" : "failure",
        requestId: response.headers.get("x-request-id") ?? undefined,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        responseHeaders: safeLocalHeaders(response.headers),
        phase: "headers_received",
      };
      emit(
        "http.response",
        OMIT("body_observed_only_on_existing_json_or_text_consumption"),
        response.ok ? "info" : "warn",
        completed,
      );
      // Observe the application's existing consumption. Never clone/read/tee a
      // response just for logging, especially uploads, streams and media bytes.
      try {
        const parseJson = response.json.bind(response);
        Object.defineProperty(response, "json", {
          configurable: true,
          writable: true,
          value: async () => {
            try {
              const value: unknown = await parseJson();
              emit("http.payload", { response: value }, "debug", {
                ...completed,
                phase: "body_consumed",
              });
              return value;
            } catch (error) {
              emit("http.body_failed", error, "error", {
                ...completed,
                phase: "body_failed",
                result: "failure",
              });
              throw error;
            }
          },
        });
        const parseText = response.text.bind(response);
        Object.defineProperty(response, "text", {
          configurable: true,
          writable: true,
          value: async () => {
            try {
              const value = await parseText();
              const json = /^application\/(?:[a-z0-9.-]+\+)?json(?:;|$)/i.test(
                response.headers.get("content-type") ?? "",
              );
              emit(
                "http.payload",
                { response: json ? value : OMIT("non_json_body") },
                "debug",
                { ...completed, phase: "body_consumed" },
              );
              return value;
            } catch (error) {
              emit("http.body_failed", error, "error", {
                ...completed,
                phase: "body_failed",
                result: "failure",
              });
              throw error;
            }
          },
        });
      } catch {
        status.omitted++;
        emit(
          "http.payload",
          OMIT("response_consumer_not_observable"),
          "debug",
          completed,
        );
      }
      return response;
    } catch (error) {
      emit("http.failure", error, "error", {
        ...fields,
        result: "failure",
        phase:
          error instanceof Error && error.name === "AbortError"
            ? "aborted"
            : "failed",
        durationMs: Math.round(performance.now() - started),
      });
      throw error;
    }
  };
  function observeSocket<T extends WebSocket>(socket: T): T {
    if (!status.enabled) return socket;
    const socketId = globalThis.crypto.randomUUID();
    const fields = { socketId, url: text(socket.url), operation: "websocket" };
    socket.addEventListener("open", () =>
      emit("realtime.open", undefined, "info", fields),
    );
    socket.addEventListener("close", (event) =>
      emit(
        "realtime.close",
        { code: event.code, wasClean: event.wasClean },
        "info",
        fields,
      ),
    );
    socket.addEventListener("error", () =>
      emit(
        "realtime.error",
        OMIT("browser_error_details_unavailable"),
        "error",
        fields,
      ),
    );
    socket.addEventListener("message", (event) =>
      emit(
        "realtime.receive",
        typeof event.data === "string" ? event.data : OMIT("binary_frame"),
        "debug",
        { ...fields, phase: "client_received" },
      ),
    );
    const send = socket.send.bind(socket);
    socket.send = (data) => {
      emit(
        "realtime.send",
        typeof data === "string" ? data : OMIT("binary_frame"),
        "debug",
        { ...fields, phase: "client_send_attempt" },
      );
      return send(data);
    };
    return socket;
  }
  return {
    emit,
    fetch,
    observeSocket,
    instanceId,
    status: () => ({ ...status }),
    stop: () => {
      stopped = true;
      queue.length = 0;
      status.pending = active;
    },
  };
}

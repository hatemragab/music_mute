import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { RotatingJsonlWriter, retentionPolicy } from "./log-retention.mjs";
import { boundedEvent } from "./redact.mjs";
export const sources = [
  "backend",
  "web-client",
  "dashboard",
  "landing-page",
  "chrome-extension",
  "macos",
  "worker",
  "windows-desktop",
  "ios",
  "android",
  "provider",
  "collector",
];
export const browserOrigins = Object.fromEntries(
  [
    ["web-client", 5173],
    ["dashboard", 5174],
    ["landing-page", 5175],
  ].map(([source, port]) => [
    source,
    [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
  ]),
);
export async function startIngress({
  file,
  keys,
  port = 19740,
  captureId = randomUUID(),
  extensionOrigins = [],
  healthDetails = () => ({}),
  writer,
  maximumPending = 128,
} = {}) {
  writer ??= new RotatingJsonlWriter(file, {
    ...retentionPolicy(),
    maxBytes: 4 * 1024 * 1024,
    maxArchives: 16,
  });
  const stats = {
    accepted: 0,
    written: 0,
    dropped: 0,
    failed: 0,
    pending: 0,
    pendingBytes: 0,
    activeRequests: 0,
    rejected: 0,
    lastWrittenAt: null,
    lastWrittenSequence: 0,
  };
  const queue = [];
  let flushing,
    closing = false;
  async function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          await writer.write(item.text);
          stats.written++;
          stats.lastWrittenAt = new Date().toISOString();
          stats.lastWrittenSequence = item.sequence;
        } catch {
          stats.failed++;
        } finally {
          stats.pending--;
          stats.pendingBytes -= item.bytes;
        }
      }
    })().finally(() => {
      flushing = undefined;
      return queue.length ? flush() : undefined;
    });
    return flushing;
  }
  function enqueue(event) {
    event = {
      ...event,
      ingressSequence: stats.accepted + 1,
      ingressInstanceId: captureId,
    };
    const text = JSON.stringify(event) + "\n",
      bytes = Buffer.byteLength(text);
    if (
      stats.pending >= maximumPending ||
      stats.pendingBytes + bytes > 4 * 1024 * 1024
    ) {
      const index = queue.findIndex(
        (item) => !["warn", "error"].includes(item.level),
      );
      if (!["warn", "error"].includes(event.level) || index < 0) {
        stats.dropped++;
        return false;
      }
      const [old] = queue.splice(index, 1);
      stats.pending--;
      stats.pendingBytes -= old.bytes;
      stats.dropped++;
    }
    queue.push({
      text,
      bytes,
      level: event.level,
      sequence: event.ingressSequence,
    });
    stats.pending++;
    stats.pendingBytes += bytes;
    stats.accepted++;
    void flush();
    return true;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const end = (code, body = {}) => {
      if (!res.destroyed) {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      }
    };
    if (
      req.headers.host !== `127.0.0.1:${port}` &&
      req.headers.host !== `localhost:${port}`
    ) {
      stats.rejected++;
      return end(403);
    }
    if (req.method === "GET" && req.url === "/health" && !req.headers.origin)
      return end(200, { captureId, stats, ...healthDetails() });
    const match = /^\/ingest\/([a-z-]+)$/.exec(req.url ?? "");
    const source = match?.[1];
    if (!sources.includes(source)) {
      stats.rejected++;
      return end(404);
    }
    const origin = req.headers.origin;
    if (origin) {
      const allowed =
        source === "chrome-extension"
          ? extensionOrigins
          : (browserOrigins[source] ?? []);
      if (!allowed.includes(origin)) {
        stats.rejected++;
        return end(403);
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      if (req.headers["access-control-request-private-network"] === "true")
        res.setHeader("Access-Control-Allow-Private-Network", "true");
    } else {
      const a = Buffer.from(req.headers["x-musicmute-log-key"] ?? ""),
        b = Buffer.from(keys[source] ?? "");
      if (!b.length || a.length !== b.length || !timingSafeEqual(a, b)) {
        stats.rejected++;
        return end(403);
      }
    }
    if (req.method === "OPTIONS" && origin) return end(204);
    if (req.method !== "POST") return end(405);
    if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? ""))
      return end(415);
    if (closing || stats.activeRequests >= 16) {
      stats.dropped++;
      return end(429);
    }
    stats.activeRequests++;
    let bytes = 0,
      chunks = [];
    try {
      req.setTimeout(2000, () => req.destroy());
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 65536) {
          chunks = [];
          return end(413);
        }
        chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        typeof value.name !== "string" ||
        value.name.length > 128 ||
        typeof value.instanceId !== "string" ||
        !/^[\w.-]{1,128}$/.test(value.instanceId)
      )
        return end(400);
      const receivedAt = new Date().toISOString(),
        validTime =
          typeof value.timestamp === "string" &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
            value.timestamp,
          ) &&
          Number.isFinite(Date.parse(value.timestamp));
      const preciseTime = validTime
        ? new Date(value.timestamp).toISOString().slice(0, 19) +
          "." +
          (value.timestamp.match(/\.(\d{1,9})/)?.[1] ?? "000") +
          "Z"
        : receivedAt;
      const safe = boundedEvent({
        ...value,
        source,
        ...(value.category === "http" &&
        /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(
          String(value.operation),
        ) &&
        !value.method
          ? { method: String(value.operation).toUpperCase() }
          : {}),
        requestId: value.requestId ?? null,
        userId: value.userId ?? null,
        origin: origin ? "client_diagnostic" : "application_observation",
        captureId,
        receivedAt,
        timestamp: preciseTime,
        sourceTimestamp: validTime ? preciseTime : undefined,
        timestampSource: validTime ? "service" : "collection",
        level: ["debug", "info", "warn", "error"].includes(value.level)
          ? value.level
          : "info",
        event: value.event ?? value.name,
      });
      if (origin && safe.userId) {
        safe.claimedUserId = safe.userId;
        safe.userId = null;
      }
      return enqueue(safe) ? end(202) : end(429);
    } catch {
      stats.rejected++;
      return end(400);
    } finally {
      stats.activeRequests--;
    }
  });
  server.maxConnections = 24;
  server.requestTimeout = 3000;
  server.headersTimeout = 3000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    server,
    stats,
    enqueue,
    flush,
    captureId,
    close: async () => {
      closing = true;
      await new Promise((resolve) => server.close(resolve));
      await flush();
      await writer.close();
    },
  };
}

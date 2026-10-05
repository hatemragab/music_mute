import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join, relative } from "node:path";
import { assertCacheDirectory, cacheFileBytes } from "./cache-budget.js";
import {
  pinChromePlayback,
  PLAYBACK_GRANT_MAX_MS,
  type PlaybackPinLease,
} from "./cache-mutator.js";

interface MediaEntry {
  path: string;
  token: string;
  expires: number;
  mime: string;
  lease?: PlaybackPinLease;
  expiry: NodeJS.Timeout;
  responses: Set<ServerResponse>;
}
export interface MediaServerOptions {
  cacheRoot?: string;
  grantDurationMs?: number;
}

export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  let start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start ||
    (!match[1] && Number(match[2]) === 0)
  )
    return null;
  end = Math.min(end, size - 1);
  return { start, end };
}

/** Read-only delivery. Capability is private to the extension-owned player. */
export class MediaServer {
  private readonly entries = new Map<string, MediaEntry>();
  private readonly pending = new Set<Promise<unknown>>();
  private generation = 0;
  private closed = false;
  private port = 0;
  private readonly server;
  constructor(
    private readonly extensionOrigin: string,
    private readonly onFailure?: (code: string) => void,
    private readonly options: MediaServerOptions = {},
  ) {
    if (
      options.grantDurationMs !== undefined &&
      (!Number.isSafeInteger(options.grantDurationMs) ||
        options.grantDurationMs < 1 ||
        options.grantDurationMs > PLAYBACK_GRANT_MAX_MS)
    )
      throw new Error("CACHE_UNSAFE");
    this.server = createServer((request, response) => {
      void this.handle(
        request.url ?? "",
        request.method ?? "",
        request.headers.host,
        request.headers.origin,
        request.headers.range,
        response,
      ).catch(() => this.problem(response, 500, "MEDIA_UNAVAILABLE"));
    });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
  }
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("MEDIA_SERVER_FAILED");
    this.port = address.port;
  }
  async issue(
    jobId: string,
    path: string,
    mime = "audio/mpeg",
  ): Promise<string> {
    // Native file playback uses the same lifecycle without opening this listener.
    if (this.closed) throw new Error("MEDIA_SERVER_FAILED");
    const generation = this.generation;
    const operation = this.issueEntry(jobId, path, mime, generation);
    this.pending.add(operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(operation);
    }
  }
  private async issueEntry(
    jobId: string,
    path: string,
    mime: string,
    generation: number,
  ): Promise<string> {
    if (!/^[a-f0-9-]{36}$/.test(jobId)) throw new Error("MEDIA_SERVER_FAILED");
    const previous = this.entries.get(jobId);
    if (previous) {
      this.entries.delete(jobId);
      await this.release(previous);
    }
    const expires =
      Date.now() + (this.options.grantDurationMs ?? PLAYBACK_GRANT_MAX_MS);
    let lease: PlaybackPinLease | undefined;
    if (this.options.cacheRoot) {
      const root = this.options.cacheRoot;
      const match = /^vocals\/([a-f0-9]{64})\/vocals\.mp3$/.exec(
        relative(root, path),
      );
      if (
        !match?.[1] ||
        path !== join(root, "vocals", match[1], "vocals.mp3") ||
        !(await assertCacheDirectory(root, root)) ||
        !(await assertCacheDirectory(root, join(root, "vocals"))) ||
        !(await assertCacheDirectory(root, join(root, "vocals", match[1]))) ||
        ((await cacheFileBytes(root, path)) ?? 0) < 1
      )
        throw new Error("CACHE_UNSAFE");
      lease = await pinChromePlayback(root, match[1], expires);
    }
    if (
      this.closed ||
      generation !== this.generation ||
      expires <= Date.now()
    ) {
      await lease?.release();
      throw new Error("CANCELLED");
    }
    const token = randomBytes(32).toString("base64url");
    const expiry = setTimeout(
      () => {
        const entry = this.entries.get(jobId);
        if (!entry || entry.token !== token) return;
        this.entries.delete(jobId);
        this.trackRelease(entry);
      },
      Math.max(1, expires - Date.now()),
    );
    expiry.unref();
    this.entries.set(jobId, {
      path,
      token,
      expires,
      mime,
      expiry,
      responses: new Set(),
      ...(lease ? { lease } : {}),
    });
    return `http://127.0.0.1:${this.port}/media/${jobId}?capability=${token}`;
  }
  async revoke(): Promise<void> {
    ++this.generation;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) this.trackRelease(entry);
    // Revocation is immediate; drain in-flight publication so it cannot leave a pin.
    await Promise.allSettled(this.pending);
  }
  private async release(entry: MediaEntry): Promise<void> {
    clearTimeout(entry.expiry);
    for (const response of entry.responses) response.destroy();
    entry.responses.clear();
    await entry.lease?.release();
  }
  private trackRelease(entry: MediaEntry): void {
    const operation = this.release(entry).catch(() =>
      this.onFailure?.("CACHE_UNSAFE"),
    );
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation));
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.revoke();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
  private problem(
    response: ServerResponse,
    status: number,
    code: string,
  ): void {
    this.onFailure?.(code);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(status, {
      "Content-Type": "application/problem+json",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify({ type: "about:blank", title: code, status }));
  }
  private async handle(
    rawUrl: string,
    method: string,
    host: string | undefined,
    origin: string | undefined,
    range: string | undefined,
    response: ServerResponse,
  ): Promise<void> {
    // Chrome's privileged extension media request can omit Origin. The secret
    // capability remains mandatory; an explicitly foreign web origin is denied.
    if (
      host !== `127.0.0.1:${this.port}` ||
      (origin !== undefined && origin !== this.extensionOrigin)
    ) {
      this.problem(response, 403, "ORIGIN_FORBIDDEN");
      return;
    }
    response.setHeader("Access-Control-Allow-Origin", this.extensionOrigin);
    response.setHeader("Vary", "Origin");
    response.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges",
    );
    if (method === "OPTIONS") {
      if (origin !== this.extensionOrigin) {
        this.problem(response, 403, "ORIGIN_FORBIDDEN");
        return;
      }
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, HEAD",
        "Access-Control-Allow-Headers": "Range",
      });
      response.end();
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD, OPTIONS");
      this.problem(response, 405, "METHOD_NOT_ALLOWED");
      return;
    }
    const url = new URL(rawUrl, `http://127.0.0.1:${this.port}`);
    const id = /^\/media\/([a-f0-9-]{36})$/.exec(url.pathname)?.[1];
    const entry = id ? this.entries.get(id) : undefined;
    const supplied = url.searchParams.get("capability") ?? "";
    if (
      !entry ||
      entry.expires <= Date.now() ||
      supplied.length !== entry.token.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(entry.token))
    ) {
      this.problem(response, 403, "MEDIA_FORBIDDEN");
      return;
    }
    const info = await lstat(entry.path);
    // Revocation may happen while the filesystem operation is in flight.
    if (this.entries.get(id!) !== entry || entry.expires <= Date.now()) {
      this.problem(response, 403, "MEDIA_FORBIDDEN");
      return;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1) {
      this.problem(response, 404, "MEDIA_UNAVAILABLE");
      return;
    }
    const bounds = parseRange(range, info.size);
    if (!bounds) {
      response.setHeader("Content-Range", `bytes */${info.size}`);
      this.problem(response, 416, "RANGE_NOT_SATISFIABLE");
      return;
    }
    const length = bounds.end - bounds.start + 1;
    response.setHeader("Content-Type", entry.mime);
    response.setHeader("Content-Length", length);
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (range)
      response.setHeader(
        "Content-Range",
        `bytes ${bounds.start}-${bounds.end}/${info.size}`,
      );
    response.writeHead(range ? 206 : 200);
    if (method === "HEAD") {
      response.end();
      return;
    }
    const stream = createReadStream(entry.path, bounds);
    entry.responses.add(response);
    response.on("close", () => {
      entry.responses.delete(response);
      stream.destroy();
    });
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  }
}

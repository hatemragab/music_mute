import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { FileHandle } from "node:fs/promises";
import { parseRange } from "../../../../chrome-extension/src/shared/media-range.js";
export interface VerifiedPlaybackFile {
  file: FileHandle;
  bytes: number;
  mime:
    | "audio/mpeg"
    | "audio/wav"
    | "audio/mp4"
    | "audio/ogg"
    | "audio/flac"
    | "audio/webm"
    | "audio/aac";
  /** The trusted Library checks owner generation, native ACL/path and exact verified file identity. */
  current(): Promise<void>;
  /** Close the descriptor and release its storage pin. */
  release(): Promise<void>;
}
interface Grant {
  revoked: boolean;
  token: string;
  owner: string;
  expires: number;
  file: VerifiedPlaybackFile;
  timer: ReturnType<typeof setTimeout>;
  responses: Set<ServerResponse>;
}
export class ScopedMediaServer {
  private readonly grants = new Map<string, Grant>();
  private readonly pending = new Set<Promise<void>>();
  private readonly revocations = new Map<string, Promise<void>>();
  private readonly server;
  private port = 0;
  private closed = false;
  private closing: Promise<void> | undefined;
  private serverClosed = false;
  private generation = 0;
  constructor(
    private readonly origin = "musicmute://app",
    private readonly grantMs = 2 * 60 * 60_000,
    private readonly now: () => number = Date.now,
  ) {
    if (
      !/^(?:musicmute:\/\/app|chrome-extension:\/\/[a-p]{32})$/u.test(origin) ||
      !Number.isSafeInteger(grantMs) ||
      grantMs < 1 ||
      grantMs > 2 * 60 * 60_000
    )
      throw new Error("MEDIA_UNAVAILABLE");
    this.server = createServer((request, response) => {
      void this.handle(
        request.url ?? "",
        request.method ?? "",
        request.headers.host,
        request.headers.origin,
        request.headers.range,
        response,
      ).catch(() => this.problem(response, 403));
    });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
    this.server.maxHeadersCount = 32;
  }
  async start(): Promise<void> {
    if (this.closed || this.port) throw new Error("MEDIA_UNAVAILABLE");
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error);
      this.server.once("error", fail);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", fail);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("MEDIA_UNAVAILABLE");
    this.port = address.port;
  }
  async issue(
    owner: string,
    file: VerifiedPlaybackFile,
  ): Promise<{ url: string; release(): Promise<void> }> {
    if (
      this.closed ||
      !this.port ||
      this.grants.size >= 32 ||
      !/^[a-f0-9-]{36}$/iu.test(owner) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 256 * 1024 ** 2 ||
      ![
        "audio/mpeg",
        "audio/wav",
        "audio/mp4",
        "audio/ogg",
        "audio/flac",
        "audio/webm",
        "audio/aac",
      ].includes(file.mime)
    )
      throw new Error("MEDIA_UNAVAILABLE");
    const generation = this.generation;
    await file.current();
    if (this.closed || generation !== this.generation || this.grants.size >= 32)
      throw new Error("MEDIA_UNAVAILABLE");
    const id = randomUUID(),
      token = randomBytes(32).toString("base64url");
    const grant: Grant = {
      revoked: false,
      token,
      owner,
      expires: this.now() + this.grantMs,
      file,
      timer: setTimeout(() => {
        void this.revoke(id).catch(() => {});
      }, this.grantMs),
      responses: new Set(),
    };
    grant.timer.unref();
    this.grants.set(id, grant);
    return {
      url: `http://127.0.0.1:${this.port}/media/${id}?capability=${token}`,
      release: () => this.revoke(id),
    };
  }
  private async revoke(id: string): Promise<void> {
    const pending = this.revocations.get(id);
    if (pending) return pending;
    const grant = this.grants.get(id);
    if (!grant) return;
    grant.revoked = true;
    clearTimeout(grant.timer);
    for (const response of grant.responses) response.destroy();
    grant.responses.clear();
    const release = Promise.resolve().then(() => grant.file.release());
    this.pending.add(release);
    this.revocations.set(id, release);
    try {
      await release;
      this.grants.delete(id);
    } finally {
      this.pending.delete(release);
      this.revocations.delete(id);
    }
  }
  async revokeOwner(owner: string): Promise<void> {
    this.generation++;
    await Promise.all(
      [...this.grants]
        .filter(([, grant]) => grant.owner === owner)
        .map(([id]) => this.revoke(id)),
    );
  }
  private problem(response: ServerResponse, status: number): void {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(status, {
      "Content-Type": "application/problem+json",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    response.end(
      JSON.stringify({
        type: "about:blank",
        title: "MEDIA_UNAVAILABLE",
        status,
      }),
    );
  }
  private async handle(
    raw: string,
    method: string,
    host: string | undefined,
    origin: string | undefined,
    range: string | undefined,
    response: ServerResponse,
  ): Promise<void> {
    if (
      host !== `127.0.0.1:${this.port}` ||
      (origin !== undefined && origin !== this.origin)
    ) {
      this.problem(response, 403);
      return;
    }
    response.setHeader("Access-Control-Allow-Origin", this.origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    if (method === "OPTIONS") {
      if (origin !== this.origin) {
        this.problem(response, 403);
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
      this.problem(response, 405);
      return;
    }
    const url = new URL(raw, `http://127.0.0.1:${this.port}`);
    const id = /^\/media\/([a-f0-9-]{36})$/u.exec(url.pathname)?.[1],
      grant = id ? this.grants.get(id) : undefined,
      token = url.searchParams.get("capability") ?? "";
    if (
      !grant ||
      grant.revoked ||
      grant.expires <= this.now() ||
      [...url.searchParams.keys()].join() !== "capability" ||
      token.length !== grant.token.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(grant.token))
    ) {
      this.problem(response, 403);
      return;
    }
    await grant.file.current();
    if (
      this.grants.get(id!) !== grant ||
      grant.revoked ||
      grant.expires <= this.now() ||
      this.closed
    ) {
      this.problem(response, 403);
      return;
    }
    const bounds = parseRange(range, grant.file.bytes);
    if (!bounds) {
      response.setHeader("Content-Range", `bytes */${grant.file.bytes}`);
      this.problem(response, 416);
      return;
    }
    if (grant.responses.size >= 8) {
      this.problem(response, 429);
      return;
    }
    response.setHeader("Content-Type", grant.file.mime);
    response.setHeader("Content-Length", bounds.end - bounds.start + 1);
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges",
    );
    if (range)
      response.setHeader(
        "Content-Range",
        `bytes ${bounds.start}-${bounds.end}/${grant.file.bytes}`,
      );
    response.writeHead(range ? 206 : 200);
    if (method === "HEAD") {
      response.end();
      return;
    }
    const stream = grant.file.file.createReadStream({
      ...bounds,
      autoClose: false,
      highWaterMark: 64 * 1024,
    });
    grant.responses.add(response);
    response.once("close", () => {
      grant.responses.delete(response);
      stream.destroy();
    });
    stream.once("error", () => response.destroy());
    stream.pipe(response);
  }
  activity() {
    return {
      grants: this.grants.size,
      pending: this.pending.size,
      idle: this.grants.size === 0 && this.pending.size === 0,
    };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.generation++;
    return (this.closing = (async () => {
      const results = await Promise.allSettled(
        [...this.grants.keys()].map((id) => this.revoke(id)),
      );
      await Promise.allSettled(this.pending);
      if (!this.serverClosed) {
        this.server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          this.server.close((error) => {
            if (
              error &&
              (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
            )
              reject(new Error("MEDIA_RELEASE_PENDING"));
            else resolve();
          }),
        );
        this.serverClosed = true;
      }
      if (
        results.some((result) => result.status === "rejected") ||
        !this.activity().idle
      )
        throw new Error("MEDIA_RELEASE_PENDING");
    })().finally(() => {
      this.closing = undefined;
    }));
  }
}

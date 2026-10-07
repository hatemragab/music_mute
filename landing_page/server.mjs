import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = resolve(directory, "dist");

const CONTENT_TYPES = {
  ".mp3": "audio/mpeg",
  ".webm": "audio/webm",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
};

const STREAMABLE_AUDIO_EXTENSIONS = new Set([".mp3", ".webm"]);

const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "media-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "upgrade-insecure-requests",
  ].join("; "),
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function setSecurityHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    response.setHeader(name, value);
}

function hiddenPath(pathname) {
  return pathname.split("/").some((segment) => segment.startsWith("."));
}

function parseByteRange(header, size) {
  if (typeof header !== "string") return undefined;

  const match = /^bytes=(.+)$/i.exec(header.trim());
  if (!match || match[1].includes(",") || size === 0) return undefined;

  const parts = /^(\d*)-(\d*)$/.exec(match[1].trim());
  if (!parts || (!parts[1] && !parts[2])) return undefined;

  if (!parts[1]) {
    const suffixLength = Number(parts[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0)
      return undefined;

    return {
      start: Math.max(size - suffixLength, 0),
      end: size - 1,
    };
  }

  const start = Number(parts[1]);
  if (!Number.isSafeInteger(start) || start >= size) return undefined;

  if (!parts[2]) return { start, end: size - 1 };

  const requestedEnd = Number(parts[2]);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start)
    return undefined;

  return { start, end: Math.min(requestedEnd, size - 1) };
}

function sendFileStream(file, response, options) {
  pipeline(createReadStream(file, options), response, (error) => {
    if (error && !response.destroyed) response.destroy(error);
  });
}

export function createLandingServer({ dist = DEFAULT_DIST } = {}) {
  const root = resolve(dist);

  return createServer(async (request, response) => {
    setSecurityHeaders(response);

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }

    let pathname;
    let search;
    try {
      const requestUrl = new URL(request.url || "/", "http://localhost");
      pathname = decodeURIComponent(requestUrl.pathname);
      search = requestUrl.search;
    } catch {
      response.writeHead(400).end();
      return;
    }

    if (pathname === "/healthz") {
      response.setHeader("X-Robots-Tag", "noindex");
      response.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : "ok");
      return;
    }

    if (hiddenPath(pathname) || pathname.includes("\0")) {
      response.writeHead(404).end();
      return;
    }

    if (pathname === "/ar" || pathname === "/ar/index.html") {
      response.writeHead(308, {
        Location: `/ar/${search}`,
        "Cache-Control": "no-store",
      });
      response.end();
      return;
    }

    const relativePath =
      pathname === "/"
        ? "index.html"
        : pathname === "/ar/"
          ? "ar/index.html"
          : `.${pathname}`;
    const file = resolve(root, relativePath);
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      response.writeHead(404).end();
      return;
    }

    try {
      const fileStats = await stat(file);
      if (!fileStats.isFile()) {
        response.writeHead(404).end();
        return;
      }
      const extension = extname(file);
      const type = CONTENT_TYPES[extension] || "application/octet-stream";
      const cache = file.endsWith("index.html")
        ? "no-store"
        : pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache";

      if (STREAMABLE_AUDIO_EXTENSIONS.has(extension)) {
        const baseHeaders = {
          "Content-Type": type,
          "Cache-Control": cache,
          "Accept-Ranges": "bytes",
        };
        const rangeHeader = request.headers.range;

        if (rangeHeader !== undefined) {
          const range = parseByteRange(rangeHeader, fileStats.size);
          if (!range) {
            response.writeHead(416, {
              ...baseHeaders,
              "Content-Range": `bytes */${fileStats.size}`,
              "Content-Length": "0",
            });
            response.end();
            return;
          }

          response.writeHead(206, {
            ...baseHeaders,
            "Content-Range": `bytes ${range.start}-${range.end}/${fileStats.size}`,
            "Content-Length": String(range.end - range.start + 1),
          });
          if (request.method === "HEAD") {
            response.end();
            return;
          }

          sendFileStream(file, response, range);
          return;
        }

        response.writeHead(200, {
          ...baseHeaders,
          "Content-Length": String(fileStats.size),
        });
        if (request.method === "HEAD") {
          response.end();
          return;
        }

        sendFileStream(file, response);
        return;
      }

      const body = await readFile(file);
      response.writeHead(200, {
        "Content-Type": type,
        "Cache-Control": cache,
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404).end();
    }
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const server = createLandingServer();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "0.0.0.0";

  server.listen(port, host);

  function shutdown() {
    server.close((error) => {
      if (error) {
        console.error("MusicMute landing server shutdown failed.");
        process.exitCode = 1;
      }
    });
  }

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

import { createServer as createHttpServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = join(directory, "dist");
const firebaseAuthPaths = new Set([
  "/__/auth/handler",
  "/__/auth/handler.js",
  "/__/auth/experiments.js",
  "/__/auth/iframe",
  "/__/auth/iframe.js",
  "/__/auth/links",
  "/__/auth/links.js",
]);
const AUTH_REQUEST_LIMIT = 1024 * 1024;
const AUTH_RESPONSE_LIMIT = 2 * 1024 * 1024;

function readAuthRequest(request, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const finish = (error) => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", finish);
      signal.removeEventListener("abort", onAbort);
      if (error) {
        request.resume();
        reject(error);
      } else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > AUTH_REQUEST_LIMIT)
        finish(
          Object.assign(new Error("Request is too large."), { status: 413 }),
        );
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onAbort = () =>
      finish(new Error("Authentication request timed out."));
    if (Number(request.headers["content-length"]) > AUTH_REQUEST_LIMIT) {
      finish(
        Object.assign(new Error("Request is too large."), { status: 413 }),
      );
      return;
    }
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", finish);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function readAuthResponse(upstream) {
  if (!upstream.body) return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of upstream.body) {
    size += chunk.length;
    if (size > AUTH_RESPONSE_LIMIT)
      throw new Error("Authentication response is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function proxyFirebaseAuth(request, response, url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const onClose = () => {
    if (!response.writableFinished) controller.abort();
  };
  response.once("close", onClose);
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.setHeader("Cache-Control", "no-store");
  try {
    const body =
      request.method === "POST"
        ? await readAuthRequest(request, controller.signal)
        : undefined;
    const headers = {};
    for (const name of [
      "accept",
      "accept-language",
      "content-type",
      "user-agent",
    ]) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const upstream = await options.fetch(`${options.origin}${url}`, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    const payload = await readAuthResponse(upstream);
    // Firebase owns these helper documents. The app's CSP blocks their inline
    // initialization and provider navigation; preserve Firebase's policy here.
    response.removeHeader("Content-Security-Policy");
    for (const name of [
      "content-type",
      "content-language",
      "location",
      "retry-after",
      "content-security-policy",
    ]) {
      const value = upstream.headers.get(name);
      if (value !== null) response.setHeader(name, value);
    }
    if (url.split("?")[0] === "/__/auth/iframe")
      response.setHeader("X-Frame-Options", "SAMEORIGIN");
    response.writeHead(upstream.status);
    response.end(request.method === "HEAD" ? undefined : payload);
  } catch (error) {
    if (!response.destroyed) {
      response.writeHead(
        error?.status === 413 ? 413 : controller.signal.aborted ? 504 : 502,
        { "Content-Type": "text/plain; charset=utf-8" },
      );
      response.end(
        request.method === "HEAD"
          ? undefined
          : "Authentication is unavailable.",
      );
    }
  } finally {
    clearTimeout(timer);
    response.off("close", onClose);
  }
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

function accountEntryHtml(body) {
  return body
    .toString("utf8")
    .replace(
      /<!-- public-discovery:start -->[\s\S]*?<!-- public-discovery:end -->/,
      '<title>MusicMute | Account</title><meta name="robots" content="noindex, nofollow" /><meta name="description" content="Sign in to access your MusicMute account." />',
    )
    .replace(
      /<!-- public-entry:start -->[\s\S]*?<!-- public-entry:end -->/,
      '<main class="entry-shell"><h1>MusicMute</h1><p>Sign in to access your account.</p><noscript><p>JavaScript is required to sign in.</p><a href="/">Open MusicMute</a></noscript></main>',
    );
}

export function publicConfig(env = process.env) {
  const apiOrigin = env.PUBLIC_API_ORIGIN;
  const firebase = {
    apiKey: env.PUBLIC_FIREBASE_API_KEY,
    authDomain: env.PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: env.PUBLIC_FIREBASE_PROJECT_ID,
    appId: env.PUBLIC_FIREBASE_APP_ID,
  };
  if (!apiOrigin || Object.values(firebase).some((value) => !value))
    throw new Error("Public browser configuration is incomplete.");
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(firebase.projectId))
    throw new Error("PUBLIC_FIREBASE_PROJECT_ID must be a valid project ID.");
  const parsed = new URL(apiOrigin);
  if (
    parsed.protocol !== "https:" ||
    parsed.pathname !== "/" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("PUBLIC_API_ORIGIN must be an HTTPS origin.");
  const enabled = env.PUBLIC_SENTRY_ENABLED ?? "false";
  if (!["true", "false"].includes(enabled))
    throw new Error("PUBLIC_SENTRY_ENABLED must be true or false.");
  const sentry = { enabled: enabled === "true", dsn: "" };
  if (sentry.enabled) {
    const dsn = new URL(env.PUBLIC_SENTRY_DSN || "");
    if (
      dsn.protocol !== "https:" ||
      !dsn.username ||
      dsn.password ||
      dsn.search ||
      dsn.hash ||
      !/^\/\d+$/.test(dsn.pathname)
    )
      throw new Error("PUBLIC_SENTRY_DSN must be a public HTTPS project DSN.");
    sentry.dsn = dsn.href;
  }
  return { apiOrigin: parsed.origin, firebase, sentry };
}

export function createWebServer({
  env = process.env,
  dist = DEFAULT_DIST,
  authFetch = fetch,
  authTimeoutMs = 15_000,
} = {}) {
  const config = publicConfig(env);
  const firebaseOrigin = `https://${config.firebase.projectId}.firebaseapp.com`;
  const indexNowKey = env.INDEXNOW_KEY;
  if (indexNowKey !== undefined && !/^[A-Za-z0-9-]{8,128}$/.test(indexNowKey))
    throw new Error(
      "INDEXNOW_KEY must contain 8-128 letters, digits, or dashes.",
    );
  const root = resolve(dist);
  const mediaOrigin = env.PUBLIC_MEDIA_ORIGIN;
  let media;
  try {
    media = new URL(mediaOrigin || "");
  } catch {
    throw new Error("PUBLIC_MEDIA_ORIGIN must be an explicit HTTPS origin.");
  }
  if (
    media.protocol !== "https:" ||
    media.pathname !== "/" ||
    media.username ||
    media.password ||
    media.search ||
    media.hash
  )
    throw new Error("PUBLIC_MEDIA_ORIGIN must be an HTTPS origin.");
  const mediaSources = media.origin;
  const telemetryOrigin = config.sentry.enabled
    ? new URL(config.sentry.dsn).origin
    : "";
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'wasm-unsafe-eval' https://apis.google.com https://www.gstatic.com",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://www.gstatic.com https://accounts.google.com https://i.ytimg.com",
    `connect-src 'self' ${telemetryOrigin} ${config.apiOrigin} ${config.apiOrigin.replace(/^https:/, "wss:").replace(/^http:/, "ws:")} ${mediaSources} https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://firebaseinstallations.googleapis.com`,
    `media-src 'self' blob: ${mediaSources}`,
    `frame-src https://${config.firebase.authDomain} https://accounts.google.com`,
  ].join("; ");
  return createHttpServer(async (request, response) => {
    response.setHeader("Strict-Transport-Security", "max-age=31536000");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    response.setHeader("Content-Security-Policy", csp);
    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(request.url || "/", "http://localhost").pathname,
      );
    } catch {
      response.writeHead(400).end();
      return;
    }
    const rawPath = (request.url || "/").split("?")[0];
    if (firebaseAuthPaths.has(rawPath)) {
      if (!["GET", "HEAD", "POST"].includes(request.method)) {
        response.writeHead(405, { Allow: "GET, HEAD, POST" }).end();
        return;
      }
      await proxyFirebaseAuth(request, response, request.url, {
        origin: firebaseOrigin,
        fetch: authFetch,
        timeoutMs: authTimeoutMs,
      });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    if (rawPath === "/__/firebase/init.json") {
      response.setHeader("X-Robots-Tag", "noindex, nofollow");
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(
        request.method === "HEAD" ? undefined : JSON.stringify(config.firebase),
      );
      return;
    }
    // Check the original request path so URL normalization and encoded slashes
    // cannot widen the fixed helper allowlist.
    if (rawPath.startsWith("/__/") || pathname.startsWith("/__/")) {
      response.writeHead(404).end();
      return;
    }
    if (pathname === "/index.html") {
      const query = new URL(request.url || "/", "http://localhost").search;
      response.writeHead(308, {
        Location: `/${query}`,
        "Cache-Control": "no-cache",
      });
      response.end();
      return;
    }
    if (indexNowKey && pathname === `/${indexNowKey}.txt`) {
      response.setHeader("X-Robots-Tag", "noindex");
      response.writeHead(200, {
        "Content-Type": types[".txt"],
        "Cache-Control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : indexNowKey);
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
    if (pathname === "/config.js") {
      response.setHeader("X-Robots-Tag", "noindex");
      const payload = `window.__MUSICMUTE_WEB_CONFIG__=${JSON.stringify(config).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029")};`;
      response.writeHead(200, {
        "Content-Type": types[".js"],
        "Cache-Control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : payload);
      return;
    }
    const requested = resolve(root, `.${pathname}`);
    if (requested !== root && !requested.startsWith(root + sep)) {
      response.writeHead(404).end();
      return;
    }
    const appRoute =
      /^\/(?:auth|jobs(?:\/[^/]+)?|library|player|settings|account)\/?$/.test(
        pathname,
      );
    let file = requested;
    try {
      if (!(await stat(file)).isFile()) {
        if (pathname !== "/" && !appRoute) {
          response.writeHead(404).end();
          return;
        }
        file = join(root, "index.html");
      }
    } catch {
      if (!appRoute || extname(pathname)) {
        response.writeHead(404).end();
        return;
      }
      file = join(root, "index.html");
    }
    try {
      let body = await readFile(file);
      const type = types[extname(file)] || "application/octet-stream";
      const cache = file.endsWith("index.html")
        ? "no-store"
        : pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache";
      if (file.endsWith("index.html") && pathname !== "/") {
        response.setHeader("X-Robots-Tag", "noindex, nofollow");
        body = Buffer.from(accountEntryHtml(body));
      }
      response.writeHead(200, { "Content-Type": type, "Cache-Control": cache });
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
  const server = createWebServer();
  server.listen(
    Number(process.env.PORT || 3000),
    process.env.HOST || "0.0.0.0",
  );
}

import { createServer as createHttpServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = join(directory, "dist");
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
};

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
  return { apiOrigin: parsed.origin, firebase };
}

export function createWebServer({
  env = process.env,
  dist = DEFAULT_DIST,
} = {}) {
  const config = publicConfig(env);
  const root = resolve(dist);
  const mediaOrigin =
    env.PUBLIC_MEDIA_ORIGIN ||
    "https://music-remover.s3.us-east-2.amazonaws.com";
  const media = new URL(mediaOrigin);
  if (
    media.protocol !== "https:" ||
    media.pathname !== "/" ||
    media.username ||
    media.password ||
    media.search ||
    media.hash
  )
    throw new Error("PUBLIC_MEDIA_ORIGIN must be an HTTPS origin.");
  const acceleration = env.PUBLIC_MEDIA_ACCELERATION_ENABLED ?? "false";
  if (!["true", "false"].includes(acceleration))
    throw new Error("PUBLIC_MEDIA_ACCELERATION_ENABLED must be true or false.");
  const mediaOrigins = [media.origin];
  if (acceleration === "true") {
    const match =
      /^([a-z0-9][a-z0-9-]{1,61}[a-z0-9])\.s3\.[a-z0-9-]+\.amazonaws\.com$/.exec(
        media.hostname,
      );
    if (!match || media.port)
      throw new Error("Acceleration requires a regional S3 bucket origin.");
    // Keep regional grants valid during rollout/rollback; permit only this bucket.
    mediaOrigins.push(`https://${match[1]}.s3-accelerate.amazonaws.com`);
  }
  const mediaSources = mediaOrigins.join(" ");
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'wasm-unsafe-eval' https://apis.google.com https://www.gstatic.com",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://www.gstatic.com https://accounts.google.com",
    `connect-src 'self' ${config.apiOrigin} ${mediaSources} https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://firebaseinstallations.googleapis.com`,
    `media-src 'self' ${mediaSources}`,
    `frame-src https://${config.firebase.authDomain} https://accounts.google.com`,
  ].join("; ");
  return createHttpServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    response.setHeader("Content-Security-Policy", csp);
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(request.url || "/", "http://localhost").pathname,
      );
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
      const body = await readFile(file);
      const type = types[extname(file)] || "application/octet-stream";
      const cache = file.endsWith("index.html")
        ? "no-store"
        : pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache";
      if (file.endsWith("index.html") && pathname !== "/") {
        response.setHeader("X-Robots-Tag", "noindex, nofollow");
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

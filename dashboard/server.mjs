import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const dist = join(root, "dist");

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const required = (environment, name) => {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const validateProductionProfile = (environment) => {
  const appEnvironment = environment.APP_ENV?.trim() || "local";
  const nodeEnvironment = environment.NODE_ENV?.trim() || "development";
  if (!["local", "production", "test"].includes(appEnvironment))
    throw new Error("APP_ENV must be local, production or test");
  if (!["development", "production", "test"].includes(nodeEnvironment))
    throw new Error("NODE_ENV must be development, production or test");
  if (
    (appEnvironment === "production") !==
    (nodeEnvironment === "production")
  ) {
    throw new Error("APP_ENV and NODE_ENV disagree");
  }
  if (appEnvironment !== "production")
    throw new Error("Dashboard server requires APP_ENV=production");
};

export const normalizeBasePath = (value) => {
  const path = value?.trim() || "/";
  if (
    !path.startsWith("/") ||
    path.includes("://") ||
    path.includes("?") ||
    path.includes("#") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("VITE_APP_BASE_PATH must be a root-relative path");
  }
  return path.endsWith("/") ? path : `${path}/`;
};

export const buildRuntimeConfig = (environment) => {
  validateProductionProfile(environment);
  const apiUrl = new URL(required(environment, "VITE_API_ORIGIN"));
  if (
    apiUrl.protocol !== "https:" ||
    apiUrl.username ||
    apiUrl.password ||
    apiUrl.pathname !== "/" ||
    apiUrl.search ||
    apiUrl.hash
  ) {
    throw new Error("VITE_API_ORIGIN must be a credential-free HTTPS origin");
  }
  return {
    apiOrigin: apiUrl.origin,
    basePath: normalizeBasePath(environment.VITE_APP_BASE_PATH),
    firebase: {
      apiKey: required(environment, "VITE_FIREBASE_API_KEY"),
      authDomain: required(environment, "VITE_FIREBASE_AUTH_DOMAIN"),
      projectId: required(environment, "VITE_FIREBASE_PROJECT_ID"),
      appId: required(environment, "VITE_FIREBASE_APP_ID"),
    },
  };
};

const safeJson = (value) =>
  JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

export const runtimeConfigScript = (config) =>
  `window.__MUSICMUTE_RUNTIME_CONFIG__=${safeJson(config)};\n`;

const commonHeaders = {
  "content-security-policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self' https:",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src https:",
    "img-src 'self' data: https:",
    "media-src 'self' blob: https:",
    "object-src 'none'",
    "script-src 'self' https://apis.google.com",
    "style-src 'self' 'unsafe-inline'",
  ].join("; "),
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

const send = (response, status, headers, body = "") => {
  response.writeHead(status, { ...commonHeaders, ...headers });
  response.end(body);
};

const isRegularFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export const createServer = ({ config, host = "0.0.0.0", port = 80 }) => {
  const indexTemplate = readFileSync(join(dist, "index.html"), "utf8");
  const index = indexTemplate.replace(
    "<head>",
    `<head>\n    <base href="${config.basePath}">\n    <script src="runtime-config.js"></script>`,
  );
  const prefix = config.basePath === "/" ? "" : config.basePath.slice(0, -1);
  const server = createHttpServer((request, response) => {
    if (!request.url) return send(response, 400, {});
    if (request.method !== "GET" && request.method !== "HEAD")
      return send(response, 405, { allow: "GET, HEAD" });
    let url;
    try {
      url = new URL(request.url, "http://localhost");
    } catch {
      return send(response, 400, {});
    }
    if (url.pathname === "/healthz")
      return send(
        response,
        200,
        { "content-type": "application/json" },
        '{"ok":true}',
      );
    if (
      prefix &&
      !(url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
    )
      return send(response, 404, {});
    const relativePath = prefix
      ? url.pathname === prefix
        ? "/"
        : url.pathname.slice(prefix.length) || "/"
      : url.pathname;
    if (relativePath === "/runtime-config.js")
      return send(
        response,
        200,
        {
          "cache-control": "no-store",
          "content-type": "text/javascript; charset=utf-8",
        },
        request.method === "HEAD" ? "" : runtimeConfigScript(config),
      );
    let decoded;
    try {
      decoded = decodeURIComponent(relativePath);
    } catch {
      return send(response, 400, {});
    }
    if (decoded.split("/").some((segment) => segment.startsWith(".")))
      return send(response, 404, {});
    const candidate = resolve(dist, `.${normalize(decoded)}`);
    if (!candidate.startsWith(`${dist}${sep}`) || !isRegularFile(candidate)) {
      const acceptsHtml = request.headers.accept
        ?.split(",")
        .some((value) => value.trim().split(";", 1)[0] === "text/html");
      if (extname(decoded) && !acceptsHtml) return send(response, 404, {});
      return send(
        response,
        200,
        { "cache-control": "no-cache", "content-type": mimeTypes[".html"] },
        request.method === "HEAD" ? "" : index,
      );
    }
    const extension = extname(candidate).toLowerCase();
    response.writeHead(200, {
      ...commonHeaders,
      "cache-control": decoded.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      "content-type": mimeTypes[extension] ?? "application/octet-stream",
    });
    if (request.method === "HEAD") return response.end();
    createReadStream(candidate).pipe(response);
  });
  return { server, host, port };
};

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const config = buildRuntimeConfig(process.env);
  const host = process.env.HOST?.trim() || "0.0.0.0";
  const port = Number(process.env.PORT || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer from 1 through 65535");
  const { server } = createServer({ config, host, port });
  server.listen(port, host, () => {
    console.log(`MusicMute dashboard listening on ${host}:${port}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

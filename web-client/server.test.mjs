import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { JSDOM } from "jsdom";
import { createWebServer, publicConfig } from "./server.mjs";

const env = {
  PUBLIC_MEDIA_ORIGIN: "https://fixture.r2.cloudflarestorage.com",
  PUBLIC_API_ORIGIN: "https://api.example.com",
  PUBLIC_FIREBASE_API_KEY: "public-key",
  PUBLIC_FIREBASE_AUTH_DOMAIN: "example.firebaseapp.com",
  PUBLIC_FIREBASE_PROJECT_ID: "example",
  PUBLIC_FIREBASE_APP_ID: "1:2:web:3",
};
let server, origin;
before(async () => {
  server = createWebServer({ env });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
test("rejects unsafe API origins", () =>
  assert.throws(() =>
    publicConfig({ ...env, PUBLIC_API_ORIGIN: "http://api.example.com" }),
  ));
test("serves runtime config without caching and a health response", async () => {
  const config = await fetch(`${origin}/config.js`);
  assert.equal(config.status, 200);
  assert.equal(
    config.headers.get("strict-transport-security"),
    "max-age=31536000",
  );
  assert.equal(config.headers.get("cache-control"), "no-store");
  assert.match(await config.text(), /api\.example\.com/);
  assert.match(
    config.headers.get("content-security-policy"),
    /media-src 'self' blob: https:\/\/fixture\.r2\.cloudflarestorage\.com/,
  );
  const health = await fetch(`${origin}/healthz`);
  assert.equal(await health.text(), "ok");
});

test("monitoring is opt-in and validates public project DSNs", () => {
  assert.deepEqual(publicConfig(env).sentry, { enabled: false, dsn: "" });
  for (const dsn of [
    "http://key@example.com/123",
    "https://key:secret@example.com/123",
    "https://key@example.com/123?token=secret",
    "https://key@example.com/path",
    "",
  ]) {
    assert.throws(() =>
      publicConfig({
        ...env,
        PUBLIC_SENTRY_ENABLED: "true",
        PUBLIC_SENTRY_DSN: dsn,
      }),
    );
  }
  assert.throws(() => publicConfig({ ...env, PUBLIC_SENTRY_ENABLED: "yes" }));
});

test("monitoring permits only its configured ingest origin in CSP", async () => {
  const monitored = createWebServer({
    env: {
      ...env,
      PUBLIC_SENTRY_ENABLED: "true",
      PUBLIC_SENTRY_DSN: "https://public@ingest.example.com/123",
    },
  });
  await new Promise((resolve) => monitored.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${monitored.address().port}/healthz`,
    );
    assert.match(
      response.headers.get("content-security-policy"),
      /connect-src 'self' https:\/\/ingest\.example\.com /,
    );
  } finally {
    await new Promise((resolve) => monitored.close(resolve));
  }
});
test("deep links serve HTML and missing assets return 404", async () => {
  const deep = await fetch(`${origin}/jobs/0123456789abcdef01234567`);
  assert.equal(deep.status, 200);
  assert.match(deep.headers.get("content-type"), /text\/html/);
  assert.equal(deep.headers.get("x-robots-tag"), "noindex, nofollow");
  const missing = await fetch(`${origin}/assets/missing.js`);
  assert.equal(missing.status, 404);
  assert.equal((await fetch(`${origin}/not-a-route`)).status, 404);
});
test("exposes the public entry point and crawl assets without indexing private routes", async () => {
  const home = await fetch(origin);
  const html = await home.text();
  assert.equal(home.headers.get("x-robots-tag"), null);
  assert.match(
    html,
    /<title>MusicMute Web App \| Remove Background Music Online<\/title>/,
  );
  assert.match(html, /rel="canonical" href="https:\/\/app\.music-mute\.com\/"/);
  assert.match(html, /name="description"/);
  assert.match(html, /href="\/favicon\.png"/);
  const icon = await fetch(`${origin}/favicon.png`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type"), /image\/png/);
  const robots = await fetch(`${origin}/robots.txt`);
  assert.match(robots.headers.get("content-type"), /^text\/plain;/);
  assert.match(
    await robots.text(),
    /Sitemap: https:\/\/app\.music-mute\.com\/sitemap\.xml/,
  );
  const sitemap = await fetch(`${origin}/sitemap.xml`);
  assert.match(sitemap.headers.get("content-type"), /^application\/xml;/);
  const sitemapBody = await sitemap.text();
  assert.deepEqual(
    [...sitemapBody.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]),
    ["https://app.music-mute.com/"],
  );
  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.headers.get("x-robots-tag"), "noindex");
});

test("public HTML includes useful content and accurate application data before JavaScript runs", async () => {
  const response = await fetch(origin);
  const { document } = new JSDOM(await response.text()).window;
  assert.equal(
    document.querySelector("h1")?.textContent,
    "Remove background music. Keep the voice.",
  );
  assert.match(
    document.querySelector("main")?.textContent,
    /Upload a local audio/,
  );
  assert.match(
    document.querySelector("main")?.textContent,
    /JavaScript is required/,
  );
  assert.ok(document.querySelector('a[href="https://music-mute.com/"]'));
  const application = JSON.parse(
    document.querySelector('script[type="application/ld+json"]').textContent,
  );
  assert.equal(application["@type"], "WebApplication");
  assert.equal(application["@id"], "https://app.music-mute.com/#application");
  assert.deepEqual(application.inLanguage, ["en", "ar"]);
  assert.match(application.browserRequirements, /account/);
  assert.equal(application.offers, undefined);
  assert.equal(application.aggregateRating, undefined);
  assert.equal(
    document.querySelector('meta[property="og:image"]')?.content,
    "https://app.music-mute.com/social-preview.png",
  );
  const head = await fetch(origin, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(
    head.headers.get("content-type"),
    response.headers.get("content-type"),
  );
  assert.equal(head.headers.get("x-robots-tag"), null);
  assert.equal(await head.text(), "");
});

test("all private HTML routes omit public discovery content and remain noindex for GET and HEAD", async () => {
  for (const path of [
    "/auth",
    "/jobs",
    "/jobs/0123456789abcdef01234567",
    "/library",
    "/player",
    "/settings",
    "/account",
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(`${origin}${path}`, { method });
      assert.equal(response.status, 200, `${method} ${path}`);
      assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
      assert.equal(response.headers.get("cache-control"), "no-store");
      const html = await response.text();
      if (method === "HEAD") {
        assert.equal(html, "");
        continue;
      }
      const { document } = new JSDOM(html).window;
      assert.equal(document.title, "MusicMute | Account");
      assert.equal(
        document.querySelector('meta[name="robots"]')?.content,
        "noindex, nofollow",
      );
      assert.equal(document.querySelector('link[rel="canonical"]'), null);
      assert.equal(
        document.querySelector('script[type="application/ld+json"]'),
        null,
      );
      assert.equal(document.querySelector('meta[property^="og:"]'), null);
      assert.doesNotMatch(document.body.textContent, /Remove background music/);
      assert.ok(
        document.querySelector('script[type="module"][src^="/assets/"]'),
      );
    }
  }
});

test("duplicate entry URL permanently redirects to the public root and preserves query parameters", async () => {
  for (const method of ["GET", "HEAD"]) {
    for (const path of ["/index.html", "/index%2ehtml"]) {
      const response = await fetch(`${origin}${path}?source=direct`, {
        method,
        redirect: "manual",
      });
      assert.equal(response.status, 308);
      assert.equal(response.headers.get("location"), "/?source=direct");
      assert.equal(await response.text(), "");
    }
  }
});

test("public crawler summary and its assets are available with correct media types", async () => {
  for (const method of ["GET", "HEAD"]) {
    const summary = await fetch(`${origin}/llms.txt`, { method });
    assert.equal(summary.status, 200);
    assert.match(summary.headers.get("content-type"), /^text\/plain;/);
    const body = await summary.text();
    if (method === "GET") {
      assert.match(body, /JavaScript and an account are required/);
      assert.match(body, /does not grant access to private audio/);
    } else assert.equal(body, "");
  }
  const stylesheet = await fetch(`${origin}/entry.css`);
  assert.match(stylesheet.headers.get("content-type"), /^text\/css;/);
  const image = await fetch(`${origin}/social-preview.png`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
});

test("optional IndexNow verification serves only the configured key for GET and HEAD", async (t) => {
  const key = "indexnow-fixture-key";
  const configured = createWebServer({ env: { ...env, INDEXNOW_KEY: key } });
  await new Promise((resolve) => configured.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => configured.close(resolve)));
  const configuredOrigin = `http://127.0.0.1:${configured.address().port}`;
  for (const method of ["GET", "HEAD"]) {
    const response = await fetch(`${configuredOrigin}/${key}.txt`, { method });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "text/plain; charset=utf-8",
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-robots-tag"), "noindex");
    assert.equal(await response.text(), method === "HEAD" ? "" : key);
    assert.equal(
      (await fetch(`${configuredOrigin}/wrong-fixture-key.txt`, { method }))
        .status,
      404,
    );
  }
  assert.equal((await fetch(`${origin}/${key}.txt`)).status, 404);
});

test("IndexNow startup rejects invalid configured verification keys", () => {
  for (const key of [
    "",
    "short",
    "a".repeat(129),
    "../unsafe-key",
    "invalid_key",
    "key with spaces",
  ])
    assert.throws(
      () => createWebServer({ env: { ...env, INDEXNOW_KEY: key } }),
      /INDEXNOW_KEY/,
    );
});

test("CSP permits only the explicit storage origin", async () => {
  const response = await fetch(`${origin}/healthz`);
  const policy = response.headers.get("content-security-policy");
  assert.ok(
    policy.includes(
      "media-src 'self' blob: https://fixture.r2.cloudflarestorage.com",
    ),
  );
  assert.ok(policy.includes(" https://fixture.r2.cloudflarestorage.com "));
  assert.ok(!policy.includes("*."));
  assert.ok(!policy.includes("amazonaws"));
});

test("CSP permits the exact public YouTube thumbnail origin without a wildcard", async () => {
  const response = await fetch(`${origin}/healthz`);
  const sources = response.headers
    .get("content-security-policy")
    .split("; ")
    .find((directive) => directive.startsWith("img-src "))
    .split(" ");
  assert.deepEqual(sources, [
    "img-src",
    "'self'",
    "data:",
    "https://www.gstatic.com",
    "https://accounts.google.com",
    "https://i.ytimg.com",
  ]);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});
test("requires a safe explicit media origin", () => {
  for (const value of [
    undefined,
    "",
    "http://storage.example.com",
    "https://user:password@storage.example.com",
    "https://storage.example.com/music-mute",
    "https://storage.example.com/?token=secret",
    "https://storage.example.com/#fragment",
  ])
    assert.throws(
      () => createWebServer({ env: { ...env, PUBLIC_MEDIA_ORIGIN: value } }),
      /PUBLIC_MEDIA_ORIGIN/,
    );
});

test("deployment checks return uncached HTML with a build version", async () => {
  const response = await fetch(`${origin}/?deployment-check=123`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(
    await response.text(),
    /name="musicmute-build" content="[a-f0-9-]{36}"/,
  );
});

async function startAuthServer(t, authFetch, options = {}) {
  const helperServer = createWebServer({
    env: { ...env, PUBLIC_FIREBASE_AUTH_DOMAIN: "app.music-mute.com" },
    authFetch,
    ...options,
  });
  await new Promise((resolve) => helperServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => helperServer.close(resolve)));
  return `http://127.0.0.1:${helperServer.address().port}`;
}

function rawRequest(origin, path, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(origin, { path, ...options }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    request.on("error", reject);
    request.end(options.body);
  });
}

test("Firebase helper forwards the exact query only to the configured project", async (t) => {
  const calls = [];
  const helperOrigin = await startAuthServer(t, async (...args) => {
    calls.push(args);
    return new Response('<script src="handler.js"></script>', {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  });
  const query =
    "?apiKey=public-key&redirectUrl=https%3A%2F%2Fapp.music-mute.com%2F&eventId=one%2Btwo&target=https://attacker.example";
  const response = await fetch(`${helperOrigin}/__/auth/handler${query}`, {
    headers: {
      Cookie: "application-session=private",
      Authorization: "Bearer private",
      "X-Forwarded-Host": "attacker.example",
    },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<script src="handler.js"></script>');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0][0],
    `https://example.firebaseapp.com/__/auth/handler${query}`,
  );
  assert.equal(calls[0][1].redirect, "manual");
  assert.equal(calls[0][1].headers.cookie, undefined);
  assert.equal(calls[0][1].headers.authorization, undefined);
  assert.equal(calls[0][1].headers["x-forwarded-host"], undefined);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("Firebase OAuth callbacks preserve POST bytes and content type", async (t) => {
  const body = "state=one%2Btwo&credential=fixture-token";
  let forwarded;
  const helperOrigin = await startAuthServer(t, async (url, options) => {
    forwarded = { url, options };
    return new Response("callback", {
      headers: { "Content-Type": "text/html" },
    });
  });
  const response = await fetch(
    `${helperOrigin}/__/auth/handler?eventId=fixture`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  assert.equal(response.status, 200);
  assert.equal(forwarded.options.method, "POST");
  assert.equal(forwarded.options.body.toString(), body);
  assert.equal(
    forwarded.options.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
});

test("Firebase helper preserves upstream status and provider redirect headers", async (t) => {
  const helperOrigin = await startAuthServer(t, async (url) => {
    return url.endsWith("handler")
      ? new Response(null, {
          status: 302,
          headers: { Location: "https://accounts.google.com/o/oauth2/auth" },
        })
      : new Response("Firebase is unavailable", {
          status: 503,
          headers: {
            "Content-Type": "text/plain",
            "Retry-After": "5",
            "Set-Cookie": "unrelated=private",
            "Content-Encoding": "gzip",
          },
        });
  });
  const redirect = await fetch(`${helperOrigin}/__/auth/handler`, {
    redirect: "manual",
  });
  assert.equal(redirect.status, 302);
  assert.equal(
    redirect.headers.get("location"),
    "https://accounts.google.com/o/oauth2/auth",
  );
  const unavailable = await fetch(`${helperOrigin}/__/auth/iframe.js`);
  assert.equal(unavailable.status, 503);
  assert.equal(await unavailable.text(), "Firebase is unavailable");
  assert.equal(unavailable.headers.get("content-type"), "text/plain");
  assert.equal(unavailable.headers.get("retry-after"), "5");
  assert.equal(unavailable.headers.get("set-cookie"), null);
  assert.equal(unavailable.headers.get("content-encoding"), null);
});

test("Firebase helper CSP and framing are scoped without changing app policy", async (t) => {
  const helperOrigin = await startAuthServer(
    t,
    async () =>
      new Response("helper", { headers: { "Content-Type": "text/html" } }),
  );
  const handler = await fetch(`${helperOrigin}/__/auth/handler`);
  assert.equal(handler.headers.get("content-security-policy"), null);
  assert.equal(handler.headers.get("x-frame-options"), "DENY");
  const iframe = await fetch(`${helperOrigin}/__/auth/iframe?apiKey=fixture`);
  assert.equal(iframe.headers.get("content-security-policy"), null);
  assert.equal(iframe.headers.get("x-frame-options"), "SAMEORIGIN");
  const app = await fetch(`${helperOrigin}/healthz`);
  assert.match(
    app.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.match(
    app.headers.get("content-security-policy"),
    /frame-src https:\/\/app\.music-mute\.com /,
  );
  assert.equal(app.headers.get("x-frame-options"), "DENY");
});

test("Firebase's own helper CSP is retained when upstream supplies one", async (t) => {
  const policy = "script-src 'nonce-firebase-auth-helper'; object-src 'none'";
  const helperOrigin = await startAuthServer(
    t,
    async () =>
      new Response("helper", {
        headers: { "Content-Security-Policy": policy },
      }),
  );
  const response = await fetch(`${helperOrigin}/__/auth/handler`);
  assert.equal(response.headers.get("content-security-policy"), policy);
});

test("Firebase helper allows only exact known paths and GET/HEAD/POST methods", async (t) => {
  let calls = 0;
  const helperOrigin = await startAuthServer(t, async (url, options) => {
    calls++;
    return new Response(options.method === "HEAD" ? null : "helper", {
      headers: { "Content-Type": "text/javascript" },
    });
  });
  for (const path of [
    "/__/auth/handler.js",
    "/__/auth/experiments.js",
    "/__/auth/iframe.js",
    "/__/auth/links",
    "/__/auth/links.js",
  ]) {
    assert.equal((await fetch(`${helperOrigin}${path}`)).status, 200);
  }
  const head = await fetch(`${helperOrigin}/__/auth/iframe`, {
    method: "HEAD",
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const expectedCalls = calls;
  for (const path of [
    "/__/auth/unknown",
    "/__/auth/handler/",
    "/__/auth/%68andler",
    "/__%2fauth/handler",
    "/__/auth/../auth/handler",
    "/__/auth/%2e%2e/auth/handler",
  ]) {
    assert.equal((await rawRequest(helperOrigin, path)).status, 404, path);
  }
  for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await fetch(`${helperOrigin}/__/auth/handler`, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD, POST");
  }
  assert.equal(calls, expectedCalls);
  assert.equal(
    (await fetch(`${helperOrigin}/healthz`, { method: "POST" })).status,
    405,
  );
});

test("Firebase init config uses current public runtime settings without an upstream request", async (t) => {
  const helperOrigin = await startAuthServer(t, () => {
    throw new Error("Init configuration must not fetch upstream.");
  });
  const response = await fetch(`${helperOrigin}/__/firebase/init.json`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await response.json(), {
    ...publicConfig(env).firebase,
    authDomain: "app.music-mute.com",
  });
  assert.equal(
    (
      await fetch(`${helperOrigin}/__/firebase/init.json`, {
        method: "POST",
        body: "fixture",
      })
    ).status,
    405,
  );
});

test("unsafe Firebase project identifiers cannot create an arbitrary upstream host", () => {
  for (const projectId of [
    "attacker.example/",
    "example.firebaseapp.com",
    "../example",
    "example@attacker.example",
    "example?target=other",
    "example\r\nheader:value",
  ]) {
    assert.throws(
      () =>
        createWebServer({
          env: { ...env, PUBLIC_FIREBASE_PROJECT_ID: projectId },
        }),
      /PUBLIC_FIREBASE_PROJECT_ID/,
    );
  }
});

test("Firebase helper rejects oversized incoming OAuth bodies before forwarding", async (t) => {
  let calls = 0;
  const helperOrigin = await startAuthServer(t, async () => {
    calls++;
    return new Response("helper");
  });
  const response = await fetch(`${helperOrigin}/__/auth/handler`, {
    method: "POST",
    body: "x".repeat(1024 * 1024 + 1),
  });
  assert.equal(response.status, 413);
  assert.equal(await response.text(), "Authentication is unavailable.");
  assert.equal(calls, 0);
});

test("Firebase helper bounds upstream responses and keeps failure details private", async (t) => {
  const helperOrigin = await startAuthServer(t, async (url) => {
    if (url.endsWith("handler")) throw new Error("secret upstream token");
    return new Response("x".repeat(2 * 1024 * 1024 + 1));
  });
  for (const path of ["handler", "iframe.js"]) {
    const response = await fetch(`${helperOrigin}/__/auth/${path}`);
    assert.equal(response.status, 502);
    assert.equal(await response.text(), "Authentication is unavailable.");
  }
});

test("Firebase helper also bounds OAuth bodies without Content-Length", async (t) => {
  let calls = 0;
  const helperOrigin = await startAuthServer(t, async () => {
    calls++;
    return new Response("helper");
  });
  const response = await rawRequest(helperOrigin, "/__/auth/handler", {
    method: "POST",
    headers: { "Transfer-Encoding": "chunked" },
    body: "x".repeat(1024 * 1024 + 1),
  });
  assert.equal(response.status, 413);
  assert.equal(calls, 0);
});

test("Firebase helper aborts stalled upstream requests within its deadline", async (t) => {
  let aborted = false;
  const helperOrigin = await startAuthServer(
    t,
    (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        });
      }),
    { authTimeoutMs: 20 },
  );
  const response = await fetch(`${helperOrigin}/__/auth/handler`);
  assert.equal(response.status, 504);
  assert.equal(await response.text(), "Authentication is unavailable.");
  assert.equal(aborted, true);
});

test("Firebase helper deadline covers a stalled response body", async (t) => {
  const helperOrigin = await startAuthServer(
    t,
    async (url, { signal }) =>
      new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () =>
              controller.error(signal.reason),
            );
          },
        }),
      ),
    { authTimeoutMs: 20 },
  );
  const response = await fetch(`${helperOrigin}/__/auth/iframe.js`);
  assert.equal(response.status, 504);
  assert.equal(await response.text(), "Authentication is unavailable.");
});

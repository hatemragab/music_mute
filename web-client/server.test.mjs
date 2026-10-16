import { after, before, test } from "node:test";
import assert from "node:assert/strict";
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

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createWebServer, publicConfig } from "./server.mjs";

const env = {
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
  assert.equal(config.headers.get("cache-control"), "no-store");
  assert.match(await config.text(), /api\.example\.com/);
  assert.match(
    config.headers.get("content-security-policy"),
    /media-src 'self' https:\/\/music-remover\.s3\.us-east-2\.amazonaws\.com/,
  );
  const health = await fetch(`${origin}/healthz`);
  assert.equal(await health.text(), "ok");
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
  assert.match(html, /<title>MusicMute \| Voice-Only Audio<\/title>/);
  assert.match(html, /rel="canonical" href="https:\/\/app\.music-mute\.com\/"/);
  assert.match(html, /name="description"/);
  assert.match(html, /href="\/favicon\.png"/);
  const icon = await fetch(`${origin}/favicon.png`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type"), /image\/png/);
  const robots = await fetch(`${origin}/robots.txt`);
  assert.match(
    await robots.text(),
    /Sitemap: https:\/\/app\.music-mute\.com\/sitemap\.xml/,
  );
  const sitemap = await fetch(`${origin}/sitemap.xml`);
  assert.match(
    await sitemap.text(),
    /<loc>https:\/\/app\.music-mute\.com\/<\/loc>/,
  );
  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.headers.get("x-robots-tag"), "noindex");
});

test("opt-in acceleration allows only this bucket and keeps regional grants valid", async () => {
  const accelerated = createWebServer({
    env: { ...env, PUBLIC_MEDIA_ACCELERATION_ENABLED: "true" },
  });
  await new Promise((resolve) => accelerated.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${accelerated.address().port}/healthz`,
    );
    const policy = response.headers.get("content-security-policy");
    assert.ok(
      policy.includes(
        "media-src 'self' https://music-remover.s3.us-east-2.amazonaws.com https://music-remover.s3-accelerate.amazonaws.com",
      ),
    );
    assert.ok(!policy.includes("*.amazonaws"));
  } finally {
    await new Promise((resolve) => accelerated.close(resolve));
  }
});
test("rejects unsafe media origins and unsupported acceleration configuration", () => {
  for (const value of [
    "https://user:password@s3.example.com",
    "https://s3.example.com/?token=secret",
    "https://s3.example.com/#fragment",
  ])
    assert.throws(() =>
      createWebServer({ env: { ...env, PUBLIC_MEDIA_ORIGIN: value } }),
    );
  assert.throws(() =>
    createWebServer({
      env: { ...env, PUBLIC_MEDIA_ACCELERATION_ENABLED: "maybe" },
    }),
  );
  assert.throws(() =>
    createWebServer({
      env: {
        ...env,
        PUBLIC_MEDIA_ACCELERATION_ENABLED: "true",
        PUBLIC_MEDIA_ORIGIN: "https://cdn.example.com",
      },
    }),
  );
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { buildRuntimeConfig, runtimeConfigScript } from "../../server.mjs";

describe("CapRover runtime server configuration", () => {
  const productionEnvironment = {
    APP_ENV: "production",
    NODE_ENV: "production",
  };

  it("builds validated public browser configuration from container variables", () => {
    assert.deepEqual(
      buildRuntimeConfig({
        ...productionEnvironment,
        VITE_API_ORIGIN: "https://api.musicmute.example/",
        VITE_APP_BASE_PATH: "/operations",
        VITE_FIREBASE_API_KEY: "public-key",
        VITE_FIREBASE_AUTH_DOMAIN: "musicmute.firebaseapp.com",
        VITE_FIREBASE_PROJECT_ID: "musicmute",
        VITE_FIREBASE_APP_ID: "1:123:web:456",
      }),
      {
        apiOrigin: "https://api.musicmute.example",
        basePath: "/operations/",
        firebase: {
          apiKey: "public-key",
          authDomain: "musicmute.firebaseapp.com",
          projectId: "musicmute",
          appId: "1:123:web:456",
        },
      },
    );
  });

  it("fails startup when a required CapRover variable is missing", () => {
    assert.throws(
      () => buildRuntimeConfig(productionEnvironment),
      /VITE_API_ORIGIN is required/,
    );
  });

  it("requires the same production profile pairing as the backend", () => {
    assert.throws(
      () =>
        buildRuntimeConfig({
          APP_ENV: "production",
          NODE_ENV: "development",
        }),
      /APP_ENV and NODE_ENV disagree/,
    );
    assert.throws(
      () => buildRuntimeConfig({ APP_ENV: "local", NODE_ENV: "development" }),
      /requires APP_ENV=production/,
    );
  });

  it("rejects an API path that would otherwise be silently discarded", () => {
    assert.throws(
      () =>
        buildRuntimeConfig({
          ...productionEnvironment,
          VITE_API_ORIGIN: "https://api.musicmute.example/api/v1",
        }),
      /HTTPS origin/,
    );
  });

  it("escapes script-breaking characters in generated runtime config", () => {
    const script = runtimeConfigScript({
      apiOrigin: "https://api.musicmute.example",
      basePath: "/</script>/",
      firebase: null,
    });

    assert.equal(script.includes("</script>"), false);
    assert.equal(script.includes("\\u003c/script\\u003e"), true);
  });
});

describe("production dashboard server", () => {
  const port = 4189;
  let child;

  const sendRawRequest = (request) =>
    new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port });
      let response = "";
      socket.setEncoding("utf8");
      socket.once("connect", () => socket.end(request));
      socket.on("data", (chunk) => {
        response += chunk;
      });
      socket.once("end", () => resolve(response));
      socket.once("error", reject);
    });

  before(async () => {
    child = spawn(process.execPath, [join(process.cwd(), "server.mjs")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        APP_ENV: "production",
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: String(port),
        VITE_API_ORIGIN: "https://api.musicmute.example",
        VITE_APP_BASE_PATH: "/operations",
        VITE_FIREBASE_API_KEY: "public-key",
        VITE_FIREBASE_AUTH_DOMAIN: "musicmute.firebaseapp.com",
        VITE_FIREBASE_PROJECT_ID: "musicmute",
        VITE_FIREBASE_APP_ID: "1:123:web:456",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Dashboard server did not start.")),
        5_000,
      );
      child.once("exit", (code) =>
        reject(new Error(`Dashboard server exited with ${code}.`)),
      );
      child.stdout.on("data", (chunk) => {
        if (!String(chunk).includes("listening")) return;
        clearTimeout(timer);
        resolve();
      });
    });
  });

  after(() => {
    child?.kill("SIGTERM");
  });

  it("serves health, runtime configuration and SPA fallback under the configured path", async () => {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    const contentSecurityPolicy =
      health.headers.get("content-security-policy") ?? "";
    assert.match(contentSecurityPolicy, /default-src 'self'/);
    assert.match(
      contentSecurityPolicy,
      /script-src 'self' https:\/\/apis\.google\.com(?:;|$)/,
    );
    assert.equal(
      health.headers.get("strict-transport-security"),
      "max-age=31536000",
    );
    const runtime = await fetch(
      `http://127.0.0.1:${port}/operations/runtime-config.js`,
    );
    assert.equal(runtime.headers.get("cache-control"), "no-store");
    assert.match(await runtime.text(), /https:\/\/api\.musicmute\.example/);
    const route = await fetch(
      `http://127.0.0.1:${port}/operations/jobs/example`,
    );
    assert.equal(route.status, 200);
    assert.match(await route.text(), /<base href="\/operations\/">/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/outside`)).status, 404);
  });

  it("does not trust a malformed Host header when parsing the request target", async () => {
    const response = await sendRawRequest(
      "GET /healthz HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n",
    );

    assert.match(response, /^HTTP\/1\.1 200 /);
    assert.equal(child.exitCode, null);
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  });

  it("does not serve SPA HTML for hidden paths", async () => {
    for (const path of [".env", ".git/HEAD"]) {
      const response = await fetch(
        `http://127.0.0.1:${port}/operations/${path}`,
      );
      assert.equal(response.status, 404, path);
      assert.equal(await response.text(), "");
    }
  });

  it("returns 404 for missing static assets", async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/operations/favicon.ico`,
    );
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "");
  });

  it("contains no local E2E identity implementation in production assets", () => {
    const assets = join(process.cwd(), "dist", "assets");
    const bundle = readdirSync(assets)
      .map((name) => readFileSync(join(assets, name), "utf8"))
      .join("\n");
    for (const marker of [
      "musicmute:e2e-role",
      "owner-fixture@example.invalid",
      "No signed-in test session",
    ]) {
      assert.equal(bundle.includes(marker), false, `found ${marker}`);
    }
  });
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createLandingServer } from "./server.mjs";

describe("MusicMute landing server", () => {
  const audioFixture = Buffer.from([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x4d, 0x75, 0x73, 0x69, 0x63, 0x21,
  ]);
  const webmFixture = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81,
  ]);
  let baseUrl;
  let directory;
  let server;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "musicmute-landing-server-"));
    await mkdir(join(directory, "assets"));
    await mkdir(join(directory, "audio"));
    await writeFile(
      join(directory, "index.html"),
      "<!doctype html><h1>MusicMute</h1>",
    );
    await mkdir(join(directory, "ar"));
    await writeFile(
      join(directory, "ar", "index.html"),
      '<!doctype html><html lang="ar"><h1>ميوزك ميوت</h1></html>',
    );
    await writeFile(join(directory, "assets", "index-123.js"), "export {};\n");
    await writeFile(join(directory, "audio", "voice-only.mp3"), audioFixture);
    await writeFile(join(directory, "audio", "original.webm"), webmFixture);
    await writeFile(join(directory, "robots.txt"), "User-agent: *\nAllow: /\n");
    server = createLandingServer({ dist: directory });
    await new Promise((resolvePromise) =>
      server.listen(0, "127.0.0.1", resolvePromise),
    );
    const address = server.address();
    assert.equal(typeof address, "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    await rm(directory, { recursive: true, force: true });
  });

  test("serves the root with security and no-store headers", async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(
      response.headers.get("content-security-policy"),
      /default-src 'self'/,
    );
    assert.match(
      response.headers.get("content-security-policy"),
      /media-src 'self'/,
    );
    assert.match(await response.text(), /MusicMute/);
  });

  test("serves health without exposing it to search engines", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-robots-tag"), "noindex");
    assert.equal(await response.text(), "ok");
  });

  test("serves the Arabic route and canonicalizes its trailing slash", async () => {
    const redirect = await fetch(`${baseUrl}/ar?source=test`, {
      redirect: "manual",
    });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), "/ar/?source=test");
    assert.equal(redirect.headers.get("cache-control"), "no-store");

    const arabic = await fetch(`${baseUrl}/ar/`);
    assert.equal(arabic.status, 200);
    assert.equal(arabic.headers.get("cache-control"), "no-store");
    assert.match(await arabic.text(), /lang="ar"/);
  });

  test("caches hashed assets immutably and crawl files conservatively", async () => {
    const asset = await fetch(`${baseUrl}/assets/index-123.js`);
    assert.equal(asset.status, 200);
    assert.equal(
      asset.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );

    const robots = await fetch(`${baseUrl}/robots.txt`);
    assert.equal(robots.status, 200);
    assert.equal(robots.headers.get("cache-control"), "no-cache");
  });

  test("supports HEAD and rejects mutations", async () => {
    const head = await fetch(`${baseUrl}/`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    const post = await fetch(`${baseUrl}/`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
  });

  test("serves the demo audio formats with streaming headers", async () => {
    for (const { pathname, type, fixture } of [
      {
        pathname: "/audio/original.webm",
        type: "audio/webm",
        fixture: webmFixture,
      },
      {
        pathname: "/audio/voice-only.mp3",
        type: "audio/mpeg",
        fixture: audioFixture,
      },
    ]) {
      const response = await fetch(`${baseUrl}${pathname}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), type);
      assert.equal(response.headers.get("accept-ranges"), "bytes");
      assert.equal(
        response.headers.get("content-length"),
        String(fixture.length),
      );
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture);
    }

    const head = await fetch(`${baseUrl}/audio/voice-only.mp3`, {
      method: "HEAD",
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "audio/mpeg");
    assert.equal(head.headers.get("accept-ranges"), "bytes");
    assert.equal(
      head.headers.get("content-length"),
      String(audioFixture.length),
    );
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  });

  test("serves closed, open, and suffix MP3 byte ranges", async () => {
    const cases = [
      {
        header: "bytes=2-5",
        start: 2,
        end: 5,
      },
      {
        header: "bytes=7-",
        start: 7,
        end: audioFixture.length - 1,
      },
      {
        header: "bytes=-3",
        start: audioFixture.length - 3,
        end: audioFixture.length - 1,
      },
      {
        header: "bytes=-999",
        start: 0,
        end: audioFixture.length - 1,
      },
      {
        header: "bytes=0-999",
        start: 0,
        end: audioFixture.length - 1,
      },
    ];

    for (const range of cases) {
      const response = await fetch(`${baseUrl}/audio/voice-only.mp3`, {
        headers: { Range: range.header },
      });
      assert.equal(response.status, 206, range.header);
      assert.equal(response.headers.get("accept-ranges"), "bytes");
      assert.equal(
        response.headers.get("content-range"),
        `bytes ${range.start}-${range.end}/${audioFixture.length}`,
      );
      assert.equal(
        response.headers.get("content-length"),
        String(range.end - range.start + 1),
      );
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        audioFixture.subarray(range.start, range.end + 1),
        range.header,
      );
    }
  });

  test("serves WebM audio byte ranges with the correct media type", async () => {
    const response = await fetch(`${baseUrl}/audio/original.webm`, {
      headers: { Range: "bytes=1-4" },
    });

    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-type"), "audio/webm");
    assert.equal(
      response.headers.get("content-range"),
      `bytes 1-4/${webmFixture.length}`,
    );
    assert.equal(response.headers.get("content-length"), "4");
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      webmFixture.subarray(1, 5),
    );
  });

  test("supports HEAD for MP3 ranges without sending a body", async () => {
    const response = await fetch(`${baseUrl}/audio/voice-only.mp3`, {
      method: "HEAD",
      headers: { Range: "bytes=1-4" },
    });
    assert.equal(response.status, 206);
    assert.equal(
      response.headers.get("content-range"),
      `bytes 1-4/${audioFixture.length}`,
    );
    assert.equal(response.headers.get("content-length"), "4");
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  });

  test("rejects malformed, unsatisfiable, and multiple MP3 ranges", async () => {
    for (const range of [
      "bytes=99-100",
      "bytes=5-4",
      "bytes=0-1,3-4",
      "bytes=-0",
      "bytes=-",
      "items=0-1",
    ]) {
      const response = await fetch(`${baseUrl}/audio/voice-only.mp3`, {
        headers: { Range: range },
      });
      assert.equal(response.status, 416, range);
      assert.equal(response.headers.get("accept-ranges"), "bytes");
      assert.equal(
        response.headers.get("content-range"),
        `bytes */${audioFixture.length}`,
      );
      assert.equal(response.headers.get("content-length"), "0");
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
  });

  test("returns 404 for unknown, hidden, and traversal paths", async () => {
    for (const pathname of [
      "/missing",
      "/.env",
      "/nested/.secret",
      "/%2e%2e/package.json",
    ]) {
      const response = await fetch(`${baseUrl}${pathname}`);
      assert.equal(response.status, 404, pathname);
    }
  });
});

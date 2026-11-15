import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { request, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScopedMediaServer } from "../src/main/player/media-server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(bytes = 10) {
  const root = await mkdtemp(
      join(tmpdir(), "musicmute-media-lifetime-matrix-"),
    ),
    path = join(root, "bounded.mp3"),
    writer = await open(path, "wx", 0o600);
  await writer.truncate(bytes);
  if (bytes === 10) await writer.write(Buffer.from("0123456789"), 0, 10, 0);
  await writer.close();
  const handle = await open(path, "r"),
    server = new ScopedMediaServer("musicmute://app", 60000),
    release = vi.fn(async () => {
      await handle.close();
    }),
    current = vi.fn(async () => {});
  await server.start();
  const grant = await server.issue(randomUUID(), {
    file: handle,
    bytes,
    mime: "audio/mpeg",
    current,
    release,
  });
  cleanup.push(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return { server, handle, release, current, grant };
}
function paused(url: string) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const client = request(
      url,
      { agent: false, headers: { Origin: "musicmute://app" } },
      (response) => {
        response.pause();
        response.on("error", () => {}); // Revocation intentionally destroys incomplete response bodies.
        resolve(response);
      },
    );
    client.on("error", reject);
    client.end();
  });
}

describe("W18 bounded real loopback range and consumer lifetime", () => {
  it.each([
    ["bytes=-3", 206, "789", "bytes 7-9/10"],
    ["bytes=4-", 206, "456789", "bytes 4-9/10"],
    ["bytes=0-999", 206, "0123456789", "bytes 0-9/10"],
  ] as const)(
    "serves %s with exact real byte bounds",
    async (range, status, body, contentRange) => {
      const f = await fixture(),
        response = await fetch(f.grant.url, {
          headers: { Origin: "musicmute://app", Range: range },
        });
      expect(response.status).toBe(status);
      expect(response.headers.get("Content-Range")).toBe(contentRange);
      expect(await response.text()).toBe(body);
      expect(f.release).not.toHaveBeenCalled();
    },
  );
  it.each([
    "bytes=10-",
    "bytes=5-2",
    "bytes=-0",
    "bytes=NaN-3",
    "bytes=0-1,4-5",
  ])(
    "refuses malformed/unsatisfiable %s without opening an arbitrary file",
    async (range) => {
      const f = await fixture(),
        response = await fetch(f.grant.url, { headers: { Range: range } });
      expect(response.status).toBe(416);
      expect(response.headers.get("Content-Range")).toBe("bytes */10");
      expect(await response.json()).toMatchObject({
        title: "MEDIA_UNAVAILABLE",
      });
      expect(f.release).not.toHaveBeenCalled();
    },
  );
  it("admits only the fixed origin/method/query and keeps HEAD/preflight independent of playback release", async () => {
    const f = await fixture(),
      preflight = await fetch(f.grant.url, {
        method: "OPTIONS",
        headers: { Origin: "musicmute://app" },
      }),
      head = await fetch(f.grant.url, {
        method: "HEAD",
        headers: { Range: "bytes=-2" },
      });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, HEAD",
    );
    expect(head.status).toBe(206);
    expect(head.headers.get("Content-Length")).toBe("2");
    expect(await head.text()).toBe("");
    expect((await fetch(f.grant.url, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${f.grant.url}&path=other.mp3`)).status).toBe(403);
    // Fetch normalizes Host; use actual bounded HTTP wire headers for this check.
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const client = request(
        f.grant.url,
        { headers: { Host: "attacker.invalid" } },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      client.on("error", reject);
      client.end();
    });
    expect(wrongHost).toBe(403);
    expect(f.release).not.toHaveBeenCalled();
  });
  it("bounds eight backpressured readers then revokes active streams before one descriptor release", async () => {
    const f = await fixture(16 * 1024 ** 2),
      streams: ReturnType<typeof f.handle.createReadStream>[] = [],
      read = f.handle.createReadStream.bind(f.handle);
    vi.spyOn(f.handle, "createReadStream").mockImplementation((options) => {
      const stream = read(options);
      streams.push(stream);
      return stream;
    });
    const readers = await Promise.all(
      Array.from({ length: 8 }, () => paused(f.grant.url)),
    );
    cleanup.push(async () => {
      for (const reader of readers) reader.destroy();
    });
    expect(readers.every((reader) => reader.statusCode === 200)).toBe(true);
    expect(streams).toHaveLength(8);
    expect(streams.every((stream) => !stream.destroyed)).toBe(true);
    expect((await fetch(f.grant.url)).status).toBe(429);
    expect(streams).toHaveLength(8);
    expect(f.release).not.toHaveBeenCalled();
    await Promise.all([f.grant.release(), f.grant.release()]);
    expect(f.release).toHaveBeenCalledOnce();
    expect(streams.every((stream) => stream.destroyed)).toBe(true);
    expect(f.handle.fd).toBe(-1);
    expect((await fetch(f.grant.url)).status).toBe(403);
  });
});

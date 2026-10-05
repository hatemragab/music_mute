import { describe, it, expect, afterEach, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  rm,
  symlink,
  link,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MediaServer, parseRange } from "../src/companion/media-server.js";
import {
  readPlaybackPins,
  withCacheMutation,
} from "../src/companion/cache-mutator.js";
import { makeOfflineSpace } from "../src/companion/cache-budget.js";

const roots: string[] = [],
  servers: MediaServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function pinnedFixture(duration?: number) {
  const root = await mkdtemp(join(tmpdir(), "mm-media-pin-"));
  roots.push(root);
  const key = "a".repeat(64),
    otherKey = "b".repeat(64);
  for (const cacheKey of [key, otherKey]) {
    const directory = join(root, "vocals", cacheKey);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "vocals.mp3"), "0123456789", {
      mode: 0o600,
    });
    await writeFile(join(directory, "result.json"), "{}", { mode: 0o600 });
  }
  const server = new MediaServer(
    "chrome-extension://" + "a".repeat(32),
    undefined,
    { cacheRoot: root, ...(duration ? { grantDurationMs: duration } : {}) },
  );
  servers.push(server);
  await server.start();
  return {
    root,
    key,
    otherKey,
    server,
    path: join(root, "vocals", key, "vocals.mp3"),
    otherPath: join(root, "vocals", otherKey, "vocals.mp3"),
  };
}
describe("disk media delivery", () => {
  it("supports bounded byte and suffix ranges and rejects malformed/multiple ranges", () => {
    expect(parseRange("bytes=2-4", 10)).toEqual({ start: 2, end: 4 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
    for (const value of [
      "bytes=20-30",
      "bytes=7-1",
      "bytes=1-2,5-6",
      "bytes=-0",
      "bytes=-",
    ])
      expect(parseRange(value, 10)).toBeNull();
  });
  it("requires origin and capability, implements HEAD/206/416, and revokes playback", async () => {
    const root = await mkdtemp(join(tmpdir(), "mm-range-"));
    const origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const server = new MediaServer(origin);
    try {
      const path = join(root, "audio.mp3");
      await writeFile(path, "0123456789");
      await server.start();
      const url = await server.issue(
        "11111111-1111-4111-8111-111111111111",
        path,
      );
      expect((await fetch(url)).status).toBe(200);
      expect(
        (await fetch(url, { headers: { Origin: "https://www.youtube.com" } }))
          .status,
      ).toBe(403);
      expect(
        (await fetch(url.replace(/capability=.*/, "capability=bad"))).status,
      ).toBe(403);
      expect(
        (
          await fetch(url.replace(/capability=.*/, "capability=bad"), {
            headers: { Origin: origin },
          })
        ).status,
      ).toBe(403);
      const range = await fetch(url, {
        headers: { Origin: origin, Range: "bytes=2-4" },
      });
      expect(range.status).toBe(206);
      expect(await range.text()).toBe("234");
      expect(range.headers.get("content-range")).toBe("bytes 2-4/10");
      const head = await fetch(url, {
        method: "HEAD",
        headers: { Origin: origin },
      });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe("10");
      expect(await head.text()).toBe("");
      expect(
        (await fetch(url, { headers: { Origin: origin, Range: "bytes=90-" } }))
          .status,
      ).toBe(416);
      await server.revoke();
      expect((await fetch(url, { headers: { Origin: origin } })).status).toBe(
        403,
      );
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("pins guest or account vocals before the grant and releases them before a cache clear", async () => {
    const env = await pinnedFixture();
    const url = await withCacheMutation(env.root, () =>
      env.server.issue("11111111-1111-4111-8111-111111111111", env.path),
    );
    expect(await readPlaybackPins(env.root)).toEqual(new Set([env.key]));
    await withCacheMutation(env.root, async () => {
      expect(
        await makeOfflineSpace(
          env.root,
          0,
          undefined,
          await readPlaybackPins(env.root),
          { clear: true },
        ),
      ).toMatchObject({ evicted_entries: 1, bytes: 12 });
    });
    expect(await readFile(env.path, "utf8")).toBe("0123456789");
    expect((await fetch(url)).status).toBe(200);
    await env.server.revoke();
    expect((await fetch(url)).status).toBe(403);
    expect(await readPlaybackPins(env.root)).toEqual(new Set());
    await withCacheMutation(env.root, async () => {
      expect(
        await makeOfflineSpace(
          env.root,
          0,
          undefined,
          await readPlaybackPins(env.root),
          { clear: true },
        ),
      ).toMatchObject({ evicted_entries: 1, bytes: 0 });
    });
  });
  it("keeps all-pinned budget admission bounded instead of unlinking served audio", async () => {
    const env = await pinnedFixture();
    await withCacheMutation(env.root, async () => {
      await env.server.issue("11111111-1111-4111-8111-111111111111", env.path);
      await env.server.issue(
        "22222222-2222-4222-8222-222222222222",
        env.otherPath,
      );
      await expect(
        makeOfflineSpace(
          env.root,
          1,
          undefined,
          await readPlaybackPins(env.root),
          { limit_bytes: 24 },
        ),
      ).rejects.toThrow("OFFLINE_CACHE_FULL");
    });
    expect(await readFile(env.path, "utf8")).toBe("0123456789");
    expect(await readFile(env.otherPath, "utf8")).toBe("0123456789");
    await env.server.close();
    expect(await readPlaybackPins(env.root)).toEqual(new Set());
  });
  it("replaces an old grant and its pin without retaining duplicate leases", async () => {
    const env = await pinnedFixture();
    const id = "11111111-1111-4111-8111-111111111111";
    const old = await env.server.issue(id, env.path);
    const current = await env.server.issue(id, env.otherPath);
    expect((await fetch(old)).status).toBe(403);
    expect((await fetch(current)).status).toBe(200);
    expect(await readPlaybackPins(env.root)).toEqual(new Set([env.otherKey]));
    expect(await readdir(join(env.root, "pins"))).toHaveLength(1);
  });
  it("releases an expired grant even if the helper stays alive", async () => {
    const env = await pinnedFixture(250);
    const url = await env.server.issue(
      "11111111-1111-4111-8111-111111111111",
      env.path,
    );
    expect(await readPlaybackPins(env.root)).toEqual(new Set([env.key]));
    await vi.waitFor(
      async () => expect(await readdir(join(env.root, "pins"))).toEqual([]),
      { timeout: 1000 },
    );
    expect((await fetch(url)).status).toBe(403);
  });
  it("drains a revoked in-flight pin without publishing a stale capability", async () => {
    const env = await pinnedFixture();
    const pending = env.server.issue(
      "11111111-1111-4111-8111-111111111111",
      env.path,
    );
    const result = expect(pending).rejects.toThrow("CANCELLED");
    await env.server.revoke();
    await result;
    expect(await readPlaybackPins(env.root)).toEqual(new Set());
    expect(await readdir(join(env.root, "pins"))).toEqual([]);
  });
  it("never publishes a grant for an arbitrary, symlinked, or externally linked audio path", async () => {
    const env = await pinnedFixture();
    const id = "11111111-1111-4111-8111-111111111111";
    await expect(
      env.server.issue(id, join(env.root, "arbitrary.mp3")),
    ).rejects.toThrow("CACHE_UNSAFE");
    await rm(env.path);
    await symlink(env.otherPath, env.path);
    await expect(env.server.issue(id, env.path)).rejects.toThrow(
      "CACHE_UNSAFE",
    );
    await rm(env.path);
    await link(env.otherPath, env.path);
    await expect(env.server.issue(id, env.path)).rejects.toThrow(
      "CACHE_UNSAFE",
    );
    expect(await readPlaybackPins(env.root)).toEqual(new Set());
    expect(await readFile(env.otherPath, "utf8")).toBe("0123456789");
  });
});

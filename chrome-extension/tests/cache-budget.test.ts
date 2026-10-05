import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCacheDirectory,
  makeOfflineSpace,
  offlineCacheBytes,
} from "../src/companion/cache-budget.js";
import { writeOfflineCacheBudget } from "../src/companion/cache-settings.js";
import { withCacheMutation } from "../src/companion/cache-mutator.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mm-budget-"));
  roots.push(root);
  const cache = join(root, "cache");
  const vocals = join(cache, "vocals");
  await mkdir(vocals, { recursive: true, mode: 0o700 });
  async function entry(label: string, bytes: number, updated: number) {
    const key = createHash("sha256").update(label).digest("hex");
    const path = join(vocals, key);
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "vocals.mp3"), Buffer.alloc(bytes - 2), {
      mode: 0o600,
    });
    await writeFile(join(path, "result.json"), "{}", { mode: 0o600 });
    await utimes(path, updated, updated);
    return { key, path };
  }
  return { root, cache, vocals, entry };
}

describe("shared offline vocals budget", () => {
  it("uses the decimal2GB default and allows persisted larger budgets without allocating media", async () => {
    const env = await fixture();
    expect(await makeOfflineSpace(env.cache, 1_500_000_000)).toEqual({
      bytes: 1_500_000_000,
      evicted_entries: 0,
    });
    await expect(makeOfflineSpace(env.cache, 2_000_000_001)).rejects.toThrow(
      "OFFLINE_CACHE_FULL",
    );
    await withCacheMutation(env.cache, () =>
      writeOfflineCacheBudget(env.cache, 4_000_000_000),
    );
    expect(await makeOfflineSpace(env.cache, 3_500_000_000)).toEqual({
      bytes: 3_500_000_000,
      evicted_entries: 0,
    });
    await expect(
      makeOfflineSpace(env.cache, 3_500_000_000, undefined, new Set(), {
        limit_bytes: 1_000_000_000,
      }),
    ).rejects.toThrow("OFFLINE_CACHE_FULL");
  });
  it("enforces a reduced saved limit on the next admission and preserves pinned sparse vocals", async () => {
    const env = await fixture();
    const oldest = await env.entry("oldest-sparse", 12, 1);
    const pinned = await env.entry("pinned-sparse", 12, 2);
    for (const entry of [oldest, pinned]) {
      const file = await open(join(entry.path, "vocals.mp3"), "r+");
      try {
        await file.truncate(750_000_000 - 2);
      } finally {
        await file.close();
      }
    }
    expect(await makeOfflineSpace(env.cache)).toEqual({
      bytes: 1_500_000_000,
      evicted_entries: 0,
    });
    await withCacheMutation(env.cache, () =>
      writeOfflineCacheBudget(env.cache, 1_000_000_000),
    );
    expect(await readdir(env.vocals)).toHaveLength(2);
    expect(
      await makeOfflineSpace(env.cache, 0, undefined, new Set([pinned.key])),
    ).toEqual({ bytes: 750_000_000, evicted_entries: 1 });
    expect(await readdir(env.vocals)).toEqual([pinned.key]);
  });
  it("reports owned metadata and unmanaged bytes without mutating or evicting files", async () => {
    const env = await fixture();
    const owned = await env.entry("owned", 12, 1);
    await mkdir(join(env.vocals, "user-data"));
    await writeFile(join(env.vocals, "user-data", "keep.txt"), "preserve");
    const names = await readdir(env.vocals);
    expect(await offlineCacheBytes(env.cache)).toBe(20);
    expect(await readdir(env.vocals)).toEqual(names);
    expect(await readFile(join(owned.path, "result.json"), "utf8")).toBe("{}");
    expect(await offlineCacheBytes(join(env.root, "missing"))).toBe(0);
    expect(await readdir(env.root)).not.toContain("missing");
  });
  it("counts metadata, evicts the least recent entry and protects pinned voices", async () => {
    const env = await fixture();
    const oldest = await env.entry("oldest", 12, 1);
    const recent = await env.entry("recent", 12, 3);
    const pinned = await env.entry("pinned", 12, 2);
    expect(
      await makeOfflineSpace(env.cache, 0, undefined, new Set([pinned.key]), {
        limit_bytes: 25,
      }),
    ).toEqual({ bytes: 24, evicted_entries: 1 });
    expect((await readdir(env.vocals)).sort()).toEqual(
      [recent.key, pinned.key].sort(),
    );
    expect(await readdir(env.vocals)).not.toContain(oldest.key);
    await expect(
      makeOfflineSpace(env.cache, 20, undefined, new Set([pinned.key]), {
        limit_bytes: 25,
      }),
    ).rejects.toThrow("OFFLINE_CACHE_FULL");
    expect(await readdir(env.vocals)).toEqual([pinned.key]);
  });
  it("reserves replacement bytes once and cannot evict the result being published", async () => {
    const env = await fixture();
    const kept = await env.entry("kept", 12, 1);
    const other = await env.entry("other", 12, 2);
    expect(
      await makeOfflineSpace(env.cache, 20, kept.path, new Set(), {
        limit_bytes: 25,
      }),
    ).toEqual({ bytes: 20, evicted_entries: 1 });
    expect(await readdir(env.vocals)).toEqual([kept.key]);
    expect(await readFile(join(kept.path, "result.json"), "utf8")).toBe("{}");
    expect(await readdir(env.vocals)).not.toContain(other.key);
  });
  it("refuses unexpected files in an owned hash entry without removing any audio", async () => {
    const env = await fixture();
    const entry = await env.entry("extra", 12, 1);
    await writeFile(join(entry.path, "unaccounted.bin"), Buffer.alloc(100), {
      mode: 0o600,
    });
    await expect(
      makeOfflineSpace(env.cache, 0, undefined, new Set(), {
        clear: true,
        limit_bytes: 25,
      }),
    ).rejects.toThrow("CACHE_UNSAFE");
    expect((await readdir(entry.path)).sort()).toEqual([
      "result.json",
      "unaccounted.bin",
      "vocals.mp3",
    ]);
  });
  it("preserves foreign data, counts its bytes and refuses unresolvable admission", async () => {
    const env = await fixture();
    await env.entry("evictable", 12, 1);
    const foreign = join(env.vocals, "user-data");
    await mkdir(join(foreign, "nested"), { recursive: true });
    await writeFile(join(foreign, "nested", "keep.txt"), "preserve");
    expect(
      await makeOfflineSpace(env.cache, 0, undefined, new Set(), {
        limit_bytes: 16,
      }),
    ).toEqual({ bytes: 8, evicted_entries: 1 });
    await expect(
      makeOfflineSpace(env.cache, 9, undefined, new Set(), {
        limit_bytes: 16,
      }),
    ).rejects.toThrow("OFFLINE_CACHE_FULL");
    expect(
      await makeOfflineSpace(env.cache, 0, undefined, new Set(), {
        limit_bytes: 16,
        clear: true,
      }),
    ).toEqual({ bytes: 8, evicted_entries: 0 });
    expect(await readFile(join(foreign, "nested", "keep.txt"), "utf8")).toBe(
      "preserve",
    );
  });
  it("does not follow unmanaged symlinks or create directories outside the cache", async () => {
    const env = await fixture();
    const outside = join(env.root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, "keep.txt"), "preserve", { mode: 0o600 });
    await symlink(outside, join(env.vocals, "unknown"));
    await expect(makeOfflineSpace(env.cache)).rejects.toThrow("CACHE_UNSAFE");
    await expect(
      assertCacheDirectory(env.cache, join(outside, "never"), true),
    ).rejects.toThrow("CACHE_UNSAFE");
    await expect(
      assertCacheDirectory(
        env.cache,
        join(env.vocals, "unknown", "never"),
        true,
      ),
    ).rejects.toThrow("CACHE_UNSAFE");
    expect(await readdir(outside)).toEqual(["keep.txt"]);
  });
});

import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readOfflineCacheBudget,
  writeOfflineCacheBudget,
} from "../src/companion/cache-settings.js";
import { withCacheMutation } from "../src/companion/cache-mutator.js";
import { MAX_OFFLINE_VOCALS_BUDGET_BYTES } from "../src/shared/storage-policy.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mm-cache-settings-"));
  roots.push(root);
  const cache = join(root, "cache");
  await mkdir(cache, { mode: 0o700 });
  return { root, cache, settings: join(cache, "offline-settings.json") };
}
const save = (cache: string, bytes: number) =>
  withCacheMutation(cache, () => writeOfflineCacheBudget(cache, bytes));

describe("shared offline storage settings", () => {
  it("defaults to decimal2GB without creating a file or missing cache directory", async () => {
    const e = await fixture();
    expect(await readOfflineCacheBudget(e.cache)).toBe(2_000_000_000);
    expect(await readOfflineCacheBudget(join(e.root, "missing"))).toBe(
      2_000_000_000,
    );
    expect(await readdir(e.cache)).toEqual([]);
    expect(await readdir(e.root)).toEqual(["cache"]);
  });
  it("persists private versioned settings atomically and observes subsequent saves", async () => {
    const e = await fixture();
    for (const bytes of [
      5_000_000_000,
      1_000_000_000,
      MAX_OFFLINE_VOCALS_BUDGET_BYTES,
    ]) {
      await save(e.cache, bytes);
      expect(await readOfflineCacheBudget(e.cache)).toBe(bytes);
      expect(JSON.parse(await readFile(e.settings, "utf8"))).toEqual({
        version: 1,
        budget_bytes: bytes,
      });
      expect((await lstat(e.settings)).mode & 0o777).toBe(0o600);
      expect(await readdir(e.cache)).toEqual(["offline-settings.json"]);
    }
  });
  it.each([
    0,
    -1,
    500_000_000,
    1_500_000_000,
    1_000_000_000.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
    MAX_OFFLINE_VOCALS_BUDGET_BYTES + 1_000_000_000,
  ])(
    "rejects invalid preference %s without replacing a saved budget",
    async (bytes) => {
      const e = await fixture();
      await save(e.cache, 3_000_000_000);
      await expect(save(e.cache, bytes)).rejects.toThrow("CACHE_LIMIT_INVALID");
      expect(await readOfflineCacheBudget(e.cache)).toBe(3_000_000_000);
      expect(await readdir(e.cache)).toEqual(["offline-settings.json"]);
    },
  );
  it.each([
    "not JSON",
    "[]",
    "null",
    JSON.stringify({ version: 2, budget_bytes: 2_000_000_000 }),
    JSON.stringify({ version: 1, budget_bytes: "2000000000" }),
    JSON.stringify({ version: 1, budget_bytes: 1_500_000_000 }),
    JSON.stringify({ version: 1, budget_bytes: 2_000_000_000, extra: true }),
    "x".repeat(1025),
  ])(
    "refuses malformed settings rather than silently resetting them: %s",
    async (raw) => {
      const e = await fixture();
      await writeFile(e.settings, raw, { mode: 0o600 });
      await expect(readOfflineCacheBudget(e.cache)).rejects.toThrow(
        "CACHE_UNSAFE",
      );
      await expect(save(e.cache, 3_000_000_000)).rejects.toThrow(
        "CACHE_UNSAFE",
      );
      expect(await readFile(e.settings, "utf8")).toBe(raw);
    },
  );
  it("refuses symlinked settings and preserves the target", async () => {
    const e = await fixture();
    const outside = join(e.root, "outside.json");
    await writeFile(
      outside,
      JSON.stringify({ version: 1, budget_bytes: 4_000_000_000 }),
      { mode: 0o600 },
    );
    await symlink(outside, e.settings);
    await expect(readOfflineCacheBudget(e.cache)).rejects.toThrow(
      "CACHE_UNSAFE",
    );
    await expect(save(e.cache, 3_000_000_000)).rejects.toThrow("CACHE_UNSAFE");
    expect(JSON.parse(await readFile(outside, "utf8")).budget_bytes).toBe(
      4_000_000_000,
    );
  });
  it("refuses linked or publicly readable settings and unsafe cache roots", async () => {
    const e = await fixture();
    await save(e.cache, 3_000_000_000);
    const linked = join(e.root, "linked.json");
    await link(e.settings, linked);
    await expect(readOfflineCacheBudget(e.cache)).rejects.toThrow(
      "CACHE_UNSAFE",
    );
    await rm(linked);
    await chmod(e.settings, 0o644);
    await expect(readOfflineCacheBudget(e.cache)).rejects.toThrow(
      "CACHE_UNSAFE",
    );
    await chmod(e.settings, 0o600);
    const alias = join(e.root, "alias");
    await symlink(e.cache, alias);
    await expect(readOfflineCacheBudget(alias)).rejects.toThrow("CACHE_UNSAFE");
    await chmod(e.cache, 0o755);
    await expect(readOfflineCacheBudget(e.cache)).rejects.toThrow(
      "CACHE_UNSAFE",
    );
    await expect(readOfflineCacheBudget("relative-cache")).rejects.toThrow(
      "CACHE_UNSAFE",
    );
  });
});

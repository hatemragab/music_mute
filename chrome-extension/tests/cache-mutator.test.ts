import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processStartIdentity } from "../src/companion/process-start.js";
import {
  readPlaybackPins,
  pinPlaybackHandoff,
  pinChromePlayback,
  withCacheMutation,
} from "../src/companion/cache-mutator.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: vi.fn(actual.link),
    lstat: vi.fn(actual.lstat),
    unlink: vi.fn(actual.unlink),
  };
});

vi.mock("../src/companion/process-start.js", async (original) => {
  const actual =
    await original<typeof import("../src/companion/process-start.js")>();
  return {
    ...actual,
    processStartIdentity: vi.fn(actual.processStartIdentity),
  };
});

const actualFs =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(link).mockReset();
  vi.mocked(lstat).mockReset();
  vi.mocked(unlink).mockReset();
  vi.mocked(processStartIdentity).mockClear();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mm-cache-lock-"));
  roots.push(root);
  return root;
}
describe("shared desktop and Chrome cache mutation", () => {
  it("refuses another live writer and releases ownership after failure", async () => {
    const root = await fixture();
    await expect(
      withCacheMutation(root, async () => {
        await expect(withCacheMutation(root, async () => 2)).rejects.toThrow(
          "LOCAL_COMPANION_BUSY",
        );
        throw new Error("fixture failure");
      }),
    ).rejects.toThrow("fixture failure");
    await expect(withCacheMutation(root, async () => 3)).resolves.toBe(3);
    await expect(readFile(join(root, ".mutation.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("never overwrites a foreign linked lock", async () => {
    const root = await fixture();
    const foreign = join(root, "foreign");
    await writeFile(foreign, "preserved", { mode: 0o600 });
    await symlink(foreign, join(root, ".mutation.lock"));
    await expect(withCacheMutation(root, async () => 1)).rejects.toThrow();
    expect(await readFile(foreign, "utf8")).toBe("preserved");
  });
  it.each([
    "before open",
    "during inspection",
    "during stale recheck",
    "during stale removal",
  ])(
    "retries a real lock handoff %s and cleans up ownership",
    async (stage) => {
      const root = await fixture();
      const path = join(root, ".mutation.lock");
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          pid: stage === "before open" ? process.pid : 2_147_483_647,
          nonce: randomUUID(),
        }),
        { mode: 0o600 },
      );
      let removed = false;
      let inspections = 0;
      if (stage === "before open") {
        vi.mocked(link).mockImplementation(async (source, destination) => {
          try {
            await actualFs.link(source, destination);
          } catch (error) {
            if (
              destination === path &&
              !removed &&
              (error as NodeJS.ErrnoException).code === "EEXIST"
            ) {
              await actualFs.unlink(path);
              removed = true;
            }
            throw error;
          }
        });
      } else if (stage === "during stale removal") {
        vi.mocked(unlink).mockImplementation(async (destination) => {
          if (destination === path && !removed) {
            await actualFs.unlink(path);
            removed = true;
          }
          await actualFs.unlink(destination);
        });
      } else {
        vi.mocked(lstat).mockImplementation(async (destination, options) => {
          if (destination === path) {
            inspections++;
            if (
              !removed &&
              inspections === (stage === "during inspection" ? 1 : 2)
            ) {
              await actualFs.unlink(path);
              removed = true;
            }
          }
          return actualFs.lstat(destination, options);
        });
      }
      const operation = vi.fn(async () => 7);
      await expect(withCacheMutation(root, operation)).resolves.toBe(7);
      expect(removed).toBe(true);
      expect(operation).toHaveBeenCalledOnce();
      expect(await readdir(root)).toEqual([]);
    },
  );
  it("refuses a genuine live holder immediately without touching its lock", async () => {
    const root = await fixture();
    const path = join(root, ".mutation.lock");
    const holder = JSON.stringify({
      version: 1,
      pid: process.pid,
      nonce: randomUUID(),
    });
    await writeFile(path, holder, { mode: 0o600 });
    vi.mocked(link).mockClear();
    const operation = vi.fn(async () => 1);
    await expect(withCacheMutation(root, operation)).rejects.toThrow(
      "LOCAL_COMPANION_BUSY",
    );
    expect(operation).not.toHaveBeenCalled();
    expect(vi.mocked(link)).toHaveBeenCalledOnce();
    expect(await readFile(path, "utf8")).toBe(holder);
    expect(await readdir(root)).toEqual([".mutation.lock"]);
  });
  it("preserves a replaced live inode during stale recovery", async () => {
    const root = await fixture();
    const path = join(root, ".mutation.lock");
    const retained = join(root, "retained-stale-lock");
    const stale = JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      nonce: randomUUID(),
    });
    const holder = JSON.stringify({
      version: 1,
      pid: process.pid,
      nonce: randomUUID(),
    });
    await writeFile(path, stale, { mode: 0o600 });
    let inspections = 0;
    vi.mocked(lstat).mockImplementation(async (destination, options) => {
      if (destination === path && ++inspections === 2) {
        await actualFs.rename(path, retained);
        await writeFile(path, holder, { mode: 0o600 });
      }
      return actualFs.lstat(destination, options);
    });
    const operation = vi.fn(async () => 1);
    await expect(withCacheMutation(root, operation)).rejects.toThrow(
      "CACHE_UNSAFE",
    );
    expect(operation).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe(holder);
    expect(await readFile(retained, "utf8")).toBe(stale);
    expect((await readdir(root)).sort()).toEqual([
      ".mutation.lock",
      "retained-stale-lock",
    ]);
  });
  it("refuses a competing live holder after stale removal", async () => {
    const root = await fixture();
    const path = join(root, ".mutation.lock");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        nonce: randomUUID(),
      }),
      { mode: 0o600 },
    );
    const holder = JSON.stringify({
      version: 1,
      pid: process.pid,
      nonce: randomUUID(),
    });
    let replaced = false;
    vi.mocked(unlink).mockImplementation(async (destination) => {
      await actualFs.unlink(destination);
      if (destination === path && !replaced) {
        await writeFile(path, holder, { mode: 0o600, flag: "wx" });
        replaced = true;
      }
    });
    const operation = vi.fn(async () => 1);
    await expect(withCacheMutation(root, operation)).rejects.toThrow(
      "LOCAL_COMPANION_BUSY",
    );
    expect(replaced).toBe(true);
    expect(operation).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe(holder);
    expect(await readdir(root)).toEqual([".mutation.lock"]);
  });
  it("bounds repeated disappearing-lock handoffs without leaving temporary files", async () => {
    const root = await fixture();
    const path = join(root, ".mutation.lock");
    let handoffs = 0;
    vi.mocked(link).mockImplementation(async (source, destination) => {
      if (destination === path) {
        await writeFile(
          path,
          JSON.stringify({
            version: 1,
            pid: process.pid,
            nonce: randomUUID(),
          }),
          { mode: 0o600, flag: "wx" },
        );
      }
      try {
        await actualFs.link(source, destination);
      } catch (error) {
        if (
          destination === path &&
          (error as NodeJS.ErrnoException).code === "EEXIST"
        ) {
          await actualFs.unlink(path);
          handoffs++;
        }
        throw error;
      }
    });
    const operation = vi.fn(async () => 1);
    await expect(withCacheMutation(root, operation)).rejects.toThrow(
      "LOCAL_COMPANION_BUSY",
    );
    expect(operation).not.toHaveBeenCalled();
    expect(handoffs).toBeGreaterThan(1);
    expect(handoffs).toBeLessThanOrEqual(3);
    expect(await readdir(root)).toEqual([]);
  });
  it("preserves a malformed private lock instead of treating it as a handoff", async () => {
    const root = await fixture();
    const path = join(root, ".mutation.lock");
    await writeFile(path, "not json", { mode: 0o600 });
    const operation = vi.fn(async () => 1);
    await expect(withCacheMutation(root, operation)).rejects.toThrow(
      "CACHE_UNSAFE",
    );
    expect(operation).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe("not json");
    expect(await readdir(root)).toEqual([".mutation.lock"]);
  });
  it("protects a live player without accepting arbitrary paths from pin records", async () => {
    const root = await fixture();
    const pins = join(root, "pins");
    await mkdir(pins, { mode: 0o700 });
    const path = join(pins, `playback-${randomUUID()}.json`);
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        cache_key: "a".repeat(64),
        pid: process.pid,
      }),
      { mode: 0o600 },
    );
    expect(await readPlaybackPins(root)).toEqual(new Set(["a".repeat(64)]));
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        cache_key: "/private/other.wav",
        pid: process.pid,
      }),
      { mode: 0o600 },
    );
    await expect(readPlaybackPins(root)).rejects.toThrow("CACHE_UNSAFE");
  });
  it("keeps a returned result pinned until the native player takes ownership", async () => {
    const root = await fixture();
    await pinPlaybackHandoff(root, "b".repeat(64));
    expect(await readPlaybackPins(root)).toEqual(new Set(["b".repeat(64)]));
    const path = join(root, "pins", `handoff-${randomUUID()}.json`);
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        cache_key: "c".repeat(64),
        pid: 2_147_483_647,
        expires_at: Date.now() + 30_000,
      }),
      { mode: 0o600 },
    );
    expect(await readPlaybackPins(root)).toEqual(
      new Set(["b".repeat(64), "c".repeat(64)]),
    );
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        cache_key: "c".repeat(64),
        pid: process.pid,
        expires_at: Date.now() - 1,
      }),
      { mode: 0o600 },
    );
    expect(await readPlaybackPins(root)).toEqual(new Set(["b".repeat(64)]));
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses out-of-range process identifiers before checking liveness", async () => {
    const root = await fixture();
    await mkdir(join(root, "pins"), { mode: 0o700 });
    const path = join(root, "pins", `playback-${randomUUID()}.json`);
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        cache_key: "d".repeat(64),
        pid: 2_147_483_648,
      }),
      { mode: 0o600 },
    );
    await expect(readPlaybackPins(root)).rejects.toThrow("CACHE_UNSAFE");
    expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(2_147_483_648);
  });
  it("durably protects a Chrome grant without persisting its path or capability", async () => {
    const root = await fixture();
    const lease = await withCacheMutation(root, () =>
      pinChromePlayback(root, "e".repeat(64), Date.now() + 60_000),
    );
    const names = await readdir(join(root, "pins"));
    expect(names).toHaveLength(1);
    const value = JSON.parse(
      await readFile(join(root, "pins", names[0]!), "utf8"),
    );
    expect(Object.keys(value).sort()).toEqual([
      "cache_key",
      "expires_at",
      "pid",
      "process_start_identity",
      "version",
    ]);
    expect(value.process_start_identity).toMatch(/^[a-f0-9]{64}$/);
    expect(await readPlaybackPins(root)).toEqual(new Set(["e".repeat(64)]));
    await lease.release();
    await lease.release();
    expect(await readdir(join(root, "pins"))).toEqual([]);
  });
  it("preserves unknown live identities and removes only a proven stale birth identity", async () => {
    const root = await fixture();
    await pinChromePlayback(root, "f".repeat(64), Date.now() + 60_000);
    vi.mocked(processStartIdentity).mockRejectedValueOnce(
      new Error("private upstream diagnostic must not escape"),
    );
    expect(await readPlaybackPins(root)).toEqual(new Set(["f".repeat(64)]));
    vi.mocked(processStartIdentity).mockResolvedValueOnce("0".repeat(64));
    expect(await readPlaybackPins(root)).toEqual(new Set());
    expect(await readdir(join(root, "pins"))).toEqual([]);
  });
  it("queries a host birth only once while reading multiple bounded grants", async () => {
    const root = await fixture();
    const leases = await Promise.all(
      ["a", "b", "c"].map((letter) =>
        pinChromePlayback(root, letter.repeat(64), Date.now() + 60_000),
      ),
    );
    vi.mocked(processStartIdentity).mockClear();
    expect(await readPlaybackPins(root)).toEqual(
      new Set(["a".repeat(64), "b".repeat(64), "c".repeat(64)]),
    );
    expect(processStartIdentity).toHaveBeenCalledTimes(1);
    await Promise.all(leases.map((lease) => lease.release()));
  });
  it("expires a bounded Chrome lease even when its process remains alive", async () => {
    const root = await fixture();
    await pinChromePlayback(root, "e".repeat(64), Date.now() + 60_000);
    const name = (await readdir(join(root, "pins")))[0]!;
    const path = join(root, "pins", name);
    const value = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      path,
      JSON.stringify({ ...value, expires_at: Date.now() - 1 }),
      { mode: 0o600 },
    );
    expect(await readPlaybackPins(root)).toEqual(new Set());
    expect(await readdir(join(root, "pins"))).toEqual([]);
  });
  it("recovers a crashed helper pin using an actual owned child PID and birth identity", async () => {
    const root = await fixture();
    await mkdir(join(root, "pins"), { mode: 0o700 });
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    await once(child, "spawn");
    const path = join(root, "pins", `playback-${randomUUID()}.json`);
    try {
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          cache_key: "a".repeat(64),
          pid: child.pid!,
          process_start_identity: await processStartIdentity(child.pid!),
          expires_at: Date.now() + 60_000,
        }),
        { mode: 0o600 },
      );
      expect(await readPlaybackPins(root)).toEqual(new Set(["a".repeat(64)]));
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    expect(await readPlaybackPins(root)).toEqual(new Set());
    expect(await readdir(join(root, "pins"))).toEqual([]);
  });
  it("never unlinks a replaced or externally linked pin while releasing ownership", async () => {
    const root = await fixture();
    const lease = await pinChromePlayback(
      root,
      "e".repeat(64),
      Date.now() + 60_000,
    );
    const path = join(root, "pins", (await readdir(join(root, "pins")))[0]!);
    const backup = join(root, "preserved-pin");
    await link(path, backup);
    await expect(lease.release()).rejects.toThrow("CACHE_UNSAFE");
    expect(await readFile(path)).toEqual(await readFile(backup));
    await rm(path);
    const foreign = join(root, "foreign-data");
    await writeFile(foreign, "preserved", { mode: 0o600 });
    await symlink(foreign, path);
    await expect(lease.release()).rejects.toThrow("CACHE_UNSAFE");
    expect(await readFile(foreign, "utf8")).toBe("preserved");
  });
  it("refuses unsafe and unbounded lease declarations before creating a pin", async () => {
    const root = await fixture();
    for (const [key, expiry] of [
      ["../other", Date.now() + 30_000],
      ["a".repeat(64), Date.now() - 1],
      ["a".repeat(64), Date.now() + 2 * 60 * 60_000],
    ] as const)
      await expect(pinChromePlayback(root, key, expiry)).rejects.toThrow(
        "CACHE_UNSAFE",
      );
    await expect(readdir(join(root, "pins"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("rejects malformed pin contents with a fixed error and preserves unknown data", async () => {
    const root = await fixture();
    await mkdir(join(root, "pins"), { mode: 0o700 });
    const path = join(root, "pins", `playback-${randomUUID()}.json`);
    const malformed = "private-url-and-capability { invalid json";
    await writeFile(path, malformed, { mode: 0o600 });
    await expect(readPlaybackPins(root)).rejects.toThrow(/^CACHE_UNSAFE$/);
    expect(await readFile(path, "utf8")).toBe(malformed);
  });
});

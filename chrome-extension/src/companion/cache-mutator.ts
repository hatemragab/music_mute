import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory } from "./app-setup.js";
import { processStartIdentity } from "./process-start.js";

export const PLAYBACK_GRANT_MAX_MS = 60 * 60_000;
const CACHE_LOCK_ATTEMPTS = 3;

function live(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
async function privateJson(path: string, maximum: number, links = 1) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    const named = await lstat(path);
    if (
      !info.isFile() ||
      info.nlink < 1 ||
      info.nlink > links ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      info.size > maximum ||
      named.isSymbolicLink() ||
      info.ino !== named.ino ||
      info.dev !== named.dev
    )
      throw new Error("CACHE_UNSAFE");
    let value: unknown;
    try {
      value = JSON.parse(await file.readFile("utf8"));
    } catch {
      throw new Error("CACHE_UNSAFE");
    }
    return { value, info };
  } finally {
    await file.close();
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Serializes cache publication/eviction across the desktop and Chrome helpers. */
export async function withCacheMutation<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  await privateDirectory(root);
  const path = join(root, ".mutation.lock");
  const temporary = join(root, `.mutation-${randomUUID()}.tmp`);
  const nonce = randomUUID();
  const file = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  let owned = false;
  let identity;
  try {
    await file.writeFile(
      JSON.stringify({ version: 1, pid: process.pid, nonce }),
    );
    await file.sync();
    identity = await file.stat();
    for (let attempt = 0; attempt < CACHE_LOCK_ATTEMPTS && !owned; attempt++) {
      try {
        await link(temporary, path);
        owned = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const current = await privateJson(path, 256, 2);
          if (
            !record(current.value) ||
            current.value.version !== 1 ||
            !Number.isSafeInteger(current.value.pid) ||
            Number(current.value.pid) < 1 ||
            Number(current.value.pid) > 2_147_483_647 ||
            typeof current.value.nonce !== "string" ||
            !/^[a-f0-9-]{36}$/.test(current.value.nonce)
          )
            throw new Error("CACHE_UNSAFE");
          if (live(Number(current.value.pid)))
            throw new Error("LOCAL_COMPANION_BUSY");
          const named = await lstat(path);
          if (named.ino !== current.info.ino || named.dev !== current.info.dev)
            throw new Error("CACHE_UNSAFE");
          await unlink(path);
        } catch (error) {
          // A release or another stale-lock recovery can remove the named lock.
          // Retry only that handoff; live or unsafe replacements still fail fast.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    if (!owned) throw new Error("LOCAL_COMPANION_BUSY");
    await unlink(temporary);
    return await operation();
  } finally {
    await file.close();
    if (owned) {
      const named = await lstat(path).catch(() => null);
      if (named?.ino === identity?.ino && named?.dev === identity?.dev)
        await unlink(path);
    }
    await unlink(temporary).catch(() => {});
  }
}

/** Native playback leases have no credentials and protect only existing hash keys. */
export async function readPlaybackPins(
  cacheRoot: string,
): Promise<Set<string>> {
  const root = join(cacheRoot, "pins");
  let names: string[];
  try {
    await privateDirectory(root);
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
  if (names.length > 256) throw new Error("CACHE_UNSAFE");
  const keys = new Set<string>();
  const identities = new Map<number, string | null | undefined>();
  for (const name of names) {
    if (!/^(playback|handoff)-[a-f0-9-]{36}\.json$/.test(name)) continue;
    const path = join(root, name);
    let pin;
    try {
      pin = await privateJson(path, 1024);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const { value, info } = pin;
    const handoff = name.startsWith("handoff-");
    const bounded = record(value) && value.process_start_identity !== undefined;
    if (
      !record(value) ||
      Object.keys(value).some(
        (key) =>
          ![
            "version",
            "cache_key",
            "pid",
            ...(handoff
              ? ["expires_at"]
              : ["expires_at", "process_start_identity"]),
          ].includes(key),
      ) ||
      value.version !== 1 ||
      typeof value.cache_key !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.cache_key) ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) < 1 ||
      Number(value.pid) > 2_147_483_647 ||
      (handoff &&
        (!Number.isSafeInteger(value.expires_at) ||
          Number(value.expires_at) > Date.now() + 60_000)) ||
      (!handoff &&
        (bounded
          ? typeof value.process_start_identity !== "string" ||
            !/^[a-f0-9]{64}$/.test(value.process_start_identity) ||
            !Number.isSafeInteger(value.expires_at) ||
            Number(value.expires_at) > Date.now() + PLAYBACK_GRANT_MAX_MS
          : value.expires_at !== undefined))
    )
      throw new Error("CACHE_UNSAFE");
    let active = handoff
      ? Number(value.expires_at) > Date.now()
      : live(Number(value.pid)) &&
        (!bounded || Number(value.expires_at) > Date.now());
    if (active && bounded) {
      // A failed OS query is uncertainty, never evidence that a player died.
      const pid = Number(value.pid);
      // Reuse a birth query across that host's grants and bound subprocess work.
      // Unqueried leases remain protected until their fixed expiry.
      if (!identities.has(pid) && identities.size < 8)
        identities.set(
          pid,
          await processStartIdentity(pid).catch(() => undefined),
        );
      const identity = identities.get(pid);
      active =
        identity === undefined || identity === value.process_start_identity;
    }
    if (active) keys.add(value.cache_key);
    else {
      const named = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!named) continue;
      if (named.ino !== info.ino || named.dev !== info.dev)
        throw new Error("CACHE_UNSAFE");
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  return keys;
}

export interface PlaybackPinLease {
  release(): Promise<void>;
}

/** Caller holds the cache lease until this credential-free pin is durable. */
export async function pinChromePlayback(
  cacheRoot: string,
  cacheKey: string,
  expiresAt: number,
): Promise<PlaybackPinLease> {
  if (
    !/^[a-f0-9]{64}$/.test(cacheKey) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + PLAYBACK_GRANT_MAX_MS
  )
    throw new Error("CACHE_UNSAFE");
  const identity = await processStartIdentity(process.pid);
  if (!identity) throw new Error("PROCESS_IDENTITY_UNAVAILABLE");
  await privateDirectory(cacheRoot);
  const root = join(cacheRoot, "pins");
  await privateDirectory(root);
  const id = randomUUID();
  const path = join(root, `playback-${id}.json`);
  const temporary = join(root, `.playback-${id}.tmp`);
  const file = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let published = false;
  let info;
  try {
    await file.writeFile(
      JSON.stringify({
        version: 1,
        cache_key: cacheKey,
        pid: process.pid,
        process_start_identity: identity,
        expires_at: expiresAt,
      }),
    );
    await file.sync();
    info = await file.stat();
    await rename(temporary, path);
    published = true;
    const directory = await open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (published) {
      const named = await lstat(path).catch(() => null);
      if (named?.ino === info?.ino && named?.dev === info?.dev)
        await unlink(path).catch(() => {});
    }
    throw error;
  } finally {
    await file.close();
    await unlink(temporary).catch(() => {});
  }
  const owned = info!;
  return {
    async release() {
      await privateDirectory(root);
      const named = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!named) return;
      if (
        named.isSymbolicLink() ||
        named.nlink !== 1 ||
        named.uid !== process.getuid?.() ||
        named.mode & 0o077 ||
        named.ino !== owned.ino ||
        named.dev !== owned.dev
      )
        throw new Error("CACHE_UNSAFE");
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      const directory = await open(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    },
  };
}

/** Protect the short gap between returning a path and AVPlayer acquiring its lease. */
export async function pinPlaybackHandoff(
  cacheRoot: string,
  cacheKey: string,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(cacheKey)) throw new Error("CACHE_UNSAFE");
  const root = join(cacheRoot, "pins");
  await privateDirectory(root);
  const file = await open(
    join(root, `handoff-${randomUUID()}.json`),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await file.writeFile(
      JSON.stringify({
        version: 1,
        cache_key: cacheKey,
        pid: process.pid,
        expires_at: Date.now() + 30_000,
      }),
    );
    await file.sync();
  } finally {
    await file.close();
  }
}

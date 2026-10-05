import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { privateDirectory } from "./app-setup.js";
import { MAX_OFFLINE_VOCALS_BUDGET_BYTES } from "../shared/storage-policy.js";
import { readOfflineCacheBudget } from "./cache-settings.js";

export async function assertCacheDirectory(
  cacheRoot: string,
  path: string,
  create = false,
): Promise<boolean> {
  if (!isAbsolute(cacheRoot) || !isAbsolute(path))
    throw new Error("CACHE_UNSAFE");
  const lexical = relative(cacheRoot, path);
  if (lexical.startsWith("..") || isAbsolute(lexical))
    throw new Error("CACHE_UNSAFE");
  if (create) {
    if (lexical !== "")
      await assertCacheDirectory(cacheRoot, dirname(path), true);
    try {
      await privateDirectory(path);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "LOCAL_DIRECTORY_NOT_PRIVATE"
      )
        throw new Error("CACHE_UNSAFE");
      throw error;
    }
  }
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077
  )
    throw new Error("CACHE_UNSAFE");
  const difference = relative(await realpath(cacheRoot), await realpath(path));
  if (difference.startsWith("..") || isAbsolute(difference))
    throw new Error("CACHE_UNSAFE");
  return true;
}
export async function cacheFileBytes(
  cacheRoot: string,
  path: string,
): Promise<number | null> {
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077
    )
      throw new Error("CACHE_UNSAFE");
    const difference = relative(
      await realpath(cacheRoot),
      await realpath(path),
    );
    if (difference.startsWith("..") || isAbsolute(difference))
      throw new Error("CACHE_UNSAFE");
    return info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export interface OfflineCacheBudgetOptions {
  limit_bytes?: number;
  clear?: boolean;
  onEvicted?: (bytes: number) => void;
}
// Foreign data is never removed. Count its bytes without following links so it
// cannot silently make the shared vocals directory exceed its budget.
async function unmanagedBytes(path: string): Promise<number> {
  const pending = [{ path, depth: 0 }];
  let files = 0;
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++files > 8192 || current.depth > 32) throw new Error("CACHE_UNSAFE");
    const info = await lstat(current.path);
    if (info.uid !== process.getuid?.() || info.isSymbolicLink())
      throw new Error("CACHE_UNSAFE");
    if (info.isDirectory()) {
      for (const name of await readdir(current.path))
        pending.push({
          path: join(current.path, name),
          depth: current.depth + 1,
        });
    } else if (info.isFile()) {
      bytes += info.size;
      if (!Number.isSafeInteger(bytes)) throw new Error("CACHE_UNSAFE");
    } else throw new Error("CACHE_UNSAFE");
  }
  return bytes;
}
interface OfflineEntry {
  path: string;
  key: string;
  bytes: number;
  updated: number;
}
async function offlineEntries(
  cacheRoot: string,
): Promise<{ entries: OfflineEntry[]; foreignBytes: number }> {
  const root = join(cacheRoot, "vocals");
  if (
    !(await assertCacheDirectory(cacheRoot, cacheRoot)) ||
    !(await assertCacheDirectory(cacheRoot, root))
  )
    return { entries: [], foreignBytes: 0 };
  const entries: OfflineEntry[] = [];
  let foreignBytes = 0;
  const names = await readdir(root);
  if (names.length > 8192) throw new Error("CACHE_UNSAFE");
  for (const name of names) {
    const path = join(root, name);
    if (!/^[a-f0-9]{64}$/.test(name)) {
      foreignBytes += await unmanagedBytes(path);
      if (!Number.isSafeInteger(foreignBytes)) throw new Error("CACHE_UNSAFE");
      continue;
    }
    await assertCacheDirectory(cacheRoot, path);
    const info = await lstat(path);
    const files = await readdir(path);
    if (files.some((file) => !["vocals.mp3", "result.json"].includes(file)))
      throw new Error("CACHE_UNSAFE");
    let bytes = 0;
    for (const file of files)
      bytes += (await cacheFileBytes(cacheRoot, join(path, file))) ?? 0;
    entries.push({ path, key: name, bytes, updated: info.mtimeMs });
  }
  return { entries, foreignBytes };
}
/** Read-only usage includes preserved unmanaged bytes and never evicts or creates files. */
export async function offlineCacheBytes(cacheRoot: string): Promise<number> {
  const { entries, foreignBytes } = await offlineEntries(cacheRoot);
  return (
    foreignBytes + entries.reduce((total, entry) => total + entry.bytes, 0)
  );
}
/** Call while holding the shared cache mutation lease; offline and temporary storage are distinct. */
export async function makeOfflineSpace(
  cacheRoot: string,
  incomingBytes = 0,
  keepRoot?: string,
  pinned: ReadonlySet<string> = new Set(),
  options: OfflineCacheBudgetOptions = {},
): Promise<{ bytes: number; evicted_entries: number }> {
  const limit =
    options.limit_bytes ?? (await readOfflineCacheBudget(cacheRoot));
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > MAX_OFFLINE_VOCALS_BUDGET_BYTES
  )
    throw new Error("CACHE_LIMIT_INVALID");
  if (
    !Number.isSafeInteger(incomingBytes) ||
    incomingBytes < 0 ||
    incomingBytes > MAX_OFFLINE_VOCALS_BUDGET_BYTES
  )
    throw new Error("CACHE_LIMIT_INVALID");
  const root = join(cacheRoot, "vocals");
  if (
    keepRoot !== undefined &&
    (relative(root, keepRoot).includes("/") ||
      !/^[a-f0-9]{64}$/.test(relative(root, keepRoot)))
  )
    throw new Error("CACHE_UNSAFE");
  const { entries, foreignBytes } = await offlineEntries(cacheRoot);
  let total =
    incomingBytes +
    foreignBytes +
    entries.reduce(
      (sum, entry) =>
        sum + (incomingBytes > 0 && entry.path === keepRoot ? 0 : entry.bytes),
      0,
    );
  if (!Number.isSafeInteger(total)) throw new Error("CACHE_LIMIT_INVALID");
  let evicted = 0;
  for (const entry of entries.sort((a, b) => a.updated - b.updated)) {
    if (entry.path === keepRoot || pinned.has(entry.key)) continue;
    if (options.clear || total > limit) {
      await assertCacheDirectory(cacheRoot, cacheRoot);
      await assertCacheDirectory(cacheRoot, root);
      await assertCacheDirectory(cacheRoot, entry.path);
      await rm(entry.path, { recursive: true, force: true });
      total -= entry.bytes;
      evicted++;
      options.onEvicted?.(total);
    }
  }
  if (!options.clear && total > limit) throw new Error("OFFLINE_CACHE_FULL");
  return { bytes: total, evicted_entries: evicted };
}

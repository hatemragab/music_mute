import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  isOfflineVocalsBudget,
  OFFLINE_VOCALS_BUDGET_BYTES,
} from "../shared/storage-policy.js";

const SETTINGS_FILE = "offline-settings.json";

async function settingsRoot(cacheRoot: string): Promise<boolean> {
  if (!isAbsolute(cacheRoot)) throw new Error("CACHE_UNSAFE");
  let info;
  try {
    info = await lstat(cacheRoot);
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
  return true;
}

/** Read on every admission so resident Chrome helpers observe desktop settings. */
export async function readOfflineCacheBudget(
  cacheRoot: string,
): Promise<number> {
  if (!(await settingsRoot(cacheRoot))) return OFFLINE_VOCALS_BUDGET_BYTES;
  const path = join(cacheRoot, SETTINGS_FILE);
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await file.stat();
    const named = await lstat(path);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      info.size > 1024 ||
      named.isSymbolicLink() ||
      named.ino !== info.ino ||
      named.dev !== info.dev
    )
      throw new Error("CACHE_UNSAFE");
    let value: unknown;
    try {
      value = JSON.parse(await file.readFile("utf8"));
    } catch {
      throw new Error("CACHE_UNSAFE");
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) => !["version", "budget_bytes"].includes(key),
      ) ||
      !("version" in value) ||
      value.version !== 1 ||
      !("budget_bytes" in value) ||
      !isOfflineVocalsBudget(value.budget_bytes)
    )
      throw new Error("CACHE_UNSAFE");
    return value.budget_bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return OFFLINE_VOCALS_BUDGET_BYTES;
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new Error("CACHE_UNSAFE");
    throw error;
  } finally {
    await file?.close();
  }
}

/** Caller holds the shared cache mutation lease. Saving a limit never evicts audio. */
export async function writeOfflineCacheBudget(
  cacheRoot: string,
  budgetBytes: number,
): Promise<void> {
  if (!isOfflineVocalsBudget(budgetBytes))
    throw new Error("CACHE_LIMIT_INVALID");
  if (!(await settingsRoot(cacheRoot))) throw new Error("CACHE_UNSAFE");
  // Refuse to replace unsafe files or malformed settings.
  await readOfflineCacheBudget(cacheRoot);
  const temporary = join(cacheRoot, `.offline-settings-${randomUUID()}.tmp`);
  const file = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(
      JSON.stringify({ version: 1, budget_bytes: budgetBytes }),
    );
    await file.sync();
    await settingsRoot(cacheRoot);
    await rename(temporary, join(cacheRoot, SETTINGS_FILE));
    const directory = await open(
      cacheRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await file.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

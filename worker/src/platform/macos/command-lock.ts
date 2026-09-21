import { open, readFile, stat, unlink } from "node:fs/promises";

const LOCK_LIMIT_BYTES = 1024;

export async function withMacUserCommandLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const handle = await acquire(path, true);
  const identity = await handle.stat();
  try {
    return await operation();
  } finally {
    await handle.close();
    await releaseIfSame(path, identity.dev, identity.ino);
  }
}

async function acquire(path: string, allowStaleRecovery: boolean) {
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({
          schemaVersion: 1,
          pid: process.pid,
          createdAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );
      await handle.sync();
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (
      !allowStaleRecovery ||
      (error as NodeJS.ErrnoException).code !== "EEXIST"
    )
      throw error;
    if (!(await staleLock(path)))
      throw new Error("Another MusicMute CLI operation is already running");
    await unlink(path);
    return await acquire(path, false);
  }
}

async function staleLock(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (
      !info.isFile() ||
      info.size < 2 ||
      info.size > LOCK_LIMIT_BYTES ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.()
    )
      return false;
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).schemaVersion !== 1 ||
      !Number.isSafeInteger((value as Record<string, unknown>).pid) ||
      ((value as Record<string, unknown>).pid as number) <= 0
    )
      return false;
    try {
      process.kill((value as Record<string, unknown>).pid as number, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}

async function releaseIfSame(
  path: string,
  device: number | bigint,
  inode: number | bigint,
): Promise<void> {
  try {
    const current = await stat(path);
    if (current.dev === device && current.ino === inode) await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

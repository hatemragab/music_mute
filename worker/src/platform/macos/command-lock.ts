import { open, readFile, lstat, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  DarwinFileLockBusyError,
  withDarwinFileLock,
} from "../../runtime/darwin-file-lock.js";

const LOCK_LIMIT_BYTES = 1024;

export class MacCommandBusyError extends Error {
  constructor(readonly operation?: string) {
    super("Another MusicMute CLI operation is already running");
  }
}

export async function withMacUserCommandLock<T>(
  path: string,
  operation: () => Promise<T>,
  purpose?: string,
): Promise<T> {
  if (process.platform === "darwin") {
    try {
      return await withDarwinFileLock(`${path}.guard`, () =>
        withLegacyCommandLock(path, operation, purpose),
      );
    } catch (error) {
      if (!(error instanceof DarwinFileLockBusyError)) throw error;
      const owner = await inspectLock(path);
      throw new MacCommandBusyError(
        owner && !owner.dead ? owner.operation : undefined,
      );
    }
  }
  return await withLegacyCommandLock(path, operation, purpose);
}

async function withLegacyCommandLock<T>(
  path: string,
  operation: () => Promise<T>,
  purpose?: string,
): Promise<T> {
  const handle = await acquire(path, true, purpose);
  const identity = await handle.stat();
  try {
    return await operation();
  } finally {
    await handle.close();
    await releaseIfSame(path, identity.dev, identity.ino);
  }
}

async function acquire(
  path: string,
  allowStaleRecovery: boolean,
  purpose?: string,
) {
  try {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({
          schemaVersion: 1,
          pid: process.pid,
          ...(purpose === undefined ? {} : { operation: purpose }),
          createdAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );
      await handle.sync();
      await link(temporary, path);
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    } finally {
      await unlink(temporary);
    }
  } catch (error) {
    if (
      !allowStaleRecovery ||
      (error as NodeJS.ErrnoException).code !== "EEXIST"
    )
      throw error;
    const owner = await inspectLock(path);
    if (owner === null)
      throw new Error("MusicMute CLI lock ownership is unknown");
    if (!owner.dead) throw new MacCommandBusyError(owner.operation);
    await unlink(path);
    return await acquire(path, false, purpose);
  }
}

async function inspectLock(
  path: string,
): Promise<{ dead: boolean; operation?: string } | null> {
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size < 2 ||
      info.size > LOCK_LIMIT_BYTES ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.()
    )
      return null;
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).schemaVersion !== 1 ||
      !Number.isSafeInteger((value as Record<string, unknown>).pid) ||
      ((value as Record<string, unknown>).pid as number) <= 0
    )
      return null;
    try {
      process.kill((value as Record<string, unknown>).pid as number, 0);
      const operation = (value as Record<string, unknown>).operation;
      return {
        dead: false,
        ...(typeof operation === "string" ? { operation } : {}),
      };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH"
        ? { dead: true }
        : null;
    }
  } catch {
    return null;
  }
}

async function releaseIfSame(
  path: string,
  device: number | bigint,
  inode: number | bigint,
): Promise<void> {
  try {
    const current = await lstat(path);
    if (current.dev === device && current.ino === inode) await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

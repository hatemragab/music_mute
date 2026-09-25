import { lstat, open, readFile, unlink, link } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DarwinFileLockBusyError,
  withDarwinFileLock,
} from "./darwin-file-lock.js";
import { setTimeout as delay } from "node:timers/promises";

const WAIT_MS = 5_000;
const RETRY_MS = 25;

export async function withDiagnosticStoreLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (process.platform !== "darwin")
    return await withWriterLock(root, operation);
  const deadline = Date.now() + WAIT_MS;
  while (true) {
    try {
      return await withDarwinFileLock(join(root, "writer.lock.guard"), () =>
        withWriterLock(root, operation),
      );
    } catch (error) {
      if (!(error instanceof DarwinFileLockBusyError)) throw error;
      if (Date.now() >= deadline) throw new Error("Diagnostic history is busy");
      await delay(RETRY_MS);
    }
  }
}

async function withWriterLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const path = join(root, "writer.lock");
  const deadline = Date.now() + WAIT_MS;
  let handle: Awaited<ReturnType<typeof open>>;
  while (true) {
    try {
      handle = await publishOwner(path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await staleLock(path)) continue;
      if (Date.now() >= deadline) throw new Error("Diagnostic history is busy");
      await delay(RETRY_MS);
    }
  }
  const identity = await handle.stat();
  try {
    return await operation();
  } finally {
    await handle.close();
    const current = await lstat(path).catch(() => null);
    if (current?.dev === identity.dev && current.ino === identity.ino)
      await unlink(path);
  }
}

async function staleLock(path: string): Promise<boolean> {
  const information = await lstat(path).catch(() => null);
  if (!information) return false;
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.size > 1_024 ||
    (process.platform !== "win32" && (information.mode & 0o077) !== 0)
  )
    return false;
  let pid: number | null = null;
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const candidate = (value as Record<string, unknown>).pid;
      if (Number.isSafeInteger(candidate) && (candidate as number) > 0)
        pid = candidate as number;
    }
  } catch {
    // An old incomplete lock is ambiguous, regardless of its age.
  }
  if (pid !== null) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
  } else {
    throw new Error(
      "Diagnostic lock ownership is unknown; operator recovery required",
    );
  }
  // Only reclaim under a kernel lock shared by all new macOS writers.
  if (process.platform !== "darwin") return false;
  const current = await lstat(path).catch(() => null);
  if (current?.dev !== information.dev || current.ino !== information.ino)
    return false;
  await unlink(path).catch(() => undefined);
  return true;
}

async function publishOwner(path: string) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`,
    );
    await handle.sync();
    await link(temporary, path);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  } finally {
    await unlink(temporary);
  }
}

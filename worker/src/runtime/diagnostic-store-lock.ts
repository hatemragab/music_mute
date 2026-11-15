import { lstat, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const WAIT_MS = 5_000;
const RETRY_MS = 25;
const STALE_INCOMPLETE_MS = 30_000;

export async function withDiagnosticStoreLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const path = join(root, "writer.lock");
  const deadline = Date.now() + WAIT_MS;
  let handle: Awaited<ReturnType<typeof open>>;
  while (true) {
    try {
      handle = await open(path, "wx", 0o600);
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
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`,
    );
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
    // A process may die before it writes its PID. Wait before reclaiming.
  }
  if (pid !== null) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
  } else if (Date.now() - information.mtimeMs < STALE_INCOMPLETE_MS) {
    return false;
  }
  const current = await lstat(path).catch(() => null);
  if (current?.dev !== information.dev || current.ino !== information.ino)
    return false;
  await unlink(path).catch(() => undefined);
  return true;
}

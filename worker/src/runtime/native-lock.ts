import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, win32 } from "node:path";
import {
  DarwinFileLockBusyError,
  withDarwinFileLock,
} from "./darwin-file-lock.js";

export class NativeLockBusyError extends Error {
  constructor() {
    super("Another MusicMute operation owns this lock");
  }
}

/**
 * Windows named-pipe bind uses FILE_FLAG_FIRST_PIPE_INSTANCE in libuv. The
 * exclusive kernel handle disappears when its process dies. No PID timeout,
 * lock-file deletion, subprocess or native addon is involved. This endpoint
 * transports no data and accepts no commands; every connection is closed.
 * Darwin retains its persistent-inode advisory lock.
 */
export async function withNativeLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!isAbsolute(path)) throw new TypeError("Lock path must be absolute");
  if (process.platform === "darwin") {
    try {
      return await withDarwinFileLock(path, operation);
    } catch (error) {
      if (error instanceof DarwinFileLockBusyError)
        throw new NativeLockBusyError();
      throw error;
    }
  }
  if (process.platform !== "win32")
    throw new TypeError("Native worker locks are unsupported on this platform");
  const parent = await realpath(dirname(path));
  const name = windowsLockPipeName(win32.join(parent, basename(path)));
  const server = createServer((socket) => socket.destroy());
  server.maxConnections = 1;
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE" ? new NativeLockBusyError() : error);
    });
    server.listen({ path: name, exclusive: true }, resolve);
  });
  try {
    return await operation();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

export function windowsLockPipeName(absolutePath: string): string {
  if (
    !win32.isAbsolute(absolutePath) ||
    !/^[A-Za-z]:\\/u.test(absolutePath) ||
    /[\0\r\n]/u.test(absolutePath)
  )
    throw new TypeError("Windows lock requires a local absolute path");
  const identity = win32.normalize(absolutePath).toLowerCase();
  const digest = createHash("sha256").update(identity).digest("hex");
  return `\\\\.\\pipe\\musicmute-lock-${digest}`;
}

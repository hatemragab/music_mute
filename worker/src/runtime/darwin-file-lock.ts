import { constants } from "node:fs";
import { open } from "node:fs/promises";

// Darwin sys/fcntl.h: O_EXLOCK is not exported in Node's fs.constants.
const O_EXLOCK = 0x00000020;

export class DarwinFileLockBusyError extends Error {
  constructor() {
    super("Local lifecycle update is already in progress");
  }
}

/** Persistent inode: never unlink this file, including after releasing its lock. */
export async function withDarwinFileLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (process.platform !== "darwin")
    throw new Error("Darwin advisory locks require macOS");
  const handle = await open(
    path,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      O_EXLOCK,
    0o600,
  ).catch((error: unknown) => {
    if (
      ["EAGAIN", "EWOULDBLOCK"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw new DarwinFileLockBusyError();
    throw error;
  });
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.()
    )
      throw new TypeError("Advisory lock file is unsafe");
    return await operation();
  } finally {
    await handle.close();
  }
}

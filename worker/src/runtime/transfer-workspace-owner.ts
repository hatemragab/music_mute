import { lstat, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Conservatively preserve a workspace until its transfer process has exited. */
export async function assertNoLiveTransfer(
  workspace: string,
  reclaim = false,
): Promise<void> {
  const path = join(workspace, "transfer-owner.json");
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 1024 ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new Error("Transfer ownership marker is unsafe");
  const marker = JSON.parse(await readFile(path, "utf8")) as {
    schemaVersion: number;
    pid: number;
  };
  if (
    marker.schemaVersion !== 1 ||
    !Number.isSafeInteger(marker.pid) ||
    marker.pid < 1
  )
    throw new Error("Transfer ownership marker is invalid");
  try {
    process.kill(marker.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    if (reclaim) await unlink(path);
    return;
  }
  throw new Error("Transfer process still owns the workspace");
}

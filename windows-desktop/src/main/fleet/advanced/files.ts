import { createHash, randomUUID } from "node:crypto";
import { lstat, open, rename, unlink, rmdir, readdir } from "node:fs/promises";
import { win32 } from "node:path";
import type { WindowsConsumerNative } from "../../../../../worker/src/platform/windows/consumer-native.js";
import type { FleetPrivateFiles } from "./inspection.js";
type Native = Pick<
  WindowsConsumerNative,
  "validatePath" | "ensurePrivateDirectory"
>;
export async function writeFleetAtomic(
  native: Native,
  root: string,
  relative: string,
  bytes: Buffer,
): Promise<void> {
  const temporary = `${relative}.${randomUUID()}.tmp`;
  await native.ensurePrivateDirectory("fleet", win32.dirname(relative));
  await native.validatePath("fleet", temporary, "absent");
  const file = await open(win32.join(root, temporary), "wx", 0o600);
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await lstat(win32.join(root, relative));
      await native.validatePath("fleet", relative, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await native.validatePath("fleet", relative, "absent");
    }
    await rename(win32.join(root, temporary), win32.join(root, relative));
    await native.validatePath("fleet", relative, "file");
  } finally {
    await unlink(win32.join(root, temporary)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}
export interface AdvancedRemovalEntry {
  relative: string;
  bytes: number;
  inode: string;
  device: string;
  written: string;
}
export interface AdvancedRemovalPlan {
  entries: AdvancedRemovalEntry[];
  directories: string[];
  bytes: number;
}
/** Fixed consumer namespaces only; all descendants are validated before any deletion. */
export async function inspectFleetRemoval(
  native: Native,
  root: string,
  relative:
    | "work"
    | "logs"
    | "state"
    | "reports"
    | "enrollment"
    | "consumer-config.json",
): Promise<AdvancedRemovalPlan> {
  const result: AdvancedRemovalPlan = {
    entries: [],
    directories: [],
    bytes: 0,
  };
  const visit = async (name: string, depth: number): Promise<void> => {
    if (depth > 6 || result.entries.length + result.directories.length >= 8192)
      throw new Error("ADVANCED_FILE_LIMIT");
    const stat = await lstat(win32.join(root, name), { bigint: true });
    if (stat.isSymbolicLink()) throw new Error("ADVANCED_FILE_INVALID");
    if (stat.isDirectory()) {
      await native.validatePath("fleet", name, "directory");
      const children = await readdir(win32.join(root, name));
      if (children.length > 8192) throw new Error("ADVANCED_FILE_LIMIT");
      for (const child of children) {
        if (
          !/^[A-Za-z0-9_.-]{1,160}$/u.test(child) ||
          child === "." ||
          child === ".."
        )
          throw new Error("ADVANCED_FILE_INVALID");
        await visit(`${name}\\${child}`, depth + 1);
      }
      result.directories.push(name);
      return;
    }
    await native.validatePath("fleet", name, "file");
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.ino === 0n ||
      stat.size > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error("ADVANCED_FILE_INVALID");
    result.bytes += Number(stat.size);
    if (result.bytes > 4 * 1024 ** 3) throw new Error("ADVANCED_FILE_LIMIT");
    result.entries.push({
      relative: name,
      bytes: Number(stat.size),
      inode: String(stat.ino),
      device: String(stat.dev),
      written: String(stat.mtimeNs),
    });
  };
  try {
    await visit(relative, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return result;
}
export async function applyFleetRemoval(
  native: Native,
  root: string,
  plan: AdvancedRemovalPlan,
  signal: AbortSignal,
): Promise<void> {
  for (const entry of plan.entries) {
    signal.throwIfAborted();
    await native.validatePath("fleet", entry.relative, "file");
    const stat = await lstat(win32.join(root, entry.relative), {
      bigint: true,
    });
    if (
      String(stat.ino) !== entry.inode ||
      String(stat.dev) !== entry.device ||
      String(stat.mtimeNs) !== entry.written ||
      Number(stat.size) !== entry.bytes ||
      stat.nlink !== 1n
    )
      throw new Error("ADVANCED_FILE_CHANGED");
    await unlink(win32.join(root, entry.relative));
  }
  for (const directory of plan.directories) {
    signal.throwIfAborted();
    await native.validatePath("fleet", directory, "directory");
    await rmdir(win32.join(root, directory));
  }
}
/** Clearing retains stream identity and sequence; readers see explicit incomplete coverage. */
export async function clearConsumerFleetLogs(
  native: Native,
  files: FleetPrivateFiles,
): Promise<{ filesCleared: number; bytesCleared: number }> {
  let names: string[];
  try {
    names = await files.names("logs");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { filesCleared: 0, bytesCleared: 0 };
    throw error;
  }
  const events = names.filter((name) =>
    /^(?:events-\d{12}|events)\.jsonl$/u.test(name),
  );
  let streamId: string;
  try {
    streamId = (await files.read("logs\\stream-id", 128))
      .toString("utf8")
      .trim();
  } catch {
    throw new Error("ADVANCED_LOG_HISTORY_INVALID");
  }
  if (!/^[a-f0-9-]{36}$/u.test(streamId))
    throw new Error("ADVANCED_LOG_HISTORY_INVALID");
  let nextSequence = 1;
  try {
    const history = JSON.parse(
      (await files.read("logs\\history.json", 4096)).toString("utf8"),
    ) as { streamId: string; nextSequence: number };
    if (
      history.streamId !== streamId ||
      !Number.isSafeInteger(history.nextSequence) ||
      history.nextSequence < 1
    )
      throw new Error("ADVANCED_LOG_HISTORY_INVALID");
    nextSequence = history.nextSequence;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const selected: { relative: string; bytes: number; sha256: string }[] = [];
  let total = 0;
  for (const name of events) {
    const bytes = await files.read(`logs\\${name}`, 2 * 1024 ** 2);
    total += bytes.length;
    if (total > 100 * 1024 ** 2) throw new Error("ADVANCED_FILE_LIMIT");
    for (const line of bytes.toString("utf8").split("\n")) {
      try {
        const v = JSON.parse(line) as { sequence: number };
        if (Number.isSafeInteger(v.sequence) && v.sequence > 0)
          nextSequence = Math.max(nextSequence, v.sequence + 1);
      } catch {
        /* Explicit clear removes corrupt event tails but retains markers. */
      }
    }
    selected.push({
      relative: `logs\\${name}`,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await writeFleetAtomic(
    native,
    files.root,
    "logs\\history.json",
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        streamId,
        nextSequence,
        incompleteHistory: true,
      }),
    ),
  );
  for (const entry of selected) {
    const bytes = await files.read(entry.relative, 2 * 1024 ** 2);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error("ADVANCED_FILE_CHANGED");
    if (entry.relative === "logs\\events.jsonl")
      await writeFleetAtomic(
        native,
        files.root,
        entry.relative,
        Buffer.alloc(0),
      );
    else {
      await native.validatePath("fleet", entry.relative, "file");
      await unlink(win32.join(files.root, entry.relative));
    }
  }
  return { filesCleared: selected.length, bytesCleared: total };
}

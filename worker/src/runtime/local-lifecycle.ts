import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { withDarwinFileLock } from "./darwin-file-lock.js";

const MAXIMUM_BYTES = 4096;
const VALID_INTENTS = ["active", "paused", "draining"] as const;

export type LocalLifecycleIntent = (typeof VALID_INTENTS)[number];

export interface LocalLifecycleState {
  schemaVersion: 1;
  intent: LocalLifecycleIntent;
  revision: number;
  updatedAt: string;
}

export async function loadLocalLifecycle(
  path: string,
): Promise<LocalLifecycleState> {
  assertAbsolute(path);
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > MAXIMUM_BYTES ||
    (info.mode & 0o077) !== 0
  )
    throw new TypeError("Local lifecycle file is unsafe");
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new TypeError("Local lifecycle file is not valid JSON");
  }
  return parseState(decoded);
}

export async function initializeLocalLifecycle(
  path: string,
): Promise<LocalLifecycleState> {
  const initial: LocalLifecycleState = {
    schemaVersion: 1,
    intent: "active",
    revision: 1,
    updatedAt: new Date().toISOString(),
  };
  await writeState(path, initial, true);
  return initial;
}

export async function setLocalLifecycleIntent(
  path: string,
  intent: LocalLifecycleIntent,
): Promise<LocalLifecycleState> {
  if (!VALID_INTENTS.includes(intent))
    throw new TypeError("Local lifecycle intent is invalid");
  assertAbsolute(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform === "darwin")
    return await withDarwinFileLock(`${path}.lock.guard`, async () => {
      await recoverDeadLifecycleLock(`${path}.lock`);
      return await writeLifecycleIntent(path, intent);
    });
  return await writeLifecycleIntent(path, intent);
}

/** Caller holds the persistent kernel lock; no concurrent reclaimer can unlink a new owner. */
async function recoverDeadLifecycleLock(path: string): Promise<void> {
  const info = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!info) return;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 1024 ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new Error("Local lifecycle lock ownership is unsafe");
  let owner: { schemaVersion?: unknown; pid?: unknown };
  try {
    owner = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(
      "Local lifecycle lock ownership is unknown; operator recovery required",
    );
  }
  if (
    !owner ||
    owner.schemaVersion !== 1 ||
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid as number) < 1
  )
    throw new Error(
      "Local lifecycle lock ownership is unknown; operator recovery required",
    );
  try {
    process.kill(owner.pid as number, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    await rm(path);
    return;
  }
  throw new Error("Local lifecycle update is already in progress");
}

async function writeLifecycleIntent(
  path: string,
  intent: LocalLifecycleIntent,
): Promise<LocalLifecycleState> {
  const lockPath = `${path}.lock`;
  assertAbsolute(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Publish ownership atomically: a killed writer must not leave an empty lock
  // that cannot be distinguished from a live writer still initializing it.
  const temporaryLock = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  const lock = await open(temporaryLock, "wx", 0o600);
  let published = false;
  try {
    await lock.writeFile(
      `${JSON.stringify({ schemaVersion: 1, pid: process.pid })}\n`,
    );
    await lock.sync();
    try {
      await link(temporaryLock, lockPath);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("Local lifecycle update is already in progress");
      throw error;
    }
    const previous = await loadLocalLifecycle(path);
    const next: LocalLifecycleState = {
      schemaVersion: 1,
      intent,
      revision: previous.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await writeState(path, next, false);
    return next;
  } finally {
    await lock.close();
    if (published) await rm(lockPath, { force: true });
    await rm(temporaryLock, { force: true });
  }
}

export function localLifecycleAllowsClaims(
  state: LocalLifecycleState,
): boolean {
  return state.intent === "active";
}

async function writeState(
  path: string,
  state: LocalLifecycleState,
  exclusive: boolean,
): Promise<void> {
  assertAbsolute(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (exclusive) {
      // Publish the complete file exclusively; never expose an empty placeholder
      // that a crash could leave behind as the authoritative lifecycle state.
      await link(temporary, path);
    } else {
      await rename(temporary, path);
    }
    await chmod(path, 0o600);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseState(value: unknown): LocalLifecycleState {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Local lifecycle state must be an object");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.some(
      (key) =>
        !["schemaVersion", "intent", "revision", "updatedAt"].includes(key),
    ) ||
    record.schemaVersion !== 1 ||
    typeof record.intent !== "string" ||
    !VALID_INTENTS.includes(record.intent as LocalLifecycleIntent) ||
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 1 ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt))
  )
    throw new TypeError("Local lifecycle state is invalid");
  return record as unknown as LocalLifecycleState;
}

function assertAbsolute(path: string): void {
  if (!isAbsolute(path))
    throw new TypeError("Local lifecycle path must be absolute");
}

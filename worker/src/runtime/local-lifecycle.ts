import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

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
  const lockPath = `${path}.lock`;
  assertAbsolute(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await open(lockPath, "wx", 0o600).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Local lifecycle update is already in progress");
    throw error;
  });
  try {
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
    await rm(lockPath, { force: true });
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
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (exclusive) {
      const destination = await open(path, "wx", 0o600);
      await destination.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
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

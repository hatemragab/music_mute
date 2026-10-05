import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  DarwinFileLockBusyError,
  withDarwinFileLock,
} from "../../../worker/src/runtime/darwin-file-lock.js";

export const ACQUISITION_SPACING_MS = 5_000;
export const ACQUISITION_REFUSAL_COOLDOWN_MS = 15 * 60_000;
const MAX_STATE_BYTES = 1024;
const STATE_FILE = "acquisition-state.json";
const LOCK_FILE = "acquisition.lock";
type Refusal = "SOURCE_BOT_CHALLENGE" | "ACQUISITION_RATE_LIMITED";
export type AcquisitionBlockReason = Refusal | "ACQUISITION_INTERRUPTED";
type StateReason = AcquisitionBlockReason | "ACQUISITION_PENDING";
interface AcquisitionState {
  version: 1;
  reason: StateReason | null;
  blocked_until: number;
  last_started_at: number;
}
interface StateRead {
  state: AcquisitionState | undefined;
  identity: Stats | undefined;
}

export class AcquisitionGateError extends Error {
  constructor(
    readonly code:
      | "ACQUISITION_BUSY"
      | "ACQUISITION_COOLDOWN"
      | "ACQUISITION_STATE_INVALID"
      | Refusal
      | "CANCELLED",
    readonly original_refusal?: unknown,
    readonly block_reason?: AcquisitionBlockReason,
    readonly retry_at?: number,
  ) {
    super(code);
    this.name = "AcquisitionGateError";
  }
}

function invalid(): never {
  throw new AcquisitionGateError("ACQUISITION_STATE_INVALID");
}
function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new AcquisitionGateError("CANCELLED");
}
function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function ownedFile(info: Stats): boolean {
  return (
    info.isFile() &&
    info.nlink === 1 &&
    info.uid === process.getuid?.() &&
    !(info.mode & 0o077) &&
    info.size > 0 &&
    info.size <= MAX_STATE_BYTES
  );
}
async function directory(root: string, expected?: Stats): Promise<Stats> {
  try {
    if (!isAbsolute(root)) return invalid();
    const info = await lstat(root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      (expected && !sameIdentity(info, expected))
    )
      return invalid();
    return info;
  } catch {
    return invalid();
  }
}
function parseState(raw: unknown, now: number): AcquisitionState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).length !== 4 ||
    Object.keys(value).some(
      (key) =>
        !["version", "reason", "blocked_until", "last_started_at"].includes(
          key,
        ),
    ) ||
    value.version !== 1 ||
    ![
      null,
      "SOURCE_BOT_CHALLENGE",
      "ACQUISITION_RATE_LIMITED",
      "ACQUISITION_PENDING",
      "ACQUISITION_INTERRUPTED",
    ].includes(value.reason as StateReason | null) ||
    !Number.isSafeInteger(value.blocked_until) ||
    !Number.isSafeInteger(value.last_started_at) ||
    Number(value.last_started_at) < 0 ||
    Number(value.last_started_at) > now ||
    Number(value.blocked_until) < 0 ||
    Number(value.blocked_until) > now + ACQUISITION_REFUSAL_COOLDOWN_MS ||
    (value.reason === null || value.reason === "ACQUISITION_PENDING"
      ? value.blocked_until !== 0
      : Number(value.blocked_until) <= Number(value.last_started_at))
  )
    return invalid();
  return value as unknown as AcquisitionState;
}
async function readState(
  root: string,
  identity: Stats,
  now: number,
): Promise<StateRead> {
  await directory(root, identity);
  let file;
  try {
    file = await open(
      join(root, STATE_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { state: undefined, identity: undefined };
    return invalid();
  }
  try {
    const before = await file.stat();
    const named = await lstat(join(root, STATE_FILE));
    if (
      !ownedFile(before) ||
      named.isSymbolicLink() ||
      !sameIdentity(before, named)
    )
      return invalid();
    const bytes = Buffer.alloc(MAX_STATE_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    const namedAfter = await lstat(join(root, STATE_FILE));
    await directory(root, identity);
    if (
      bytesRead !== before.size ||
      bytesRead > MAX_STATE_BYTES ||
      !ownedFile(after) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      !sameIdentity(before, namedAfter) ||
      namedAfter.isSymbolicLink()
    )
      return invalid();
    return {
      state: parseState(
        JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
        now,
      ),
      identity: before,
    };
  } catch {
    return invalid();
  } finally {
    await file.close();
  }
}
async function writeState(
  root: string,
  identity: Stats,
  previous: StateRead,
  state: AcquisitionState,
): Promise<StateRead> {
  await directory(root, identity);
  const temporary = join(root, `.acquisition-${randomUUID()}.tmp`);
  let file;
  let temporaryIdentity: Stats | undefined;
  try {
    file = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_WRONLY,
      0o600,
    );
    temporaryIdentity = await file.stat();
    await file.writeFile(JSON.stringify(state));
    await file.sync();
    await directory(root, identity);
    const current = await lstat(join(root, STATE_FILE)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        return invalid();
      },
    );
    if (
      previous.identity
        ? !current ||
          !ownedFile(current) ||
          !sameIdentity(previous.identity, current) ||
          current.mtimeMs !== previous.identity.mtimeMs ||
          current.ctimeMs !== previous.identity.ctimeMs
        : current !== undefined
    )
      return invalid();
    const namedTemporary = await lstat(temporary);
    if (
      !ownedFile(namedTemporary) ||
      !sameIdentity(temporaryIdentity, namedTemporary)
    )
      return invalid();
    await rename(temporary, join(root, STATE_FILE));
    const parent = await open(
      root,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
    );
    try {
      if (!sameIdentity(identity, await parent.stat())) return invalid();
      await parent.sync();
    } finally {
      await parent.close();
    }
    const persisted = await readState(
      root,
      identity,
      Math.max(
        state.last_started_at,
        state.blocked_until - ACQUISITION_REFUSAL_COOLDOWN_MS,
      ),
    );
    if (JSON.stringify(persisted.state) !== JSON.stringify(state))
      return invalid();
    return persisted;
  } catch {
    return invalid();
  } finally {
    await file?.close();
    if (temporaryIdentity) {
      const named = await lstat(temporary).catch(() => undefined);
      if (named && sameIdentity(temporaryIdentity, named))
        await unlink(temporary).catch(() => {});
    }
  }
}

/** A local admission wait, never an extraction retry. */
export function waitForAcquisitionSpacing(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new AcquisitionGateError("CANCELLED"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** One user-wide guest acquisition owner; kernel locks release when a helper exits. */
export class AcquisitionGate {
  constructor(
    private readonly root: string,
    private readonly clock: () => number = Date.now,
    private readonly wait: (
      milliseconds: number,
      signal: AbortSignal,
    ) => Promise<void> = waitForAcquisitionSpacing,
  ) {}
  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) return invalid();
    return now;
  }
  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    cancelled(signal);
    const identity = await directory(this.root);
    let entered = false;
    try {
      return await withDarwinFileLock(join(this.root, LOCK_FILE), async () => {
        entered = true;
        cancelled(signal);
        let now = this.now();
        let previous = await readState(this.root, identity, now);
        cancelled(signal);
        if (previous.state?.reason === "ACQUISITION_PENDING") {
          await writeState(this.root, identity, previous, {
            version: 1,
            reason: "ACQUISITION_INTERRUPTED",
            blocked_until: now + ACQUISITION_REFUSAL_COOLDOWN_MS,
            last_started_at: previous.state.last_started_at,
          });
          throw new AcquisitionGateError(
            "ACQUISITION_COOLDOWN",
            undefined,
            "ACQUISITION_INTERRUPTED",
            now + ACQUISITION_REFUSAL_COOLDOWN_MS,
          );
        }
        if (previous.state && previous.state.blocked_until > now) {
          const reason = previous.state.reason;
          if (reason === null) return invalid();
          throw new AcquisitionGateError(
            "ACQUISITION_COOLDOWN",
            undefined,
            reason,
            previous.state.blocked_until,
          );
        }
        const delay = previous.state
          ? Math.max(
              0,
              previous.state.last_started_at + ACQUISITION_SPACING_MS - now,
            )
          : 0;
        if (delay > 0) {
          await this.wait(delay, signal);
          cancelled(signal);
          now = this.now();
          if (now < previous.state!.last_started_at + ACQUISITION_SPACING_MS)
            return invalid();
        }
        cancelled(signal);
        previous = await writeState(this.root, identity, previous, {
          version: 1,
          reason: "ACQUISITION_PENDING",
          blocked_until: 0,
          last_started_at: now,
        });
        const clearPending = async (): Promise<void> => {
          const settledAt = this.now();
          if (settledAt < now) return invalid();
          await writeState(this.root, identity, previous, {
            version: 1,
            reason: null,
            blocked_until: 0,
            last_started_at: now,
          });
        };
        let result: T;
        try {
          cancelled(signal);
          result = await operation();
        } catch (error) {
          const code =
            error instanceof Error && "code" in error ? error.code : undefined;
          if (
            code === "SOURCE_BOT_CHALLENGE" ||
            code === "ACQUISITION_RATE_LIMITED"
          ) {
            let retryAt: number;
            try {
              const failedAt = this.now();
              if (failedAt < now) return invalid();
              retryAt = failedAt + ACQUISITION_REFUSAL_COOLDOWN_MS;
              await writeState(this.root, identity, previous, {
                version: 1,
                reason: code,
                blocked_until: retryAt,
                last_started_at: now,
              });
            } catch {
              throw new AcquisitionGateError(
                "ACQUISITION_STATE_INVALID",
                error,
              );
            }
            throw new AcquisitionGateError(code, error, code, retryAt);
          } else if (signal.aborted || typeof code === "string") {
            await clearPending();
          }
          throw error;
        }
        await clearPending();
        cancelled(signal);
        return result;
      });
    } catch (error) {
      if (error instanceof DarwinFileLockBusyError)
        throw new AcquisitionGateError("ACQUISITION_BUSY");
      if (!entered && !(error instanceof AcquisitionGateError))
        return invalid();
      throw error;
    }
  }
}

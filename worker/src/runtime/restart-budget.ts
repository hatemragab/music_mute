import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ControlPlaneError } from "./control-plane-client.js";

const MAX_STARTS = 5;
interface RestartState {
  schemaVersion: 1;
  starts: number;
  blocked: boolean;
  nextStartAt: number;
}
export class RestartCircuitOpenError extends Error {
  constructor() {
    super(
      process.platform === "win32"
        ? "Worker restart budget exhausted or permanent failure; repair the cause, stop MusicMuteWorker, run manage-windows-service.ps1 -Action ResetRestartBudget, then start the service"
        : "Worker restart budget exhausted or permanent failure; repair the cause, then run mw restart",
    );
    this.name = "RestartCircuitOpenError";
  }
}

/** Persist admission before startup so a SIGKILL also consumes the budget. */
export class PersistentRestartBudget {
  private state: RestartState | undefined;
  private writes: Promise<void> = Promise.resolve();
  constructor(
    readonly path: string,
    private readonly clock = Date.now,
    private readonly random = Math.random,
  ) {}

  async admit(signal: AbortSignal): Promise<void> {
    const state = await readState(this.path);
    if (state.blocked || state.starts >= MAX_STARTS)
      throw new RestartCircuitOpenError();
    const wait = Math.max(0, state.nextStartAt - this.clock());
    if (wait > 0) await delay(Math.min(wait, 300_000), undefined, { signal });
    signal.throwIfAborted();
    const starts = state.starts + 1;
    const backoff = Math.min(300_000, 5_000 * 2 ** (starts - 1));
    this.state = {
      schemaVersion: 1,
      starts,
      blocked: false,
      nextStartAt:
        this.clock() + Math.round(backoff * (0.5 + this.random() * 0.5)),
    };
    await this.persist();
  }

  async recordFailure(error: unknown): Promise<void> {
    if (!this.state) return;
    if (
      error instanceof TypeError ||
      (error instanceof ControlPlaneError && !error.retryable)
    )
      this.state.blocked = true;
    await this.persist();
  }

  /** Successful authoritative completion proves this incarnation is useful. */
  async recordSuccess(): Promise<void> {
    if (!this.state) return;
    this.state = {
      schemaVersion: 1,
      starts: 1,
      blocked: false,
      nextStartAt: 0,
    };
    await this.persist();
  }

  async orderlyStop(): Promise<void> {
    if (!this.state) return;
    this.state = freshState();
    await this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = { ...this.state! };
    this.writes = this.writes.then(() => writeState(this.path, snapshot));
    return this.writes;
  }
}

/** Only call after the operator has explicitly requested restart and service stopped. */
export async function resetRestartBudget(path: string): Promise<void> {
  await writeState(path, freshState());
}
function freshState(): RestartState {
  return { schemaVersion: 1, starts: 0, blocked: false, nextStartAt: 0 };
}
async function readState(path: string): Promise<RestartState> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return freshState();
    throw error;
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 4096 ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new TypeError("Restart budget file is unsafe");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Restart budget is invalid");
  const state = value as RestartState;
  if (
    Object.keys(state).sort().join() !==
      "blocked,nextStartAt,schemaVersion,starts" ||
    state.schemaVersion !== 1 ||
    !Number.isSafeInteger(state.starts) ||
    state.starts < 0 ||
    state.starts > MAX_STARTS ||
    typeof state.blocked !== "boolean" ||
    !Number.isSafeInteger(state.nextStartAt) ||
    state.nextStartAt < 0
  )
    throw new TypeError("Restart budget is invalid");
  return state;
}
async function writeState(path: string, state: RestartState): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(`${JSON.stringify(state)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
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

/** Keep the service quiescent instead of letting launchd repeatedly relaunch it. */
export async function waitForOperatorStop(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {}, 60_000);
    signal.addEventListener(
      "abort",
      () => {
        clearInterval(timer);
        resolve();
      },
      { once: true },
    );
  });
}

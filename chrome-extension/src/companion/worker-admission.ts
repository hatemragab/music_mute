import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  loadPersonalReservation as loadReservation,
  persistPersonalReservation as persist,
  removePersonalReservation as removeReservation,
  withPersonalAdmissionLock as withAdmissionLock,
  personalProcessIdentity as identity,
  personalAdmissionSocketPath,
  verifyIdlePersonalEngine,
  validatePersonalEngineEndpoint,
  type PersonalReservation as Reservation,
  type PersonalEngineEndpoint,
} from "../../../worker/src/runtime/personal-reservation.js";

const MAX_FRAME_BYTES = 16 * 1024;
const MAX_STATUS_BYTES = 512 * 1024;

/** No account, machine credential, media or capability crosses this boundary. */
export interface WorkerAdmissionLease {
  readonly signal: AbortSignal;
  readonly keepWarmWhenIdle: boolean;
  registerEngine(pid: number, endpoint?: PersonalEngineEndpoint): Promise<void>;
  markIdle(): Promise<void>;
  release(): Promise<void>;
}

interface AdmissionOptions {
  signal: AbortSignal;
  workerRoot?: string;
  timeoutMs?: number;
  exchangeTimeoutMs?: number;
  onWaiting?: () => void;
}

class IdleSelectionChanged extends Error {
  constructor(
    readonly pid: number,
    readonly expected: string,
    readonly failure: unknown,
  ) {
    super("WORKER_COORDINATION_UNAVAILABLE");
  }
}

function validPid(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) > 1 &&
    Number(value) <= 2 ** 31 - 1
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("WORKER_COORDINATION_UNSAFE");
  }
}

async function privateState(root: string): Promise<string> {
  if (!isAbsolute(root) || resolve(root) !== root)
    throw new Error("WORKER_COORDINATION_UNSAFE");
  const state = join(root, "state");
  // Coordination-only directories create no enrollment, credentials or service.
  for (const directory of [root, state]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o700 ||
      (await realpath(directory)) !== directory
    )
      throw new Error("WORKER_COORDINATION_UNSAFE");
  }
  return state;
}

async function privateJson(
  path: string,
  limit: number,
): Promise<Record<string, unknown> | undefined> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw new Error("WORKER_COORDINATION_UNSAFE");
  });
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > limit
    )
      throw new Error();
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("WORKER_COORDINATION_UNSAFE");
  } finally {
    await handle.close();
  }
}

async function assertNoLegacyWorker(state: string): Promise<void> {
  const value = await privateJson(
    join(state, "runtime-status.json"),
    MAX_STATUS_BYTES,
  );
  if (!value) {
    // No status cannot prove that an installed legacy process has not started.
    if (await exists(join(state, "../config/runtime.json")))
      throw new Error("WORKER_UPDATE_REQUIRED");
    return;
  }
  if (!validPid(value.processId))
    throw new Error("WORKER_COORDINATION_UNAVAILABLE");
  if (await identity(value.processId))
    throw new Error("WORKER_UPDATE_REQUIRED");
  // Dead PID is safe even if last status was ready. A stopped label is not proof.
}

/** Accepted fleet jobs finish; every grant survives service/client restarts. */
export async function acquireWorkerAdmission(
  options: AdmissionOptions,
): Promise<WorkerAdmissionLease> {
  if (options.signal.aborted) throw new Error("CANCELLED");
  const state = await privateState(
    options.workerRoot ??
      join(homedir(), "Library", "Application Support", "MusicMuteWorker"),
  );
  const deadline = performance.now() + (options.timeoutMs ?? 1_800_000);
  const client_identity = await identity(process.pid);
  if (!client_identity) throw new Error("WORKER_COORDINATION_UNAVAILABLE");
  const reservation: Reservation = {
    request_id: randomUUID(),
    phase: "active",
    client_pid: process.pid,
    client_identity,
  };
  let announced = false;
  for (;;) {
    if (options.signal.aborted) throw new Error("CANCELLED");
    if (performance.now() >= deadline) throw new Error("WORKER_WAIT_TIMEOUT");
    const attempt = async (): Promise<WorkerAdmissionLease | undefined> => {
      if (
        (await exists(join(state, "app-maintenance.json"))) ||
        (await exists(join(state, "app-preparation.json")))
      )
        throw new Error("WORKER_MAINTENANCE_BUSY");
      const path = await personalAdmissionSocketPath(state);
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw new Error("WORKER_COORDINATION_UNSAFE");
      });
      if (info) {
        if (
          !info.isSocket() ||
          info.isSymbolicLink() ||
          info.uid !== process.getuid?.() ||
          (info.mode & 0o777) !== 0o600
        )
          throw new Error("WORKER_COORDINATION_UNSAFE");
        const socket = await connect(path, options.exchangeTimeoutMs ?? 5000);
        if (socket) {
          // The lock is released before the potentially long fleet drain.
          return new AdmissionConnection(socket, reservation.request_id, {
            ...options,
            timeoutMs: Math.max(1, deadline - performance.now()),
          });
        }
      }
      await assertNoLegacyWorker(state);
      const saved = await loadReservation(state);
      if (saved) {
        const pid = saved.engine_pid ?? saved.client_pid;
        const expected =
          saved.engine_pid !== undefined
            ? saved.process_identity
            : saved.client_identity;
        if (pid === undefined || expected === undefined)
          throw new Error("WORKER_RECOVERY_REQUIRED");
        if ((await identity(pid)) === expected) {
          if (saved.phase === "idle") {
            try {
              await verifyIdlePersonalEngine(saved);
            } catch (error) {
              throw new IdleSelectionChanged(pid, expected, error);
            }
            const adopted: Reservation = {
              ...saved,
              ...reservation,
              phase: "active",
            };
            await persist(state, adopted);
            return new StandaloneAdmission(
              state,
              adopted,
              options.signal,
              true,
            );
          }
          if (saved.phase === undefined)
            throw new Error("WORKER_RECOVERY_REQUIRED");
          return undefined;
        }
        await removeReservation(state);
      }
      await persist(state, reservation);
      return new StandaloneAdmission(state, reservation, options.signal);
    };
    let lease: WorkerAdmissionLease | undefined;
    try {
      lease = await withAdmissionLock(state, attempt);
    } catch (error) {
      if (error instanceof IdleSelectionChanged) {
        // Update retirement is observed outside the admission lock. Selection
        // is replayed only before dispatch and after the exact process exits.
        const exitDeadline = performance.now() + 5000;
        while ((await identity(error.pid)) === error.expected) {
          if (options.signal.aborted) throw new Error("CANCELLED");
          if (performance.now() >= exitDeadline)
            throw new Error("WORKER_COORDINATION_UNAVAILABLE");
          await delay(25);
        }
        continue;
      }
      if (
        !(error instanceof Error) ||
        error.message !== "WORKER_COORDINATION_BUSY"
      )
        throw error;
    }
    if (lease instanceof AdmissionConnection) {
      try {
        await lease.acquire();
        return lease;
      } catch (error) {
        await lease.release().catch(() => {});
        throw error;
      }
    }
    if (lease) return lease;
    if (!announced) {
      options.onWaiting?.();
      announced = true;
    }
    await delay(250, undefined, { signal: options.signal }).catch(() => {});
  }
}

function connect(path: string, timeout: number): Promise<Socket | undefined> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    const timer = setTimeout(
      () => socket.destroy(new Error("WORKER_COORDINATION_UNAVAILABLE")),
      timeout,
    );
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT")
        resolve(undefined);
      else reject(new Error("WORKER_COORDINATION_UNAVAILABLE"));
    });
  });
}

class StandaloneAdmission implements WorkerAdmissionLease {
  readonly keepWarmWhenIdle = true;
  private released = false;
  private registered = false;
  constructor(
    private readonly state: string,
    private reservation: Reservation,
    readonly signal: AbortSignal,
    private readonly inheritedIdle = false,
  ) {}
  async registerEngine(
    pid: number,
    endpoint?: PersonalEngineEndpoint,
  ): Promise<void> {
    if (this.signal.aborted) throw new Error("CANCELLED");
    if (!validPid(pid) || pid === process.pid || this.registered)
      throw new Error("WORKER_COORDINATION_UNSAFE");
    await withAdmissionLock(this.state, async () => {
      const saved = await loadReservation(this.state);
      if (
        !saved ||
        saved.phase !== "active" ||
        saved.request_id !== this.reservation.request_id
      )
        throw new Error("WORKER_COORDINATION_UNAVAILABLE");
      if (
        saved.engine_pid !== undefined &&
        saved.engine_pid !== pid &&
        (await identity(saved.engine_pid)) === saved.process_identity
      )
        throw new Error("WORKER_COORDINATION_UNSAFE");
      const process_identity = await identity(pid);
      if (!process_identity) throw new Error("WORKER_COORDINATION_UNAVAILABLE");
      if (endpoint) await validatePersonalEngineEndpoint(endpoint);
      this.reservation = {
        ...saved,
        engine_pid: pid,
        process_identity,
        ...endpoint,
      };
      await persist(this.state, this.reservation);
      this.registered = true;
    });
  }
  async markIdle(): Promise<void> {
    if (this.signal.aborted) throw new Error("CANCELLED");
    await withAdmissionLock(this.state, async () => {
      const saved = await loadReservation(this.state);
      if (
        !this.registered ||
        !saved ||
        saved.phase !== "active" ||
        saved.request_id !== this.reservation.request_id
      )
        throw new Error("WORKER_COORDINATION_UNAVAILABLE");
      await verifyIdlePersonalEngine(saved);
      this.reservation = { ...saved, phase: "idle" };
      await persist(this.state, this.reservation);
    });
  }
  async release(): Promise<void> {
    if (this.released) return;
    await withAdmissionLock(this.state, async () => {
      const saved = await loadReservation(this.state);
      if (
        !saved ||
        (this.reservation.phase === "idle" &&
          saved.request_id !== this.reservation.request_id)
      ) {
        this.released = true;
        return;
      }
      if (saved.request_id !== this.reservation.request_id)
        throw new Error("WORKER_COORDINATION_UNAVAILABLE");
      // Idle ownership belongs to the resident engine, across helper exit and
      // subsequent requests. It is never released while a model remains live.
      if (
        this.reservation.phase === "idle" &&
        (saved.phase === "idle" || saved.phase === "retiring")
      ) {
        this.released = true;
        return;
      }
      if (
        saved.engine_pid !== undefined &&
        (await identity(saved.engine_pid)) === saved.process_identity
      ) {
        if (this.inheritedIdle && !this.registered) {
          // The current generation never acknowledged ENGINE, so it could not
          // dispatch processing. A fresh idle handshake permits cancellation
          // to return the inherited warm engine to idle ownership safely.
          await verifyIdlePersonalEngine(saved);
          this.reservation = { ...saved, phase: "idle" };
          await persist(this.state, this.reservation);
          this.released = true;
          return;
        }
        throw new Error("ENGINE_EXIT_UNCONFIRMED");
      }
      await removeReservation(this.state);
      this.released = true;
    });
  }
}

class AdmissionConnection implements WorkerAdmissionLease {
  readonly keepWarmWhenIdle = false;
  async markIdle(): Promise<void> {
    throw new Error("WORKER_COORDINATION_UNSAFE");
  }
  private readonly cancellation = new AbortController();
  private pending:
    | {
        type: string;
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private buffer = "";
  private receivedBytes = 0;
  private released = false;
  private granted = false;
  private registered = false;
  private readonly abort = () => this.fail(new Error("CANCELLED"));
  constructor(
    private readonly socket: Socket,
    private readonly id: string,
    private readonly options: AdmissionOptions,
  ) {
    options.signal.addEventListener("abort", this.abort, { once: true });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.read(chunk));
    socket.on("error", () =>
      this.fail(new Error("WORKER_COORDINATION_UNAVAILABLE")),
    );
    socket.on("close", () => {
      options.signal.removeEventListener("abort", this.abort);
      if (!this.released)
        this.fail(new Error("WORKER_COORDINATION_UNAVAILABLE"));
    });
    if (options.signal.aborted) this.abort();
  }
  get signal(): AbortSignal {
    return this.cancellation.signal;
  }
  async acquire(): Promise<void> {
    await this.exchange(
      "GRANTED",
      { type: "PERSONAL", client_pid: process.pid },
      this.options.timeoutMs ?? 1_800_000,
    );
    this.granted = true;
  }
  async registerEngine(pid: number): Promise<void> {
    if (this.signal.aborted) throw new Error("CANCELLED");
    if (
      !this.granted ||
      this.registered ||
      !validPid(pid) ||
      pid === process.pid
    )
      throw new Error("WORKER_COORDINATION_UNSAFE");
    await this.exchange("REGISTERED", { type: "ENGINE", engine_pid: pid });
    this.registered = true;
  }
  async release(): Promise<void> {
    if (this.released) return;
    try {
      await this.exchange("RELEASED", { type: "RELEASE" });
      this.released = true;
    } finally {
      this.socket.destroy();
    }
  }
  private exchange(
    type: string,
    fields: Record<string, unknown>,
    timeout = this.options.exchangeTimeoutMs ?? 5000,
  ): Promise<void> {
    if (
      this.pending ||
      this.socket.destroyed ||
      (type !== "RELEASED" && this.signal.aborted)
    )
      return Promise.reject(new Error("WORKER_COORDINATION_UNAVAILABLE"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(
          new Error(
            type === "GRANTED"
              ? "WORKER_WAIT_TIMEOUT"
              : "WORKER_COORDINATION_UNAVAILABLE",
          ),
        );
      }, timeout);
      this.pending = { type, resolve, reject, timer };
      this.socket.write(
        JSON.stringify({
          protocol_version: 1,
          request_id: this.id,
          ...fields,
        }) + "\n",
      );
    });
  }
  private fail(error: Error): void {
    this.cancellation.abort(error);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
  }
  private read(chunk: string): void {
    this.receivedBytes += Buffer.byteLength(chunk);
    this.buffer += chunk;
    if (
      this.receivedBytes > MAX_FRAME_BYTES ||
      this.buffer.length > MAX_FRAME_BYTES
    ) {
      this.fail(new Error("WORKER_COORDINATION_UNSAFE"));
      this.socket.destroy();
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error();
        const message = value as Record<string, unknown>;
        if (
          message.protocol_version !== 1 ||
          message.request_id !== this.id ||
          Object.keys(message).some(
            (key) =>
              ![
                "protocol_version",
                "request_id",
                "type",
                "error_code",
              ].includes(key),
          )
        )
          throw new Error();
        if (message.type === "WAITING") {
          if (this.pending?.type === "GRANTED") this.options.onWaiting?.();
          else if (this.pending?.type !== "RELEASED") throw new Error();
          continue;
        }
        if (message.type === "ERROR") {
          const code = message.error_code;
          this.fail(
            new Error(
              typeof code === "string" && /^[A-Z_]{1,60}$/.test(code)
                ? code
                : "WORKER_COORDINATION_UNAVAILABLE",
            ),
          );
          this.socket.destroy();
          return;
        }
        // Abort races durable ACKs. RELEASE follows the original frame on this
        // pipe; it is safe before any processing frame has been dispatched.
        if (
          this.signal.aborted &&
          ["GRANTED", "REGISTERED"].includes(String(message.type))
        )
          continue;
        if (message.type === "RELEASED") {
          this.released = true;
          if (this.pending?.type === "RELEASED") this.resolvePending();
          else this.fail(new Error("ENGINE_EXIT_UNCONFIRMED"));
          this.socket.end();
          continue;
        }
        if (message.type !== this.pending?.type) throw new Error();
        this.resolvePending();
      } catch {
        this.fail(new Error("WORKER_COORDINATION_UNSAFE"));
        this.socket.destroy();
        return;
      }
    }
  }
  private resolvePending(): void {
    const pending = this.pending!;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve();
  }
}

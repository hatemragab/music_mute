import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { delimiter, isAbsolute, win32 } from "node:path";
import {
  ChildFrameDecoder,
  ChildProtocolError,
  encodeChildFrame,
  type ChildRequest,
  type ChildRequestCommand,
  type ChildResponse,
} from "./ipc/child-protocol.js";
import {
  CHILD_PROGRESS_STAGES,
  parseChildProgress,
  type ChildProgress,
} from "./ipc/child-progress.js";
import { sanitizeDiagnostic } from "./diagnostic-redaction.js";
export { sanitizeDiagnostic } from "./diagnostic-redaction.js";
import { ChildCommandError } from "./ipc/child-command-error.js";
export { ChildCommandError } from "./ipc/child-command-error.js";

// Native provider startup includes verified model loading and one warm-up pass.
// A cold MPS launch can exceed ten seconds even though steady-state jobs are
// fast, so keep the supervisor bounded without turning normal preload into a
// restart loop.
const DEFAULT_START_TIMEOUT_MS = 300_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const STDERR_LIMIT_BYTES = 16 * 1024;

export interface ChildProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  trustedExecutableDirectory?: string;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
  windowsJobObject?: boolean;
  /** Trusted retained consumer mode: omit console hosts while preserving the Windows Job chain. */
  windowsDetachedConsole?: true;
  /** Verified consumer release engine root; embedded Python does not use cwd imports. */
  windowsEngineModuleRoot?: string;
  onStartupStage?: (stage: "loading" | "warming") => void;
}

export function windowsGuardianArguments(
  engineRoot: string | undefined,
  parentPid: number,
  arguments_: readonly string[],
  detachedConsole = false,
): string[] {
  if (
    !Number.isSafeInteger(parentPid) ||
    parentPid < 1 ||
    typeof detachedConsole !== "boolean" ||
    (detachedConsole && engineRoot === undefined) ||
    (engineRoot !== undefined &&
      (!win32.isAbsolute(engineRoot) || engineRoot.includes("\0")))
  )
    throw new Error("Windows engine guardian configuration is invalid");
  return [
    ...(engineRoot
      ? [
          "-I",
          "-B",
          "-c",
          "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('musicmute_engine.windows_guardian',run_name='__main__')",
          engineRoot,
        ]
      : ["-B", "-m", "musicmute_engine.windows_guardian"]),
    "--parent-pid",
    String(parentPid),
    ...(detachedConsole ? ["--detached-console"] : []),
    "--",
    ...arguments_,
  ];
}

/** Console isolation is valid only for the verified Windows guardian-owned Job mode. */
export function workerChildDetached(
  options: Pick<
    ChildProcessOptions,
    "windowsDetachedConsole" | "windowsJobObject" | "windowsEngineModuleRoot"
  >,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (options.windowsDetachedConsole !== undefined) {
    if (
      options.windowsDetachedConsole !== true ||
      platform !== "win32" ||
      options.windowsJobObject !== true ||
      !options.windowsEngineModuleRoot ||
      !win32.isAbsolute(options.windowsEngineModuleRoot) ||
      options.windowsEngineModuleRoot.includes("\0")
    )
      throw new TypeError(
        "Detached Windows console requires a verified guardian-owned Job",
      );
    // Node's pinned libuv uses DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    // it does not set CREATE_BREAKAWAY_FROM_JOB and the child remains referenced.
    return true;
  }
  return platform !== "win32";
}

interface PendingRequest {
  resolve: (response: ChildResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  onProgress?: (progress: ChildProgress) => void;
  lastProgress?: ChildProgress;
}

const CHILD_STOP_MESSAGES = {
  CHILD_TERMINATION_SIGNAL_FAILED: "Worker child termination signal failed",
  CHILD_EXIT_UNCONFIRMED: "Worker child exit could not be confirmed",
  PROCESS_GROUP_EXIT_UNCONFIRMED:
    "Worker process group exit could not be confirmed",
} as const;
const CHILD_STOP_ERRNOS = new Set([
  "EACCES",
  "EINTR",
  "EINVAL",
  "EIO",
  "EPERM",
  "ESRCH",
]);
type ChildStopCode = keyof typeof CHILD_STOP_MESSAGES;

/** Internal diagnostics only. Never retain arbitrary child/OS messages or causes. */
export class ChildStopError extends Error {
  readonly code: ChildStopCode;
  readonly errno: string | undefined;

  constructor(code: ChildStopCode, errno?: unknown) {
    const safeCode = Object.hasOwn(CHILD_STOP_MESSAGES, code)
      ? code
      : "CHILD_EXIT_UNCONFIRMED";
    super(CHILD_STOP_MESSAGES[safeCode]);
    this.name = "ChildStopError";
    this.code = safeCode;
    this.errno =
      typeof errno === "string" && CHILD_STOP_ERRNOS.has(errno)
        ? errno
        : undefined;
  }
}

/** Only fixed stop stages and allowlisted errno can enter a supervisor summary. */
export function childStopFailureSummary(error: unknown): string {
  if (
    !(error instanceof ChildStopError) ||
    !Object.hasOwn(CHILD_STOP_MESSAGES, error.code)
  )
    return "CHILD_STOP_UNCONFIRMED";
  const errno = CHILD_STOP_ERRNOS.has(error.errno ?? "")
    ? error.errno
    : undefined;
  return error.code + (errno === undefined ? "" : `:${errno}`);
}

export class WorkerChildProcess {
  private currentIncarnation = randomUUID();
  private child: ChildProcessWithoutNullStreams | null = null;
  private processGroupPid: number | undefined;
  private decoder = new ChildFrameDecoder();
  private readonly pending = new Map<string, PendingRequest>();
  private ready: Promise<ChildResponse> | null = null;
  private resolveReady: ((response: ChildResponse) => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private activeProcessRequestId: string | null = null;
  private stderr = "";

  constructor(private readonly options: ChildProcessOptions) {}

  get incarnation(): string {
    return this.currentIncarnation;
  }

  /** Exact spawned guardian PID; it is not an exit or descendant-idle proof. */
  getPid(): number | undefined {
    return this.isAlive() ? this.child?.pid : undefined;
  }

  isAlive(): boolean {
    return (
      this.child !== null &&
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      this.child.stdin.writable
    );
  }

  async start(): Promise<ChildResponse> {
    if (this.child || this.ready)
      throw new Error("Worker child has already been started");
    const detached = workerChildDetached(this.options);
    await this.confirmProcessGroupExit();
    this.currentIncarnation = randomUUID();
    this.decoder = new ChildFrameDecoder();
    this.stderr = "";
    const env = childEnvironment(
      this.options.env,
      this.options.trustedExecutableDirectory,
    );
    this.ready = new Promise<ChildResponse>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    const spawnOptions: SpawnOptionsWithoutStdio = {
      cwd: this.options.cwd,
      env,
      windowsHide: true,
      // Give the POSIX worker its own process group so cancellation also
      // terminates media decoders, not just the Python parent.
      detached,
    };
    const arguments_ = [
      ...this.options.args,
      "--incarnation",
      this.incarnation,
    ];
    const guardian = fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "./process-guardian.ts"
          : "./process-guardian.js",
        import.meta.url,
      ),
    );
    const child =
      process.platform === "win32"
        ? spawn(
            this.options.command,
            this.options.windowsJobObject
              ? windowsGuardianArguments(
                  this.options.windowsEngineModuleRoot,
                  process.pid,
                  arguments_,
                  this.options.windowsDetachedConsole === true,
                )
              : arguments_,
            spawnOptions,
          )
        : (spawn(
            process.execPath,
            [guardian, this.options.command, ...arguments_],
            { ...spawnOptions, stdio: ["pipe", "pipe", "pipe", "ipc"] },
          ) as ChildProcessWithoutNullStreams);
    this.child = child;
    if (process.platform !== "win32") this.processGroupPid = child.pid;
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    child.stdin.on("error", () =>
      this.fail(new Error("Worker child pipe failed"), child),
    );
    child.once("error", (error) => this.fail(error, child));
    child.once("exit", (code, signal) => {
      const detail = code === 0 ? "stopped" : `exited (${code ?? signal})`;
      this.fail(new Error(`Worker child ${detail}`), child);
      if (this.child === child) this.child = null;
    });
    const timeout = setTimeout(
      () => this.fail(new Error("Worker child startup timed out"), child),
      boundedTimeout(this.options.startTimeoutMs, DEFAULT_START_TIMEOUT_MS),
    );
    try {
      return await this.ready;
    } finally {
      clearTimeout(timeout);
      this.ready = null;
      this.resolveReady = null;
      this.rejectReady = null;
    }
  }

  request(
    command: Exclude<ChildRequestCommand, "cancel" | "shutdown">,
    payload: Record<string, unknown>,
    timeoutMs?: number,
    onProgress?: (progress: ChildProgress) => void,
  ): Promise<ChildResponse> {
    if (command === "process") {
      if (this.activeProcessRequestId)
        throw new Error("Worker child already has an active process request");
    }
    const pending = this.send(command, payload, timeoutMs, onProgress);
    if (command === "process") {
      this.activeProcessRequestId = pending.requestId;
      const clear = () => {
        if (this.activeProcessRequestId === pending.requestId)
          this.activeProcessRequestId = null;
      };
      void pending.response.then(clear, clear);
    }
    return pending.response;
  }

  cancel(
    targetRequestId = this.activeProcessRequestId,
    timeoutMs?: number,
  ): Promise<ChildResponse> {
    if (!targetRequestId) throw new Error("No active child request to cancel");
    return this.send("cancel", { targetRequestId }, timeoutMs).response;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      await this.confirmProcessGroupExit();
      return;
    }
    const timeoutMs = boundedTimeout(
      this.options.stopTimeoutMs,
      DEFAULT_STOP_TIMEOUT_MS,
    );
    try {
      await this.send("shutdown", {}, timeoutMs).response;
      if (child.exitCode === null && child.signalCode === null)
        await Promise.race([
          once(child, "exit"),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Worker child shutdown timed out")),
              timeoutMs,
            ),
          ),
        ]);
    } catch {
      try {
        killProcessingTree(child);
      } catch (error) {
        throw new ChildStopError(
          "CHILD_TERMINATION_SIGNAL_FAILED",
          (error as NodeJS.ErrnoException).code,
        );
      }
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([
          once(child, "exit"),
          new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      }
    }
    if (child.exitCode === null && child.signalCode === null)
      throw new ChildStopError("CHILD_EXIT_UNCONFIRMED");
    await this.confirmProcessGroupExit();
  }

  private async confirmProcessGroupExit(): Promise<void> {
    const pid = this.processGroupPid;
    if (pid === undefined || process.platform === "win32") return;
    const deadline =
      performance.now() +
      boundedTimeout(this.options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS);
    for (;;) {
      try {
        process.kill(-pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          if (this.processGroupPid === pid) this.processGroupPid = undefined;
          return;
        }
        const errno = (error as NodeJS.ErrnoException).code;
        // Allow a transient denied/interrupted probe to settle during shutdown.
        // Retry within the existing deadline; only ESRCH releases the fence.
        if (
          (errno === "EPERM" || errno === "EINTR") &&
          performance.now() < deadline
        ) {
          await delay(10);
          continue;
        }
        throw new ChildStopError("PROCESS_GROUP_EXIT_UNCONFIRMED", errno);
      }
      // Guardian exit alone cannot prove native inference/decoder descendants
      // have exited after a forced kill. Keep the GPU fence until the OS agrees.
      if (performance.now() >= deadline)
        throw new ChildStopError("PROCESS_GROUP_EXIT_UNCONFIRMED");
      await delay(10);
    }
  }

  terminateActive(): void {
    const child = this.child;
    if (!child) return;
    this.fail(
      new Error("Worker child was terminated by the supervisor"),
      child,
    );
  }

  isProcessing(): boolean {
    return this.activeProcessRequestId !== null;
  }

  diagnosticTail(): string {
    return this.stderr;
  }

  private send(
    command: ChildRequestCommand,
    payload: Record<string, unknown>,
    timeoutMs?: number,
    onProgress?: (progress: ChildProgress) => void,
  ): { requestId: string; response: Promise<ChildResponse> } {
    const child = this.child;
    if (!child || child.exitCode !== null || !child.stdin.writable)
      throw new Error("Worker child is not running");
    const requestId = randomUUID();
    const message: ChildRequest = {
      protocolVersion: 1,
      type: "request",
      command,
      requestId,
      incarnation: this.incarnation,
      sentAt: new Date().toISOString(),
      payload,
    };
    const response = new Promise<ChildResponse>((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          this.pending.delete(requestId);
          reject(new Error(`Worker child ${command} timed out`));
          killProcessingTree(child);
        },
        boundedTimeout(
          timeoutMs,
          this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        ),
      );
      this.pending.set(requestId, {
        resolve,
        reject,
        timeout,
        ...(onProgress === undefined ? {} : { onProgress }),
      });
      child.stdin.write(encodeChildFrame(message), (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(new Error("Worker child pipe write failed"));
      });
    });
    return { requestId, response };
  }

  private onData(chunk: Buffer): void {
    try {
      for (const message of this.decoder.push(chunk)) {
        if (message.type === "request")
          throw new ChildProtocolError(
            "MESSAGE_INVALID",
            "Worker child emitted a request frame",
          );
        if (message.incarnation !== this.incarnation)
          throw new ChildProtocolError(
            "MESSAGE_INVALID",
            "Worker child incarnation changed",
          );
        if (message.type === "startup-progress") {
          if (
            this.resolveReady !== null &&
            Object.keys(message.payload).length === 1 &&
            (message.payload.stage === "loading" ||
              message.payload.stage === "warming")
          ) {
            try {
              this.options.onStartupStage?.(message.payload.stage);
            } catch {
              // A status observer cannot change child readiness.
            }
          }
          continue;
        }
        if (message.type === "ready") {
          this.resolveReady?.(message);
          continue;
        }
        if (message.type === "accepted") continue;
        const pending = this.pending.get(message.requestId);
        if (!pending) continue;
        if (message.type === "progress") {
          if (message.requestId !== this.activeProcessRequestId) continue;
          const progress = parseChildProgress(message.payload);
          if (progress === null) continue;
          const previous = pending.lastProgress;
          if (previous !== undefined) {
            const currentRank = CHILD_PROGRESS_STAGES.indexOf(progress.stage);
            const previousRank = CHILD_PROGRESS_STAGES.indexOf(previous.stage);
            if (currentRank < previousRank) continue;
            if (currentRank === previousRank) {
              if (
                progress.work === undefined ||
                (previous.work !== undefined &&
                  progress.work.completed <= previous.work.completed)
              )
                continue;
            }
          }
          pending.lastProgress = progress;
          try {
            pending.onProgress?.(progress);
          } catch {
            // Observability must not turn a valid processing result into a failure.
          }
          continue;
        }
        clearTimeout(pending.timeout);
        this.pending.delete(message.requestId);
        if (message.type === "error") {
          const code =
            typeof message.payload.code === "string"
              ? message.payload.code.slice(0, 100)
              : "CHILD_ERROR";
          const summary =
            typeof message.payload.summary === "string"
              ? message.payload.summary.slice(0, 200)
              : undefined;
          pending.reject(new ChildCommandError(code, summary));
        } else {
          pending.resolve(message);
        }
      }
    } catch (error) {
      this.fail(
        error instanceof Error ? error : new Error("Worker child failed"),
      );
    }
  }

  private onStderr(chunk: Buffer): void {
    const combined = `${this.stderr}${sanitizeDiagnostic(chunk.toString("utf8"))}`;
    this.stderr = combined.slice(-STDERR_LIMIT_BYTES);
  }

  private fail(error: Error, child = this.child): void {
    this.rejectReady?.(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    if (child) killProcessingTree(child);
  }
}

function killProcessingTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  child.kill("SIGKILL");
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 100 || value > 7_200_000)
    throw new TypeError("Worker child timeout is outside the allowed range");
  return value;
}

function childEnvironment(
  extra: NodeJS.ProcessEnv | undefined,
  trustedExecutableDirectory: string | undefined,
) {
  const names = [
    "HOME",
    "PATH",
    "SYSTEMROOT",
    "TMPDIR",
    "WINDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "MPLCONFIGDIR",
    "NUMBA_CACHE_DIR",
    "XDG_CACHE_HOME",
  ] as const;
  const env: NodeJS.ProcessEnv = {
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONUNBUFFERED: "1",
  };
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (trustedExecutableDirectory !== undefined) {
    if (
      !isAbsolute(trustedExecutableDirectory) ||
      trustedExecutableDirectory.includes(delimiter)
    )
      throw new TypeError("Worker child executable directory is invalid");
    env.PATH = env.PATH
      ? `${trustedExecutableDirectory}${delimiter}${env.PATH}`
      : trustedExecutableDirectory;
  }
  const allowed = new Set([
    "MUSICMUTE_LOG_LEVEL",
    "MUSICMUTE_PROVIDER",
    "MUSICMUTE_SENTRY_ENGINE_ENABLED",
    "MUSICMUTE_SENTRY_ENGINE_DSN",
    "MUSICMUTE_SENTRY_ENVIRONMENT",
    "MUSICMUTE_SENTRY_RELEASE",
  ]);
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (!allowed.has(name))
      throw new TypeError("Worker child environment key is not allowlisted");
    if (value !== undefined) env[name] = value;
  }
  return env;
}

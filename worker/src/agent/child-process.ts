import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { delimiter, isAbsolute } from "node:path";
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
  onStartupStage?: (stage: "loading" | "warming") => void;
}

interface PendingRequest {
  resolve: (response: ChildResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  onProgress?: (progress: ChildProgress) => void;
  lastProgress?: ChildProgress;
}

export class ChildCommandError extends Error {
  constructor(
    readonly code: string,
    readonly summary?: string,
  ) {
    super(
      summary
        ? `Worker child command failed: ${code} (${summary})`
        : `Worker child command failed: ${code}`,
    );
    this.name = "ChildCommandError";
  }
}

export class WorkerChildProcess {
  private currentIncarnation = randomUUID();
  private child: ChildProcessWithoutNullStreams | null = null;
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
      detached: process.platform !== "win32",
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
              ? [
                  "-B",
                  "-m",
                  "musicmute_engine.windows_guardian",
                  "--parent-pid",
                  String(process.pid),
                  "--",
                  ...arguments_,
                ]
              : arguments_,
            spawnOptions,
          )
        : (spawn(
            process.execPath,
            [guardian, this.options.command, ...arguments_],
            { ...spawnOptions, stdio: ["pipe", "pipe", "pipe", "ipc"] },
          ) as ChildProcessWithoutNullStreams);
    this.child = child;
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
    if (!child) return;
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
      killProcessingTree(child);
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([
          once(child, "exit"),
          new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      }
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

export function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/\S+/giu, "[REDACTED_URL]")
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(
      /\b(token|secret|password|credential|authorization)\s*[=:]\s*\S+/giu,
      "$1=[REDACTED]",
    )
    .replace(/\/Users\/[^/\s]+/gu, "/Users/[REDACTED]")
    .replace(/C:\\Users\\[^\\\s]+/giu, "C:\\Users\\[REDACTED]");
}

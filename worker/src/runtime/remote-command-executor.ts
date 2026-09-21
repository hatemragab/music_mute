import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, statfs } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  WorkerCommandMetric,
  WorkerCommandResult,
  WorkerRemoteCommand,
} from "./contracts.js";

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const DOCTOR_TIMEOUT_MS = 60_000;
const BENCHMARK_TIMEOUT_MS = 7_200_000;

export interface RuntimeCommandExecutor {
  execute(
    command: WorkerRemoteCommand,
    signal?: AbortSignal,
  ): Promise<WorkerCommandResult>;
}

export interface PackagedRuntimeCommandExecutorOptions {
  workRoot: string;
  modelCacheRoot: string;
  engineRoot: string;
  pythonPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  provider: "coreml" | "directml";
  directmlDeviceId?: number;
  serviceCheck: () => Promise<void>;
  runFile?: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      timeout: number;
      signal?: AbortSignal;
      env: NodeJS.ProcessEnv;
    },
  ) => Promise<{ stdout: string }>;
}

export class PackagedRuntimeCommandExecutor implements RuntimeCommandExecutor {
  private readonly runFile;

  constructor(private readonly options: PackagedRuntimeCommandExecutorOptions) {
    this.runFile = options.runFile ?? runPackagedFile;
  }

  async execute(
    command: WorkerRemoteCommand,
    signal?: AbortSignal,
  ): Promise<WorkerCommandResult> {
    try {
      return command.kind === "doctor"
        ? await this.doctor(command, signal)
        : await this.benchmark(command, signal);
    } catch {
      if (signal?.aborted) throw signal.reason;
      return {
        outcome: "failed",
        summary:
          command.kind === "doctor"
            ? "One or more requested worker health checks failed"
            : "Worker benchmark failed",
        metrics: [],
      };
    }
  }

  private async doctor(
    command: WorkerRemoteCommand,
    signal?: AbortSignal,
  ): Promise<WorkerCommandResult> {
    const metrics: WorkerCommandMetric[] = [];
    if (command.checks.includes("service")) {
      await this.options.serviceCheck();
      metrics.push(metric("check.service", 1, "boolean"));
    }
    if (command.checks.includes("storage")) {
      await access(
        this.options.workRoot,
        constants.R_OK | constants.W_OK | constants.X_OK,
      );
      const storage = await statfs(this.options.workRoot);
      metrics.push(
        metric("check.storage", 1, "boolean"),
        metric("storage.free_bytes", storage.bavail * storage.bsize, "bytes"),
      );
    }
    if (
      command.checks.some((check) =>
        ["model", "provider", "ffmpeg"].includes(check),
      )
    ) {
      const diagnostics = await this.runDoctor(signal);
      if (command.checks.includes("model")) {
        metrics.push(
          metric("check.model", 1, "boolean"),
          metric("model.bytes", finiteNumber(diagnostics.modelBytes), "bytes"),
        );
      }
      if (command.checks.includes("provider"))
        metrics.push(metric("check.provider", 1, "boolean"));
      if (command.checks.includes("ffmpeg"))
        metrics.push(metric("check.ffmpeg", 1, "boolean"));
    }
    return {
      outcome: "succeeded",
      summary: `${command.checks.length} worker health checks passed`,
      metrics,
    };
  }

  private async runDoctor(
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const { stdout } = await this.runFile(
      this.options.pythonPath,
      [
        "-m",
        "musicmute_engine.service_doctor",
        "--provider",
        this.options.provider,
        "--model-cache",
        this.options.modelCacheRoot,
        "--ffmpeg",
        this.options.ffmpegPath,
        "--ffprobe",
        this.options.ffprobePath,
      ],
      {
        cwd: this.options.engineRoot,
        timeout: DOCTOR_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal }),
        env: childEnvironment(this.options.ffmpegPath),
      },
    );
    return record(JSON.parse(stdout) as unknown, "doctor result");
  }

  private async benchmark(
    command: WorkerRemoteCommand,
    signal?: AbortSignal,
  ): Promise<WorkerCommandResult> {
    if (command.recipeId === null || command.iterations === null)
      throw new TypeError("Benchmark command is incomplete");
    const commandRoot = join(dirname(this.options.workRoot), "commands");
    await mkdir(commandRoot, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(commandRoot, "benchmark-"));
    const reportPath = join(temporary, "report.json");
    const fixturePath = join(
      dirname(dirname(this.options.workRoot)),
      "state",
      "qualification.wav",
    );
    try {
      const fixtureSha256 = await sha256(fixturePath);
      await this.runFile(
        this.options.pythonPath,
        [
          "-m",
          "musicmute_engine.qualification",
          "--provider",
          this.options.provider,
          "--fixture",
          fixturePath,
          "--fixture-sha256",
          fixtureSha256,
          "--work-root",
          temporary,
          "--release-root",
          resolve(this.options.engineRoot, "../.."),
          "--model-cache",
          this.options.modelCacheRoot,
          "--ffmpeg",
          this.options.ffmpegPath,
          "--ffprobe",
          this.options.ffprobePath,
          "--directml-device-id",
          String(this.options.directmlDeviceId ?? 0),
          "--recipe-id",
          command.recipeId,
          "--iterations",
          String(command.iterations),
          "--report",
          reportPath,
        ],
        {
          cwd: this.options.engineRoot,
          timeout: BENCHMARK_TIMEOUT_MS,
          ...(signal === undefined ? {} : { signal }),
          env: childEnvironment(this.options.ffmpegPath),
        },
      );
      const report = record(
        JSON.parse(await readFile(reportPath, "utf8")) as unknown,
        "benchmark report",
      );
      const dispatch = record(report.providerDispatch, "provider dispatch");
      if (report.status !== "PASS" || dispatch.proven !== true)
        throw new TypeError("Benchmark evidence is invalid");
      if (!Array.isArray(report.recipes))
        throw new TypeError("Benchmark recipes are invalid");
      const recipes = report.recipes.map((entry) =>
        record(entry, "benchmark recipe"),
      );
      if (
        recipes.length !== command.iterations ||
        recipes.some((entry) => entry.recipeId !== command.recipeId)
      )
        throw new TypeError("Benchmark result identity changed");
      const seconds = recipes.map((entry) =>
        finiteNumber(entry.endToEndSeconds),
      );
      const resultBytes = recipes.map((entry) =>
        finiteNumber(entry.resultBytes),
      );
      return {
        outcome: "succeeded",
        summary: `${command.recipeId} completed ${command.iterations} benchmark iteration${command.iterations === 1 ? "" : "s"}`,
        metrics: [
          metric("benchmark.iterations", command.iterations, "count"),
          metric("benchmark.mean_seconds", mean(seconds), "seconds"),
          metric("benchmark.min_seconds", Math.min(...seconds), "seconds"),
          metric("benchmark.max_seconds", Math.max(...seconds), "seconds"),
          metric("benchmark.mean_result_bytes", mean(resultBytes), "bytes"),
        ],
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

function childEnvironment(ffmpegPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUNBUFFERED: "1",
  };
  for (const name of [
    "HOME",
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
  ] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const inheritedPath = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  env.PATH = `${dirname(ffmpegPath)}${delimiter}${inheritedPath}`;
  return env;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new TypeError("Command metric is invalid");
  return value;
}

function metric(
  name: string,
  value: number,
  unit: string,
): WorkerCommandMetric {
  if (!Number.isFinite(value)) throw new TypeError("Command metric is invalid");
  return { name, value, unit };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new TypeError("Command metrics are empty");
  return values.reduce((total, value) => total + value, 0) / values.length;
}

async function sha256(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function runPackagedFile(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeout: number;
    signal?: AbortSignal;
    env: NodeJS.ProcessEnv;
  },
): Promise<{ stdout: string }> {
  const result = await execFileAsync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: OUTPUT_LIMIT_BYTES,
  });
  return { stdout: result.stdout };
}

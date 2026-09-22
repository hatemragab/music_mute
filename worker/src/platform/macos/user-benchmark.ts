import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parseQualificationEvidence } from "../../enrollment/report-builder.js";
import { loadLocalLifecycle } from "../../runtime/local-lifecycle.js";
import {
  MacLaunchAgentController,
  writeLaunchAgentPlist,
} from "./launch-agent.js";
import { qualifyMacUserRelease } from "./user-installer.js";
import type { MacUserLayout } from "./user-paths.js";
import { loadRuntimeConfig } from "../../runtime/runtime-config.js";
import { MAC_RECIPE_IDS, type MacRecipeId } from "./runtime-recipes.js";

const executeFile = promisify(execFile);
const CAPACITY_TIMEOUT_MS = 7_200_000;
const MINIMUM_TWO_WORKER_SPEEDUP = 1.1;

export interface MacUserFileBenchmarkOptions {
  layout: MacUserLayout;
  uid: number;
  inputPath: string;
  recipeId: MacRecipeId;
  iterations?: 1 | 2;
  launchAgent?: Pick<MacLaunchAgentController, "status">;
}

export async function benchmarkMacUserFile(
  options: MacUserFileBenchmarkOptions,
): Promise<Record<string, unknown>> {
  if (!MAC_RECIPE_IDS.includes(options.recipeId))
    throw new TypeError(
      `File benchmark recipe must be one of: ${MAC_RECIPE_IDS.join(", ")}`,
    );

  const inputPath = resolve(options.inputPath);
  const iterationCount = options.iterations ?? 1;
  if (inputPath !== options.inputPath)
    throw new TypeError(
      "File benchmark input must be an absolute normalized path",
    );
  const input = await lstat(inputPath);
  if (!input.isFile() || input.isSymbolicLink() || input.size < 1)
    throw new TypeError(
      "File benchmark input must be a non-empty regular file",
    );

  const launchAgent =
    options.launchAgent ?? new MacLaunchAgentController(options.uid);
  const releaseRoot = await requireStoppedBenchmarkRuntime(
    options.layout,
    launchAgent,
  );
  const root = await mkdtemp(
    join(options.layout.temporaryRoot, "file-benchmark-"),
  );
  await chmod(root, 0o700);
  const reportPath = join(root, "report.json");
  const workRoot = join(root, "work");
  await mkdir(workRoot, { mode: 0o700 });
  const started = process.hrtime.bigint();
  try {
    await executeFile(
      options.layout.pythonPath,
      [
        "-m",
        "musicmute_engine.qualification",
        "--provider",
        "mps",
        "--fixture",
        inputPath,
        "--fixture-sha256",
        await sha256(inputPath),
        "--work-root",
        workRoot,
        "--release-root",
        releaseRoot,
        "--model-cache",
        options.layout.modelRoot,
        "--ffmpeg",
        options.layout.ffmpegPath,
        "--ffprobe",
        options.layout.ffprobePath,
        "--recipe-id",
        options.recipeId,
        "--iterations",
        String(iterationCount),
        "--report",
        reportPath,
      ],
      {
        cwd: options.layout.engineRoot,
        timeout: CAPACITY_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: benchmarkEnvironment(options.layout),
      },
    );
    const processWallSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    return summarizeFileBenchmarkReport(
      JSON.parse(await readFile(reportPath, "utf8")) as unknown,
      {
        inputPath,
        inputBytes: input.size,
        recipeId: options.recipeId,
        iterationCount,
        processWallSeconds,
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function summarizeFileBenchmarkReport(
  value: unknown,
  context: {
    inputPath: string;
    inputBytes: number;
    recipeId: string;
    iterationCount?: 1 | 2;
    processWallSeconds: number;
  },
): Record<string, unknown> {
  const report = record(value, "File benchmark report");
  if (report.status !== "PASS" || report.provider !== "mps")
    throw new TypeError("File benchmark did not prove MPS execution");
  const dispatch = record(report.providerDispatch, "Provider dispatch");
  if (dispatch.proven !== true)
    throw new TypeError("File benchmark did not prove MPS execution");
  const iterationCount = context.iterationCount ?? 1;
  if (
    !Array.isArray(report.recipes) ||
    report.recipes.length !== iterationCount
  )
    throw new TypeError(
      `File benchmark must contain exactly ${iterationCount} Kim Vocal 2 pass${iterationCount === 1 ? "" : "es"}`,
    );

  const iterations = report.recipes.map((candidate, index) => {
    const recipe = record(candidate, `File benchmark iteration ${index + 1}`);
    if (recipe.recipeId !== context.recipeId)
      throw new TypeError("File benchmark recipe identity changed");
    const endToEndSeconds = positiveNumber(
      recipe.endToEndSeconds,
      "File benchmark duration",
    );
    const rawStages = record(
      recipe.stageTimings,
      "File benchmark stage timings",
    );
    const stageTimings = Object.fromEntries(
      Object.entries(rawStages).map(([stage, seconds]) => [
        stage,
        nonNegativeNumber(seconds, `File benchmark ${stage} timing`),
      ]),
    );
    return {
      iteration: index + 1,
      endToEndSeconds,
      sourceDurationSeconds: positiveNumber(
        recipe.sourceDurationSeconds,
        "File benchmark source duration",
      ),
      outputDurationSeconds: positiveNumber(
        recipe.outputDurationSeconds,
        "File benchmark output duration",
      ),
      resultBytes: positiveNumber(
        recipe.resultBytes,
        "File benchmark result bytes",
      ),
      stageTimings,
    };
  });
  const firstPassSeconds = iterations[0]!.endToEndSeconds;
  const warmPasses = iterations.slice(1);
  const warmSeconds = warmPasses.map((iteration) => iteration.endToEndSeconds);
  const warmMeanSeconds =
    warmSeconds.length === 0
      ? null
      : warmSeconds.reduce((total, seconds) => total + seconds, 0) /
        warmSeconds.length;
  const preloadSeconds = positiveNumber(
    report.preloadSeconds,
    "File benchmark model preload duration",
  );
  return {
    schemaVersion: 1,
    status: "PASS",
    scope: "local-engine-only",
    networkUsed: false,
    backendUsed: false,
    storageUsed: false,
    databaseUsed: false,
    inputPath: context.inputPath,
    inputBytes: context.inputBytes,
    recipeId: context.recipeId,
    provider: "mps",
    processWallSeconds: context.processWallSeconds,
    engineTotalSeconds: positiveNumber(
      report.totalSeconds,
      "File benchmark total duration",
    ),
    modelPreloadSeconds: preloadSeconds,
    firstPassSeconds,
    coldSeconds: preloadSeconds + firstPassSeconds,
    warm:
      warmMeanSeconds === null
        ? null
        : {
            passes: warmSeconds.length,
            meanSeconds: warmMeanSeconds,
            minSeconds: Math.min(...warmSeconds),
            maxSeconds: Math.max(...warmSeconds),
            speedupVsFirstPass: firstPassSeconds / warmMeanSeconds,
          },
    providerDispatch: dispatch,
    iterations,
  };
}

export async function benchmarkMacUserWorker(options: {
  layout: MacUserLayout;
  uid: number;
  launchAgent?: Pick<
    MacLaunchAgentController,
    "bootstrap" | "bootout" | "status"
  >;
  qualify?: typeof qualifyMacUserRelease;
  workers?: 1 | 2;
  capacityBenchmark?: typeof runTwoWorkerCapacityBenchmark;
}) {
  const launchAgent =
    options.launchAgent ?? new MacLaunchAgentController(options.uid);
  const releaseRoot = await requireStoppedBenchmarkRuntime(
    options.layout,
    launchAgent,
  );
  const fixturePath = join(options.layout.stateRoot, "qualification.wav");
  const fixtureSha256 = await sha256(fixturePath);
  const qualify = options.qualify ?? qualifyMacUserRelease;
  try {
    const warmupReportPath = await qualify(
      options.layout,
      releaseRoot,
      fixturePath,
      fixtureSha256,
      launchAgent,
    );
    const rawWarmup = JSON.parse(
      await readFile(warmupReportPath, "utf8"),
    ) as unknown;
    const warmup = parseQualificationEvidence(rawWarmup);
    if ((options.workers ?? 1) === 1) return warmup;
    const capacity = await (
      options.capacityBenchmark ?? runTwoWorkerCapacityBenchmark
    )({
      layout: options.layout,
      machineId: (await loadRuntimeConfig(options.layout.configPath)).machineId,
      releaseRoot,
      fixturePath,
      fixtureSha256,
      baseline: rawWarmup,
    });
    return { baseline: warmup, capacity };
  } finally {
    await writeLaunchAgentPlist(options.layout);
  }
}

export async function runTwoWorkerCapacityBenchmark(options: {
  layout: MacUserLayout;
  machineId: string;
  releaseRoot: string;
  fixturePath: string;
  fixtureSha256: string;
  baseline: unknown;
}) {
  const baselineEvidence = parseQualificationEvidence(options.baseline);
  const root = await mkdtemp(join(options.layout.temporaryRoot, "capacity-"));
  await chmod(root, 0o700);
  try {
    const measuredBaseline = await runCapacityQualification({
      ...options,
      workRoot: join(root, "baseline"),
      reportPath: join(root, "baseline.json"),
      label: "baseline",
    });
    assertSameRuntimeIdentity(baselineEvidence, [measuredBaseline.parsed]);
    const baselineSeconds = measuredBaseline.wallSeconds;
    const reports = [0, 1].map((index) => ({
      workRoot: join(root, `worker-${index}`),
      reportPath: join(root, `worker-${index}.json`),
    }));
    const started = process.hrtime.bigint();
    const evidence = await Promise.all(
      reports.map(({ workRoot, reportPath }) =>
        runCapacityQualification({
          ...options,
          workRoot,
          reportPath,
          label: "concurrent worker",
        }),
      ),
    );
    const elapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    assertSameRuntimeIdentity(
      baselineEvidence,
      evidence.map(({ parsed }) => parsed),
    );
    const throughputSpeedup = (2 * baselineSeconds) / elapsedSeconds;
    if (
      !Number.isFinite(throughputSpeedup) ||
      throughputSpeedup < MINIMUM_TWO_WORKER_SPEEDUP
    )
      throw new Error(
        `Two-worker capacity did not improve throughput by ${MINIMUM_TWO_WORKER_SPEEDUP.toFixed(1)}x`,
      );
    const validatedAt = new Date();
    const result = {
      schemaVersion: 1,
      status: "PASS" as const,
      machineId: options.machineId,
      validatedMaxWorkersPerGpu: 2 as const,
      baselineSeconds,
      concurrentWallSeconds: elapsedSeconds,
      concurrentWorkerSeconds: evidence.map(({ seconds }) => seconds),
      throughputSpeedup,
      releaseManifestDigest: baselineEvidence.releaseManifestDigest,
      modelDigest: baselineEvidence.modelDigest,
      fixtureDigest: baselineEvidence.fixtureDigest,
      validatedAt: validatedAt.toISOString(),
      expiresAt: new Date(
        validatedAt.getTime() + 7 * 24 * 60 * 60_000,
      ).toISOString(),
    };
    await writeFile(
      options.layout.capacityValidationPath,
      `${JSON.stringify(result, null, 2)}\n`,
      { mode: 0o600 },
    );
    await chmod(options.layout.capacityValidationPath, 0o600);
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runCapacityQualification(options: {
  layout: MacUserLayout;
  releaseRoot: string;
  fixturePath: string;
  fixtureSha256: string;
  workRoot: string;
  reportPath: string;
  label: string;
}) {
  await mkdir(options.workRoot, { mode: 0o700 });
  const started = process.hrtime.bigint();
  await executeFile(
    options.layout.pythonPath,
    [
      "-m",
      "musicmute_engine.qualification",
      "--provider",
      "mps",
      "--fixture",
      options.fixturePath,
      "--fixture-sha256",
      options.fixtureSha256,
      "--work-root",
      options.workRoot,
      "--release-root",
      options.releaseRoot,
      "--model-cache",
      options.layout.modelRoot,
      "--ffmpeg",
      options.layout.ffmpegPath,
      "--ffprobe",
      options.layout.ffprobePath,
      "--report",
      options.reportPath,
    ],
    {
      cwd: options.layout.engineRoot,
      timeout: CAPACITY_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      env: benchmarkEnvironment(options.layout),
    },
  );
  const wallSeconds = Number(process.hrtime.bigint() - started) / 1e9;
  const raw = JSON.parse(await readFile(options.reportPath, "utf8")) as unknown;
  return {
    parsed: parseQualificationEvidence(raw),
    seconds: reportSeconds(raw, options.label),
    wallSeconds,
  };
}

function assertSameRuntimeIdentity(
  baseline: ReturnType<typeof parseQualificationEvidence>,
  candidates: ReturnType<typeof parseQualificationEvidence>[],
): void {
  if (
    candidates.some(
      (candidate) =>
        candidate.releaseManifestDigest !== baseline.releaseManifestDigest ||
        candidate.modelDigest !== baseline.modelDigest ||
        candidate.fixtureDigest !== baseline.fixtureDigest,
    )
  )
    throw new TypeError("Capacity benchmark runtime identity changed");
}

function reportSeconds(value: unknown, label: string): number {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} benchmark report is invalid`);
  const seconds = (value as Record<string, unknown>).totalSeconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0)
    throw new TypeError(`${label} benchmark duration is invalid`);
  return seconds;
}

async function sha256(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function requireStoppedBenchmarkRuntime(
  layout: MacUserLayout,
  launchAgent: Pick<MacLaunchAgentController, "status">,
): Promise<string> {
  const lifecycle = await loadLocalLifecycle(layout.lifecyclePath);
  const service = await launchAgent.status();
  if (lifecycle.intent !== "draining" || service.loaded)
    throw new Error(
      "Benchmark requires an already-drained and stopped worker; run drain, wait for jobs, then stop",
    );
  const releaseRoot = await realpath(layout.currentLink);
  const trustedRoot = await realpath(layout.releasesRoot);
  if (!releaseRoot.startsWith(`${trustedRoot}${sep}`))
    throw new TypeError("Active release is outside the trusted runtime root");
  return releaseRoot;
}

function benchmarkEnvironment(layout: MacUserLayout): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MPLCONFIGDIR: join(layout.cacheRoot, "matplotlib"),
    NUMBA_CACHE_DIR: join(layout.cacheRoot, "numba"),
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPYCACHEPREFIX: join(layout.cacheRoot, "python"),
    PYTHONUNBUFFERED: "1",
    XDG_CACHE_HOME: layout.cacheRoot,
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function positiveNumber(value: unknown, label: string): number {
  const number = nonNegativeNumber(value, label);
  if (number === 0) throw new TypeError(`${label} is invalid`);
  return number;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new TypeError(`${label} is invalid`);
  return value;
}

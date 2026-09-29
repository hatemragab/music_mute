import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
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
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  WORKER_RECIPE_IDS,
  type WorkerRecipeId,
} from "../../../protocol/v1/protocol.js";
const CAPACITY_TIMEOUT_MS = 7_200_000;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

export interface FileBenchmarkLayout {
  outputRoot: string;
  stateRoot: string;
  temporaryRoot: string;
  engineRoot: string;
  pythonPath: string;
  modelRoot: string;
  ffmpegPath: string;
  ffprobePath: string;
}

export interface RepeatedBenchmarkRun {
  iteration: number;
  role: "cold" | "warmup" | "measured";
  endToEndSeconds: number;
  sourceDurationSeconds: number;
  decodedInputDurationSeconds: number;
  decodedInputSamples: number;
  outputDurationSeconds: number;
  resultBytes: number;
  resultDigest: string;
  separationRtf: number | null;
  stageTimings: Record<string, number>;
  gpuMemoryBefore: unknown;
  gpuMemoryAfter: unknown;
  grouping: {
    selectedSize: 1 | 2 | 4;
    processedWindows: number;
    modelCalls: number;
    largestBatch: number;
  } | null;
}

export interface SavedBenchmarkAudioArtifact {
  iteration: number;
  role: RepeatedBenchmarkRun["role"];
  format: "mp3" | "flac";
  fileName: string;
  sha256: string;
  bytes: number;
}

export interface RepeatedBenchmarkReport {
  schemaVersion: 2;
  status: "PASS";
  scope: "local-engine-only";
  sourceMode: "candidate-engine" | "installed-engine";
  engineDigest: string;
  releaseManifestDigest: string;
  fixtureDigest: string;
  modelDigest: string;
  recipeId: string;
  recipeDigest: string;
  provider: "mps" | "directml";
  serviceIdentity: "S-1-5-19" | "current-user";
  fallbackDisabled: boolean;
  providerDispatch: Record<string, unknown>;
  gpuModel: string | null;
  gpuIdentity: Record<string, unknown> | null;
  osVersion: string;
  runtime: Record<string, unknown>;
  source: Record<string, unknown>;
  audioSettings: Record<string, unknown>;
  preloadSeconds: number;
  processWallSeconds: number;
  warmupRuns: number;
  measuredRuns: number;
  runs: RepeatedBenchmarkRun[];
  measuredSummary: {
    count: number;
    medianSeconds: number;
    minSeconds: number;
    maxSeconds: number;
    medianSeparationRtf: number | null;
  };
  savedAudio: boolean;
  savedAudioArtifacts: SavedBenchmarkAudioArtifact[];
  memoryScope: string;
  timingScope: string;
  comparison?: {
    comparable: boolean;
    reasons: string[];
    baselineMedianSeconds: number | null;
    candidateMedianSeconds: number | null;
    speedup: number | null;
  } | null;
}

export interface FileBenchmarkOptions {
  layout: FileBenchmarkLayout;
  provider: "mps" | "directml";
  requireStoppedRuntime: () => Promise<string>;
  environment: NodeJS.ProcessEnv;
  runProcess?: typeof runFileBenchmarkProcess;
  inputPath: string;
  recipeId: WorkerRecipeId;
  warmupRuns?: number;
  measuredRuns?: number;
  groupSize?: number;
  candidateEngineRoot?: string;
  outputReportPath?: string;
  saveAudioDir?: string;
  baselineReportPath?: string;
  onProgress?: (event: Record<string, unknown>) => void;
}

export async function benchmarkWorkerFile(
  options: FileBenchmarkOptions,
): Promise<RepeatedBenchmarkReport> {
  if (!WORKER_RECIPE_IDS.includes(options.recipeId))
    throw new TypeError(
      `File benchmark recipe must be one of: ${WORKER_RECIPE_IDS.join(", ")}`,
    );

  const inputPath = resolve(options.inputPath);
  const warmupRuns = options.warmupRuns ?? 1;
  const measuredRuns = options.measuredRuns ?? 3;
  const groupSize = options.groupSize ?? 1;
  if (!Number.isSafeInteger(warmupRuns) || warmupRuns < 0 || warmupRuns > 2)
    throw new TypeError("Benchmark warm-up runs must be between 0 and 2");
  if (
    !Number.isSafeInteger(measuredRuns) ||
    measuredRuns < 3 ||
    measuredRuns > 10
  )
    throw new TypeError("Benchmark measured runs must be between 3 and 10");
  if (options.provider === "directml" && groupSize !== 1)
    throw new TypeError("DirectML requires window group 1");
  if (![1, 2, 4].includes(groupSize))
    throw new TypeError("Window group must be 1, 2, or 4");
  if (inputPath !== options.inputPath)
    throw new TypeError(
      "File benchmark input must be an absolute normalized path",
    );
  const input = await lstat(inputPath);
  if (!input.isFile() || input.isSymbolicLink() || input.size < 1)
    throw new TypeError(
      "File benchmark input must be a non-empty regular file",
    );

  const candidateEngineRoot =
    options.candidateEngineRoot === undefined
      ? options.layout.engineRoot
      : await safeCandidateEngineRoot(options.candidateEngineRoot);
  const outputReportPath =
    options.outputReportPath === undefined
      ? null
      : await safeNewBenchmarkOutput(
          options.layout,
          options.outputReportPath,
          ".json",
        );
  const saveAudioDir =
    options.saveAudioDir === undefined
      ? null
      : await safeNewBenchmarkOutput(options.layout, options.saveAudioDir, "");
  const baseline =
    options.baselineReportPath === undefined
      ? null
      : await readBenchmarkBaseline(options.baselineReportPath);
  const releaseRoot = await options.requireStoppedRuntime();
  const root = await mkdtemp(
    join(options.layout.temporaryRoot, "file-benchmark-"),
  );
  await chmod(root, 0o700);
  const reportPath = join(root, "report.json");
  const workRoot = join(root, "work");
  await mkdir(workRoot, { mode: 0o700 });
  const started = process.hrtime.bigint();
  const progressEvents: Record<string, unknown>[] = [];
  try {
    const arguments_ = [
      "-m",
      "musicmute_engine.benchmark_file",
      "--provider",
      options.provider,
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
      "--warmup-runs",
      String(warmupRuns),
      "--measured-runs",
      String(measuredRuns),
      "--group-size",
      String(groupSize),
      "--report",
      reportPath,
      ...(options.candidateEngineRoot === undefined
        ? []
        : ["--candidate-engine-root", candidateEngineRoot]),
      ...(saveAudioDir === null ? [] : ["--save-audio-dir", saveAudioDir]),
    ];
    await (options.runProcess ?? runFileBenchmarkProcess)(
      options.layout.pythonPath,
      arguments_,
      {
        cwd: candidateEngineRoot,
        env: {
          ...options.environment,
          PYTHONPATH: candidateEngineRoot,
          PYTORCH_ENABLE_MPS_FALLBACK: "0",
        },
        onProgress: (event) => {
          if (progressEvents.length < 1_000) progressEvents.push(event);
          options.onProgress?.(event);
        },
      },
    );
    const processWallSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    const raw = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
    const report = summarizeRepeatedBenchmarkReport(raw, {
      processWallSeconds,
      measuredRuns,
      warmupRuns,
      groupSize,
      provider: options.provider,
    });
    const comparison =
      baseline === null ? null : compareBenchmarkReports(baseline, report);
    const result = { ...report, comparison };
    if (outputReportPath !== null)
      await writeFile(
        outputReportPath,
        `${JSON.stringify(result, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
    return result;
  } catch (error) {
    const saved = await preserveFileBenchmarkFailure(
      options.layout,
      reportPath,
      progressEvents,
    ).catch(() => null);
    throw new Error(
      saved === null
        ? "GPU file benchmark failed; no diagnostic report could be saved"
        : `GPU file benchmark failed; local diagnostic report: ${saved}`,
      { cause: error },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function summarizeRepeatedBenchmarkReport(
  value: unknown,
  context: {
    processWallSeconds: number;
    measuredRuns: number;
    warmupRuns: number;
    groupSize?: number;
    provider?: "mps" | "directml";
  },
): RepeatedBenchmarkReport {
  const report = record(value, "Repeated benchmark report");
  if (
    report.schemaVersion !== 2 ||
    report.status !== "PASS" ||
    report.scope !== "local-engine-only" ||
    !["mps", "directml"].includes(String(report.provider)) ||
    (context.provider !== undefined && report.provider !== context.provider) ||
    (report.provider === "directml" && report.serviceIdentity !== "S-1-5-19") ||
    typeof report.fallbackDisabled !== "boolean" ||
    (report.provider === "mps" && report.fallbackDisabled !== true)
  )
    throw new TypeError(
      "Repeated benchmark report must prove local GPU execution",
    );
  const dispatch = record(report.providerDispatch, "Provider dispatch");
  if (
    dispatch.proven !== true ||
    dispatch.cpuNodeEvents !== 0 ||
    !Number.isSafeInteger(dispatch.acceleratedNodeEvents) ||
    (dispatch.acceleratedNodeEvents as number) < 1
  )
    throw new TypeError(
      "Repeated benchmark did not prove GPU dispatch without fallback",
    );
  for (const key of [
    "engineDigest",
    "releaseManifestDigest",
    "fixtureDigest",
    "modelDigest",
    "recipeDigest",
  ])
    if (typeof report[key] !== "string" || !SHA256_HEX.test(report[key]))
      throw new TypeError(`Repeated benchmark ${key} is invalid`);
  if (
    report.sourceMode !== "candidate-engine" &&
    report.sourceMode !== "installed-engine"
  )
    throw new TypeError("Repeated benchmark source mode is invalid");
  if (
    typeof report.recipeId !== "string" ||
    !WORKER_RECIPE_IDS.includes(report.recipeId as WorkerRecipeId)
  )
    throw new TypeError("Repeated benchmark recipe is invalid");
  const source = record(report.source, "Benchmark source");
  const audioSettings = record(
    report.audioSettings,
    "Benchmark audio settings",
  );
  if (
    source.sha256 !== report.fixtureDigest ||
    !Number.isSafeInteger(source.bytes) ||
    (source.bytes as number) < 1 ||
    !Number.isSafeInteger(source.decodedSamples) ||
    (source.decodedSamples as number) < 1 ||
    positiveNumber(source.decodedDurationSeconds, "Decoded duration") > 1800 ||
    source.sampleRate !== 44_100 ||
    source.channels !== 2 ||
    ![1, 2, 4].includes(audioSettings.groupSize as number) ||
    (report.provider === "directml" && audioSettings.groupSize !== 1) ||
    (context.groupSize !== undefined &&
      audioSettings.groupSize !== context.groupSize) ||
    ![160, 192, 320].includes(audioSettings.bitrateKbps as number) ||
    audioSettings.format !== "mp3" ||
    !Number.isSafeInteger(audioSettings.hopLength) ||
    (audioSettings.hopLength as number) < 1 ||
    !Number.isSafeInteger(audioSettings.segmentSize) ||
    (audioSettings.segmentSize as number) < 1 ||
    !Number.isSafeInteger(audioSettings.fftSize) ||
    (audioSettings.fftSize as number) < 1 ||
    typeof audioSettings.overlap !== "number" ||
    !Number.isFinite(audioSettings.overlap) ||
    audioSettings.overlap <= 0 ||
    audioSettings.overlap >= 1
  )
    throw new TypeError(
      "Repeated benchmark source or audio settings are invalid",
    );
  if (
    report.warmupRuns !== context.warmupRuns ||
    report.measuredRuns !== context.measuredRuns ||
    !Array.isArray(report.runs) ||
    report.runs.length !== 1 + context.warmupRuns + context.measuredRuns
  )
    throw new TypeError("Repeated benchmark run count is invalid");
  const runs: RepeatedBenchmarkRun[] = report.runs.map((candidate, index) => {
    const run = record(candidate, `Benchmark run ${index + 1}`);
    const expectedRole =
      index === 0
        ? "cold"
        : index <= context.warmupRuns
          ? "warmup"
          : "measured";
    if (
      run.role !== expectedRole ||
      run.iteration !== index + 1 ||
      run.recipeId !== report.recipeId ||
      run.recipeDigest !== report.recipeDigest ||
      !SHA256_HEX.test(String(run.resultDigest))
    )
      throw new TypeError("Repeated benchmark run identity is invalid");
    const stages = record(run.stageTimings, "Benchmark stage timings");
    const stageTimings = Object.fromEntries(
      Object.entries(stages).map(([stage, seconds]) => [
        stage,
        nonNegativeNumber(seconds, `Benchmark ${stage} timing`),
      ]),
    );
    const decodedInputDurationSeconds = positiveNumber(
      run.measuredInputDurationSeconds,
      "Decoded input duration",
    );
    const separation = stageTimings.separation;
    let grouping: RepeatedBenchmarkRun["grouping"] = null;
    if (run.grouping !== undefined && run.grouping !== null) {
      const observed = record(run.grouping, "Benchmark window grouping");
      const selectedSize = audioSettings.groupSize as 1 | 2 | 4;
      const processedWindows = observed.processedWindows as number;
      const modelCalls = observed.modelCalls as number;
      const largestBatch = observed.largestBatch as number;
      if (
        observed.selectedSize !== selectedSize ||
        !Number.isSafeInteger(processedWindows) ||
        processedWindows < 1 ||
        !Number.isSafeInteger(modelCalls) ||
        modelCalls !== Math.ceil(processedWindows / selectedSize) ||
        !Number.isSafeInteger(largestBatch) ||
        largestBatch !== Math.min(selectedSize, processedWindows)
      )
        throw new TypeError("Benchmark window grouping evidence is invalid");
      grouping = { selectedSize, processedWindows, modelCalls, largestBatch };
    } else if (audioSettings.groupSize !== 1) {
      throw new TypeError("Grouped benchmark execution evidence is missing");
    }
    return {
      iteration: index + 1,
      role: expectedRole,
      endToEndSeconds: positiveNumber(
        run.endToEndSeconds,
        "Benchmark run duration",
      ),
      sourceDurationSeconds: positiveNumber(
        run.sourceDurationSeconds,
        "Source duration",
      ),
      decodedInputDurationSeconds,
      decodedInputSamples: positiveNumber(
        run.measuredInputSamples,
        "Decoded input samples",
      ),
      outputDurationSeconds: positiveNumber(
        run.outputDurationSeconds,
        "Output duration",
      ),
      resultBytes: positiveNumber(run.resultBytes, "Output bytes"),
      resultDigest: run.resultDigest as string,
      separationRtf:
        separation === undefined
          ? null
          : separation / decodedInputDurationSeconds,
      stageTimings,
      gpuMemoryBefore:
        report.provider === "mps" ? parseMpsMemory(run.gpuMemoryBefore) : null,
      gpuMemoryAfter:
        report.provider === "mps" ? parseMpsMemory(run.gpuMemoryAfter) : null,
      grouping,
    };
  });
  const measured = runs.filter((run) => run.role === "measured");
  const savedAudio = report.savedAudio === true;
  if (!Array.isArray(report.savedAudioArtifacts))
    throw new TypeError("Benchmark saved audio evidence is missing");
  const artifactFormats: ("mp3" | "flac")[] = !savedAudio
    ? []
    : report.savedAudioArtifacts.length === runs.length
      ? ["mp3"]
      : ["mp3", "flac"];
  if (
    report.savedAudioArtifacts.length !==
    runs.length * artifactFormats.length
  )
    throw new TypeError("Benchmark saved audio count is invalid");
  const savedAudioArtifacts: SavedBenchmarkAudioArtifact[] =
    report.savedAudioArtifacts.map((candidate, index) => {
      const artifact = record(candidate, "Benchmark saved audio artifact");
      const run = runs[Math.floor(index / artifactFormats.length)];
      if (!run) throw new TypeError("Benchmark saved audio run is missing");
      const format = artifactFormats[index % artifactFormats.length]!;
      const fileName = `${String(run.iteration).padStart(2, "0")}-${run.role}-vocals.${format}`;
      if (
        artifact.iteration !== run.iteration ||
        artifact.role !== run.role ||
        artifact.format !== format ||
        artifact.fileName !== fileName ||
        typeof artifact.sha256 !== "string" ||
        !SHA256_HEX.test(artifact.sha256) ||
        !Number.isSafeInteger(artifact.bytes) ||
        (artifact.bytes as number) < 1
      )
        throw new TypeError("Benchmark saved audio identity is invalid");
      return {
        iteration: run.iteration,
        role: run.role,
        format,
        fileName,
        sha256: artifact.sha256,
        bytes: artifact.bytes as number,
      };
    });
  const seconds = measured.map((run) => run.endToEndSeconds);
  const rtfs = measured.flatMap((run) =>
    run.separationRtf === null ? [] : [run.separationRtf],
  );
  const sourceMode = report.sourceMode as
    "candidate-engine" | "installed-engine";
  const gpuModel =
    typeof report.gpuModel === "string" &&
    /^[A-Za-z0-9 ._-]{1,100}$/u.test(report.gpuModel)
      ? report.gpuModel
      : null;
  const runtime = record(report.runtime, "Benchmark runtime");
  const gpuIdentity =
    report.provider === "directml"
      ? parseDirectmlIdentity(report.gpuIdentity)
      : null;
  if (gpuIdentity !== null && gpuIdentity.name !== gpuModel)
    throw new TypeError("DirectML adapter name does not match the report");
  return {
    schemaVersion: 2,
    status: "PASS",
    scope: "local-engine-only",
    sourceMode,
    engineDigest: report.engineDigest as string,
    releaseManifestDigest: report.releaseManifestDigest as string,
    fixtureDigest: report.fixtureDigest as string,
    modelDigest: report.modelDigest as string,
    recipeId: report.recipeId,
    recipeDigest: report.recipeDigest as string,
    provider: report.provider as "mps" | "directml",
    serviceIdentity:
      report.provider === "directml" ? "S-1-5-19" : "current-user",
    fallbackDisabled: report.fallbackDisabled,
    providerDispatch: {
      proven: true,
      acceleratedNodeEvents: dispatch.acceleratedNodeEvents,
      cpuNodeEvents: 0,
    },
    gpuModel,
    gpuIdentity,
    osVersion:
      typeof report.osVersion === "string"
        ? report.osVersion.slice(0, 100)
        : "unknown",
    runtime: Object.fromEntries(
      ["python", "torch", "onnxRuntime", "audioSeparator", "ffmpeg", "ffprobe"]
        .filter((key) => typeof runtime[key] === "string")
        .map((key) => [key, String(runtime[key]).slice(0, 150)]),
    ),
    source: {
      sha256: source.sha256,
      bytes: source.bytes,
      decodedDurationSeconds: source.decodedDurationSeconds,
      decodedSamples: source.decodedSamples,
      sampleRate: source.sampleRate,
      channels: source.channels,
    },
    audioSettings: {
      format: audioSettings.format,
      bitrateKbps: audioSettings.bitrateKbps,
      groupSize: audioSettings.groupSize,
      hopLength: audioSettings.hopLength,
      segmentSize: audioSettings.segmentSize,
      fftSize: audioSettings.fftSize,
      overlap: audioSettings.overlap,
    },
    preloadSeconds: positiveNumber(report.preloadSeconds, "Preload duration"),
    processWallSeconds: positiveNumber(
      context.processWallSeconds,
      "Process duration",
    ),
    warmupRuns: context.warmupRuns,
    measuredRuns: context.measuredRuns,
    runs,
    measuredSummary: {
      count: measured.length,
      medianSeconds: median(seconds),
      minSeconds: Math.min(...seconds),
      maxSeconds: Math.max(...seconds),
      medianSeparationRtf:
        rtfs.length === measured.length ? median(rtfs) : null,
    },
    savedAudio,
    savedAudioArtifacts,
    memoryScope:
      report.provider === "mps"
        ? "MPS process allocations sampled at full-run boundaries; not peak occupancy"
        : "GPU allocation is unavailable; no peak-memory claim",
    timingScope:
      report.provider === "mps"
        ? "MPS synchronized at full-run boundaries; no per-window synchronization"
        : "Synchronous DirectML session runs; host wall-clock timings",
  };
}

export function compareBenchmarkReports(
  baseline: RepeatedBenchmarkReport,
  candidate: RepeatedBenchmarkReport,
): NonNullable<RepeatedBenchmarkReport["comparison"]> {
  const reasons: string[] = [];
  for (const key of [
    "fixtureDigest",
    "modelDigest",
    "recipeDigest",
    "recipeId",
    "provider",
    "releaseManifestDigest",
  ] as const)
    if (baseline[key] !== candidate[key]) reasons.push(`${key} differs`);
  const { groupSize: _baselineGroup, ...baselineAudio } =
    baseline.audioSettings;
  const { groupSize: _candidateGroup, ...candidateAudio } =
    candidate.audioSettings;
  if (JSON.stringify(baselineAudio) !== JSON.stringify(candidateAudio))
    reasons.push("audio settings differ");
  if (
    baseline.gpuModel === null ||
    candidate.gpuModel === null ||
    baseline.gpuModel !== candidate.gpuModel
  )
    reasons.push("GPU model differs or is unavailable");
  if (baseline.osVersion !== candidate.osVersion)
    reasons.push("OS version differs");
  if (
    JSON.stringify(baseline.gpuIdentity) !==
    JSON.stringify(candidate.gpuIdentity)
  )
    reasons.push("GPU adapter identity differs");
  if (JSON.stringify(baseline.runtime) !== JSON.stringify(candidate.runtime))
    reasons.push("runtime dependencies differ");
  const baselineDuration = Number(baseline.source.decodedDurationSeconds);
  const candidateDuration = Number(candidate.source.decodedDurationSeconds);
  if (Math.abs(baselineDuration - candidateDuration) > 0.001)
    reasons.push("decoded duration differs");
  return {
    comparable: reasons.length === 0,
    reasons,
    baselineMedianSeconds: baseline.measuredSummary.medianSeconds,
    candidateMedianSeconds: candidate.measuredSummary.medianSeconds,
    speedup:
      reasons.length === 0
        ? baseline.measuredSummary.medianSeconds /
          candidate.measuredSummary.medianSeconds
        : null,
  };
}

function median(values: number[]): number {
  if (values.length === 0) throw new TypeError("Benchmark samples are missing");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function parseMpsMemory(
  value: unknown,
): { tensorAllocatedBytes: number; driverAllocatedBytes: number } | null {
  if (value === null || value === undefined) return null;
  const recordValue = record(value, "MPS memory sample");
  const tensor = recordValue.tensorAllocatedBytes;
  const driver = recordValue.driverAllocatedBytes;
  if (
    !Number.isSafeInteger(tensor) ||
    !Number.isSafeInteger(driver) ||
    (tensor as number) < 0 ||
    (driver as number) < 0
  )
    throw new TypeError("MPS memory sample is invalid");
  return {
    tensorAllocatedBytes: tensor as number,
    driverAllocatedBytes: driver as number,
  };
}

export function parseDirectmlIdentity(value: unknown): Record<string, unknown> {
  const adapter = record(value, "DirectML adapter identity");
  if (
    adapter.source !== "DXGI EnumAdapters1/GetDesc1" ||
    adapter.deviceIndex !== 0 ||
    typeof adapter.name !== "string" ||
    !/^[A-Za-z0-9 ._-]{1,100}$/u.test(adapter.name) ||
    typeof adapter.luid !== "string" ||
    !/^[a-f0-9]{16}$/u.test(adapter.luid) ||
    typeof adapter.driverVersion !== "string" ||
    !/^\d{1,5}(?:\.\d{1,5}){3}$/u.test(adapter.driverVersion) ||
    adapter.driverVersion.split(".").some((part) => Number(part) > 65535) ||
    [
      "vendorId",
      "deviceId",
      "subsystemId",
      "revision",
      "dedicatedVideoMemoryBytes",
      "sharedSystemMemoryLimitBytes",
    ].some(
      (key) =>
        !Number.isSafeInteger(adapter[key]) || (adapter[key] as number) < 0,
    ) ||
    adapter.vendorId === 0
  )
    throw new TypeError("DirectML adapter identity is invalid");
  return Object.fromEntries(
    [
      "source",
      "deviceIndex",
      "name",
      "luid",
      "driverVersion",
      "vendorId",
      "deviceId",
      "subsystemId",
      "revision",
      "dedicatedVideoMemoryBytes",
      "sharedSystemMemoryLimitBytes",
    ].map((key) => [key, adapter[key]]),
  );
}

async function safeCandidateEngineRoot(value: string): Promise<string> {
  const root = resolve(value);
  if (root !== value)
    throw new TypeError(
      "Candidate engine root must be an absolute normalized path",
    );
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new TypeError("Candidate engine root is unsafe");
  const module = await lstat(
    join(root, "musicmute_engine", "benchmark_file.py"),
  );
  if (!module.isFile() || module.isSymbolicLink())
    throw new TypeError("Candidate engine module is unsafe");
  return root;
}

async function safeNewBenchmarkOutput(
  layout: FileBenchmarkLayout,
  value: string,
  suffix: string,
): Promise<string> {
  const output = resolve(value);
  if (
    output !== value ||
    (suffix && !output.endsWith(suffix)) ||
    basename(output).length > 180
  )
    throw new TypeError("Benchmark output must be an absolute normalized path");
  const parent = await realpath(dirname(output));
  const home = await realpath(layout.outputRoot);
  if (parent !== home && !parent.startsWith(`${home}${sep}`))
    throw new TypeError(
      "Benchmark output must be inside the permitted output directory",
    );
  const existing = await lstat(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) throw new TypeError("Benchmark output already exists");
  return output;
}

async function readBenchmarkBaseline(
  path: string,
): Promise<RepeatedBenchmarkReport> {
  if (resolve(path) !== path || !path.endsWith(".json"))
    throw new TypeError("Baseline report path must be an absolute .json path");
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > 4 * 1024 * 1024
  )
    throw new TypeError("Baseline report file is unsafe");
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  return parseStoredRepeatedBenchmarkReport(raw);
}

export function parseStoredRepeatedBenchmarkReport(
  value: unknown,
): RepeatedBenchmarkReport {
  const stored = record(value, "Stored benchmark report");
  const measuredRuns = stored.measuredRuns;
  const warmupRuns = stored.warmupRuns;
  if (
    !Number.isSafeInteger(measuredRuns) ||
    (measuredRuns as number) < 3 ||
    (measuredRuns as number) > 10 ||
    !Number.isSafeInteger(warmupRuns) ||
    (warmupRuns as number) < 0 ||
    (warmupRuns as number) > 2 ||
    !Array.isArray(stored.runs)
  )
    throw new TypeError("Stored benchmark run count is invalid");

  // The CLI writes a normalized report. Restore only the raw runner field names
  // that the shared validator expects, then recalculate its summary from runs.
  const runs = stored.runs.map((candidate: unknown) => {
    const run = record(candidate, "Stored benchmark run");
    return {
      ...run,
      recipeId: stored.recipeId,
      recipeDigest: stored.recipeDigest,
      measuredInputDurationSeconds: run.decodedInputDurationSeconds,
      measuredInputSamples: run.decodedInputSamples,
    };
  });
  return summarizeRepeatedBenchmarkReport(
    { ...stored, runs },
    {
      processWallSeconds: positiveNumber(
        stored.processWallSeconds,
        "Stored benchmark process duration",
      ),
      measuredRuns: measuredRuns as number,
      warmupRuns: warmupRuns as number,
    },
  );
}

export async function runFileBenchmarkProcess(
  executable: string,
  arguments_: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    onProgress?: (event: Record<string, unknown>) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  if (process.platform === "win32")
    throw new TypeError("Windows benchmarks require an owned service task");
  if (options.signal?.aborted) throw new Error("GPU benchmark interrupted");
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    let stoppedReason: "timeout" | "interrupted" | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    const stopGroup = (reason: "timeout" | "interrupted") => {
      if (stoppedReason !== null) return;
      stoppedReason = reason;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* already exited */
        }
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* already exited */
          }
        }, 5_000);
        killTimer.unref();
      }
    };
    const onInterrupt = () => stopGroup("interrupted");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    options.signal?.addEventListener("abort", onInterrupt, { once: true });
    const timeout = setTimeout(() => stopGroup("timeout"), CAPACITY_TIMEOUT_MS);
    timeout.unref();
    const finish = () => {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
      options.signal?.removeEventListener("abort", onInterrupt);
      clearTimeout(timeout);
      if (killTimer !== null) clearTimeout(killTimer);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 16 * 1024) output = "";
      let newline = output.indexOf("\n");
      while (newline >= 0) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        try {
          const event = JSON.parse(line) as unknown;
          if (event && typeof event === "object" && !Array.isArray(event)) {
            const data = event as Record<string, unknown>;
            if (
              typeof data.type === "string" &&
              /^[a-z-]{1,32}$/u.test(data.type)
            )
              options.onProgress?.({
                type: data.type,
                ...(Number.isSafeInteger(data.index)
                  ? { index: data.index }
                  : {}),
                ...(typeof data.stage === "string" &&
                /^[a-z-]{1,64}$/u.test(data.stage)
                  ? { stage: data.stage }
                  : {}),
                ...(typeof data.role === "string" &&
                /^(cold|warmup|measured)$/u.test(data.role)
                  ? { role: data.role }
                  : {}),
                ...(typeof data.status === "string" &&
                /^(PASS|FAIL)$/u.test(data.status)
                  ? { status: data.status }
                  : {}),
              });
          }
        } catch {
          /* Ignore malformed progress lines; final report is authoritative. */
        }
        newline = output.indexOf("\n");
      }
    });
    child.stderr.on("data", () => {
      /* Never print Python stderr with private paths or media names. */
    });
    child.once("error", (error) => {
      finish();
      rejectRun(error);
    });
    child.once("close", (code) => {
      finish();
      if (stoppedReason !== null)
        rejectRun(new Error(`GPU benchmark ${stoppedReason}`));
      else if (code !== 0) rejectRun(new Error("GPU benchmark process failed"));
      else resolveRun();
    });
  });
}

async function preserveFileBenchmarkFailure(
  layout: FileBenchmarkLayout,
  reportPath: string,
  progress: Record<string, unknown>[],
): Promise<string> {
  const root = join(layout.stateRoot, "benchmark-failures");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(
    root,
    `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`,
  );
  const raw = await readFile(reportPath, "utf8").catch(() => "");
  let failure: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const candidate = parsed as Record<string, unknown>;
      if (candidate.status === "FAIL")
        failure = {
          code:
            typeof candidate.code === "string" &&
            /^[A-Za-z0-9_]{1,64}$/u.test(candidate.code)
              ? candidate.code
              : "BENCHMARK_FAILED",
          reason:
            typeof candidate.reason === "string" &&
            /^[A-Za-z0-9 ._-]{1,160}$/u.test(candidate.reason)
              ? candidate.reason
              : "Benchmark failed",
        };
    }
  } catch {
    /* Preserve sanitized progress when the child did not write a report. */
  }
  await writeFile(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: "FAIL",
        ...failure,
        progress: progress.slice(-100),
      },
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return path;
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

export async function sha256(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
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

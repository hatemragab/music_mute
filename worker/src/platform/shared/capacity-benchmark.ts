import { WORKER_RECIPE_IDS } from "../../../protocol/v1/protocol.js";
import {
  parseStoredRepeatedBenchmarkReport,
  summarizeRepeatedBenchmarkReport,
} from "./file-benchmark.js";

const MINIMUM_SPEEDUP = 1.1;
const MAX_ABSOLUTE_DIFFERENCE = 0.01;
const MAX_RMS_DIFFERENCE = 0.0001;

/** Validate the measurements themselves; a producer's PASS is not authority. */
export function parseCapacityBenchmarkReport(
  value: unknown,
  options: {
    provider: "mps" | "directml";
    fixtureDigest: string;
    warmupRuns: number;
    measuredRuns: number;
    stored?: boolean;
  },
) {
  const report = record(value);
  if (
    report.schemaVersion !== 1 ||
    report.kind !== "two-worker-capacity" ||
    report.scope !== "local-engine-only" ||
    report.provider !== options.provider ||
    report.fixtureDigest !== options.fixtureDigest ||
    report.warmupRuns !== options.warmupRuns ||
    report.measuredRuns !== options.measuredRuns ||
    !Number.isInteger(options.warmupRuns) ||
    options.warmupRuns < 1 ||
    options.warmupRuns > 2 ||
    !Number.isInteger(options.measuredRuns) ||
    options.measuredRuns < 3 ||
    options.measuredRuns > 10 ||
    report.minimumSpeedup !== MINIMUM_SPEEDUP ||
    record(report.qualityLimits).maxAbsoluteDifference !==
      MAX_ABSOLUTE_DIFFERENCE ||
    record(report.qualityLimits).rmsDifference !== MAX_RMS_DIFFERENCE
  )
    throw new TypeError("Capacity benchmark context is invalid");
  const identityKeys = [
    "engineDigest",
    "releaseManifestDigest",
    "fixtureDigest",
    "modelDigest",
    "provider",
    "serviceIdentity",
    "gpuIdentity",
    "osVersion",
  ] as const;
  const recipes = list(report.recipes, WORKER_RECIPE_IDS.length).map(
    (entry, recipeIndex) => {
      const recipe = record(entry);
      if (recipe.recipeId !== WORKER_RECIPE_IDS[recipeIndex])
        throw new TypeError("Capacity benchmark recipe coverage changed");
      const cohorts = [record(recipe.baseline), record(recipe.concurrent)].map(
        (cohort, index) => {
          const wallSeconds = positive(cohort.wallSeconds);
          const workerSeconds = list(cohort.workerSeconds, index + 1).map(
            positive,
          );
          const workerPids = list(cohort.workerPids, index + 1).map((pid) => {
            if (!Number.isSafeInteger(pid) || Number(pid) <= 0)
              throw new TypeError("Capacity process identity is invalid");
            return Number(pid);
          });
          if (
            new Set(workerPids).size !== workerPids.length ||
            workerSeconds.some((seconds) => seconds > wallSeconds)
          )
            throw new TypeError(
              "Capacity cohort is not independent or has invalid timings",
            );
          return { wallSeconds, workerSeconds, workerPids };
        },
      );
      const workerReports = list(recipe.workerReports, 2).map(
        (group, groupIndex) =>
          list(group, groupIndex + 1).map((entry, workerIndex) => {
            const measurement = record(entry);
            const raw = options.stored
              ? record(measurement.benchmark)
              : measurement;
            for (const key of identityKeys) {
              if (JSON.stringify(raw[key]) !== JSON.stringify(report[key]))
                throw new TypeError("Capacity worker identity changed");
            }
            if (
              raw.recipeId !== recipe.recipeId ||
              measurement.measuredWallSeconds !==
                cohorts[groupIndex]!.workerSeconds[workerIndex]
            )
              throw new TypeError("Capacity worker measurement changed");
            const benchmark = options.stored
              ? parseStoredRepeatedBenchmarkReport(raw)
              : summarizeRepeatedBenchmarkReport(raw, {
                  provider: options.provider,
                  groupSize: Number(record(raw.audioSettings).groupSize),
                  warmupRuns: options.warmupRuns,
                  measuredRuns: options.measuredRuns,
                  processWallSeconds: positive(raw.taskWallSeconds),
                });
            if (
              benchmark.sourceMode !== "installed-engine" ||
              benchmark.warmupRuns !== options.warmupRuns ||
              benchmark.measuredRuns !== options.measuredRuns ||
              benchmark.processWallSeconds <
                positive(measurement.measuredWallSeconds) ||
              benchmark.runs
                .filter((run) => run.role === "measured")
                .reduce((sum, run) => sum + run.endToEndSeconds, 0) >
                positive(measurement.measuredWallSeconds) + 1e-6 ||
              benchmark.preloadSeconds +
                benchmark.runs.reduce(
                  (sum, run) => sum + run.endToEndSeconds,
                  0,
                ) >
                benchmark.processWallSeconds + 1e-6 ||
              !Number.isSafeInteger(measurement.peakResidentBytes)
            )
              throw new TypeError("Capacity worker bounds changed");
            return {
              benchmark,
              measuredWallSeconds: positive(measurement.measuredWallSeconds),
              peakResidentBytes: positive(measurement.peakResidentBytes),
            };
          }),
      );
      const allWorkers = workerReports.flat();
      const settings = JSON.stringify(allWorkers[0]!.benchmark.audioSettings);
      const firstWorker = allWorkers[0]!.benchmark;
      if (
        allWorkers.some(
          ({ benchmark }) =>
            JSON.stringify(benchmark.audioSettings) !== settings ||
            benchmark.recipeDigest !== firstWorker.recipeDigest ||
            JSON.stringify(benchmark.runtime) !==
              JSON.stringify(firstWorker.runtime) ||
            JSON.stringify(benchmark.source) !==
              JSON.stringify(firstWorker.source),
        )
      )
        throw new TypeError(
          "Capacity processing context changed between workers",
        );
      const baseline = cohorts[0]!;
      const concurrent = cohorts[1]!;
      const speedup = (2 * baseline.wallSeconds) / concurrent.wallSeconds;
      if (Math.abs(positive(recipe.throughputSpeedup) - speedup) > 1e-8)
        throw new TypeError("Capacity throughput calculation changed");
      const expectedComparisons = 3 * options.measuredRuns;
      const seen = new Set<string>();
      const quality = list(recipe.quality, expectedComparisons).map((entry) => {
        const item = record(entry);
        const workers = item.cohortWorkers;
        const index = Number(item.worker);
        const iteration = Number(item.iteration);
        if (
          (workers !== 1 && workers !== 2) ||
          !Number.isInteger(item.worker) ||
          index < 0 ||
          index >= workers ||
          !Number.isInteger(item.iteration) ||
          iteration < 2 + options.warmupRuns ||
          iteration >= 2 + options.warmupRuns + options.measuredRuns
        )
          throw new TypeError("Capacity output comparison identity is invalid");
        const key = `${workers}:${index}:${iteration}`;
        if (seen.has(key))
          throw new TypeError("Capacity output comparison is duplicated");
        seen.add(key);
        const maximum = nonnegative(item.maxAbsoluteDifference);
        const rms = nonnegative(item.rmsDifference);
        if (
          rms > maximum ||
          item.sampleRate !== 44100 ||
          item.channels !== 2 ||
          !Number.isSafeInteger(item.frames) ||
          Number(item.frames) < 1 ||
          Number(item.frames) > 44100 * 1800
        )
          throw new TypeError("Capacity output comparison is invalid");
        const passed =
          maximum <= MAX_ABSOLUTE_DIFFERENCE && rms <= MAX_RMS_DIFFERENCE;
        if (item.passed !== passed)
          throw new TypeError("Capacity output quality verdict changed");
        return {
          cohortWorkers: workers,
          worker: index,
          iteration,
          passed,
          maxAbsoluteDifference: maximum,
          rmsDifference: rms,
          frames: Number(item.frames),
          sampleRate: 44100,
          channels: 2,
        };
      });
      if (new Set(quality.map((item) => item.frames)).size !== 1)
        throw new TypeError("Capacity output duration changed");
      const passed =
        speedup >= MINIMUM_SPEEDUP && quality.every((item) => item.passed);
      if (recipe.passed !== passed)
        throw new TypeError("Capacity recipe verdict changed");
      return {
        recipeId: recipe.recipeId as string,
        baseline,
        concurrent,
        throughputSpeedup: speedup,
        quality,
        passed,
        workerReports,
      };
    },
  );
  const status = recipes.every((recipe) => recipe.passed) ? "PASS" : "FAIL";
  if (report.status !== status)
    throw new TypeError("Capacity benchmark verdict changed");
  const first = recipes[0]!.workerReports[0]![0]!.benchmark;
  return {
    schemaVersion: 1 as const,
    kind: "two-worker-capacity" as const,
    status,
    scope: "local-engine-only" as const,
    engineDigest: first.engineDigest,
    releaseManifestDigest: first.releaseManifestDigest,
    fixtureDigest: first.fixtureDigest,
    modelDigest: first.modelDigest,
    provider: first.provider,
    serviceIdentity: first.serviceIdentity,
    gpuIdentity: first.gpuIdentity,
    osVersion: first.osVersion,
    warmupRuns: options.warmupRuns,
    measuredRuns: options.measuredRuns,
    minimumSpeedup: MINIMUM_SPEEDUP,
    qualityLimits: {
      maxAbsoluteDifference: MAX_ABSOLUTE_DIFFERENCE,
      rmsDifference: MAX_RMS_DIFFERENCE,
    },
    measurementScope:
      "Common post-warmup start barrier; output comparison and report finalization excluded",
    memoryScope:
      "Individual process lifetime peak resident bytes; excludes GPU allocation and media subprocesses",
    recipes,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Capacity evidence must be an object");
  return value as Record<string, unknown>;
}
function list(value: unknown, length: number): unknown[] {
  if (!Array.isArray(value) || value.length !== length)
    throw new TypeError("Capacity evidence count is invalid");
  return value;
}
function nonnegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new TypeError("Capacity measurement is invalid");
  return value;
}
function positive(value: unknown): number {
  const number = nonnegative(value);
  if (number === 0)
    throw new TypeError("Capacity measurement must be positive");
  return number;
}

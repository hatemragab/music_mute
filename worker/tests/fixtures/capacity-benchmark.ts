import { WORKER_RECIPE_IDS } from "../../protocol/v1/protocol.js";
import { repeatedReport } from "./repeated-benchmark.js";

export function capacityReport(
  overrides: Partial<{
    engineDigest: string;
    releaseManifestDigest: string;
    fixtureDigest: string;
    modelDigest: string;
  }> = {},
) {
  const identity = {
    engineDigest: "a".repeat(64),
    releaseManifestDigest: "b".repeat(64),
    fixtureDigest: "c".repeat(64),
    modelDigest: "d".repeat(64),
    provider: "mps",
    serviceIdentity: "current-user",
    gpuIdentity: null,
    osVersion: "26.0",
    ...overrides,
  };
  return {
    schemaVersion: 1,
    kind: "two-worker-capacity",
    scope: "local-engine-only",
    status: "PASS",
    ...identity,
    warmupRuns: 1,
    measuredRuns: 3,
    minimumSpeedup: 1.1,
    qualityLimits: { maxAbsoluteDifference: 0.01, rmsDifference: 0.0001 },
    recipes: WORKER_RECIPE_IDS.map((recipeId) => ({
      recipeId,
      baseline: { wallSeconds: 310, workerSeconds: [305], workerPids: [100] },
      concurrent: {
        wallSeconds: 420,
        workerSeconds: [410, 410],
        workerPids: [101, 102],
      },
      throughputSpeedup: 620 / 420,
      passed: true,
      workerReports: [1, 2].map((count) =>
        Array.from({ length: count }, () => {
          const raw = repeatedReport(
            count === 1 ? [120, 115, 100, 90, 110] : [160, 150, 130, 125, 135],
          );
          return {
            ...raw,
            ...identity,
            source: { ...raw.source, sha256: identity.fixtureDigest },
            sourceMode: "installed-engine",
            recipeId,
            measuredWallSeconds: count === 1 ? 305 : 410,
            taskWallSeconds: 800,
            peakResidentBytes: 500_000_000,
            runs: raw.runs.map((run) => ({ ...run, recipeId })),
          };
        }),
      ),
      quality: [1, 2].flatMap((count) =>
        Array.from({ length: count }, (_, worker) =>
          [3, 4, 5].map((iteration) => ({
            cohortWorkers: count,
            worker,
            iteration,
            passed: true,
            maxAbsoluteDifference: 0,
            rmsDifference: 0,
            frames: 7_938_000,
            sampleRate: 44100,
            channels: 2,
          })),
        ).flat(),
      ),
    })),
  };
}

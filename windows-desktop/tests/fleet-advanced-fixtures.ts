import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { repeatedReport } from "../../worker/tests/fixtures/repeated-benchmark.js";
import { capacityReport } from "../../worker/tests/fixtures/capacity-benchmark.js";
import { summarizeRepeatedBenchmarkReport } from "../../worker/src/platform/shared/file-benchmark.js";
import type { AdvancedBenchmarkConfiguration } from "../src/main/fleet/advanced/benchmark-child.js";
import type { AdvancedReadySnapshot } from "../src/main/fleet/advanced/benchmark-runner.js";
import { prepared, fleetSid } from "./fleet-fixtures.js";
export const advancedRequest = "cb9c4c74-7e0d-4cbd-9f04-2d5ce37019a7";
export const advancedTransaction = "ab9c4c74-7e0d-4cbd-9f04-2d5ce37019a7";
export const advancedGpu = prepared().gpu;
export const processIdentity = {
  sid: fleetSid,
  sessionId: 1,
  pid: 12345,
  creationTime: "133000000000000000",
};
export function benchmarkConfig(
  operation: AdvancedBenchmarkConfiguration["operation"] = "benchmark_file",
): AdvancedBenchmarkConfiguration {
  return {
    version: 1,
    bootIdentity: "e".repeat(64),
    operation,
    requestId: advancedRequest,
    release: "a".repeat(64),
    sid: fleetSid,
    manifestSha256: "b".repeat(64),
    helperSha256: "d".repeat(64),
    gpu: { ...advancedGpu },
    fixture: {
      relativePath:
        operation === "benchmark_file"
          ? `prepare\\work\\${advancedRequest}\\source.wav`
          : `prepare\\approved\\${"c".repeat(64)}.wav`,
      bytes: 4000000,
      sha256: "c".repeat(64),
    },
    recipe: "kim-vocals-v2",
    warmupRuns: 1,
    measuredRuns: 3,
  };
}
export function readySnapshot(): AdvancedReadySnapshot {
  return {
    bootIdentity: "e".repeat(64),
    release: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    nativeSha256: "d".repeat(64),
    modelSha256: MODEL.sha256,
    evidence: { gpuIdentity: { ...advancedGpu } },
    releaseRoot: `C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal\\runtime\\releases\\${"a".repeat(64)}`,
  } as unknown as AdvancedReadySnapshot;
}
export function consumerRepeatedRaw() {
  return {
    ...repeatedReport([120, 115, 100, 90, 110]),
    sourceMode: "installed-engine",
    provider: "directml",
    serviceIdentity: fleetSid,
    gpuIdentity: { ...advancedGpu },
    gpuModel: advancedGpu.name,
    modelDigest: MODEL.sha256,
  };
}
export function consumerRepeatedStored() {
  return summarizeRepeatedBenchmarkReport(consumerRepeatedRaw(), {
    provider: "directml",
    groupSize: 1,
    warmupRuns: 1,
    measuredRuns: 3,
    processWallSeconds: 800,
    expectedUserSid: fleetSid,
  });
}
export function consumerCapacityRaw() {
  const raw = capacityReport({
    modelDigest: MODEL.sha256,
  }) as unknown as Record<string, unknown>;
  Object.assign(raw, {
    provider: "directml",
    serviceIdentity: fleetSid,
    gpuIdentity: { ...advancedGpu },
  });
  for (const recipe of raw.recipes as {
    workerReports: Record<string, unknown>[][];
  }[])
    for (const cohort of recipe.workerReports)
      for (const report of cohort)
        Object.assign(report, {
          provider: "directml",
          serviceIdentity: fleetSid,
          gpuIdentity: { ...advancedGpu },
          gpuModel: advancedGpu.name,
          fallbackDisabled: true,
        });
  return raw;
}

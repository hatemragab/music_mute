import { describe, expect, it } from "vitest";
import { parseCapacityBenchmarkReport } from "../src/platform/shared/capacity-benchmark.js";
import { capacityReport as fixture } from "./fixtures/capacity-benchmark.js";

const options = {
  provider: "mps" as const,
  fixtureDigest: "c".repeat(64),
  warmupRuns: 1,
  measuredRuns: 3,
};

describe("shared capacity evidence", () => {
  it("recomputes throughput and survives normalized report round trips", () => {
    const report = parseCapacityBenchmarkReport(fixture(), options);
    expect(report.status).toBe("PASS");
    expect(report.recipes[0]!.throughputSpeedup).toBe(620 / 420);
    expect(
      parseCapacityBenchmarkReport(report, { ...options, stored: true }),
    ).toEqual(report);
  });

  it("retains valid measurements that fail the speed gate without qualifying them", () => {
    const raw = fixture();
    raw.status = "FAIL";
    for (const recipe of raw.recipes) {
      recipe.concurrent.wallSeconds = 620;
      recipe.throughputSpeedup = 1;
      recipe.passed = false;
    }
    expect(parseCapacityBenchmarkReport(raw, options).status).toBe("FAIL");
  });

  it("rejects forged speed, missing comparisons, reused processes and CPU fallback", () => {
    for (const mutate of [
      (raw: ReturnType<typeof fixture>) => {
        raw.recipes[0]!.throughputSpeedup = 2;
      },
      (raw: ReturnType<typeof fixture>) => {
        raw.recipes[0]!.quality.pop();
      },
      (raw: ReturnType<typeof fixture>) => {
        raw.recipes[0]!.concurrent.workerPids = [101, 101];
      },
      (raw: ReturnType<typeof fixture>) => {
        raw.recipes[0]!.workerReports[1]![0]!.providerDispatch.cpuNodeEvents = 1;
      },
      (raw: ReturnType<typeof fixture>) => {
        raw.recipes[0]!.quality[0]!.rmsDifference = 0.01;
        raw.recipes[0]!.quality[0]!.maxAbsoluteDifference = 0.02;
      },
      (raw: ReturnType<typeof fixture>) => {
        raw.recipes[0]!.workerReports[1]![0]!.fixtureDigest = "f".repeat(64);
      },
      (raw: ReturnType<typeof fixture>) => {
        raw.recipes[0]!.workerReports[1]![0]!.sourceMode = "candidate-engine";
      },
      (raw: ReturnType<typeof fixture>) => {
        raw.recipes[0]!.concurrent.workerSeconds[0] = 1;
        raw.recipes[0]!.workerReports[1]![0]!.measuredWallSeconds = 1;
      },
      (raw: ReturnType<typeof fixture>) => {
        raw.recipes[0]!.workerReports[1]![0]!.taskWallSeconds = 411;
      },
      (raw: ReturnType<typeof fixture>) => {
        raw.recipes[0]!.workerReports[1]![0]!.runtime.torch = "changed";
      },
      (raw: ReturnType<typeof fixture>) => {
        raw.recipes[0]!.workerReports[1]![0]!.source.bytes += 1;
      },
    ]) {
      const raw = fixture();
      mutate(raw);
      expect(() => parseCapacityBenchmarkReport(raw, options)).toThrow();
    }
  });
});

import { describe, it, expect } from "vitest";
import { parseCapacityBenchmarkReport } from "../src/platform/shared/capacity-benchmark.js";
import { parseStoredRepeatedBenchmarkReport } from "../src/platform/shared/file-benchmark.js";
import {
  createCapacityReceipt,
  parseCapacityReceipt,
} from "../src/runtime/capacity-receipt.js";
import { stableCapacityGpuIdentity } from "../src/runtime/capacity-gpu-identity.js";
import { capacityReport } from "./fixtures/capacity-benchmark.js";
const sid = "S-1-5-21-100-200-300-1001";
const gpu = {
  source: "DXGI EnumAdapters1/GetDesc1",
  deviceIndex: 2,
  name: "NVIDIA RTX fixture",
  luid: "0000000000001234",
  driverVersion: "1.2.3.4",
  vendorId: 4318,
  deviceId: 123,
  subsystemId: 1,
  revision: 1,
  dedicatedVideoMemoryBytes: 8 * 1024 ** 3,
  sharedSystemMemoryLimitBytes: 4 * 1024 ** 3,
};
function consumer() {
  const raw = capacityReport() as unknown as Record<string, unknown>;
  raw.provider = "directml";
  raw.serviceIdentity = sid;
  raw.gpuIdentity = gpu;
  for (const recipe of raw.recipes as {
    workerReports: Record<string, unknown>[][];
  }[]) {
    for (const cohort of recipe.workerReports)
      for (const report of cohort) {
        Object.assign(report, {
          provider: "directml",
          serviceIdentity: sid,
          gpuIdentity: gpu,
          gpuModel: gpu.name,
          fallbackDisabled: true,
        });
      }
  }
  return raw;
}
const options = {
  provider: "directml" as const,
  fixtureDigest: "c".repeat(64),
  warmupRuns: 1,
  measuredRuns: 3,
  expectedUserSid: sid,
};
describe("explicit Windows consumer benchmark identity context", () => {
  it("requires explicit current SID and preserves actual nonzero adapter ordinal through normalized reports", () => {
    const raw = consumer(),
      result = parseCapacityBenchmarkReport(raw, options);
    expect(result.serviceIdentity).toBe(sid);
    expect(result.gpuIdentity?.deviceIndex).toBe(2);
    expect(
      parseCapacityBenchmarkReport(result, { ...options, stored: true }),
    ).toEqual(result);
    const { expectedUserSid: _sid, ...legacy } = options;
    expect(() => parseCapacityBenchmarkReport(raw, legacy)).toThrow();
    expect(() =>
      parseCapacityBenchmarkReport(raw, {
        ...options,
        expectedUserSid: "S-1-5-19",
      }),
    ).toThrow();
    expect(() =>
      parseCapacityBenchmarkReport(raw, {
        ...options,
        expectedUserSid: "S-1-5-21-100-200-300-1002",
      }),
    ).toThrow();
  });
  it("rejects CPU fallback and an out-of-range ordinal even when a producer declares PASS", () => {
    for (const mutate of [
      (r: Record<string, unknown>) => {
        (
          r.recipes as { workerReports: Record<string, unknown>[][] }[]
        )[0]!.workerReports[0]![0]!.fallbackDisabled = false;
      },
      (r: Record<string, unknown>) => {
        (r.gpuIdentity as typeof gpu).deviceIndex = 16;
      },
    ]) {
      const raw = consumer();
      raw.gpuIdentity = { ...gpu };
      mutate(raw);
      expect(() => parseCapacityBenchmarkReport(raw, options)).toThrow();
    }
  });
  it("binds seven-day receipt to actual SID/hardware/driver/model/release/fixture and leaves legacy receipts strict", () => {
    const measurements = parseCapacityBenchmarkReport(consumer(), options),
      identity = {
        releaseManifestDigest: measurements.releaseManifestDigest,
        modelDigest: measurements.modelDigest,
        fixtureDigest: measurements.fixtureDigest,
        provider: "directml" as const,
        gpuIdentity: stableCapacityGpuIdentity(measurements.gpuIdentity, {
          allowDeviceOrdinal: true,
        }),
        hostDigest: "f".repeat(64),
      };
    const receipt = createCapacityReceipt({
      machineId: "dc1b9b77-28e9-42cc-86de-76a9311aa7eb",
      identity,
      measurements,
      expectedUserSid: sid,
    });
    expect(
      parseCapacityReceipt(receipt, {
        machineId: receipt.machineId,
        provider: "directml",
        expectedUserSid: sid,
      }),
    ).toEqual(receipt);
    expect(() =>
      parseCapacityReceipt(receipt, {
        machineId: receipt.machineId,
        provider: "directml",
      }),
    ).toThrow();
    expect(() =>
      parseStoredRepeatedBenchmarkReport(
        measurements.recipes[0]!.workerReports[0]![0]!.benchmark,
      ),
    ).toThrow();
  });
});

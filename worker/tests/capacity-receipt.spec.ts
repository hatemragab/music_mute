import { describe, expect, it } from "vitest";
import { parseCapacityBenchmarkReport } from "../src/platform/shared/capacity-benchmark.js";
import { stableCapacityGpuIdentity } from "../src/runtime/capacity-identity.js";
import {
  assertCapacityReceiptIdentity,
  createCapacityReceipt,
  parseCapacityReceipt,
} from "../src/runtime/capacity-receipt.js";
import { capacityReport } from "./fixtures/capacity-benchmark.js";

const machineId = "00000000-0000-4000-8000-000000000010";
const now = Date.parse("2026-09-29T04:00:00Z");
const gpuIdentity = {
  source: "DXGI EnumAdapters1/GetDesc1",
  deviceIndex: 0,
  name: "Radeon RX 580",
  luid: "0000000000000001",
  driverVersion: "31.0.21925.1001",
  vendorId: 4098,
  deviceId: 26591,
  subsystemId: 1,
  revision: 1,
  dedicatedVideoMemoryBytes: 8 * 1024 ** 3,
  sharedSystemMemoryLimitBytes: 12 * 1024 ** 3,
};
function fixture(provider: "mps" | "directml" = "mps") {
  const raw = capacityReport();
  if (provider === "directml") {
    Object.assign(raw, { provider, gpuIdentity, serviceIdentity: "S-1-5-19" });
    for (const recipe of raw.recipes)
      for (const worker of recipe.workerReports.flat()) {
        Object.assign(worker, {
          provider,
          gpuIdentity,
          serviceIdentity: "S-1-5-19",
          gpuModel: gpuIdentity.name,
          fallbackDisabled: false,
        });
      }
  }
  const measurements = parseCapacityBenchmarkReport(raw, {
    provider,
    fixtureDigest: raw.fixtureDigest,
    warmupRuns: 1,
    measuredRuns: 3,
  });
  const identity = {
    provider,
    gpuIdentity:
      provider === "directml" ? stableCapacityGpuIdentity(gpuIdentity) : null,
    releaseManifestDigest: raw.releaseManifestDigest,
    modelDigest: raw.modelDigest,
    fixtureDigest: raw.fixtureDigest,
    hostDigest: "a".repeat(64),
  };
  return {
    identity,
    receipt: createCapacityReceipt({ machineId, now, identity, measurements }),
  };
}

describe("capacity admission receipt", () => {
  it.each(["mps", "directml"] as const)(
    "revalidates the full %s measurements and installed identity",
    (provider) => {
      const { identity, receipt } = fixture(provider);
      expect(
        parseCapacityReceipt(receipt, { machineId, provider, now }),
      ).toEqual(receipt);
      expect(() =>
        assertCapacityReceiptIdentity(receipt, identity),
      ).not.toThrow();
      for (const key of [
        "hostDigest",
        "releaseManifestDigest",
        "fixtureDigest",
        "modelDigest",
      ] as const)
        expect(() =>
          assertCapacityReceiptIdentity(receipt, {
            ...identity,
            [key]: "f".repeat(64),
          }),
        ).toThrow("installed runtime");
    },
  );

  it("rejects expired, future, excessive, reversed, old and foreign-machine approvals", () => {
    const { receipt } = fixture();
    const cases = [
      { expiresAt: new Date(now).toISOString() },
      { validatedAt: new Date(now + 600_000).toISOString() },
      { expiresAt: new Date(now + 8 * 86400000).toISOString() },
      {
        validatedAt: new Date(now + 60_000).toISOString(),
        expiresAt: new Date(now + 30_000).toISOString(),
      },
      { schemaVersion: 2 },
      { machineId: "00000000-0000-4000-8000-000000000011" },
      { status: "IN_PROGRESS" },
      { unrecognized: true },
    ];
    for (const changes of cases)
      expect(() =>
        parseCapacityReceipt(
          { ...receipt, ...changes },
          { machineId, provider: "mps", now },
        ),
      ).toThrow();
  });

  it("does not accept a PASS summary without matching timing and output-quality evidence", () => {
    const { receipt } = fixture();
    const speed = structuredClone(receipt);
    speed.measurements.recipes[0]!.throughputSpeedup *= 2;
    const quality = structuredClone(receipt);
    quality.measurements.recipes[1]!.quality.pop();
    const dispatch = structuredClone(receipt);
    dispatch.measurements.recipes[1]!.workerReports[1]![0]!.benchmark.providerDispatch.cpuNodeEvents = 1;
    for (const value of [
      speed,
      quality,
      dispatch,
      { ...receipt, measurements: {} },
    ])
      expect(() =>
        parseCapacityReceipt(value, { machineId, provider: "mps", now }),
      ).toThrow();
  });

  it("preserves approval across an adapter LUID change but rejects driver or hardware changes", () => {
    const { identity, receipt } = fixture("directml");
    const afterReboot = stableCapacityGpuIdentity({
      ...gpuIdentity,
      luid: "0000000000000002",
    });
    expect(afterReboot).toEqual(identity.gpuIdentity);
    expect(() =>
      assertCapacityReceiptIdentity(receipt, {
        ...identity,
        gpuIdentity: afterReboot,
      }),
    ).not.toThrow();
    for (const changes of [
      { driverVersion: "31.0.21925.1002" },
      { deviceId: 123 },
    ])
      expect(() =>
        assertCapacityReceiptIdentity(receipt, {
          ...identity,
          gpuIdentity: stableCapacityGpuIdentity({
            ...gpuIdentity,
            ...changes,
          }),
        }),
      ).toThrow("installed runtime");
    for (const driverVersion of [undefined, "", "1.2.3", "1.2.3.65536"])
      expect(() =>
        stableCapacityGpuIdentity({ ...gpuIdentity, driverVersion }),
      ).toThrow();
  });
});

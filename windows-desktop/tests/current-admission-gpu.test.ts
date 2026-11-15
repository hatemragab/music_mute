import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  readCurrentFleetGpu,
  readCurrentPersonalGpu,
} from "../src/main/admission/current-gpu.js";
import { fleetRecordAuthority } from "../src/main/fleet/store.js";
import type { FleetActiveRuntimeProof } from "../src/main/fleet/active-runtime.js";
import { record } from "./fleet-fixtures.js";
import { receipt } from "./fixtures/prepare.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
function fixture() {
  const ready = receipt(),
    enrolled = record();
  ready.sid = enrolled.sid;
  ready.qualification.serviceIdentity = enrolled.sid;
  enrolled.prepared.bootIdentity = "0".repeat(64);
  enrolled.prepared.modelDigest = MODEL.sha256;
  enrolled.prepared.report.runtime.modelDigest = MODEL.sha256;
  const gpu = {
      ...enrolled.prepared.gpu,
      luid: "0000000000004321",
      driverVersion: "32.0.4.5",
      deviceIndex: 1,
    },
    qualification = {
      ...ready.qualification,
      serviceIdentity: enrolled.sid,
      gpuId: `dxgi-${gpu.luid}`,
      directmlDeviceId: gpu.deviceIndex,
      gpuIdentity: gpu,
      fixtureDigest: enrolled.prepared.fixtureDigest,
      resourceObservations: {
        inferenceSlots: 1,
        dedicatedVideoMemoryLimitBytes: gpu.dedicatedVideoMemoryBytes,
        sharedSystemMemoryLimitBytes: gpu.sharedSystemMemoryLimitBytes,
      },
    },
    active: FleetActiveRuntimeProof = {
      version: 2,
      bootIdentity: ready.bootIdentity,
      sid: enrolled.sid,
      authority: fleetRecordAuthority(enrolled),
      transaction: randomUUID(),
      updateIdentity: "f".repeat(64),
      release: ready.release,
      manifestDigest: ready.manifestSha256,
      archiveDigest: "d".repeat(64),
      modelDigest: MODEL.sha256,
      fixtureDigest: enrolled.prepared.fixtureDigest,
      approvedRecipeDigests: { "kim-vocals-v2": "0".repeat(64) },
      qualification,
      qualifiedAt: new Date().toISOString(),
    };
  const values = new Map([
      ["ready_receipt", ready],
      ["enrollment", enrolled],
      ["active_runtime", active],
    ] as [string, unknown][]),
    native = {
      identity: async () => ({
        sid: enrolled.sid,
        sessionId: 1,
        pid: 10,
        creationTime: "10000",
        logonSid: "S-1-5-5-1-2",
        nativeArch: "x64" as const,
        processArch: "x64" as const,
        osMajor: 10 as const,
        osBuild: 19045,
        localAppData: "C:\\Users\\fixture\\AppData\\Local",
      }),
      bootIdentity: vi.fn(async () => ready.bootIdentity),
      enumerateGpus: vi.fn(async () => [
        ready.qualification.gpuIdentity,
        { ...gpu, deviceIndex: 5 },
      ]),
      vaultRead: vi.fn(async (_namespace: string, key: string) =>
        values.has(key) ? Buffer.from(JSON.stringify(values.get(key))) : null,
      ),
    };
  return { native, values, ready, enrolled, gpu, active };
}
it("actual admission selects the current approved secondary fleet overlay/ordinal independently from personal Ready and leaves original approval intact", async () => {
  const f = fixture(),
    original = structuredClone(f.enrolled);
  expect(await readCurrentPersonalGpu(f.native, f.ready.release)).toEqual(
    f.ready.qualification.gpuIdentity,
  );
  expect(await readCurrentFleetGpu(f.native, f.ready.release)).toEqual({
    ...f.gpu,
    deviceIndex: 5,
  });
  expect(f.enrolled).toEqual(original);
  expect(f.enrolled.prepared.gpu.luid).not.toBe(f.gpu.luid);
});
it.each([
  "legacy-witness",
  "stale-boot",
  "wrong-release",
  "driver",
  "hardware",
  "ambiguous",
  "missing-overlay",
])(
  "actual current fleet selector denies %s before any model or permit authority",
  async (failure) => {
    const f = fixture();
    if (failure === "legacy-witness")
      delete (f.active as Partial<FleetActiveRuntimeProof>).bootIdentity;
    if (failure === "stale-boot") f.active.bootIdentity = "0".repeat(64);
    if (failure === "wrong-release") f.active.release = "f".repeat(64);
    if (failure === "driver")
      f.native.enumerateGpus.mockResolvedValue([
        { ...f.gpu, driverVersion: "32.0.9.9" },
      ]);
    if (failure === "hardware")
      f.native.enumerateGpus.mockResolvedValue([{ ...f.gpu, deviceId: 999 }]);
    if (failure === "ambiguous")
      f.native.enumerateGpus.mockResolvedValue([f.gpu, f.gpu]);
    if (failure === "missing-overlay") f.values.delete("active_runtime");
    await expect(
      readCurrentFleetGpu(f.native, f.ready.release),
    ).rejects.toThrow();
  },
);
it("a changed witness during actual native enumeration cannot publish a current GPU", async () => {
  const f = fixture();
  f.native.enumerateGpus.mockImplementation(async () => {
    f.native.bootIdentity.mockResolvedValue("0".repeat(64));
    return [f.gpu];
  });
  await expect(readCurrentFleetGpu(f.native, f.ready.release)).rejects.toThrow(
    "FLEET_PREPARE_REQUIRED",
  );
});

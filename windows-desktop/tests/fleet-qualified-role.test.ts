import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createQualifiedFleetRoleControl } from "../src/agent/fleet.js";
import {
  readOperationalFleetIdentity,
  type FleetActiveRuntimeProof,
} from "../src/main/fleet/active-runtime.js";
import { fleetRecordAuthority } from "../src/main/fleet/store.js";
import type { FleetRoleControlOptions } from "../src/main/fleet/role-control.js";
import { parseFleetChildCommand } from "../src/main/fleet/channel.js";
import type { ConsumerGpuLease } from "../../worker/src/platform/windows/consumer-native.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { record } from "./fleet-fixtures.js";
import { receipt } from "./fixtures/prepare.js";

function fixture() {
  const enrollment = record();
  enrollment.prepared.modelDigest = MODEL.sha256;
  enrollment.prepared.report.runtime.modelDigest = MODEL.sha256;
  const currentGpu = {
    ...enrollment.prepared.gpu,
    luid: "0000000000004321",
    driverVersion: "32.0.2.3",
    deviceIndex: 1,
  };
  const bootIdentity = "f".repeat(64);
  const proof: FleetActiveRuntimeProof = {
    version: 2,
    bootIdentity,
    sid: enrollment.sid,
    authority: fleetRecordAuthority(enrollment),
    transaction: randomUUID(),
    updateIdentity: "e".repeat(64),
    release: "e".repeat(64),
    manifestDigest: "f".repeat(64),
    archiveDigest: "1".repeat(64),
    modelDigest: MODEL.sha256,
    fixtureDigest: enrollment.prepared.fixtureDigest,
    approvedRecipeDigests: { "kim-vocals-v2": "0".repeat(64) },
    qualification: {
      ...receipt().qualification,
      serviceIdentity: enrollment.sid,
      gpuId: `dxgi-${currentGpu.luid}`,
      gpuIdentity: currentGpu,
      directmlDeviceId: currentGpu.deviceIndex,
      releaseManifestDigest: "f".repeat(64),
      fixtureDigest: enrollment.prepared.fixtureDigest,
      resourceObservations: {
        inferenceSlots: 1,
        dedicatedVideoMemoryLimitBytes: currentGpu.dedicatedVideoMemoryBytes,
        sharedSystemMemoryLimitBytes: currentGpu.sharedSystemMemoryLimitBytes,
      },
    },
    qualifiedAt: "2026-10-09T00:00:00Z",
  };
  const native = {
    bootIdentity: vi.fn(async () => bootIdentity),
    vaultRead: vi.fn(async () => Buffer.from(JSON.stringify(proof))),
    enumerateGpus: vi.fn(async () => [currentGpu]),
  };
  const options: Omit<FleetRoleControlOptions, "gpuLuid"> = {
    runtime: {
      execute: vi.fn(),
    } as unknown as FleetRoleControlOptions["runtime"],
    idle: () => true,
    setPending: vi.fn(async () => {}),
    acquireGuard: vi.fn(async (): Promise<ConsumerGpuLease> => ({
      luid: currentGpu.luid,
      gpu: currentGpu,
      nonce: "a".repeat(64),
      identity: {
        sid: enrollment.sid,
        sessionId: 2,
        pid: 123,
        creationTime: "134000000000000000",
      },
      abandoned: false,
    })),
    releaseGuard: vi.fn(async () => {}),
  };
  return { enrollment, proof, currentGpu, native, options };
}
function acquire(gpuLuid: string) {
  return parseFleetChildCommand(
    Buffer.from(
      JSON.stringify({
        version: 1,
        requestId: randomUUID(),
        action: "guard_acquire",
        gpuLuid,
      }),
    ),
  );
}

it("receives the actually resolved reboot overlay GPU rather than immutable original enrollment LUID", async () => {
  const f = fixture(),
    original = structuredClone(f.enrollment);
  const active = await readOperationalFleetIdentity(f.native, f.enrollment, {
    release: f.proof.release,
    manifestDigest: f.proof.manifestDigest,
    archiveDigest: f.proof.archiveDigest,
    modelDigest: f.proof.modelDigest,
  });
  const control = createQualifiedFleetRoleControl(active.gpu, f.options);
  await expect(
    control.execute(acquire(f.enrollment.prepared.gpu.luid)),
  ).rejects.toThrow("FLEET_GPU_INVALID");
  expect(f.options.acquireGuard).not.toHaveBeenCalled();
  expect((await control.execute(acquire(active.gpu.luid))).data?.held).toBe(
    true,
  );
  expect(f.options.acquireGuard).toHaveBeenCalledOnce();
  expect(f.enrollment).toEqual(original);
  vi.mocked(f.options.releaseGuard).mockRejectedValueOnce(
    new Error("EXIT_UNCONFIRMED"),
  );
  await expect(control.releaseAfterExit()).rejects.toThrow("EXIT_UNCONFIRMED");
  expect(control.guardHeld()).toBe(true);
  await control.releaseAfterExit();
  expect(control.guardHeld()).toBe(false);
});
it("uses actual current ordinal remapping under the same qualified LUID", async () => {
  const f = fixture();
  f.native.enumerateGpus.mockResolvedValue([
    { ...f.currentGpu, deviceIndex: 4 },
  ]);
  const active = await readOperationalFleetIdentity(f.native, f.enrollment);
  expect(active.gpu.deviceIndex).toBe(4);
  const control = createQualifiedFleetRoleControl(active.gpu, f.options);
  expect((await control.execute(acquire(active.gpu.luid))).data?.held).toBe(
    true,
  );
  expect(f.options.acquireGuard).toHaveBeenCalledOnce();
});
it.each(["boot", "driver", "hardware", "luid"])(
  "never binds a control from %s-stale current qualification",
  async (kind) => {
    const f = fixture();
    if (kind === "boot")
      f.native.bootIdentity.mockResolvedValue("b".repeat(64));
    else
      f.native.enumerateGpus.mockResolvedValue([
        {
          ...f.currentGpu,
          ...(kind === "driver"
            ? { driverVersion: "32.0.9.9" }
            : kind === "hardware"
              ? { deviceId: 42 }
              : { luid: "0000000000009999" }),
        },
      ]);
    await expect(
      readOperationalFleetIdentity(f.native, f.enrollment),
    ).rejects.toThrow("FLEET_PREPARE_REQUIRED");
    expect(f.options.acquireGuard).not.toHaveBeenCalled();
  },
);
it("fails closed before control/guard creation when runtime did not publish a qualified GPU", () => {
  const f = fixture();
  expect(() => createQualifiedFleetRoleControl(undefined, f.options)).toThrow(
    "FLEET_GPU_INVALID",
  );
  expect(f.options.acquireGuard).not.toHaveBeenCalled();
});

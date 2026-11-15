import { createHash, randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { expect, it, vi } from "vitest";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import { storePreparationTarget } from "../src/main/prepare/store-model-ready.js";
import { StorePreparationOperations } from "../src/main/prepare/store-operations.js";
import { parseStoreFleetActiveProof } from "../src/main/fleet/store-active-proof.js";
import {
  readStoreFleetRuntimeIdentityForGui,
  readStoreApprovedFleetGpuSelection,
} from "../src/main/fleet/store-active-runtime.js";
import { refreshApprovedStoreFleetRuntime } from "../src/main/fleet/store-update-preparation.js";
import {
  fleetRecordAuthority,
  type FleetEnrollmentRecord,
  type StoreFleetPreparedIdentity,
} from "../src/main/fleet/store.js";
import type { HostContext } from "../src/main/host-context.js";
import { record } from "./fleet-fixtures.js";
import { receipt } from "./fixtures/prepare.js";

// Synthetic receiving observations only: no installed Store package/GPU grant.
function fixture() {
  const old = record(),
    raw = receipt().qualification,
    qualification = {
      ...raw,
      serviceIdentity: old.sid,
      fixtureDigest: old.prepared.fixtureDigest,
      gpuIdentity: old.prepared.gpu,
      gpuId: `dxgi-${old.prepared.gpu.luid}`,
      directmlDeviceId: old.prepared.gpu.deviceIndex,
      resourceObservations: {
        ...raw.resourceObservations,
        dedicatedVideoMemoryLimitBytes:
          old.prepared.gpu.dedicatedVideoMemoryBytes,
        sharedSystemMemoryLimitBytes:
          old.prepared.gpu.sharedSystemMemoryLimitBytes,
      },
    },
    product = STORE_PRODUCTS.worker,
    fullName = `${product.identityName}_0.1.3.2_x64__${product.publisherId}`,
    enrollment: FleetEnrollmentRecord & {
      prepared: StoreFleetPreparedIdentity;
    } = {
      ...old,
      prepared: {
        ...old.prepared,
        distribution: "microsoft-store",
        archiveDigest: null,
        modelDigest: MODEL.sha256,
        qualificationPath: win32.join(
          "C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal",
          `prepare\\approved\\qualification-${createHash("sha256").update(old.requests.report).digest("hex")}.json`,
        ),
        output: {
          path: qualification.uploadCandidate.path,
          bytes: qualification.uploadCandidate.resultBytes,
          sha256: qualification.uploadCandidate.resultDigest,
        },
        report: {
          ...old.prepared.report,
          runtime: {
            ...old.prepared.report.runtime,
            modelDigest: MODEL.sha256,
          },
        },
        storeBinding: {
          package: {
            identityName: product.identityName,
            publisher: product.publisher,
            publisherId: product.publisherId,
            familyName: product.familyName,
            fullName,
            packageVersion: "0.1.3.2",
            architecture: "x64",
            signatureKind: 3,
            healthy: true,
            current: true,
            installedLocation: `C:\\Program Files\\WindowsApps\\${fullName}`,
          },
          inventorySha256: old.prepared.release,
          runtimeManifestSha256: old.prepared.manifestDigest,
          sid: old.sid,
          bootIdentity: old.prepared.bootIdentity!,
          recipeDigests: {
            "kim-vocals-v2": "0".repeat(64),
            "kim-vocals-v2-trim": "1".repeat(64),
          },
        },
      },
    },
    storeBinding = {
      ...enrollment.prepared.storeBinding,
      bootIdentity: "7".repeat(64),
      inventorySha256: "8".repeat(64),
      runtimeManifestSha256: "9".repeat(64),
    },
    currentGpu = {
      ...enrollment.prepared.gpu,
      deviceIndex: 1,
      driverVersion: "33.0.1.2",
      luid: "0000000000004567",
    };
  return {
    enrollment,
    proof: {
      version: 1 as const,
      distribution: "microsoft-store" as const,
      archiveDigest: null,
      authority: fleetRecordAuthority(enrollment),
      transaction: randomUUID(),
      runtimeIdentity: storePreparationTarget(storeBinding),
      storeBinding,
      modelDigest: MODEL.sha256,
      fixtureDigest: enrollment.prepared.fixtureDigest,
      qualification: {
        ...qualification,
        releaseManifestDigest: storeBinding.runtimeManifestSha256,
        gpuIdentity: currentGpu,
        gpuId: `dxgi-${currentGpu.luid}`,
        directmlDeviceId: currentGpu.deviceIndex,
      },
      qualifiedAt: "2026-10-10T00:00:00.000Z",
    },
  };
}
it("receives fresh boot/driver/Store observations while retaining original backend approval, credentials, model and both recipes", () => {
  const { enrollment, proof } = fixture(),
    original = structuredClone(enrollment),
    parsed = parseStoreFleetActiveProof(proof, enrollment);
  expect(parsed).toEqual(proof);
  expect(parsed).not.toBe(proof);
  expect(enrollment).toEqual(original);
  expect(parsed.archiveDigest).toBeNull();
  expect(parsed).not.toHaveProperty("ready");
});
it.each([
  "name",
  "vendorId",
  "deviceId",
  "subsystemId",
  "revision",
  "dedicatedVideoMemoryBytes",
  "sharedSystemMemoryLimitBytes",
])(
  "denies changed physical adapter %s despite a new boot and driver",
  (key) => {
    const { enrollment, proof } = fixture(),
      gpu = proof.qualification.gpuIdentity;
    expect(() =>
      parseStoreFleetActiveProof(
        {
          ...proof,
          qualification: {
            ...proof.qualification,
            gpuIdentity: {
              ...gpu,
              [key]:
                typeof gpu[key as keyof typeof gpu] === "string"
                  ? "foreign GPU"
                  : 123,
            },
          },
        },
        enrollment,
      ),
    ).toThrow("FLEET_ACTIVE_RUNTIME_INVALID");
  },
);
it("does not rebind an LUID in the same boot or accept an unsigned/foreign package observation", () => {
  const { enrollment, proof } = fixture(),
    sameBoot = {
      ...proof.storeBinding,
      bootIdentity: enrollment.prepared.bootIdentity!,
    };
  for (const changed of [
    {
      storeBinding: sameBoot,
      runtimeIdentity: storePreparationTarget(sameBoot),
    },
    {
      storeBinding: {
        ...proof.storeBinding,
        package: { ...proof.storeBinding.package, signatureKind: 0 },
      },
    },
    { storeBinding: { ...proof.storeBinding, sid: `${enrollment.sid}9` } },
  ])
    expect(() =>
      parseStoreFleetActiveProof(
        {
          ...proof,
          ...changed,
        },
        enrollment,
      ),
    ).toThrow("FLEET_ACTIVE_RUNTIME_INVALID");
});
it("denies stale approval, caller archives, changed quality, CPU fallback, wrong fixture and future timestamps", () => {
  const { enrollment, proof } = fixture();
  for (const change of [
    { authority: "a".repeat(64) },
    { archiveDigest: "a".repeat(64) },
    { modelDigest: "a".repeat(64) },
    { fixtureDigest: "a".repeat(64) },
    { runtimeIdentity: "a".repeat(64) },
    { qualifiedAt: "2999-01-01T00:00:00.000Z" },
    {
      storeBinding: {
        ...proof.storeBinding,
        recipeDigests: {
          ...proof.storeBinding.recipeDigests,
          "kim-vocals-v2-trim": "f".repeat(64),
        },
      },
    },
    { qualification: { ...proof.qualification, provider: "cpu" } },
    {
      qualification: {
        ...proof.qualification,
        providerDispatch: {
          ...proof.qualification.providerDispatch,
          cpuNodeEvents: 1,
        },
      },
    },
    {
      qualification: {
        ...proof.qualification,
        runtimeDiagnostics: {
          ...proof.qualification.runtimeDiagnostics,
          onnxRuntime: "foreign",
        },
      },
    },
    { legacy: true },
  ])
    expect(() =>
      parseStoreFleetActiveProof({ ...proof, ...change }, enrollment),
    ).toThrow("FLEET_ACTIVE_RUNTIME_INVALID");
});
it("rejects accessor proof fields without invoking them", () => {
  const { enrollment, proof } = fixture(),
    getter = vi.fn(() => proof.qualification);
  Object.defineProperty(proof, "qualification", {
    enumerable: true,
    get: getter,
  });
  expect(() => parseStoreFleetActiveProof(proof, enrollment)).toThrow(
    "FLEET_ACTIVE_RUNTIME_INVALID",
  );
  expect(getter).not.toHaveBeenCalled();
});
it("denies caller-built GUI/Prepare owners before code, model or vault IO", async () => {
  const { enrollment } = fixture(),
    assertHost = vi.fn(),
    snapshotStoreReady = vi.fn(),
    mediaCodeView = vi.fn(),
    operations = Object.assign(
      Object.create(StorePreparationOperations.prototype),
      { assertHost, snapshotStoreReady, mediaCodeView },
    ),
    vaultRead = vi.fn(),
    host = { native: { vaultRead } } as unknown as HostContext,
    signal = new AbortController().signal;
  await expect(
    readStoreFleetRuntimeIdentityForGui(host, operations, enrollment, signal),
  ).rejects.toThrow();
  await expect(
    readStoreApprovedFleetGpuSelection(host, operations, enrollment, signal),
  ).rejects.toThrow();
  await expect(
    refreshApprovedStoreFleetRuntime(
      {
        host,
        operations,
        target: { sid: enrollment.sid, identity: "a".repeat(64) },
        transaction: randomUUID(),
      },
      signal,
    ),
  ).rejects.toThrow();
  expect(assertHost).not.toHaveBeenCalled();
  expect(snapshotStoreReady).not.toHaveBeenCalled();
  expect(mediaCodeView).not.toHaveBeenCalled();
  expect(vaultRead).not.toHaveBeenCalled();
});

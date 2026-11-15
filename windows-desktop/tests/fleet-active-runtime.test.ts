import { expect, it } from "vitest";
import { record } from "./fleet-fixtures.js";
import { receipt } from "./fixtures/prepare.js";
import {
  fleetRecordAuthority,
  VaultFleetStore,
} from "../src/main/fleet/store.js";
import {
  parseFleetActiveRuntime,
  resolveActiveFleetIdentity,
  readActiveFleetIdentity,
  readOperationalFleetIdentity,
  readApprovedFleetGpuSelection,
  type FleetActiveRuntimeProof,
} from "../src/main/fleet/active-runtime.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
function fixture() {
  const r = record(),
    raw = receipt().qualification;
  r.prepared.modelDigest = MODEL.sha256;
  r.prepared.report.runtime.modelDigest = MODEL.sha256;
  const qualification = {
    ...raw,
    serviceIdentity: r.sid,
    gpuId: `dxgi-${r.prepared.gpu.luid}`,
    gpuIdentity: {
      ...r.prepared.gpu,
      driverVersion: "32.0.2.3",
      deviceIndex: 1,
    },
    directmlDeviceId: 1,
    resourceObservations: {
      inferenceSlots: 1,
      dedicatedVideoMemoryLimitBytes: r.prepared.gpu.dedicatedVideoMemoryBytes,
      sharedSystemMemoryLimitBytes: r.prepared.gpu.sharedSystemMemoryLimitBytes,
    },
    releaseManifestDigest: "f".repeat(64),
    fixtureDigest: r.prepared.fixtureDigest,
  };
  const proof: FleetActiveRuntimeProof = {
    version: 2,
    bootIdentity: receipt().bootIdentity,
    sid: r.sid,
    authority: fleetRecordAuthority(r),
    transaction: "a989d129-1c23-47ea-bb02-e6ea6b7a9901",
    updateIdentity: "e".repeat(64),
    release: "e".repeat(64),
    manifestDigest: "f".repeat(64),
    archiveDigest: "1".repeat(64),
    modelDigest: MODEL.sha256,
    fixtureDigest: r.prepared.fixtureDigest,
    approvedRecipeDigests: { "kim-vocals-v2": "0".repeat(64) },
    qualification,
    qualifiedAt: "2026-10-09T00:00:00Z",
  };
  return { r, proof, qualification };
}
it("requires the current boot witness even when every DXGI LUID/driver/model field is reused", async () => {
  const { r, proof } = fixture(),
    native = {
      bootIdentity: async () => "f".repeat(64),
      vaultRead: async () => Buffer.from(JSON.stringify(proof)),
    };
  await expect(readActiveFleetIdentity(native, r)).rejects.toThrow(
    "FLEET_PREPARE_REQUIRED",
  );
  delete r.prepared.bootIdentity;
  await expect(
    readActiveFleetIdentity({ ...native, vaultRead: async () => null }, r),
  ).rejects.toThrow("FLEET_PREPARE_REQUIRED");
  const { bootIdentity: _boot, ...legacy } = proof;
  await expect(
    readActiveFleetIdentity(
      {
        ...native,
        vaultRead: async () =>
          Buffer.from(JSON.stringify({ ...legacy, version: 1 })),
      },
      r,
    ),
  ).rejects.toThrow("FLEET_PREPARE_REQUIRED");
  await expect(
    readActiveFleetIdentity(
      { ...native, vaultRead: async () => Buffer.from('{"version":1}') },
      r,
    ),
  ).rejects.toThrow("FLEET_ACTIVE_RUNTIME_INVALID");
});
it("only fresh cross-witness or legacy qualification can rebind LUID and still requires the approved stable descriptor", () => {
  const { r, proof } = fixture(),
    moved = {
      ...proof,
      bootIdentity: "f".repeat(64),
      qualification: {
        ...(proof.qualification as Record<string, unknown>),
        gpuId: "dxgi-0000000000004321",
        gpuIdentity: {
          ...(proof.qualification as { gpuIdentity: Record<string, unknown> })
            .gpuIdentity,
          luid: "0000000000004321",
        },
      },
    };
  expect(() => parseFleetActiveRuntime(moved, r)).not.toThrow();
  expect(() =>
    parseFleetActiveRuntime(
      { ...moved, bootIdentity: r.prepared.bootIdentity! },
      r,
    ),
  ).toThrow("FLEET_ACTIVE_RUNTIME_INVALID");
  delete r.prepared.bootIdentity;
  expect(() => parseFleetActiveRuntime(moved, r)).not.toThrow();
  for (const changed of [
    { deviceId: 123 },
    { vendorId: 123 },
    { subsystemId: 123 },
    { revision: 9 },
    { name: "Other hardware" },
    { dedicatedVideoMemoryBytes: 123 },
  ])
    expect(() =>
      parseFleetActiveRuntime(
        {
          ...moved,
          qualification: {
            ...moved.qualification,
            gpuIdentity: { ...moved.qualification.gpuIdentity, ...changed },
          },
        },
        r,
      ),
    ).toThrow("FLEET_ACTIVE_RUNTIME_INVALID");
});
it("resolves a guarded active runtime without rewriting original approval, credential or IDs", () => {
  const { r, proof } = fixture(),
    original = structuredClone(r);
  expect(
    resolveActiveFleetIdentity(r, proof, {
      release: proof.release,
      manifestDigest: proof.manifestDigest,
      archiveDigest: proof.archiveDigest,
      modelDigest: proof.modelDigest,
    }),
  ).toMatchObject({
    source: "consumer-update",
    release: proof.release,
    gpu: { deviceIndex: 1, driverVersion: "32.0.2.3" },
    qualificationPath: null,
  });
  expect(r).toEqual(original);
  expect(r.prepared.manifestDigest).not.toBe(proof.manifestDigest);
});
it("requires fresh qualification for driver changes and preserves physical approved adapter identity", () => {
  const { r, proof, qualification } = fixture();
  expect(() => parseFleetActiveRuntime(proof, r)).not.toThrow();
  for (const change of [
    { luid: "0000000000009999" },
    { vendorId: 32902 },
    { deviceId: 1 },
  ])
    expect(() =>
      parseFleetActiveRuntime(
        {
          ...proof,
          qualification: {
            ...qualification,
            gpuIdentity: { ...qualification.gpuIdentity, ...change },
          },
        },
        r,
      ),
    ).toThrow("FLEET_ACTIVE_RUNTIME_INVALID");
});
it("cannot substitute personal fixture, different recipe semantics, CPU fallback or foreign SID", () => {
  const { r, proof, qualification } = fixture();
  for (const changed of [
    { ...proof, fixtureDigest: receipt().fixtureSha256 },
    { ...proof, sid: "S-1-5-21-1-2-3-1002" },
    {
      ...proof,
      qualification: {
        ...qualification,
        providerDispatch: {
          ...qualification.providerDispatch,
          cpuNodeEvents: 1,
        },
      },
    },
    {
      ...proof,
      qualification: {
        ...qualification,
        recipes: qualification.recipes.map((v) => ({
          ...v,
          recipeDigest: "9".repeat(64),
        })),
      },
    },
    {
      ...proof,
      approvedRecipeDigests: {
        ...proof.approvedRecipeDigests,
        "kim-vocals-v2-trim": "1".repeat(64),
      },
    },
  ])
    expect(() => parseFleetActiveRuntime(changed, r)).toThrow(
      "FLEET_ACTIVE_RUNTIME_INVALID",
    );
});
it("binds overlay to exact credential authority and refuses revoked or replaced machines", () => {
  const { r, proof } = fixture();
  for (const changed of [
    { ...r, machineCredential: "n".repeat(43) },
    { ...r, credentialRevision: 2 },
    { ...r, phase: "revoked" as const },
  ])
    expect(() => parseFleetActiveRuntime(proof, changed)).toThrow(
      "FLEET_ACTIVE_RUNTIME_INVALID",
    );
});
it("a stale or missing proof never falls back to original enrollment for a new Ready target", () => {
  const { r, proof } = fixture(),
    expected = {
      release: proof.release,
      manifestDigest: proof.manifestDigest,
      modelDigest: proof.modelDigest,
    };
  expect(() => resolveActiveFleetIdentity(r, null, expected)).toThrow(
    "FLEET_PREPARE_REQUIRED",
  );
  expect(() =>
    resolveActiveFleetIdentity(r, proof, {
      ...expected,
      modelDigest: "2".repeat(64),
    }),
  ).toThrow("FLEET_PREPARE_REQUIRED");
  expect(resolveActiveFleetIdentity(r, null)).toMatchObject({
    source: "enrollment",
    release: r.prepared.release,
  });
});
it("restoring the prior overlay atomically restores the previous active identity", () => {
  const { r, proof } = fixture(),
    old = { ...proof, release: "7".repeat(64), archiveDigest: "8".repeat(64) };
  const next = resolveActiveFleetIdentity(r, proof),
    restored = resolveActiveFleetIdentity(r, old);
  expect(next.release).not.toBe(restored.release);
  expect(restored.release).toBe(old.release);
  expect(fleetRecordAuthority(r)).toBe(proof.authority);
});
it("corrupt/oversized DPAPI proof fails closed rather than enabling the original runtime", async () => {
  const { r } = fixture();
  for (const bytes of [Buffer.from("{broken"), Buffer.alloc(16385)])
    await expect(
      readActiveFleetIdentity(
        {
          bootIdentity: async () => receipt().bootIdentity,
          vaultRead: async () => Buffer.from(bytes),
        },
        r,
      ),
    ).rejects.toThrow("FLEET_ACTIVE_RUNTIME_INVALID");
});
it("replacement enrollment retires old local overlay/capacity under the actual cache mutex", async () => {
  const { r, proof } = fixture(),
    data = new Map<string, Buffer>([
      ["enrollment", Buffer.from(JSON.stringify(r))],
      ["active_runtime", Buffer.from(JSON.stringify(proof))],
      ["capacity", Buffer.from("old capacity")],
    ]),
    events: string[] = [];
  const native = {
    bootIdentity: async () => receipt().bootIdentity,
    vaultRead: async (_root: string, key: string) =>
      data.has(key) ? Buffer.from(data.get(key)!) : null,
    vaultWrite: async (_root: string, key: string, value: Buffer) => {
      events.push(`write:${key}`);
      data.set(key, Buffer.from(value));
    },
    vaultDelete: async (_root: string, key: string) => {
      events.push(`delete:${key}`);
      data.delete(key);
    },
    acquireMutex: async () => {
      events.push("lock");
      return {
        scope: "cache" as const,
        nonce: "a".repeat(64),
        identity: {
          sid: r.sid,
          sessionId: 1,
          pid: 20,
          creationTime: "133000000000000000",
        },
        abandoned: false,
      };
    },
    releaseMutex: async () => {
      events.push("unlock");
    },
  };
  const next = {
    ...r,
    machineCredential: "n".repeat(43),
    credentialRevision: 2,
  };
  await new VaultFleetStore(native, r.sid).write(next);
  expect(events).toEqual([
    "lock",
    "write:enrollment",
    "delete:active_runtime",
    "delete:capacity",
    "unlock",
  ]);
  expect(await readActiveFleetIdentity(native, next)).toMatchObject({
    source: "enrollment",
  });
});
it("failed replacement persistence preserves the old valid overlay and always releases the mutex", async () => {
  const { r, proof } = fixture(),
    data = new Map<string, Buffer>([
      ["enrollment", Buffer.from(JSON.stringify(r))],
      ["active_runtime", Buffer.from(JSON.stringify(proof))],
    ]);
  let released = false;
  const native = {
    bootIdentity: async () => receipt().bootIdentity,
    vaultRead: async (_root: string, key: string) =>
      data.has(key) ? Buffer.from(data.get(key)!) : null,
    vaultWrite: async () => {
      throw new Error("VAULT_UNAVAILABLE");
    },
    vaultDelete: async (_root: string, key: string) => {
      data.delete(key);
    },
    acquireMutex: async () => ({
      scope: "cache" as const,
      nonce: "a".repeat(64),
      identity: {
        sid: r.sid,
        sessionId: 1,
        pid: 20,
        creationTime: "133000000000000000",
      },
      abandoned: false,
    }),
    releaseMutex: async () => {
      released = true;
    },
  };
  await expect(
    new VaultFleetStore(native, r.sid).write({
      ...r,
      machineCredential: "n".repeat(43),
    }),
  ).rejects.toThrow("VAULT_UNAVAILABLE");
  expect(released).toBe(true);
  expect(await readActiveFleetIdentity(native, r)).toMatchObject({
    source: "consumer-update",
    release: proof.release,
  });
});

it("current operational proof requires actual DXGI driver/descriptor and witness; ordinal is resolved by stable LUID", async () => {
  const { r, proof, qualification } = fixture(),
    native = {
      vaultRead: async () => Buffer.from(JSON.stringify(proof)),
      bootIdentity: async () => proof.bootIdentity,
      enumerateGpus: async () => [
        { ...qualification.gpuIdentity, deviceIndex: 7 },
      ],
    };
  expect((await readOperationalFleetIdentity(native, r)).gpu.deviceIndex).toBe(
    7,
  );
  for (const change of [
    { driverVersion: "changed" },
    { deviceId: 123 },
    { luid: "0000000000009999" },
  ])
    await expect(
      readOperationalFleetIdentity(
        {
          ...native,
          enumerateGpus: async () => [
            { ...qualification.gpuIdentity, ...change },
          ],
        },
        r,
      ),
    ).rejects.toThrow("FLEET_PREPARE_REQUIRED");
});
it("selection derives same-witness LUID from latest accepted overlay rather than an older original approval", async () => {
  const { r, proof, qualification } = fixture();
  r.prepared.bootIdentity = "f".repeat(64);
  qualification.gpuIdentity.luid = "0000000000004321";
  qualification.gpuId = `dxgi-${qualification.gpuIdentity.luid}`;
  const native = {
    vaultRead: async () => Buffer.from(JSON.stringify(proof)),
    bootIdentity: async () => proof.bootIdentity,
  };
  expect(
    await readApprovedFleetGpuSelection(native, r, proof.bootIdentity),
  ).toMatchObject({
    approvedGpu: { luid: "0000000000004321" },
    allowLuidRebind: false,
  });
  expect(
    await readApprovedFleetGpuSelection(
      { ...native, bootIdentity: async () => "9".repeat(64) },
      r,
      "9".repeat(64),
    ),
  ).toMatchObject({ allowLuidRebind: true });
});

import { createHash, randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { expect, it, vi } from "vitest";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { parseQualificationEvidence } from "../../worker/src/enrollment/report-builder.js";
import type { HostContext } from "../src/main/host-context.js";
import type { StorePreparationOperations } from "../src/main/prepare/store-operations.js";
import { PERSONAL_RECIPE_DIGESTS } from "../src/main/personal/timeline.js";
import { PrepareFailure } from "../src/main/prepare/controller.js";
import {
  storePreparationTarget,
  type StorePreparationBinding,
} from "../src/main/prepare/store-model-ready.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import {
  fleetRecordAuthority,
  type FleetEnrollmentRecord,
} from "../src/main/fleet/store.js";
import { record } from "./fleet-fixtures.js";
import { receipt } from "./fixtures/prepare.js";

// Real repair/publication/readers with explicitly synthetic private module
// boundaries. These tests are not installed Store/GPU/held-file proof.
const boundary = vi.hoisted(() => {
  class Operations {
    #host: object;
    held = vi.fn(async (..._args: unknown[]) => {});
    view = vi.fn();
    ready = vi.fn();
    reuseModel = vi.fn();
    model = vi.fn();
    fixed = vi.fn();
    approved = vi.fn();
    constructor(host: object) {
      this.#host = host;
    }
    assertHost(host: object) {
      if (host !== this.#host) throw Error("FOREIGN_HOST");
    }
    assertHeldMutation(...args: unknown[]) {
      return this.held(...args);
    }
    mediaCodeView() {
      return this.view();
    }
    snapshotStoreReady() {
      return this.ready();
    }
    reuse() {
      return this.reuseModel();
    }
    perform(...args: unknown[]) {
      return this.model(...args);
    }
    requalifyInstalled(...args: unknown[]) {
      return this.fixed(...args);
    }
    qualifyApprovedFixtureHeld(...args: unknown[]) {
      return this.approved(...args);
    }
  }
  return { Operations, read: vi.fn(), fingerprint: vi.fn(), verify: vi.fn() };
});
vi.mock("../src/main/prepare/store-operations.js", () => ({
  StorePreparationOperations: boundary.Operations,
}));
vi.mock("../src/main/prepare/private-files.js", () => ({
  readPrivateBytes: boundary.read,
  privateFingerprint: boundary.fingerprint,
  verifyPrivateFile: boundary.verify,
}));
import { readApprovedLegacyFleetQualification } from "../src/main/fleet/store-approval-witness.js";
import { parseStoreFleetActiveProof } from "../src/main/fleet/store-active-proof.js";
import { readStoreFleetRuntimeIdentityForGui } from "../src/main/fleet/store-active-runtime.js";
import {
  repairApprovedLegacyStoreFleetRuntime,
  refreshApprovedStoreFleetRuntime,
} from "../src/main/fleet/store-update-preparation.js";

function fixture() {
  boundary.read.mockReset();
  boundary.fingerprint.mockReset();
  boundary.verify.mockReset();
  const legacy = record(),
    personalRoot = "C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal",
    original = {
      ...receipt().qualification,
      serviceIdentity: legacy.sid,
      fixtureDigest: legacy.prepared.fixtureDigest,
      gpuIdentity: legacy.prepared.gpu,
      gpuId: `dxgi-${legacy.prepared.gpu.luid}`,
      directmlDeviceId: legacy.prepared.gpu.deviceIndex,
      resourceObservations: {
        inferenceSlots: 1,
        dedicatedVideoMemoryLimitBytes:
          legacy.prepared.gpu.dedicatedVideoMemoryBytes,
        sharedSystemMemoryLimitBytes:
          legacy.prepared.gpu.sharedSystemMemoryLimitBytes,
      },
      recipes: receipt().qualification.recipes.map((row) => ({
        ...row,
        recipeDigest:
          PERSONAL_RECIPE_DIGESTS[
            row.recipeId as keyof typeof PERSONAL_RECIPE_DIGESTS
          ],
      })),
    },
    relative = `prepare\\approved\\qualification-${createHash("sha256").update(legacy.requests.report).digest("hex")}.json`;
  legacy.prepared.modelDigest = MODEL.sha256;
  legacy.prepared.report.runtime.modelDigest = MODEL.sha256;
  legacy.prepared.qualificationPath = win32.join(personalRoot, relative);
  legacy.prepared.output = {
    path: original.uploadCandidate.path,
    bytes: original.uploadCandidate.resultBytes,
    sha256: original.uploadCandidate.resultDigest,
  };
  const product = STORE_PRODUCTS.worker,
    fullName = `${product.identityName}_0.1.3.2_x64__${product.publisherId}`,
    binding: StorePreparationBinding = {
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
      inventorySha256: "8".repeat(64),
      runtimeManifestSha256: "9".repeat(64),
      sid: legacy.sid,
      bootIdentity: "7".repeat(64),
      recipeDigests: PERSONAL_RECIPE_DIGESTS,
    };
  let currentRecord: FleetEnrollmentRecord = legacy,
    originalRaw = Buffer.from(JSON.stringify(original));
  const rows = new Map<string, Buffer>(),
    events: string[] = [],
    native = {
      vaultRead: vi.fn(async (_scope: string, key: string) =>
        key === "enrollment"
          ? Buffer.from(JSON.stringify(currentRecord))
          : rows.has(key)
            ? Buffer.from(rows.get(key)!)
            : null,
      ),
      vaultWrite: vi.fn(async (_scope: string, key: string, bytes: Buffer) => {
        events.push(`write:${key}`);
        rows.set(key, Buffer.from(bytes));
      }),
      vaultDelete: vi.fn(async () => {}),
      acquireMutex: vi.fn(async () => ({})),
      releaseMutex: vi.fn(async () => {}),
      enumerateGpus: vi.fn(async () => [legacy.prepared.gpu]),
      bootIdentity: vi.fn(async () => binding.bootIdentity),
    },
    host = {
      identity: { sid: legacy.sid },
      personalRoot,
      native,
    } as unknown as HostContext,
    ops = new boundary.Operations(host),
    fresh = {
      ...original,
      releaseManifestDigest: binding.runtimeManifestSha256,
    },
    evidence = parseQualificationEvidence(fresh, {
      runtimeProfile: "windows-user",
      expectedUserSid: legacy.sid,
      expectedFixtureDigest: legacy.prepared.fixtureDigest,
    });
  ops.view.mockResolvedValue({ binding });
  ops.ready
    .mockRejectedValueOnce(new PrepareFailure("INTEGRITY_INVALID"))
    .mockResolvedValue({ binding, evidence });
  ops.reuseModel.mockResolvedValue(false);
  ops.model.mockImplementation(async () => {
    events.push("model");
  });
  ops.fixed.mockImplementation(async () => {
    events.push("fixed-qualification");
  });
  ops.approved.mockImplementation(async () => {
    events.push("approved-qualification");
    return { raw: fresh, evidence, bootIdentity: binding.bootIdentity };
  });
  boundary.read.mockImplementation(async (_host, path: string) => {
    if (path !== relative) throw Error("FOREIGN_PATH");
    events.push("original-approval");
    return Buffer.from(originalRaw);
  });
  boundary.fingerprint.mockResolvedValue({ bytes: 10000 });
  boundary.verify.mockResolvedValue({ sha256: legacy.prepared.fixtureDigest });
  const options = {
      host,
      operations: ops as unknown as StorePreparationOperations,
      target: { sid: legacy.sid, identity: storePreparationTarget(binding) },
      transaction: randomUUID(),
    },
    signal = new AbortController().signal;
  return {
    legacy,
    original,
    host,
    native,
    binding,
    ops,
    options,
    signal,
    rows,
    events,
    fresh,
    setOriginal: (value: unknown) => {
      originalRaw = Buffer.from(JSON.stringify(value));
    },
    setRecord: (value: FleetEnrollmentRecord) => {
      currentRecord = value;
    },
    originalSha: () => createHash("sha256").update(originalRaw).digest("hex"),
  };
}
it("explicitly repairs into a separately tagged current Store proof without changing original credentials, report or archive approval", async () => {
  const f = fixture(),
    immutable = JSON.stringify(f.legacy);
  const proof = await repairApprovedLegacyStoreFleetRuntime(
    f.options,
    f.signal,
  );
  expect(proof).toMatchObject({
    version: 2,
    source: "legacy-consumer-repair",
    approvalQualificationSha256: f.originalSha(),
    authority: fleetRecordAuthority(f.legacy),
    archiveDigest: null,
  });
  expect(JSON.stringify(f.legacy)).toBe(immutable);
  expect(f.native.vaultWrite).toHaveBeenCalledOnce();
  expect(f.rows.has("enrollment")).toBe(false);
  expect(f.events.indexOf("original-approval")).toBeLessThan(
    f.events.indexOf("model"),
  );
  expect(f.events.indexOf("model")).toBeLessThan(
    f.events.indexOf("fixed-qualification"),
  );
  expect(f.events.at(-1)).toBe("write:store_active_runtime");
  await expect(
    readStoreFleetRuntimeIdentityForGui(
      f.host,
      f.options.operations,
      f.legacy,
      f.signal,
    ),
  ).resolves.toMatchObject({
    source: "legacy-consumer-repair",
    archiveDigest: null,
    storeBinding: f.binding,
  });
});
it("does not authorize a legacy enrollment through automatic refresh or relabel the legacy record as Store", async () => {
  const f = fixture();
  await expect(
    refreshApprovedStoreFleetRuntime(f.options, f.signal),
  ).rejects.toThrow("FLEET_PREPARE_REQUIRED");
  expect(f.ops.fixed).not.toHaveBeenCalled();
  expect(f.ops.model).not.toHaveBeenCalled();
  expect(f.native.vaultWrite).not.toHaveBeenCalled();
});
it.each([
  "recipes",
  "modelDigest",
  "releaseManifestDigest",
  "uploadCandidate",
  "gpuIdentity",
])(
  "rejects changed original approval %s before model or GPU effects",
  async (key) => {
    const f = fixture(),
      changed = structuredClone(f.original);
    if (key === "recipes")
      Reflect.set(changed.recipes[0]!, "recipeDigest", "f".repeat(64));
    else if (key === "uploadCandidate")
      changed.uploadCandidate.resultBytes += 1;
    else if (key === "gpuIdentity") changed.gpuIdentity.name = "Foreign GPU";
    else Reflect.set(changed, key, "f".repeat(64));
    f.setOriginal(changed);
    await expect(
      repairApprovedLegacyStoreFleetRuntime(f.options, f.signal),
    ).rejects.toThrow();
    expect(f.ops.model).not.toHaveBeenCalled();
    expect(f.ops.fixed).not.toHaveBeenCalled();
    expect(f.native.vaultWrite).not.toHaveBeenCalled();
  },
);
it("rejects foreign physical GPU or missing approved fixture before installing model or qualifying", async () => {
  for (const cause of ["gpu", "fixture"]) {
    const f = fixture();
    if (cause === "gpu")
      f.native.enumerateGpus.mockResolvedValue([
        { ...f.legacy.prepared.gpu, deviceId: 999 },
      ]);
    else boundary.verify.mockResolvedValue({ sha256: "f".repeat(64) });
    await expect(
      repairApprovedLegacyStoreFleetRuntime(f.options, f.signal),
    ).rejects.toThrow();
    expect(f.ops.model).not.toHaveBeenCalled();
    expect(f.ops.fixed).not.toHaveBeenCalled();
    expect(f.native.vaultWrite).not.toHaveBeenCalled();
  }
});
it("requires original enrollment and raw approval to remain unchanged before separate publication", async () => {
  for (const cause of ["record", "approval"]) {
    const f = fixture();
    f.ops.approved.mockImplementation(async () => {
      if (cause === "record")
        f.setRecord({ ...f.legacy, machineCredential: "n".repeat(43) });
      else f.setOriginal({ ...f.original, totalSeconds: 21 });
      return {
        raw: f.fresh,
        evidence: parseQualificationEvidence(f.fresh, {
          runtimeProfile: "windows-user",
          expectedUserSid: f.legacy.sid,
          expectedFixtureDigest: f.legacy.prepared.fixtureDigest,
        }),
        bootIdentity: f.binding.bootIdentity,
      };
    });
    await expect(
      repairApprovedLegacyStoreFleetRuntime(f.options, f.signal),
    ).rejects.toThrow("UPDATE_FLEET_CHANGED");
    expect(f.native.vaultWrite).not.toHaveBeenCalled();
  }
});
it("denies repaired overlay when original approval changes later, and rejects v1 downgrade or missing witness tag", async () => {
  const f = fixture(),
    proof = await repairApprovedLegacyStoreFleetRuntime(f.options, f.signal);
  expect(proof?.version).toBe(2);
  for (const changed of [
    { ...proof, version: 1 },
    { ...proof, source: "store-enrollment" },
    { ...proof, approvalQualificationSha256: "foreign" },
  ])
    expect(() => parseStoreFleetActiveProof(changed, f.legacy)).toThrow();
  f.setOriginal({ ...f.original, totalSeconds: 21 });
  await expect(
    readStoreFleetRuntimeIdentityForGui(
      f.host,
      f.options.operations,
      f.legacy,
      f.signal,
    ),
  ).rejects.toThrow("FLEET_PREPARE_REQUIRED");
});
it("keeps original approval reads strict and rejects forged Store operations before any model or vault access", async () => {
  const f = fixture();
  boundary.read.mockResolvedValue(Buffer.from("\uFEFF{}"));
  await expect(
    readApprovedLegacyFleetQualification(f.host, f.legacy),
  ).rejects.toThrow();
  const forged = Object.create(
    boundary.Operations.prototype,
  ) as StorePreparationOperations;
  await expect(
    repairApprovedLegacyStoreFleetRuntime(
      { ...f.options, operations: forged },
      f.signal,
    ),
  ).rejects.toThrow();
  expect(f.native.vaultWrite).not.toHaveBeenCalled();
  expect(
    isDeepStrictEqual(
      f.legacy.prepared.report.runtime.modelDigest,
      MODEL.sha256,
    ),
  ).toBe(true);
});

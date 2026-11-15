import { expect, it } from "vitest";
import {
  parseStoreModelReady,
  storePreparationTarget,
  type StorePreparationBinding,
} from "../src/main/prepare/store-model-ready.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import { receipt, sid, bootIdentity } from "./fixtures/prepare.js";
function expected(): StorePreparationBinding {
  const product = STORE_PRODUCTS.worker;
  return {
    package: {
      identityName: product.identityName,
      publisher: product.publisher,
      publisherId: product.publisherId,
      familyName: product.familyName,
      fullName: `${product.identityName}_0.1.3.2_x64__${product.publisherId}`,
      packageVersion: "0.1.3.2",
      architecture: "x64",
      signatureKind: 3,
      healthy: true,
      current: true,
      installedLocation: `C:\\Program Files\\WindowsApps\\${product.identityName}_0.1.3.2_x64__${product.publisherId}`,
    },
    inventorySha256: "c".repeat(64),
    runtimeManifestSha256: "b".repeat(64),
    sid,
    bootIdentity,
    recipeDigests: {
      "kim-vocals-v2": "0".repeat(64),
      "kim-vocals-v2-trim": "1".repeat(64),
    },
  };
}
function record() {
  const binding = expected(),
    old = receipt();
  return {
    version: 1,
    distribution: "microsoft-store",
    target: storePreparationTarget(binding),
    packageFullName: binding.package.fullName,
    inventorySha256: binding.inventorySha256,
    runtimeManifestSha256: binding.runtimeManifestSha256,
    sid,
    bootIdentity,
    modelSha256: old.modelSha256,
    fixtureSha256: old.fixtureSha256,
    modelFingerprint: old.modelFingerprint,
    qualification: old.qualification,
    qualifiedAt: old.activatedAt,
  };
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
it("receives explicit Store model observations without inventing executable/Ready authority (synthetic qualification fixture)", () => {
  const result = parseStoreModelReady(bytes(record()), expected());
  expect(result.receipt.distribution).toBe("microsoft-store");
  expect(result.evidence.provider).toBe("directml");
  expect(Object.isFrozen(result.receipt.modelFingerprint)).toBe(true);
  expect(result).not.toHaveProperty("ready");
  expect(() => parseStoreModelReady(bytes(receipt()), expected())).toThrow(
    "INTEGRITY_INVALID",
  );
});
it.each([
  "packageFullName",
  "inventorySha256",
  "runtimeManifestSha256",
  "sid",
  "bootIdentity",
  "modelSha256",
  "fixtureSha256",
  "target",
])(
  "denies changed %s instead of accepting a stale cached observation",
  (key) => {
    expect(() =>
      parseStoreModelReady(
        bytes({ ...record(), [key]: "foreign" }),
        expected(),
      ),
    ).toThrow("INTEGRITY_INVALID");
  },
);
it("binds the target to the actual code generation and both production recipes", () => {
  const base = expected(),
    target = storePreparationTarget(base);
  expect(
    storePreparationTarget({ ...base, inventorySha256: "d".repeat(64) }),
  ).not.toBe(target);
  expect(
    storePreparationTarget({ ...base, runtimeManifestSha256: "d".repeat(64) }),
  ).not.toBe(target);
  expect(
    storePreparationTarget({
      ...base,
      recipeDigests: {
        ...base.recipeDigests,
        "kim-vocals-v2-trim": "d".repeat(64),
      },
    }),
  ).not.toBe(target);
});
it("retains GPU-only/provider/model/fixture/recipe qualification checks", () => {
  const valid = record();
  for (const qualification of [
    { ...valid.qualification, provider: "cpu" },
    { ...valid.qualification, gpuOnlyPolicy: "allow-fallback" },
    {
      ...valid.qualification,
      providerDispatch: {
        ...valid.qualification.providerDispatch,
        cpuNodeEvents: 1,
      },
    },
    {
      ...valid.qualification,
      recipes: valid.qualification.recipes.map((row) => ({
        ...row,
        recipeDigest: "f".repeat(64),
      })),
    },
    {
      ...valid.qualification,
      runtimeDiagnostics: {
        ...valid.qualification.runtimeDiagnostics,
        onnxRuntime: "foreign",
      },
    },
  ])
    expect(() =>
      parseStoreModelReady(bytes({ ...valid, qualification }), expected()),
    ).toThrow("INTEGRITY_INVALID");
});
it("denies malformed, oversized, duplicate and extra fields and wrong model bytes", () => {
  const valid = record();
  for (const value of [
    Buffer.alloc(16385),
    Buffer.from("{"),
    Buffer.concat([Buffer.from([239, 187, 191]), bytes(valid)]),
    Buffer.from(
      JSON.stringify(valid).replace('"version":1', '"version":1,"version":1'),
    ),
    bytes({ ...valid, archiveSha256: "a".repeat(64) }),
    bytes({
      ...valid,
      modelFingerprint: { ...valid.modelFingerprint, bytes: 1 },
    }),
  ])
    expect(() => parseStoreModelReady(value, expected())).toThrow(
      "INTEGRITY_INVALID",
    );
  expect(() =>
    storePreparationTarget({
      ...expected(),
      package: { ...expected().package, signatureKind: 0 as 3 },
    }),
  ).toThrow();
});

import { expect, it, vi } from "vitest";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import {
  parseFleetRecord,
  type FleetEnrollmentRecord,
  type StoreFleetPreparedIdentity,
} from "../src/main/fleet/store.js";
import { resolveActiveFleetIdentity } from "../src/main/fleet/active-runtime.js";
import { readStoreFleetRuntimeIdentity } from "../src/main/fleet/store-active-runtime.js";
import { StoreFleetPreparation } from "../src/main/fleet/store-preparation.js";
import { WindowsFleetPreparation } from "../src/main/fleet/preparation.js";
import { StorePreparationOperations } from "../src/main/prepare/store-operations.js";
import { StoreNodeIssuer } from "../src/main/session/store-node-issuer.js";
import type { HostContext } from "../src/main/host-context.js";
import { record } from "./fleet-fixtures.js";

// Synthetic receiving observations; this fixture is not installed Store code
// and cannot create a genuine issuer, Prepare owner or processing/GPU grant.
function storeRecord(): FleetEnrollmentRecord & {
  prepared: StoreFleetPreparedIdentity;
} {
  const legacy = record(),
    product = STORE_PRODUCTS.worker,
    fullName = `${product.identityName}_0.1.3.2_x64__${product.publisherId}`;
  return {
    ...legacy,
    prepared: {
      ...legacy.prepared,
      distribution: "microsoft-store",
      archiveDigest: null,
      modelDigest: MODEL.sha256,
      report: {
        ...legacy.prepared.report,
        runtime: {
          ...legacy.prepared.report.runtime,
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
        inventorySha256: legacy.prepared.release,
        runtimeManifestSha256: legacy.prepared.manifestDigest,
        sid: legacy.sid,
        bootIdentity: legacy.prepared.bootIdentity!,
        recipeDigests: {
          "kim-vocals-v2": "0".repeat(64),
          "kim-vocals-v2-trim": "1".repeat(64),
        },
      },
    },
  };
}

it("round trips explicit Store fleet observations without fabricating a runtime archive or replacing original approval", () => {
  const current = storeRecord(),
    parsed = parseFleetRecord(current, current.sid);
  expect(parsed).toEqual(current);
  expect(parsed).not.toBe(current);
  expect(parsed.prepared.archiveDigest).toBeNull();
  expect(parseFleetRecord(record(), current.sid).prepared.archiveDigest).toBe(
    "a".repeat(64),
  );
});

it("rejects relabeled archives and mismatched Store generation, model, user, boot or internal manifest observations", () => {
  const current = storeRecord();
  for (const prepared of [
    { ...current.prepared, archiveDigest: "a".repeat(64) },
    { ...current.prepared, distribution: "legacy" },
    { ...current.prepared, release: "9".repeat(64) },
    { ...current.prepared, manifestDigest: "9".repeat(64) },
    { ...current.prepared, modelDigest: "9".repeat(64) },
    { ...current.prepared, bootIdentity: "9".repeat(64) },
    { ...current.prepared, extra: true },
    {
      ...current.prepared,
      storeBinding: {
        ...current.prepared.storeBinding,
        sid: `${current.sid}9`,
      },
    },
    {
      ...current.prepared,
      storeBinding: {
        ...current.prepared.storeBinding,
        package: {
          ...current.prepared.storeBinding.package,
          signatureKind: 0,
        },
      },
    },
    {
      ...current.prepared,
      storeBinding: {
        ...current.prepared.storeBinding,
        recipeDigests: { "kim-vocals-v2": "0".repeat(64) },
      },
    },
  ])
    expect(() =>
      parseFleetRecord({ ...current, prepared }, current.sid),
    ).toThrow("FLEET_STATE_CORRUPT");
});

it("keeps legacy runtime and preparation authority separate from a Store-tagged record", async () => {
  const current = storeRecord(),
    snapshotReady = vi.fn(),
    legacy = new WindowsFleetPreparation({} as HostContext, {
      snapshotReady,
      qualifyApprovedFixture: vi.fn(),
    });
  expect(() => resolveActiveFleetIdentity(current, null)).toThrow(
    "FLEET_PREPARE_REQUIRED",
  );
  await expect(
    legacy.verify(current.prepared, new AbortController().signal),
  ).rejects.toThrow("FLEET_PREPARE_REQUIRED");
  expect(snapshotReady).not.toHaveBeenCalled();
});

it("does not open a caller helper or invoke an overridden Node-role getter to read Store fleet state", async () => {
  const getter = vi.fn(() => "fleet"),
    openNative = vi.fn(),
    assertNative = vi.fn(),
    issuer = Object.assign(Object.create(StoreNodeIssuer.prototype), {
      openNative,
      assertNative,
    });
  Object.defineProperty(issuer, "nodeRole", { get: getter });
  await expect(
    readStoreFleetRuntimeIdentity(
      issuer,
      storeRecord(),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(openNative).not.toHaveBeenCalled();
  expect(assertNative).not.toHaveBeenCalled();
});

it("rejects caller-built fleet preparation authority and accessor options before data or model IO", () => {
  const assertHost = vi.fn(),
    snapshotStoreReady = vi.fn(),
    operations = Object.assign(
      Object.create(StorePreparationOperations.prototype),
      { assertHost, snapshotStoreReady },
    ),
    host = { native: { vaultRead: vi.fn() } } as unknown as HostContext,
    getter = vi.fn(() => "caller label"),
    options = {};
  Object.defineProperty(options, "label", { enumerable: true, get: getter });
  expect(() => StoreFleetPreparation.open(host, operations, options)).toThrow(
    "FLEET_PREPARE_REQUIRED",
  );
  expect(() => StoreFleetPreparation.open(host, operations)).toThrow();
  expect(() =>
    Reflect.construct(StoreFleetPreparation, [
      Symbol("caller"),
      host,
      operations,
      {},
    ]),
  ).toThrow("FLEET_PREPARE_REQUIRED");
  expect(getter).not.toHaveBeenCalled();
  expect(assertHost).not.toHaveBeenCalled();
  expect(snapshotStoreReady).not.toHaveBeenCalled();
  expect(host.native.vaultRead).not.toHaveBeenCalled();
});

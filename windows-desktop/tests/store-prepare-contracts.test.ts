import { describe, expect, it } from "vitest";
import {
  parseStorePrepareLaunch,
  parseStorePrepareLaunchResult,
  parseStorePrepareResult,
  parseStorePrepareCleanup,
} from "../src/shared/store-prepare-contracts.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import { bootIdentity, gpu, receipt, sid } from "./fixtures/prepare.js";
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const product = STORE_PRODUCTS.worker;
const baseline = {
  version: 1,
  requestId: "12345678-1234-4234-8234-123456789012",
  operation: "qualify",
  binding: {
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
  },
  gpu,
  fixture: { kind: "fixed" },
};
const launch = {
  version: 1,
  requestId: baseline.requestId,
  owner: {
    role: "prepare",
    nonce: "a".repeat(64),
    identity: {
      sid,
      sessionId: 1,
      pid: 345,
      creationTime: "132000000000000000",
    },
  },
  inventorySha256: baseline.binding.inventorySha256,
};
const response = {
  ...launch,
  operation: "qualify",
  bootIdentity,
  raw: receipt().qualification,
};
describe("Store preparation receiving contracts", () => {
  it("binds synthetic qualification bytes to request, exact owner and both unchanged recipes without minting Ready", () => {
    const request = parseStorePrepareLaunch(bytes(baseline)),
      started = parseStorePrepareLaunchResult(bytes(launch), request),
      result = parseStorePrepareResult(bytes(response), request, started);
    expect(result.evidence?.provider).toBe("directml");
    expect(result.result.owner).toEqual(started.owner);
    expect(result).not.toHaveProperty("ready");
    expect(Object.isFrozen(request.binding.recipeDigests)).toBe(true);
    expect(Object.isFrozen(request.binding.package)).toBe(true);
  });
  it("admits only the fixed fixture or exact approved private content-addressed WAV", () => {
    const approved = {
      kind: "approved",
      sha256: "d".repeat(64),
      relativePath: `prepare\\approved\\${"d".repeat(64)}.wav`,
      bytes: 1000,
    };
    expect(
      parseStorePrepareLaunch(bytes({ ...baseline, fixture: approved }))
        .fixture,
    ).toEqual(approved);
    for (const fixture of [
      { kind: "caller", path: "C:\\song.wav" },
      { ...approved, relativePath: "prepare\\approved\\..\\song.wav" },
      { ...approved, bytes: 43 },
      { kind: "fixed", path: "song.wav" },
    ])
      expect(() =>
        parseStorePrepareLaunch(bytes({ ...baseline, fixture })),
      ).toThrow("STORE_PREPARE_CONTRACT_DENIED");
  });
  it.each([
    { operation: "arbitrary-tool" },
    { executable: "C:\\caller.exe" },
    { requestId: "12345678-1234-1234-8234-123456789012" },
    { gpu: { ...gpu, deviceIndex: 16 } },
    { binding: { ...baseline.binding, archiveSha256: "d".repeat(64) } },
    {
      binding: {
        ...baseline.binding,
        package: { ...baseline.binding.package, signatureKind: 2 },
      },
    },
  ])("denies unbound code/generation/path fields %j", (changed) => {
    expect(() =>
      parseStorePrepareLaunch(bytes({ ...baseline, ...changed })),
    ).toThrow("STORE_PREPARE_CONTRACT_DENIED");
  });
  it("rejects stale request, owner birth, boot and inventory even with otherwise passing raw qualification", () => {
    const request = parseStorePrepareLaunch(bytes(baseline)),
      started = parseStorePrepareLaunchResult(bytes(launch), request);
    for (const changed of [
      { requestId: "87654321-1234-4234-8234-123456789012" },
      { inventorySha256: "d".repeat(64) },
      { bootIdentity: "d".repeat(64) },
      { owner: { ...launch.owner, nonce: "d".repeat(64) } },
      {
        owner: {
          ...launch.owner,
          identity: {
            ...launch.owner.identity,
            creationTime: "132000000000000001",
          },
        },
      },
      { operation: "inspect" },
    ])
      expect(() =>
        parseStorePrepareResult(
          bytes({ ...response, ...changed }),
          request,
          started,
        ),
      ).toThrow("STORE_PREPARE_CONTRACT_DENIED");
  });
  it("denies CPU fallback, changed GPU, recipe or internal manifest result", () => {
    const request = parseStorePrepareLaunch(bytes(baseline)),
      started = parseStorePrepareLaunchResult(bytes(launch), request);
    for (const raw of [
      { ...response.raw, provider: "cpu" },
      { ...response.raw, releaseManifestDigest: "d".repeat(64) },
      { ...response.raw, gpuIdentity: { ...gpu, luid: "0000000000000043" } },
      {
        ...response.raw,
        recipes: response.raw.recipes.map((r) => ({
          ...r,
          recipeDigest: "d".repeat(64),
        })),
      },
    ])
      expect(() =>
        parseStorePrepareResult(bytes({ ...response, raw }), request, started),
      ).toThrow("STORE_PREPARE_CONTRACT_DENIED");
  });
  it("keeps inspection separate from qualification and rejects ambiguous duplicate adapters", () => {
    const request = parseStorePrepareLaunch(
        bytes({ ...baseline, operation: "inspect" }),
      ),
      started = parseStorePrepareLaunchResult(bytes(launch), request),
      inspected = {
        ...response,
        operation: "inspect",
        raw: { version: 1, sid, gpus: [gpu] },
      };
    expect(
      parseStorePrepareResult(bytes(inspected), request, started),
    ).not.toHaveProperty("evidence");
    for (const gpus of [[], [gpu, gpu], [{ ...gpu, luid: "0000000000000043" }]])
      expect(() =>
        parseStorePrepareResult(
          bytes({ ...inspected, raw: { version: 1, sid, gpus } }),
          request,
          started,
        ),
      ).toThrow("STORE_PREPARE_CONTRACT_DENIED");
  });
  it("requires separately confirmed whole Job and physical GPU cleanup bound to the same launched owner", () => {
    const request = parseStorePrepareLaunch(bytes(baseline)),
      started = parseStorePrepareLaunchResult(bytes(launch), request),
      cleanup = { ...launch, job: "confirmed", gpu: "confirmed" };
    expect(parseStorePrepareCleanup(bytes(cleanup), request, started)).toEqual(
      cleanup,
    );
    for (const changed of [
      { job: "pending" },
      { gpu: "released" },
      { owner: { ...launch.owner, nonce: "d".repeat(64) } },
      { signedReceipt: true },
    ])
      expect(() =>
        parseStorePrepareCleanup(
          bytes({ ...cleanup, ...changed }),
          request,
          started,
        ),
      ).toThrow("STORE_PREPARE_CONTRACT_DENIED");
  });
  it("denies duplicate fields, BOM, malformed UTF8 and oversized input", () => {
    for (const value of [
      Buffer.alloc(8193),
      Buffer.from([0xff]),
      Buffer.concat([Buffer.from([239, 187, 191]), bytes(baseline)]),
      Buffer.from(
        JSON.stringify(baseline).replace(
          '"version":1',
          '"version":1,"version":1',
        ),
      ),
    ])
      expect(() => parseStorePrepareLaunch(value)).toThrow(
        "STORE_PREPARE_CONTRACT_DENIED",
      );
  });
});

import { expect, it } from "vitest";
import {
  parseStoreMediaRequest,
  parseStoreMediaLaunch,
  parseStoreMediaEvent,
  parseStoreMediaCleanup,
  storeMediaOutput,
  storeMediaNativeRequest,
  parseStoreMediaNativeRequest,
} from "../src/shared/store-media-request.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import { sid, bootIdentity } from "./fixtures/prepare.js";
const id = "12345678-1234-4234-8234-123456789012",
  product = STORE_PRODUCTS.worker;
const binding = {
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
  inventorySha256: "a".repeat(64),
  runtimeManifestSha256: "b".repeat(64),
  sid,
  bootIdentity,
  recipeDigests: {
    "kim-vocals-v2": "c".repeat(64),
    "kim-vocals-v2-trim": "d".repeat(64),
  },
};
const config = (operation: string) => ({
  version: 1,
  operation,
  requestId: id,
  executionId: id,
  release: binding.inventorySha256,
  sid,
  manifestSha256: binding.runtimeManifestSha256,
  helperSha256: "f".repeat(64),
  ...(["cloud_prepare", "cloud_probe", "silence_analyze"].includes(operation)
    ? { inputBytes: 50 }
    : {}),
  ...(operation === "silence_analyze"
    ? { inputSha256: "e".repeat(64), durationSeconds: 12.5 }
    : {}),
});
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const input = (operation = "cloud_prepare") => ({
  version: 1,
  requestId: id,
  binding,
  configuration: config(operation),
});
const launch = {
  version: 1,
  requestId: id,
  inventorySha256: binding.inventorySha256,
  owner: {
    role: "prepare",
    nonce: "1".repeat(64),
    identity: {
      sid,
      sessionId: 1,
      pid: 345,
      creationTime: "132000000000000000",
    },
  },
};
it.each([
  "cloud_prepare",
  "cloud_probe",
  "silence_analyze",
  "diagnostics_doctor",
  "browser_check_youtube",
])(
  "keeps existing %s CPU result limits without GPU/Ready/code authority",
  (operation) => {
    const request = parseStoreMediaRequest(bytes(input(operation))),
      held = parseStoreMediaLaunch(bytes(launch), request),
      output = storeMediaOutput(request.configuration);
    expect(Object.isFrozen(request)).toBe(true);
    expect(request).not.toHaveProperty("gpu");
    expect(request).not.toHaveProperty("ready");
    expect(
      parseStoreMediaEvent(
        bytes({
          ...launch,
          state: "completed",
          result: {
            relativePath: output.relativePath,
            bytes: 20,
            sha256: "2".repeat(64),
          },
        }),
        request,
        held,
      ),
    ).toMatchObject({ state: "completed" });
    expect(
      parseStoreMediaCleanup(
        bytes({ ...launch, job: "confirmed", gpu: "not-required" }),
        request,
        held,
      ),
    ).toMatchObject({ gpu: "not-required" });
  },
);
it("rejects paths/commands/quality changes and mismatched request/configuration/code bindings", () => {
  for (const changed of [
    { ...input(), command: "cmd.exe" },
    { ...input(), gpu: {} },
    {
      ...input(),
      configuration: { ...config("cloud_prepare"), requestId: "abcdefgh" },
    },
    {
      ...input(),
      configuration: { ...config("cloud_prepare"), release: "9".repeat(64) },
    },
    {
      ...input(),
      configuration: {
        ...config("cloud_prepare"),
        manifestSha256: "9".repeat(64),
      },
    },
    {
      ...input(),
      configuration: { ...config("cloud_prepare"), sid: "S-1-5-21-9-9-9-1001" },
    },
    {
      ...input(),
      configuration: { ...config("cloud_prepare"), inputBytes: 0 },
    },
    {
      ...input(),
      configuration: { ...config("cloud_prepare"), executable: "ffmpeg.exe" },
    },
    {
      ...input(),
      configuration: { ...config("silence_analyze"), durationSeconds: 7201 },
    },
    { ...input(), configuration: config("benchmark_file") },
    {
      ...input(),
      binding: {
        ...binding,
        package: { ...binding.package, signatureKind: 0 },
      },
    },
  ])
    expect(() => parseStoreMediaRequest(bytes(changed))).toThrow(
      "STORE_MEDIA_REQUEST_INVALID",
    );
});
it("carries fractional silence duration only inside the exact bounded private configuration", () => {
  const original = parseStoreMediaRequest(bytes(input("silence_analyze"))),
    wire = storeMediaNativeRequest(original),
    decoded = parseStoreMediaNativeRequest(JSON.parse(bytes(wire).toString()));
  expect(wire).not.toHaveProperty("configuration");
  expect(JSON.parse(wire.configuration_json).durationSeconds).toBe(12.5);
  expect(decoded).toEqual(original);
  expect(
    bytes(decoded.configuration).equals(bytes(original.configuration)),
  ).toBe(true);
  for (const configuration_json of [
    "{}",
    "[]",
    wire.configuration_json.replace(
      '"durationSeconds":12.5',
      '"durationSeconds":12.5,"durationSeconds":13',
    ),
    wire.configuration_json.replace(
      '"durationSeconds":12.5',
      '"durationSeconds":1e999',
    ),
    "\ufeff" + wire.configuration_json,
    " ".repeat(8193),
  ])
    expect(() =>
      parseStoreMediaNativeRequest({ ...wire, configuration_json }),
    ).toThrow("STORE_MEDIA_REQUEST_INVALID");
  expect(() => parseStoreMediaNativeRequest(original)).toThrow(
    "STORE_MEDIA_REQUEST_INVALID",
  );
  expect(() =>
    parseStoreMediaNativeRequest({
      ...wire,
      configuration: original.configuration,
    }),
  ).toThrow("STORE_MEDIA_REQUEST_INVALID");
  expect(() =>
    parseStoreMediaNativeRequest({ ...wire, configuration_json: {} }),
  ).toThrow("STORE_MEDIA_REQUEST_INVALID");
});
it("requires original media owner/generation and exact bounded result paths, never GPU cleanup claims", () => {
  const request = parseStoreMediaRequest(bytes(input())),
    held = parseStoreMediaLaunch(bytes(launch), request),
    output = storeMediaOutput(request.configuration);
  for (const owner of [
    { ...launch.owner, nonce: "9".repeat(64) },
    { ...launch.owner, role: "personal" },
    {
      ...launch.owner,
      identity: {
        ...launch.owner.identity,
        creationTime: "132000000000000001",
      },
    },
  ])
    expect(() =>
      parseStoreMediaEvent(
        bytes({ ...launch, owner, state: "waiting" }),
        request,
        held,
      ),
    ).toThrow("STORE_MEDIA_REQUEST_INVALID");
  for (const result of [
    { relativePath: "C:\\outside.json", bytes: 20, sha256: "2".repeat(64) },
    { relativePath: output.relativePath, bytes: 4097, sha256: "2".repeat(64) },
    { relativePath: output.relativePath, bytes: 20, sha256: "g".repeat(64) },
    {
      relativePath: output.relativePath,
      bytes: 20,
      sha256: "2".repeat(64),
      ready: true,
    },
  ])
    expect(() =>
      parseStoreMediaEvent(
        bytes({ ...launch, state: "completed", result }),
        request,
        held,
      ),
    ).toThrow("STORE_MEDIA_REQUEST_INVALID");
  expect(() =>
    parseStoreMediaCleanup(
      bytes({ ...launch, job: "confirmed", gpu: "confirmed" }),
      request,
      held,
    ),
  ).toThrow("STORE_MEDIA_REQUEST_INVALID");
});

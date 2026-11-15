import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import {
  STORE_CPU_OPERATIONS,
  type StoreCpuOperationKind,
} from "../src/shared/store-cpu-operation.js";
import {
  parseStoreGuiCpuCleanup,
  parseStoreGuiCpuLaunchCommand,
  parseStoreGuiCpuReadyEvent,
  parseStoreGuiCpuRecovery,
  parseStoreGuiCpuRequestCommand,
  parseStoreGuiCpuStartAck,
  parseStoreGuiCpuWaitEvent,
} from "../src/shared/store-gui-cpu-contracts.js";
import {
  parseStoreMediaLaunch,
  parseStoreMediaRequest,
  storeMediaOutput,
} from "../src/shared/store-media-request.js";
import { STORE_PREPARE_FAILURE_CODES } from "../src/shared/store-prepare-contracts.js";
import { bootIdentity, sid } from "./fixtures/prepare.js";

const requestId = "12345678-1234-4234-8234-123456789012",
  commandId = "87654321-4321-4321-8321-210987654321",
  incarnation = "24681357-1234-4234-8234-123456789012",
  product = STORE_PRODUCTS.worker,
  fullName = `${product.identityName}_0.1.3.2_x64__${product.publisherId}`;
const binding = {
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
  inventorySha256: "a".repeat(64),
  runtimeManifestSha256: "b".repeat(64),
  sid,
  bootIdentity,
  recipeDigests: {
    "kim-vocals-v2": "c".repeat(64),
    "kim-vocals-v2-trim": "d".repeat(64),
  },
};
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const input = (operation: StoreCpuOperationKind = "cloud_prepare") => ({
  version: 1,
  requestId,
  binding,
  configuration: {
    version: 1,
    operation,
    requestId,
    executionId: incarnation,
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
  },
});
const launchInput = {
  version: 1,
  requestId,
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
function fixture(operation: StoreCpuOperationKind = "cloud_prepare") {
  const request = parseStoreMediaRequest(bytes(input(operation))),
    launch = parseStoreMediaLaunch(bytes(launchInput), request),
    expectation = {
      version: 1,
      distribution: "microsoft-store",
      kind: "cpu-tools",
      requestId,
      incarnation,
      operation,
      configurationSha256: createHash("sha256")
        .update(JSON.stringify(request.configuration))
        .digest("hex"),
      inventorySha256: binding.inventorySha256,
      runtimeManifestSha256: binding.runtimeManifestSha256,
      nodeOwner: launch.owner,
      token: "2".repeat(64),
    };
  return { request, launch, expectation };
}
const denied = "STORE_GUI_CPU_CONTRACT_INVALID";

it.each(STORE_CPU_OPERATIONS)(
  "receives original %s launch recovery or exact owner-free terminal cleanup without granting a GPU lease",
  (operation) => {
    const { request, launch } = fixture(operation),
      retired = {
        version: 1,
        requestId: request.requestId,
        inventorySha256: request.binding.inventorySha256,
        state: "retired",
        job: "confirmed",
        gpu: "not-required",
      };
    expect(parseStoreGuiCpuRecovery(bytes(launch), request)).toEqual(launch);
    const terminal = parseStoreGuiCpuRecovery(bytes(retired), request);
    expect(terminal).toEqual(retired);
    expect(Object.isFrozen(terminal)).toBe(true);
    expect(terminal).not.toHaveProperty("owner");
    expect(terminal).not.toHaveProperty("token");
    expect(terminal).not.toHaveProperty("retire");
  },
);
it("rejects foreign-generation, uncertain, mixed or malformed terminal CPU recovery", () => {
  const { request, launch } = fixture(),
    retired = {
      version: 1,
      requestId: request.requestId,
      inventorySha256: request.binding.inventorySha256,
      state: "retired",
      job: "confirmed",
      gpu: "not-required",
    };
  for (const candidate of [
    { ...retired, version: 2 },
    { ...retired, requestId: commandId },
    { ...retired, inventorySha256: "9".repeat(64) },
    { ...retired, state: "waiting" },
    { ...retired, state: null },
    { ...retired, job: "unknown" },
    { ...retired, job: true },
    { ...retired, gpu: "confirmed" },
    { ...retired, gpu: "unknown" },
    { ...retired, owner: launch.owner },
    { ...retired, token: "2".repeat(64) },
    { ...retired, authority: {} },
    { ...launch, state: "retired" },
    { ...launch, requestId: commandId },
    { ...launch, inventorySha256: "9".repeat(64) },
  ])
    expect(() => parseStoreGuiCpuRecovery(bytes(candidate), request)).toThrow(
      denied,
    );
  for (const field of Object.keys(retired)) {
    const missing = { ...retired } as Record<string, unknown>;
    delete missing[field];
    expect(() => parseStoreGuiCpuRecovery(bytes(missing), request)).toThrow(
      denied,
    );
  }
  for (const input of [
    Buffer.from([0xff]),
    Buffer.from("\ufeff" + JSON.stringify(retired)),
    Buffer.from(JSON.stringify(retired) + JSON.stringify(retired)),
    Buffer.from(
      JSON.stringify(retired).replace(
        '"job":"confirmed"',
        '"job":"confirmed","job":"confirmed"',
      ),
    ),
    Buffer.alloc(4097),
    Buffer.alloc(0),
  ])
    expect(() => parseStoreGuiCpuRecovery(input, request)).toThrow(denied);
});

it.each(STORE_CPU_OPERATIONS)(
  "binds %s CPU messages to the original request without granting GPU or code authority",
  (operation) => {
    const { request, launch, expectation } = fixture(operation),
      output = storeMediaOutput(request.configuration);
    for (const action of ["cpu_launch", "cpu_recover"])
      expect(
        parseStoreGuiCpuRequestCommand(
          bytes({ version: 1, requestId: commandId, action, request }),
        ),
      ).toEqual({ version: 1, requestId: commandId, action, request });
    for (const action of ["cpu_ready", "cpu_start", "cpu_wait", "cpu_cancel"])
      expect(
        parseStoreGuiCpuLaunchCommand(
          bytes({ version: 1, requestId: commandId, action, launch }),
          request,
          launch,
        ),
      ).toEqual({ version: 1, requestId: commandId, action, launch });
    expect(
      parseStoreGuiCpuReadyEvent(
        bytes({ ...launch, state: "waiting" }),
        request,
        launch,
      ),
    ).toEqual({ ...launch, state: "waiting" });
    const ready = parseStoreGuiCpuReadyEvent(
      bytes({ ...launch, state: "ready", expectation }),
      request,
      launch,
    );
    expect(ready).toEqual({ ...launch, state: "ready", expectation });
    expect(Object.isFrozen(ready)).toBe(true);
    expect(ready).not.toHaveProperty("gpu");
    expect(ready).not.toHaveProperty("authority");
    expect(ready).not.toHaveProperty("retire");
    if (ready.state === "ready") {
      expect(Object.isFrozen(ready.expectation.nodeOwner.identity)).toBe(true);
      expect(Reflect.ownKeys(ready.expectation)).toHaveLength(11);
    }
    expect(
      parseStoreGuiCpuStartAck(
        bytes({ ...launch, started: true }),
        request,
        launch,
      ),
    ).toEqual({ ...launch, started: true });
    expect(
      parseStoreGuiCpuWaitEvent(
        bytes({ ...launch, state: "waiting" }),
        request,
        launch,
      ),
    ).toEqual({ ...launch, state: "waiting" });
    expect(
      parseStoreGuiCpuWaitEvent(
        bytes({
          ...launch,
          state: "completed",
          result: {
            relativePath: output.relativePath,
            bytes: 20,
            sha256: "3".repeat(64),
          },
        }),
        request,
        launch,
      ),
    ).toMatchObject({ state: "completed", result: { bytes: 20 } });
    expect(
      parseStoreGuiCpuCleanup(
        bytes({ ...launch, job: "confirmed", gpu: "not-required" }),
        request,
        launch,
      ),
    ).toEqual({ ...launch, job: "confirmed", gpu: "not-required" });
  },
);

it("hashes the parsed canonical configuration rather than the incoming key order", () => {
  const { launch, expectation } = fixture(),
    original = input(),
    reordered = {
      ...original,
      configuration: Object.fromEntries(
        Object.entries(original.configuration).reverse(),
      ),
    },
    request = parseStoreMediaRequest(bytes(reordered));
  expect(JSON.stringify(reordered.configuration)).not.toBe(
    JSON.stringify(request.configuration),
  );
  expect(
    parseStoreGuiCpuReadyEvent(
      bytes({ ...launch, state: "ready", expectation }),
      request,
      launch,
    ),
  ).toMatchObject({ state: "ready" });
});

it("rejects owner nonce, SID, session, PID, birth and role substitutions in every bound observation", () => {
  const { request, launch, expectation } = fixture();
  for (const owner of [
    { ...launch.owner, nonce: "9".repeat(64) },
    { ...launch.owner, role: "personal" },
    ...[
      { sid: "S-1-5-21-9-9-9-1001" },
      { sessionId: 2 },
      { pid: 346 },
      { creationTime: "132000000000000001" },
    ].map((change) => ({
      ...launch.owner,
      identity: { ...launch.owner.identity, ...change },
    })),
  ]) {
    const changed = { ...launch, owner };
    expect(() =>
      parseStoreGuiCpuLaunchCommand(
        bytes({
          version: 1,
          requestId: commandId,
          action: "cpu_start",
          launch: changed,
        }),
        request,
        launch,
      ),
    ).toThrow(denied);
    expect(() =>
      parseStoreGuiCpuReadyEvent(
        bytes({ ...changed, state: "waiting" }),
        request,
        launch,
      ),
    ).toThrow(denied);
    expect(() =>
      parseStoreGuiCpuReadyEvent(
        bytes({
          ...launch,
          state: "ready",
          expectation: { ...expectation, nodeOwner: owner },
        }),
        request,
        launch,
      ),
    ).toThrow(denied);
    expect(() =>
      parseStoreGuiCpuWaitEvent(
        bytes({ ...changed, state: "failed", errorCode: "OPERATION_FAILED" }),
        request,
        launch,
      ),
    ).toThrow(denied);
    expect(() =>
      parseStoreGuiCpuStartAck(
        bytes({ ...changed, started: true }),
        request,
        launch,
      ),
    ).toThrow(denied);
    expect(() =>
      parseStoreGuiCpuCleanup(
        bytes({ ...changed, job: "confirmed", gpu: "not-required" }),
        request,
        launch,
      ),
    ).toThrow(denied);
  }
});

it("requires the original request, operation, inventory, internal manifest and configuration SHA", () => {
  const { request, launch, expectation } = fixture();
  for (const change of [
    { requestId: commandId },
    { operation: "cloud_probe" },
    { inventorySha256: "9".repeat(64) },
    { runtimeManifestSha256: "9".repeat(64) },
    { configurationSha256: "9".repeat(64) },
    { incarnation: "ABCDEF12-1234-4234-8234-123456789012" },
    { token: "g".repeat(64) },
    { gpu: { deviceIndex: 1 } },
    { authority: true },
  ])
    expect(() =>
      parseStoreGuiCpuReadyEvent(
        bytes({
          ...launch,
          state: "ready",
          expectation: { ...expectation, ...change },
        }),
        request,
        launch,
      ),
    ).toThrow(denied);
  for (const change of [
    { requestId: commandId },
    { inventorySha256: "9".repeat(64) },
    { index: 1 },
  ])
    expect(() =>
      parseStoreGuiCpuReadyEvent(
        bytes({ ...launch, ...change, state: "ready", expectation }),
        request,
        launch,
      ),
    ).toThrow(denied);
});

it("keeps request and launch command schemas separate and closes their action sets", () => {
  const { request, launch } = fixture();
  for (const action of [
    "cpu_start",
    "launch",
    "CPU_LAUNCH",
    "cpu_launch ",
    null,
  ])
    expect(() =>
      parseStoreGuiCpuRequestCommand(
        bytes({ version: 1, requestId: commandId, action, request }),
      ),
    ).toThrow(denied);
  for (const action of [
    "cpu_launch",
    "cpu_recover",
    "start",
    "cpu_wait ",
    null,
  ])
    expect(() =>
      parseStoreGuiCpuLaunchCommand(
        bytes({ version: 1, requestId: commandId, action, launch }),
        request,
        launch,
      ),
    ).toThrow(denied);
  for (const change of [
    { version: 2 },
    { requestId: "not-a-uuid" },
    { requestId: "12345678-1234-1234-8234-123456789012" },
    { launch },
    { command: "cmd.exe" },
    {
      request: {
        ...request,
        configuration: { ...request.configuration, executable: "ffmpeg.exe" },
      },
    },
  ])
    expect(() =>
      parseStoreGuiCpuRequestCommand(
        bytes({
          version: 1,
          requestId: commandId,
          action: "cpu_launch",
          request,
          ...change,
        }),
      ),
    ).toThrow(denied);
});

it("requires exact waiting/ready/start states and preserves CPU-only cleanup", () => {
  const { request, launch, expectation } = fixture();
  for (const value of [
    { ...launch, state: "waiting", expectation },
    { ...launch, state: "ready" },
    { ...launch, state: "completed", expectation },
    { ...launch, state: "ready", expectation, ready: true },
  ])
    expect(() =>
      parseStoreGuiCpuReadyEvent(bytes(value), request, launch),
    ).toThrow(denied);
  for (const value of [
    { started: true },
    { ...launch, started: false },
    { ...launch, started: "true" },
    { ...launch, started: true, state: "ready" },
  ])
    expect(() =>
      parseStoreGuiCpuStartAck(bytes(value), request, launch),
    ).toThrow(denied);
  for (const value of [
    { ...launch, job: "confirmed", gpu: "confirmed" },
    { ...launch, job: "waiting", gpu: "not-required" },
    { ...launch, job: "confirmed", gpu: "not-required", retired: true },
  ])
    expect(() =>
      parseStoreGuiCpuCleanup(bytes(value), request, launch),
    ).toThrow(denied);
});

it("receives only closed failure codes and exact existing result bounds", () => {
  const { request, launch } = fixture(),
    output = storeMediaOutput(request.configuration);
  for (const errorCode of STORE_PREPARE_FAILURE_CODES)
    expect(
      parseStoreGuiCpuWaitEvent(
        bytes({ ...launch, state: "failed", errorCode }),
        request,
        launch,
      ),
    ).toEqual({ ...launch, state: "failed", errorCode });
  for (const errorCode of [
    "UNKNOWN_ERROR",
    "operation_failed",
    "C:\\private\\file",
    "E".repeat(97),
    null,
  ])
    expect(() =>
      parseStoreGuiCpuWaitEvent(
        bytes({ ...launch, state: "failed", errorCode }),
        request,
        launch,
      ),
    ).toThrow(denied);
  for (const value of [
    {
      ...launch,
      state: "failed",
      errorCode: "OPERATION_FAILED",
      message: "private path",
    },
    { ...launch, state: "failed", errorCode: "OPERATION_FAILED", result: {} },
    { ...launch, state: "ready" },
    {
      ...launch,
      state: "completed",
      result: {
        relativePath: "C:\\outside.json",
        bytes: 20,
        sha256: "3".repeat(64),
      },
    },
    {
      ...launch,
      state: "completed",
      result: {
        relativePath: output.relativePath,
        bytes: output.maximumBytes + 1,
        sha256: "3".repeat(64),
      },
    },
    {
      ...launch,
      state: "completed",
      result: {
        relativePath: output.relativePath,
        bytes: 20,
        sha256: "3".repeat(64),
        ready: true,
      },
    },
  ])
    expect(() =>
      parseStoreGuiCpuWaitEvent(bytes(value), request, launch),
    ).toThrow(denied);
});

it("rejects duplicate and escaped duplicate keys, BOM, invalid UTF-8, trailing data and oversized frames", () => {
  const { request, launch, expectation } = fixture();
  const cases = [
    {
      value: {
        version: 1,
        requestId: commandId,
        action: "cpu_launch",
        request,
      },
      parse: (value: Uint8Array) => parseStoreGuiCpuRequestCommand(value),
    },
    {
      value: { version: 1, requestId: commandId, action: "cpu_start", launch },
      parse: (value: Uint8Array) =>
        parseStoreGuiCpuLaunchCommand(value, request, launch),
    },
    {
      value: { ...launch, state: "ready", expectation },
      parse: (value: Uint8Array) =>
        parseStoreGuiCpuReadyEvent(value, request, launch),
    },
    {
      value: { ...launch, state: "failed", errorCode: "OPERATION_FAILED" },
      parse: (value: Uint8Array) =>
        parseStoreGuiCpuWaitEvent(value, request, launch),
    },
    {
      value: { ...launch, started: true },
      parse: (value: Uint8Array) =>
        parseStoreGuiCpuStartAck(value, request, launch),
    },
    {
      value: { ...launch, job: "confirmed", gpu: "not-required" },
      parse: (value: Uint8Array) =>
        parseStoreGuiCpuCleanup(value, request, launch),
    },
  ];
  for (const { value, parse } of cases) {
    const wire = JSON.stringify(value);
    for (const changed of [
      Buffer.from(wire.replace('"version":1', '"version":1,"version":1')),
      Buffer.from(wire.replace('"version":1', '"version":1,"\\u0076ersion":1')),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(wire)]),
      Buffer.concat([Buffer.from([0xc3, 0x28]), Buffer.from(wire)]),
      Buffer.from(`${wire} {}`),
      Buffer.alloc(19000, 0x20),
      Buffer.alloc(0),
      Buffer.from("null"),
      Buffer.from("[]"),
    ])
      expect(() => parse(changed)).toThrow(denied);
  }
  const requestWire = JSON.stringify({
    version: 1,
    requestId: commandId,
    action: "cpu_launch",
    request,
  });
  expect(() =>
    parseStoreGuiCpuRequestCommand(
      Buffer.from(
        requestWire.replace(
          '"inputBytes":50',
          '"inputBytes":50,"inputBytes":50',
        ),
      ),
    ),
  ).toThrow(denied);
});

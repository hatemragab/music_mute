import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import {
  parseStoreBenchmarkCleanup,
  parseStoreBenchmarkRecovery,
  parseStoreBenchmarkEvent,
  parseStoreBenchmarkLaunch,
  parseStoreBenchmarkLaunchCommand,
  parseStoreBenchmarkRequest,
  parseStoreBenchmarkRequestCommand,
  storeBenchmarkConfigurationSha256,
} from "../src/shared/store-benchmark-contracts.js";
import { STORE_PREPARE_FAILURE_CODES } from "../src/shared/store-prepare-contracts.js";
import {
  validateAdvancedBenchmarkReport,
  type AdvancedBenchmarkConfiguration,
} from "../src/main/fleet/advanced/benchmark-child.js";
import {
  advancedRequest,
  benchmarkConfig,
  consumerCapacityRaw,
  consumerRepeatedRaw,
  processIdentity,
} from "./fleet-advanced-fixtures.js";

// Synthetic receiving data only; no fixture creates a native Store owner,
// runs an engine, proves Store registration or grants a processing lease.
const product = STORE_PRODUCTS.worker,
  fullName = `${product.identityName}_0.1.3.2_x64__${product.publisherId}`,
  binding = {
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
    sid: processIdentity.sid,
    bootIdentity: "e".repeat(64),
    recipeDigests: {
      "kim-vocals-v2": "c".repeat(64),
      "kim-vocals-v2-trim": "d".repeat(64),
    },
  },
  launchInput = {
    version: 1,
    requestId: advancedRequest,
    inventorySha256: binding.inventorySha256,
    owner: {
      role: "prepare",
      nonce: "1".repeat(64),
      identity: { ...processIdentity, pid: 345 },
    },
  },
  denied = "STORE_BENCHMARK_CONTRACT_INVALID";
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
function input(
  operation: AdvancedBenchmarkConfiguration["operation"] = "benchmark_file",
) {
  return {
    version: 1,
    requestId: advancedRequest,
    operation,
    binding: structuredClone(binding),
    configuration: benchmarkConfig(operation),
  };
}
function fixture(
  operation: AdvancedBenchmarkConfiguration["operation"] = "benchmark_file",
) {
  const request = parseStoreBenchmarkRequest(bytes(input(operation))),
    launch = parseStoreBenchmarkLaunch(bytes(launchInput), request),
    result = {
      configurationSha256: storeBenchmarkConfigurationSha256(
        request.configuration,
      ),
      rawBytes: 1000,
      rawSha256: "f".repeat(64),
      wallSeconds: 12.25,
    };
  return { request, launch, result };
}
function completed() {
  const original = fixture();
  return { ...original.launch, state: "completed", result: original.result };
}

describe("closed Store benchmark receiving data", () => {
  it.each(["benchmark_file", "benchmark_capacity"] as const)(
    "round trips and deeply freezes %s requests without adding launch authority",
    (operation) => {
      const { request, launch } = fixture(operation);
      expect(parseStoreBenchmarkRequest(bytes(request))).toEqual(request);
      expect(Object.keys(request).sort()).toEqual([
        "binding",
        "configuration",
        "operation",
        "requestId",
        "version",
      ]);
      for (const value of [
        request,
        request.binding,
        request.binding.package,
        request.binding.recipeDigests,
        request.configuration,
        request.configuration.gpu,
        request.configuration.fixture,
        launch,
        launch.owner,
        launch.owner.identity,
      ])
        expect(Object.isFrozen(value)).toBe(true);
      expect(() =>
        Object.assign(request.configuration.fixture, { bytes: 44 }),
      ).toThrow();
    },
  );
  it.each(["benchmark_launch", "benchmark_recover"] as const)(
    "receives %s with the original request ID and unchanged request",
    (action) => {
      const { request } = fixture();
      const received = parseStoreBenchmarkRequestCommand(
        bytes({
          version: 1,
          requestId: request.requestId,
          action,
          request,
        }),
      );
      expect(received.request).toEqual(request);
      expect(Object.isFrozen(received)).toBe(true);
      expect(() =>
        parseStoreBenchmarkRequestCommand(
          bytes({
            ...received,
            requestId: "87654321-4321-4321-8321-210987654321",
          }),
        ),
      ).toThrow(denied);
    },
  );
  it.each(["benchmark_wait", "benchmark_cancel"] as const)(
    "receives %s only for the exact original launch and matching request ID",
    (action) => {
      const { request, launch } = fixture();
      const command = {
        version: 1,
        requestId: request.requestId,
        action,
        launch,
      };
      expect(
        parseStoreBenchmarkLaunchCommand(bytes(command), request, launch),
      ).toEqual(command);
      expect(() =>
        parseStoreBenchmarkLaunchCommand(
          bytes({
            ...command,
            requestId: "87654321-4321-4321-8321-210987654321",
          }),
          request,
          launch,
        ),
      ).toThrow(denied);
    },
  );
  it("admits both unchanged file recipes and explicit capacity saveAudio:false", () => {
    const file = input();
    file.configuration.recipe = "kim-vocals-v2-trim";
    file.configuration.groupSize = 1;
    file.configuration.saveAudio = true;
    expect(parseStoreBenchmarkRequest(bytes(file)).configuration.recipe).toBe(
      "kim-vocals-v2-trim",
    );
    const capacity = input("benchmark_capacity");
    capacity.configuration.saveAudio = false;
    expect(
      parseStoreBenchmarkRequest(bytes(capacity)).configuration.saveAudio,
    ).toBe(false);
  });
  it("admits only same-generation candidate observations and deeply freezes them", () => {
    const file = input();
    file.configuration.candidate = {
      release: binding.inventorySha256,
      manifestSha256: binding.runtimeManifestSha256,
      engineDigest: "2".repeat(64),
    };
    const request = parseStoreBenchmarkRequest(bytes(file));
    expect(Object.isFrozen(request.configuration.candidate)).toBe(true);
    expect(request.configuration.candidate).toEqual(
      file.configuration.candidate,
    );
    // A syntactically valid helper pin remains data for the actual native owner.
    file.configuration.helperSha256 = "3".repeat(64);
    expect(
      parseStoreBenchmarkRequest(bytes(file)).configuration.helperSha256,
    ).toBe("3".repeat(64));
  });

  it.each([
    { requestId: "87654321-4321-4321-8321-210987654321" },
    { bootIdentity: "f".repeat(64) },
    { sid: "S-1-5-21-1-2-3-1001" },
    { release: "f".repeat(64) },
    { manifestSha256: "f".repeat(64) },
    { helperSha256: "not-a-digest" },
    { recipe: "cpu-vocals" },
    { warmupRuns: -1 },
    { warmupRuns: 3 },
    { measuredRuns: 2 },
    { measuredRuns: 11 },
    { measuredRuns: 3.5 },
    { groupSize: 2 },
    { saveAudio: "false" },
    { provider: "cpu" },
    { executable: "C:\\outside\\python.exe" },
    {
      fixture: {
        ...benchmarkConfig().fixture,
        relativePath: "..\\outside.wav",
      },
    },
  ])(
    "rejects stale configuration, changed quality or caller execution fields %j",
    (change) => {
      const raw = input();
      Object.assign(raw.configuration, change);
      expect(() => parseStoreBenchmarkRequest(bytes(raw))).toThrow(denied);
    },
  );
  it.each([
    {
      release: "f".repeat(64),
      manifestSha256: binding.runtimeManifestSha256,
      engineDigest: "2".repeat(64),
    },
    {
      release: binding.inventorySha256,
      manifestSha256: "f".repeat(64),
      engineDigest: "2".repeat(64),
    },
    {
      release: binding.inventorySha256,
      manifestSha256: binding.runtimeManifestSha256,
      engineDigest: "invalid",
    },
    {
      release: binding.inventorySha256,
      manifestSha256: binding.runtimeManifestSha256,
      engineDigest: "2".repeat(64),
      path: "C:\\outside",
    },
    {
      release: binding.inventorySha256,
      manifestSha256: binding.runtimeManifestSha256,
      engineDigest: "2".repeat(64),
      archiveDigest: "3".repeat(64),
    },
  ])("rejects foreign or extra candidate authority %j", (candidate) => {
    const raw = input();
    Object.assign(raw.configuration, { candidate });
    expect(() => parseStoreBenchmarkRequest(bytes(raw))).toThrow(denied);
  });
  it.each([
    { recipe: "kim-vocals-v2-trim" },
    { warmupRuns: 0 },
    { saveAudio: true },
    {
      candidate: {
        release: binding.inventorySha256,
        manifestSha256: binding.runtimeManifestSha256,
        engineDigest: "2".repeat(64),
      },
    },
    {
      fixture: {
        ...benchmarkConfig("benchmark_capacity").fixture,
        bytes: 64 * 1024 ** 2 + 1,
      },
    },
  ])("preserves capacity benchmark restrictions %j", (change) => {
    const raw = input("benchmark_capacity");
    Object.assign(raw.configuration, change);
    expect(() => parseStoreBenchmarkRequest(bytes(raw))).toThrow(denied);
  });
  it.each([
    { operation: "benchmark_capacity" },
    { version: 2 },
    { authority: "caller" },
    { binding: { ...binding, runtimeManifestSha256: "f".repeat(64) } },
    {
      binding: {
        ...binding,
        recipeDigests: { ...binding.recipeDigests, extra: "a".repeat(64) },
      },
    },
    {
      binding: {
        ...binding,
        package: { ...binding.package, signatureKind: 0 },
      },
    },
    {
      binding: { ...binding, package: { ...binding.package, current: false } },
    },
    {
      binding: {
        ...binding,
        package: { ...binding.package, architecture: "arm64" },
      },
    },
  ])(
    "rejects malformed/foreign request and package observations %j",
    (change) => {
      expect(() =>
        parseStoreBenchmarkRequest(bytes({ ...input(), ...change })),
      ).toThrow(denied);
    },
  );

  it("canonicalizes all configuration object levels, so shuffled JSON keys keep the same bytes/hash", () => {
    const raw = input(),
      normal = parseStoreBenchmarkRequest(bytes(raw));
    raw.configuration = Object.fromEntries(
      Object.entries(raw.configuration).reverse(),
    ) as AdvancedBenchmarkConfiguration;
    raw.configuration.gpu = Object.fromEntries(
      Object.entries(raw.configuration.gpu).reverse(),
    ) as AdvancedBenchmarkConfiguration["gpu"];
    raw.configuration.fixture = Object.fromEntries(
      Object.entries(raw.configuration.fixture).reverse(),
    ) as AdvancedBenchmarkConfiguration["fixture"];
    const received = parseStoreBenchmarkRequest(bytes(raw));
    expect(JSON.stringify(received.configuration)).toBe(
      JSON.stringify(normal.configuration),
    );
    expect(Object.keys(received.configuration)).toEqual([
      "bootIdentity",
      "fixture",
      "gpu",
      "helperSha256",
      "manifestSha256",
      "measuredRuns",
      "operation",
      "recipe",
      "release",
      "requestId",
      "sid",
      "version",
      "warmupRuns",
    ]);
    expect(Object.keys(received.configuration.fixture)).toEqual([
      "bytes",
      "relativePath",
      "sha256",
    ]);
    expect(Object.keys(received.configuration.gpu)).toEqual([
      "dedicatedVideoMemoryBytes",
      "deviceId",
      "deviceIndex",
      "driverVersion",
      "luid",
      "name",
      "revision",
      "sharedSystemMemoryLimitBytes",
      "source",
      "subsystemId",
      "vendorId",
    ]);
    expect(storeBenchmarkConfigurationSha256(received.configuration)).toBe(
      createHash("sha256")
        .update(JSON.stringify(normal.configuration))
        .digest("hex"),
    );
    expect(
      storeBenchmarkConfigurationSha256(
        parseStoreBenchmarkRequest(bytes(received)).configuration,
      ),
    ).toBe(storeBenchmarkConfigurationSha256(normal.configuration));
  });
  it("keeps explicit optional values in canonical configuration identity", () => {
    const raw = input();
    raw.configuration.candidate = {
      release: binding.inventorySha256,
      manifestSha256: binding.runtimeManifestSha256,
      engineDigest: "2".repeat(64),
    };
    raw.configuration.groupSize = 1;
    raw.configuration.saveAudio = false;
    const request = parseStoreBenchmarkRequest(bytes(raw));
    expect(Object.keys(request.configuration.candidate!)).toEqual([
      "engineDigest",
      "manifestSha256",
      "release",
    ]);
    expect(storeBenchmarkConfigurationSha256(request.configuration)).not.toBe(
      storeBenchmarkConfigurationSha256(benchmarkConfig()),
    );
    expect(parseStoreBenchmarkRequest(bytes(request)).configuration).toEqual(
      request.configuration,
    );
  });
  it.each(["\ud800", "\udfff", "\ufdd0", "\uffff", "\u{1fffe}"])(
    "rejects non-roundtrippable Unicode in GPU observation %j",
    (name) => {
      const raw = input();
      raw.configuration.gpu.name = name;
      expect(() => parseStoreBenchmarkRequest(bytes(raw))).toThrow(denied);
    },
  );
  it("does not invoke getters, inherited values or serialization hooks in retained expected data", () => {
    const getter = vi.fn(() => binding.inventorySha256),
      config = benchmarkConfig();
    Object.defineProperty(config, "release", { enumerable: true, get: getter });
    expect(() => storeBenchmarkConfigurationSha256(config)).toThrow(denied);
    expect(getter).not.toHaveBeenCalled();
    for (const invalid of [
      Object.assign(Object.create({ inherited: true }), benchmarkConfig()),
      { ...benchmarkConfig(), toJSON: vi.fn() },
      {
        ...benchmarkConfig(),
        gpu: Object.assign(Object.create({}), benchmarkConfig().gpu),
      },
      {
        ...benchmarkConfig(),
        fixture: Object.assign(Object.create({}), benchmarkConfig().fixture),
      },
    ])
      expect(() => storeBenchmarkConfigurationSha256(invalid)).toThrow(denied);
    const { request, launch } = fixture();
    const malformed = { ...request, binding: { ...request.binding } };
    Object.defineProperty(malformed.binding, "sid", {
      enumerable: true,
      get: getter,
    });
    expect(() => parseStoreBenchmarkLaunch(bytes(launch), malformed)).toThrow(
      denied,
    );
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects coercion-capable retained values without invoking caller methods", () => {
    for (const field of [
      "requestId",
      "operation",
      "bootIdentity",
      "helperSha256",
    ]) {
      const coercion = vi.fn(() => benchmarkConfig().helperSha256),
        config = benchmarkConfig();
      Object.assign(config, { [field]: { toString: coercion } });
      expect(() => storeBenchmarkConfigurationSha256(config)).toThrow(denied);
      expect(coercion).not.toHaveBeenCalled();
    }
    for (const nested of ["fixture", "candidate"] as const) {
      const coercion = vi.fn(() => binding.inventorySha256),
        config = benchmarkConfig();
      if (nested === "fixture")
        Object.assign(config.fixture, { sha256: { toString: coercion } });
      else
        Object.assign(config, {
          candidate: {
            release: { toString: coercion },
            manifestSha256: binding.runtimeManifestSha256,
            engineDigest: "2".repeat(64),
          },
        });
      expect(() => storeBenchmarkConfigurationSha256(config)).toThrow(denied);
      expect(coercion).not.toHaveBeenCalled();
    }
  });
  it("keeps valid Unicode and normalizes numeric JSON spellings to canonical parsed bytes", () => {
    const raw = input();
    raw.configuration.gpu.name = "GPU عربي 日本 😀";
    const request = parseStoreBenchmarkRequest(bytes(raw));
    expect(request.configuration.gpu.name).toBe(raw.configuration.gpu.name);
    const alternate = bytes(raw)
      .toString("utf8")
      .replace('"measuredRuns":3', '"measuredRuns":3e0')
      .replace('"warmupRuns":1', '"warmupRuns":1.0');
    expect(
      JSON.stringify(
        parseStoreBenchmarkRequest(Buffer.from(alternate)).configuration,
      ),
    ).toBe(JSON.stringify(request.configuration));
  });
  it("rejects malformed UTF8, BOM, escaped duplicate keys, excess JSON and oversized input", () => {
    const valid = bytes(input()).toString("utf8");
    const malformed = [
      Buffer.alloc(0),
      Buffer.from([0xc3, 0x28]),
      Buffer.from(`\ufeff${valid}`),
      Buffer.from(`${valid} {}`),
      Buffer.from(
        valid.replace('"version":1', '"version":1,"\\u0076ersion":1'),
      ),
      Buffer.from(
        valid.replace('"bytes":4000000', '"bytes":4000000,"bytes":4000000'),
      ),
      Buffer.from(`${" ".repeat(16384)}${valid}`),
      Buffer.from(JSON.stringify({ deeply: { nested: { unknown: [] } } })),
    ];
    for (const row of malformed)
      expect(() => parseStoreBenchmarkRequest(row)).toThrow(denied);
    expect(() =>
      parseStoreBenchmarkRequestCommand(Buffer.from(" ".repeat(18433))),
    ).toThrow(denied);
    const { request, launch } = fixture();
    for (const parse of [
      parseStoreBenchmarkEvent,
      parseStoreBenchmarkCleanup,
      parseStoreBenchmarkLaunchCommand,
    ])
      expect(() =>
        parse(Buffer.from(" ".repeat(4097)), request, launch),
      ).toThrow(denied);
  });
  it("rejects command/action transplantation and unknown authority fields", () => {
    const { request, launch } = fixture();
    for (const action of [
      "cpu_launch",
      "prepare_launch",
      "benchmark_wait",
      "benchmark_start",
    ])
      expect(() =>
        parseStoreBenchmarkRequestCommand(
          bytes({ version: 1, requestId: request.requestId, action, request }),
        ),
      ).toThrow(denied);
    expect(() =>
      parseStoreBenchmarkRequestCommand(
        bytes({
          version: 1,
          requestId: request.requestId,
          action: "benchmark_launch",
          request,
          launch,
        }),
      ),
    ).toThrow(denied);
    for (const action of [
      "cpu_wait",
      "prepare_wait",
      "benchmark_launch",
      "benchmark_ready",
    ])
      expect(() =>
        parseStoreBenchmarkLaunchCommand(
          bytes({ version: 1, requestId: request.requestId, action, launch }),
          request,
          launch,
        ),
      ).toThrow(denied);
  });
});

describe("original benchmark launch observations", () => {
  it.each(STORE_PREPARE_FAILURE_CODES)(
    "receives only the known failure code %s",
    (errorCode) => {
      const { request, launch } = fixture();
      expect(
        parseStoreBenchmarkEvent(
          bytes({ ...launch, state: "failed", errorCode }),
          request,
          launch,
        ),
      ).toEqual({ ...launch, state: "failed", errorCode });
    },
  );
  it("receives waiting/completed metadata and exact confirmed Job+GPU cleanup", () => {
    const { request, launch, result } = fixture();
    expect(
      parseStoreBenchmarkEvent(
        bytes({ ...launch, state: "waiting" }),
        request,
        launch,
      ),
    ).toEqual({ ...launch, state: "waiting" });
    const event = parseStoreBenchmarkEvent(
      bytes({ ...launch, state: "completed", result }),
      request,
      launch,
    );
    expect(event).toEqual({ ...launch, state: "completed", result });
    if (event.state !== "completed") throw new Error("TEST_COMPLETION_MISSING");
    expect(Object.isFrozen(event.result)).toBe(true);
    expect(Object.isFrozen(event)).toBe(true);
    const cleanup = parseStoreBenchmarkCleanup(
      bytes({ ...launch, job: "confirmed", gpu: "confirmed" }),
      request,
      launch,
    );
    expect(Object.isFrozen(cleanup)).toBe(true);
    expect(cleanup).toEqual({ ...launch, job: "confirmed", gpu: "confirmed" });
  });
  it.each([
    { owner: { ...launchInput.owner, nonce: "2".repeat(64) } },
    { owner: { ...launchInput.owner, role: "fleet" } },
    {
      owner: {
        ...launchInput.owner,
        identity: { ...launchInput.owner.identity, sid: "S-1-5-21-1-2-3-1001" },
      },
    },
    {
      owner: {
        ...launchInput.owner,
        identity: { ...launchInput.owner.identity, sessionId: 2 },
      },
    },
    {
      owner: {
        ...launchInput.owner,
        identity: { ...launchInput.owner.identity, pid: 346 },
      },
    },
    {
      owner: {
        ...launchInput.owner,
        identity: {
          ...launchInput.owner.identity,
          creationTime: "133000000000000001",
        },
      },
    },
    { inventorySha256: "f".repeat(64) },
    { requestId: "87654321-4321-4321-8321-210987654321" },
  ])(
    "rejects an independently replaced original launch %j at every subsequent boundary",
    (change) => {
      const { request, launch, result } = fixture(),
        swapped = { ...launch, ...change };
      expect(() =>
        parseStoreBenchmarkEvent(
          bytes({ ...swapped, state: "completed", result }),
          request,
          launch,
        ),
      ).toThrow(denied);
      expect(() =>
        parseStoreBenchmarkCleanup(
          bytes({ ...swapped, job: "confirmed", gpu: "confirmed" }),
          request,
          launch,
        ),
      ).toThrow(denied);
      expect(() =>
        parseStoreBenchmarkLaunchCommand(
          bytes({
            version: 1,
            requestId: request.requestId,
            action: "benchmark_cancel",
            launch: swapped,
          }),
          request,
          launch,
        ),
      ).toThrow(denied);
    },
  );
  it.each([
    { owner: { ...launchInput.owner, nonce: "invalid" } },
    {
      owner: {
        ...launchInput.owner,
        identity: { ...launchInput.owner.identity, pid: 0 },
      },
    },
    {
      owner: {
        ...launchInput.owner,
        identity: { ...launchInput.owner.identity, creationTime: "0" },
      },
    },
    {
      owner: {
        ...launchInput.owner,
        identity: { ...launchInput.owner.identity, elevated: false },
      },
    },
    { version: 2 },
    { state: "ready" },
  ])("rejects malformed initial launch %j", (change) => {
    const { request } = fixture();
    expect(() =>
      parseStoreBenchmarkLaunch(bytes({ ...launchInput, ...change }), request),
    ).toThrow(denied);
  });
  it.each([
    { configurationSha256: "f".repeat(64) },
    { rawBytes: 1 },
    { rawBytes: 8 * 1024 ** 2 + 1 },
    { rawBytes: 2.5 },
    { rawBytes: Number.MAX_SAFE_INTEGER + 1 },
    { rawSha256: "invalid" },
    { wallSeconds: 0 },
    { wallSeconds: -1 },
    { wallSeconds: 86400.1 },
    { wallSeconds: Number.POSITIVE_INFINITY },
    { wallSeconds: "12" },
    { rawPath: "C:\\outside\\report.json" },
    { ready: true },
  ])("rejects altered or unbounded result metadata %j", (change) => {
    const { request, launch } = fixture(),
      event = completed();
    Object.assign(event.result, change);
    expect(() =>
      parseStoreBenchmarkEvent(bytes(event), request, launch),
    ).toThrow(denied);
  });
  it.each([2, 8 * 1024 ** 2])(
    "accepts raw report bound %i without reading or granting report authority",
    (rawBytes) => {
      const { request, launch } = fixture(),
        event = completed();
      event.result.rawBytes = rawBytes;
      event.result.wallSeconds = rawBytes === 2 ? 0.001 : 86400;
      expect(
        parseStoreBenchmarkEvent(bytes(event), request, launch).state,
      ).toBe("completed");
    },
  );
  it("rejects unknown states/failure codes and incomplete or CPU-only cleanup", () => {
    const { request, launch } = fixture();
    for (const row of [
      { ...launch, state: "failed", errorCode: "UNTRUSTED_RUNTIME_ERROR" },
      { ...launch, state: "ready" },
      { ...launch, state: "waiting", result: {} },
      { ...launch, state: "completed" },
    ])
      expect(() =>
        parseStoreBenchmarkEvent(bytes(row), request, launch),
      ).toThrow(denied);
    for (const row of [
      { ...launch, job: "pending", gpu: "confirmed" },
      { ...launch, job: "confirmed", gpu: "not-required" },
      { ...launch, job: "confirmed" },
      { ...launch, job: "confirmed", gpu: "confirmed", ready: true },
    ])
      expect(() =>
        parseStoreBenchmarkCleanup(bytes(row), request, launch),
      ).toThrow(denied);
  });
  it("rejects a non-finite number decoded from actual JSON numeric syntax", () => {
    const { request, launch } = fixture(),
      wire = bytes(completed())
        .toString("utf8")
        .replace('"wallSeconds":12.25', '"wallSeconds":1e400');
    expect(() =>
      parseStoreBenchmarkEvent(Buffer.from(wire), request, launch),
    ).toThrow(denied);
  });
  it("revalidates supplied original requests/launches without executing their getters", () => {
    const { request, launch } = fixture(),
      getter = vi.fn(() => launch.owner.nonce),
      original = { ...launch, owner: { ...launch.owner } };
    Object.defineProperty(original.owner, "nonce", {
      enumerable: true,
      get: getter,
    });
    expect(() =>
      parseStoreBenchmarkCleanup(
        bytes({ ...launch, job: "confirmed", gpu: "confirmed" }),
        request,
        original,
      ),
    ).toThrow(denied);
    expect(getter).not.toHaveBeenCalled();
    const config = {
      ...request.configuration,
      gpu: { ...request.configuration.gpu },
    };
    Object.defineProperty(config.gpu, "name", {
      enumerable: true,
      get: getter,
    });
    expect(() => storeBenchmarkConfigurationSha256(config)).toThrow(denied);
    expect(getter).not.toHaveBeenCalled();
  });
});

it("retains the existing actual report validators and quality/GPU/model checks", () => {
  const file = fixture(),
    capacity = fixture("benchmark_capacity");
  expect(
    validateAdvancedBenchmarkReport(
      consumerRepeatedRaw(),
      file.request.configuration,
      800,
    ).status,
  ).toBe("PASS");
  expect(
    validateAdvancedBenchmarkReport(
      consumerCapacityRaw(),
      capacity.request.configuration,
      800,
    ).status,
  ).toBe("PASS");
  for (const change of [
    { fallbackDisabled: false },
    { provider: "cpu" },
    { modelDigest: "f".repeat(64) },
    { releaseManifestDigest: "f".repeat(64) },
    {
      gpuIdentity: { ...file.request.configuration.gpu, luid: "1".repeat(16) },
    },
    { recipeId: "kim-vocals-v2-trim" },
  ])
    expect(() =>
      validateAdvancedBenchmarkReport(
        { ...consumerRepeatedRaw(), ...change },
        file.request.configuration,
        800,
      ),
    ).toThrow();
});

it("receives exact original-request benchmark retirement without inventing an owner and still accepts an issued original launch", () => {
  const { request, launch } = fixture(),
    terminal = {
      version: 1,
      requestId: request.requestId,
      inventorySha256: request.binding.inventorySha256,
      state: "retired",
      job: "confirmed",
      gpu: "confirmed",
    };
  const parsed = parseStoreBenchmarkRecovery(bytes(terminal), request);
  expect(parsed).toEqual(terminal);
  expect(parsed).not.toHaveProperty("owner");
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(parseStoreBenchmarkRecovery(bytes(launch), request)).toEqual(launch);
  for (const change of [
    { requestId: "00000000-0000-4000-8000-000000000000" },
    { inventorySha256: "0".repeat(64) },
    { job: "unknown" },
    { gpu: "not-required" },
    { state: "completed" },
    { owner: launch.owner },
    { ready: true },
    { version: 2 },
  ])
    expect(() =>
      parseStoreBenchmarkRecovery(bytes({ ...terminal, ...change }), request),
    ).toThrow(denied);
  for (const raw of [
    Buffer.from("\uFEFF" + JSON.stringify(terminal)),
    Buffer.from(
      JSON.stringify(terminal).replace(
        '"version":1',
        '"version":1,"version":1',
      ),
    ),
    Buffer.alloc(4097),
  ])
    expect(() => parseStoreBenchmarkRecovery(raw, request)).toThrow(denied);
});

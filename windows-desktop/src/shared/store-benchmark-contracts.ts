import { createHash } from "node:crypto";
import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
import {
  processIdentityFromWire,
  sameConsumerProcess,
} from "../../../worker/src/platform/windows/consumer-native.js";
import {
  parseAdvancedBenchmarkConfiguration,
  type AdvancedBenchmarkConfiguration,
} from "../main/fleet/advanced/benchmark-child.js";
import {
  parseStorePreparationBinding,
  type StorePreparationBinding,
} from "../main/prepare/store-model-ready.js";
import { storeCpuFields } from "./store-cpu-operation.js";
import {
  STORE_PREPARE_FAILURE_CODES,
  type StorePrepareCleanup,
  type StorePrepareLaunch,
} from "./store-prepare-contracts.js";

/** Receiving data only. A request, launch, result digest or cleanup observation
 * never constructs a Store code owner, Prepare child, GPU lease or Ready grant. */
export interface StoreBenchmarkRequest {
  readonly version: 1;
  readonly requestId: string;
  readonly operation: AdvancedBenchmarkConfiguration["operation"];
  readonly binding: StorePreparationBinding;
  readonly configuration: AdvancedBenchmarkConfiguration;
}
export interface StoreBenchmarkRequestCommand {
  readonly version: 1;
  readonly requestId: string;
  readonly action: "benchmark_launch" | "benchmark_recover";
  readonly request: StoreBenchmarkRequest;
}
export interface StoreBenchmarkLaunchCommand {
  readonly version: 1;
  readonly requestId: string;
  readonly action: "benchmark_wait" | "benchmark_cancel";
  readonly launch: StorePrepareLaunch;
}
export interface StoreBenchmarkResult {
  readonly configurationSha256: string;
  readonly rawBytes: number;
  readonly rawSha256: string;
  readonly wallSeconds: number;
}
export type StoreBenchmarkEvent =
  | (StorePrepareLaunch & { readonly state: "waiting" })
  | (StorePrepareLaunch & {
      readonly state: "failed";
      readonly errorCode: (typeof STORE_PREPARE_FAILURE_CODES)[number];
    })
  | (StorePrepareLaunch & {
      readonly state: "completed";
      readonly result: StoreBenchmarkResult;
    });
export type StoreBenchmarkCleanup = StorePrepareCleanup;

const UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
  HASH = /^[a-f0-9]{64}$/u,
  CONFIGURATION_FIELDS = [
    "bootIdentity",
    "version",
    "operation",
    "requestId",
    "release",
    "sid",
    "manifestSha256",
    "helperSha256",
    "gpu",
    "fixture",
    "recipe",
    "warmupRuns",
    "measuredRuns",
  ] as const,
  OPTIONAL_CONFIGURATION_FIELDS = [
    "groupSize",
    "candidate",
    "saveAudio",
  ] as const,
  GPU_FIELDS = [
    "source",
    "deviceIndex",
    "name",
    "vendorId",
    "deviceId",
    "subsystemId",
    "revision",
    "driverVersion",
    "luid",
    "dedicatedVideoMemoryBytes",
    "sharedSystemMemoryLimitBytes",
  ] as const,
  LAUNCH_FIELDS = ["version", "requestId", "owner", "inventorySha256"] as const;

function deny(): never {
  throw new Error("STORE_BENCHMARK_CONTRACT_INVALID");
}
function id(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) deny();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) deny();
  return value;
}
function received(bytes: Uint8Array, maximum: number): unknown {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > maximum
  )
    deny();
  const text = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
  if (text.charCodeAt(0) === 0xfeff) deny();
  return parseStrictJson(text, maximum, 512);
}
/** Only validated JSON records reach this copier. Binary ASCII key ordering
 * agrees with native Json::Object; it does not depend on locale or input order. */
function canonical<T>(value: T): T {
  if (value && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [
            key,
            canonical((value as Record<string, unknown>)[key]),
          ]),
      ),
    ) as T;
  }
  if (typeof value === "string") {
    // Native UTF-8 JSON must not acquire a different string from a lone
    // surrogate or a non-character during a configuration round trip.
    if (/[\uD800-\uDFFF]/u.test(value)) deny();
    for (const character of value) {
      const point = character.codePointAt(0)!;
      if ((point >= 0xfdd0 && point <= 0xfdef) || (point & 0xffff) >= 0xfffe)
        deny();
    }
  }
  return value;
}
function configuration(value: unknown): AdvancedBenchmarkConfiguration {
  const optional = OPTIONAL_CONFIGURATION_FIELDS.filter((field) =>
      value && typeof value === "object" ? Object.hasOwn(value, field) : false,
    ),
    row = storeCpuFields(value, [...CONFIGURATION_FIELDS, ...optional]);
  for (const field of optional) if (row[field] === undefined) deny();
  // The legacy parser assumes data values in its regular expressions. Reject
  // coercion-capable values before calling it on a retained programmatic input.
  if (
    row.version !== 1 ||
    (row.operation !== "benchmark_file" &&
      row.operation !== "benchmark_capacity") ||
    typeof row.sid !== "string" ||
    typeof row.recipe !== "string" ||
    typeof row.warmupRuns !== "number" ||
    typeof row.measuredRuns !== "number"
  )
    deny();
  id(row.requestId);
  for (const field of [
    "bootIdentity",
    "release",
    "manifestSha256",
    "helperSha256",
  ])
    digest(row[field]);
  // Validate descriptors before the shared business parser reads any nested
  // field. No getters, inherited fields or caller serialization hooks run.
  row.fixture = storeCpuFields(row.fixture, [
    "relativePath",
    "bytes",
    "sha256",
  ]);
  row.gpu = storeCpuFields(row.gpu, GPU_FIELDS);
  const fixture = row.fixture as Record<string, unknown>;
  if (
    typeof fixture.relativePath !== "string" ||
    typeof fixture.bytes !== "number"
  )
    deny();
  digest(fixture.sha256);
  if (optional.includes("candidate")) {
    const candidate = storeCpuFields(row.candidate, [
      "release",
      "manifestSha256",
      "engineDigest",
    ]);
    for (const value of Object.values(candidate)) digest(value);
    row.candidate = candidate;
  }
  return canonical(parseAdvancedBenchmarkConfiguration(row));
}
function requestValue(value: unknown): StoreBenchmarkRequest {
  const row = storeCpuFields(value, [
      "version",
      "requestId",
      "operation",
      "binding",
      "configuration",
    ]),
    requestId = id(row.requestId),
    binding = parseStorePreparationBinding(row.binding),
    config = configuration(row.configuration);
  if (
    row.version !== 1 ||
    row.operation !== config.operation ||
    config.requestId !== requestId ||
    config.bootIdentity !== binding.bootIdentity ||
    config.sid !== binding.sid ||
    config.release !== binding.inventorySha256 ||
    config.manifestSha256 !== binding.runtimeManifestSha256 ||
    (config.candidate &&
      (config.candidate.release !== binding.inventorySha256 ||
        config.candidate.manifestSha256 !== binding.runtimeManifestSha256))
  )
    deny();
  // helperSha256 and candidate.engineDigest remain receiving pins. The actual
  // living native code owner independently compares its held code bytes.
  return Object.freeze({
    version: 1,
    requestId,
    operation: config.operation,
    binding,
    configuration: config,
  });
}
function launchValue(
  value: unknown,
  request: StoreBenchmarkRequest,
  previous?: StorePrepareLaunch,
): StorePrepareLaunch {
  const row = storeCpuFields(value, LAUNCH_FIELDS),
    owner = storeCpuFields(row.owner, ["role", "nonce", "identity"]),
    shape = storeCpuFields(owner.identity, [
      "sid",
      "sessionId",
      "pid",
      "creationTime",
    ]),
    identity = processIdentityFromWire({
      sid: shape.sid,
      session_id: shape.sessionId,
      pid: shape.pid,
      creation_time: shape.creationTime,
    });
  if (
    row.version !== 1 ||
    id(row.requestId) !== request.requestId ||
    digest(row.inventorySha256) !== request.binding.inventorySha256 ||
    owner.role !== "prepare" ||
    identity.sid !== request.binding.sid
  )
    deny();
  const result: StorePrepareLaunch = Object.freeze({
    version: 1,
    requestId: request.requestId,
    inventorySha256: request.binding.inventorySha256,
    owner: Object.freeze({
      role: "prepare",
      nonce: digest(owner.nonce),
      identity: Object.freeze(identity),
    }),
  });
  if (previous) {
    const original = launchValue(previous, request);
    if (
      result.owner.nonce !== original.owner.nonce ||
      !sameConsumerProcess(result.owner.identity, original.owner.identity)
    )
      deny();
  }
  return result;
}
function eventLaunch(row: Record<string, unknown>) {
  return {
    version: row.version,
    requestId: row.requestId,
    owner: row.owner,
    inventorySha256: row.inventorySha256,
  };
}

export function parseStoreBenchmarkRequest(
  bytes: Uint8Array,
): StoreBenchmarkRequest {
  try {
    return requestValue(received(bytes, 16384));
  } catch {
    return deny();
  }
}
export function parseStoreBenchmarkRequestCommand(
  bytes: Uint8Array,
): StoreBenchmarkRequestCommand {
  try {
    const row = storeCpuFields(received(bytes, 18432), [
      "version",
      "requestId",
      "action",
      "request",
    ]);
    if (
      row.version !== 1 ||
      (row.action !== "benchmark_launch" && row.action !== "benchmark_recover")
    )
      deny();
    const request = requestValue(row.request);
    if (id(row.requestId) !== request.requestId) deny();
    return Object.freeze({
      version: 1,
      requestId: request.requestId,
      action: row.action,
      request,
    });
  } catch {
    return deny();
  }
}
export function parseStoreBenchmarkLaunchCommand(
  bytes: Uint8Array,
  request: StoreBenchmarkRequest,
  launch: StorePrepareLaunch,
): StoreBenchmarkLaunchCommand {
  try {
    const row = storeCpuFields(received(bytes, 4096), [
      "version",
      "requestId",
      "action",
      "launch",
    ]);
    if (
      row.version !== 1 ||
      (row.action !== "benchmark_wait" && row.action !== "benchmark_cancel")
    )
      deny();
    const bound = launchValue(row.launch, requestValue(request), launch);
    if (id(row.requestId) !== bound.requestId) deny();
    return Object.freeze({
      version: 1,
      requestId: bound.requestId,
      action: row.action,
      launch: bound,
    });
  } catch {
    return deny();
  }
}
export function parseStoreBenchmarkLaunch(
  bytes: Uint8Array,
  request: StoreBenchmarkRequest,
): StorePrepareLaunch {
  try {
    return launchValue(received(bytes, 4096), requestValue(request));
  } catch {
    return deny();
  }
}
export function storeBenchmarkConfigurationSha256(
  value: AdvancedBenchmarkConfiguration,
): string {
  try {
    return createHash("sha256")
      .update(JSON.stringify(configuration(value)), "utf8")
      .digest("hex");
  } catch {
    return deny();
  }
}
export function parseStoreBenchmarkEvent(
  bytes: Uint8Array,
  request: StoreBenchmarkRequest,
  launch: StorePrepareLaunch,
): StoreBenchmarkEvent {
  try {
    const value = received(bytes, 4096),
      state =
        value && typeof value === "object"
          ? Object.getOwnPropertyDescriptor(value, "state")?.value
          : undefined;
    if (state !== "waiting" && state !== "failed" && state !== "completed")
      deny();
    const row = storeCpuFields(value, [
        ...LAUNCH_FIELDS,
        "state",
        ...(state === "failed"
          ? ["errorCode"]
          : state === "completed"
            ? ["result"]
            : []),
      ]),
      original = requestValue(request),
      base = launchValue(eventLaunch(row), original, launch);
    if (state === "waiting") return Object.freeze({ ...base, state });
    if (state === "failed") {
      const errorCode = STORE_PREPARE_FAILURE_CODES.find(
        (code) => code === row.errorCode,
      );
      if (!errorCode) deny();
      return Object.freeze({ ...base, state, errorCode });
    }
    const result = storeCpuFields(row.result, [
      "configurationSha256",
      "rawBytes",
      "rawSha256",
      "wallSeconds",
    ]);
    if (
      digest(result.configurationSha256) !==
        storeBenchmarkConfigurationSha256(original.configuration) ||
      !Number.isSafeInteger(result.rawBytes) ||
      (result.rawBytes as number) < 2 ||
      (result.rawBytes as number) > 8 * 1024 ** 2 ||
      typeof result.wallSeconds !== "number" ||
      !Number.isFinite(result.wallSeconds) ||
      result.wallSeconds <= 0 ||
      result.wallSeconds > 86400
    )
      deny();
    return Object.freeze({
      ...base,
      state,
      result: Object.freeze({
        configurationSha256: result.configurationSha256 as string,
        rawBytes: result.rawBytes as number,
        rawSha256: digest(result.rawSha256),
        wallSeconds: result.wallSeconds,
      }),
    });
  } catch {
    return deny();
  }
}
export function parseStoreBenchmarkCleanup(
  bytes: Uint8Array,
  request: StoreBenchmarkRequest,
  launch: StorePrepareLaunch,
): StoreBenchmarkCleanup {
  try {
    const row = storeCpuFields(received(bytes, 4096), [
        ...LAUNCH_FIELDS,
        "job",
        "gpu",
      ]),
      base = launchValue(eventLaunch(row), requestValue(request), launch);
    if (row.job !== "confirmed" || row.gpu !== "confirmed") deny();
    return Object.freeze({ ...base, job: "confirmed", gpu: "confirmed" });
  } catch {
    return deny();
  }
}

export interface StoreBenchmarkRetiredRequest {
  readonly version: 1;
  readonly requestId: string;
  readonly inventorySha256: string;
  readonly state: "retired";
  readonly job: "confirmed";
  readonly gpu: "confirmed";
}
/** Terminal observations from recovery of the exact private original request.
 * An unissued request has no reflected Prepare owner and grants no launch. */
export function parseStoreBenchmarkRecovery(
  bytes: Uint8Array,
  request: StoreBenchmarkRequest,
): StorePrepareLaunch | StoreBenchmarkRetiredRequest {
  try {
    const value = received(bytes, 4096),
      original = requestValue(request);
    if (!value || typeof value !== "object" || !Object.hasOwn(value, "state"))
      return launchValue(value, original);
    const row = storeCpuFields(value, [
      "version",
      "requestId",
      "inventorySha256",
      "state",
      "job",
      "gpu",
    ]);
    if (
      row.version !== 1 ||
      id(row.requestId) !== original.requestId ||
      digest(row.inventorySha256) !== original.binding.inventorySha256 ||
      row.state !== "retired" ||
      row.job !== "confirmed" ||
      row.gpu !== "confirmed"
    )
      deny();
    return Object.freeze({
      version: 1,
      requestId: original.requestId,
      inventorySha256: original.binding.inventorySha256,
      state: "retired",
      job: "confirmed",
      gpu: "confirmed",
    });
  } catch {
    return deny();
  }
}

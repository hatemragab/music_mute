import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
import {
  processIdentityFromWire,
  sameConsumerProcess,
  type ConsumerOwnedProcess,
} from "../../../worker/src/platform/windows/consumer-native.js";
import {
  storePreparationTarget,
  type StorePreparationBinding,
} from "../main/prepare/store-model-ready.js";
import type { CloudMediaChildConfig } from "../main/cloud/media-child.js";
import type { SilenceChildConfig } from "../main/player/silence-child.js";
import type { DiagnosticDoctorConfiguration } from "../main/diagnostics/doctor-child.js";
import type { BrowserYoutubeCheckConfiguration } from "../main/browser/youtube-check-child.js";
export type StoreMediaConfiguration =
  | CloudMediaChildConfig
  | SilenceChildConfig
  | DiagnosticDoctorConfiguration
  | BrowserYoutubeCheckConfiguration;
export interface StoreMediaRequest {
  readonly version: 1;
  readonly requestId: string;
  readonly binding: StorePreparationBinding;
  readonly configuration: StoreMediaConfiguration;
}
/** Private native carrier. Outer native frames retain their integer grammar;
 * decimals are decoded only inside this bounded, closed configuration. */
export interface StoreMediaNativeRequest {
  readonly version: 1;
  readonly requestId: string;
  readonly binding: StorePreparationBinding;
  readonly configuration_json: string;
}
export interface StoreMediaLaunch {
  readonly version: 1;
  readonly requestId: string;
  readonly owner: ConsumerOwnedProcess;
  readonly inventorySha256: string;
}
function deny(): never {
  throw new Error("STORE_MEDIA_REQUEST_INVALID");
}
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
function exact(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    deny();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== "string" || !fields.includes(k))
  )
    deny();
  const row: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) deny();
    row[field] = d.value;
  }
  return row;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) deny();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) deny();
  return value;
}
function received(bytes: Uint8Array, maximum: number): unknown {
  if (!bytes.byteLength || bytes.byteLength > maximum) deny();
  return parseStrictJson(
    new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes),
    maximum,
    512,
  );
}
export function storeMediaOutput(configuration: StoreMediaConfiguration) {
  const request = id(configuration.requestId);
  switch (configuration.operation) {
    case "cloud_prepare":
    case "cloud_probe":
      return Object.freeze({
        relativePath: `cloud\\work\\${request}\\media-result.json`,
        maximumBytes: 4096,
      });
    case "silence_analyze":
      return Object.freeze({
        relativePath: `prepare\\work\\${request}\\silence-map.json`,
        maximumBytes: 1024 ** 2,
      });
    case "diagnostics_doctor":
      return Object.freeze({
        relativePath: `cloud\\work\\${request}\\doctor-result.json`,
        maximumBytes: 4096,
      });
    case "browser_check_youtube":
      return Object.freeze({
        relativePath: `cloud\\work\\${request}\\youtube-check-result.json`,
        maximumBytes: 4096,
      });
    default:
      return deny();
  }
}
/** Receiving data only. A genuine Session/Node issuer independently retains
 * the current protected code and actual child/role Job authority. */
export function parseStoreMediaRequest(bytes: Uint8Array): StoreMediaRequest {
  try {
    const row = exact(received(bytes, 16384), [
        "version",
        "requestId",
        "binding",
        "configuration",
      ]),
      requestId = id(row.requestId);
    if (row.version !== 1) deny();
    const binding = exact(row.binding, [
      "package",
      "inventorySha256",
      "runtimeManifestSha256",
      "sid",
      "bootIdentity",
      "recipeDigests",
    ]) as unknown as StorePreparationBinding;
    storePreparationTarget(binding);
    const operation = Object.getOwnPropertyDescriptor(
      row.configuration as object,
      "operation",
    )?.value;
    const base = [
      "version",
      "operation",
      "requestId",
      "executionId",
      "release",
      "sid",
      "manifestSha256",
      "helperSha256",
    ];
    const cloud = operation === "cloud_prepare" || operation === "cloud_probe",
      silence = operation === "silence_analyze";
    if (
      !cloud &&
      !silence &&
      operation !== "diagnostics_doctor" &&
      operation !== "browser_check_youtube"
    )
      deny();
    const config = exact(row.configuration, [
      ...base,
      ...(cloud
        ? ["inputBytes"]
        : silence
          ? ["inputBytes", "inputSha256", "durationSeconds"]
          : []),
    ]);
    if (
      config.version !== 1 ||
      id(config.requestId) !== requestId ||
      !id(config.executionId) ||
      digest(config.release) !== binding.inventorySha256 ||
      digest(config.manifestSha256) !== binding.runtimeManifestSha256 ||
      config.sid !== binding.sid ||
      !digest(config.helperSha256)
    )
      deny();
    if (
      (cloud || silence) &&
      (!Number.isSafeInteger(config.inputBytes) ||
        (config.inputBytes as number) < 1 ||
        (config.inputBytes as number) > 256 * 1024 ** 2)
    )
      deny();
    if (
      silence &&
      (!digest(config.inputSha256) ||
        typeof config.durationSeconds !== "number" ||
        !Number.isFinite(config.durationSeconds) ||
        config.durationSeconds <= 0 ||
        config.durationSeconds > 7200)
    )
      deny();
    return Object.freeze({
      version: 1,
      requestId,
      binding: Object.freeze({
        ...binding,
        package: Object.freeze({ ...binding.package }),
        recipeDigests: Object.freeze({ ...binding.recipeDigests }),
      }),
      configuration: Object.freeze({
        ...config,
      }) as unknown as StoreMediaConfiguration,
    });
  } catch {
    return deny();
  }
}
export function storeMediaNativeRequest(
  request: StoreMediaRequest,
): StoreMediaNativeRequest {
  const original = parseStoreMediaRequest(Buffer.from(JSON.stringify(request))),
    configuration_json = JSON.stringify(original.configuration);
  if (Buffer.byteLength(configuration_json, "utf8") > 8192) deny();
  return Object.freeze({
    version: 1,
    requestId: original.requestId,
    binding: original.binding,
    configuration_json,
  });
}
export function parseStoreMediaNativeRequest(
  value: unknown,
): StoreMediaRequest {
  try {
    const row = exact(value, [
      "version",
      "requestId",
      "binding",
      "configuration_json",
    ]);
    if (typeof row.configuration_json !== "string") deny();
    const configuration = received(Buffer.from(row.configuration_json), 8192);
    return parseStoreMediaRequest(
      Buffer.from(
        JSON.stringify({
          version: row.version,
          requestId: row.requestId,
          binding: row.binding,
          configuration,
        }),
      ),
    );
  } catch {
    return deny();
  }
}
function launchRow(
  value: unknown,
  request: StoreMediaRequest,
  previous?: StoreMediaLaunch,
): StoreMediaLaunch {
  const row = exact(value, [
      "version",
      "requestId",
      "owner",
      "inventorySha256",
    ]),
    owner = exact(row.owner, ["role", "nonce", "identity"]);
  const shape = exact(owner.identity, [
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
  const result: StoreMediaLaunch = Object.freeze({
    version: 1,
    requestId: request.requestId,
    inventorySha256: request.binding.inventorySha256,
    owner: Object.freeze({
      role: "prepare",
      nonce: digest(owner.nonce),
      identity: Object.freeze(identity),
    }),
  });
  if (
    previous &&
    (previous.requestId !== result.requestId ||
      previous.inventorySha256 !== result.inventorySha256 ||
      previous.owner.nonce !== result.owner.nonce ||
      !sameConsumerProcess(previous.owner.identity, result.owner.identity))
  )
    deny();
  return result;
}
export function parseStoreMediaLaunch(
  bytes: Uint8Array,
  request: StoreMediaRequest,
): StoreMediaLaunch {
  try {
    return launchRow(received(bytes, 4096), request);
  } catch {
    return deny();
  }
}
export function parseStoreMediaEvent(
  bytes: Uint8Array,
  request: StoreMediaRequest,
  launch: StoreMediaLaunch,
) {
  try {
    const value = received(bytes, 4096),
      tag = Object.getOwnPropertyDescriptor(value as object, "state")?.value;
    const complete = tag === "completed";
    if (!complete && tag !== "waiting") deny();
    const row = exact(value, [
      "version",
      "requestId",
      "owner",
      "inventorySha256",
      "state",
      ...(complete ? ["result"] : []),
    ]);
    const base = launchRow(
      {
        version: row.version,
        requestId: row.requestId,
        owner: row.owner,
        inventorySha256: row.inventorySha256,
      },
      request,
      launch,
    );
    if (!complete) return { ...base, state: "waiting" as const };
    const summary = exact(row.result, ["relativePath", "bytes", "sha256"]),
      output = storeMediaOutput(request.configuration);
    if (
      summary.relativePath !== output.relativePath ||
      !Number.isSafeInteger(summary.bytes) ||
      (summary.bytes as number) < 2 ||
      (summary.bytes as number) > output.maximumBytes
    )
      deny();
    return {
      ...base,
      state: "completed" as const,
      result: Object.freeze({
        relativePath: output.relativePath,
        bytes: summary.bytes as number,
        sha256: digest(summary.sha256),
      }),
    };
  } catch {
    return deny();
  }
}
export function parseStoreMediaCleanup(
  bytes: Uint8Array,
  request: StoreMediaRequest,
  launch: StoreMediaLaunch,
) {
  try {
    const row = exact(received(bytes, 4096), [
      "version",
      "requestId",
      "owner",
      "inventorySha256",
      "job",
      "gpu",
    ]);
    const base = launchRow(
      {
        version: row.version,
        requestId: row.requestId,
        owner: row.owner,
        inventorySha256: row.inventorySha256,
      },
      request,
      launch,
    );
    if (row.job !== "confirmed" || row.gpu !== "not-required") deny();
    return Object.freeze({
      ...base,
      job: "confirmed" as const,
      gpu: "not-required" as const,
    });
  } catch {
    return deny();
  }
}

import { createHash } from "node:crypto";
import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
import { sameConsumerProcess } from "../../../worker/src/platform/windows/consumer-native.js";
import {
  parseStoreCpuOperationExpectation,
  storeCpuFields,
  type StoreCpuOperationExpectation,
} from "./store-cpu-operation.js";
import {
  parseStoreMediaCleanup,
  parseStoreMediaEvent,
  parseStoreMediaLaunch,
  parseStoreMediaRequest,
  type StoreMediaLaunch,
  type StoreMediaRequest,
} from "./store-media-request.js";
import { STORE_PREPARE_FAILURE_CODES } from "./store-prepare-contracts.js";

/** Receiving data only. Commands and observations never construct a private
 * Creator operation, code owner, child Job or workspace retirement authority. */
export interface StoreGuiCpuRequestCommand {
  readonly version: 1;
  readonly requestId: string;
  readonly action: "cpu_launch" | "cpu_recover";
  readonly request: StoreMediaRequest;
}
export interface StoreGuiCpuLaunchCommand {
  readonly version: 1;
  readonly requestId: string;
  readonly action: "cpu_ready" | "cpu_start" | "cpu_wait" | "cpu_cancel";
  readonly launch: StoreMediaLaunch;
}
export type StoreGuiCpuCommand =
  StoreGuiCpuRequestCommand | StoreGuiCpuLaunchCommand;
export type StoreGuiCpuReadyEvent =
  | (StoreMediaLaunch & { readonly state: "waiting" })
  | (StoreMediaLaunch & {
      readonly state: "ready";
      readonly expectation: StoreCpuOperationExpectation;
    });
export interface StoreGuiCpuFailedEvent extends StoreMediaLaunch {
  readonly state: "failed";
  readonly errorCode: (typeof STORE_PREPARE_FAILURE_CODES)[number];
}
export interface StoreGuiCpuStartAck extends StoreMediaLaunch {
  readonly started: true;
}
export type StoreGuiCpuWaitEvent =
  ReturnType<typeof parseStoreMediaEvent> | StoreGuiCpuFailedEvent;
export type StoreGuiCpuCleanup = ReturnType<typeof parseStoreMediaCleanup>;
/** A terminal original-request cleanup observation, with no Node owner or
 * launch capability. Native must independently retire any partially born Job. */
export interface StoreGuiCpuRetiredRecovery {
  readonly version: 1;
  readonly requestId: string;
  readonly inventorySha256: string;
  readonly state: "retired";
  readonly job: "confirmed";
  readonly gpu: "not-required";
}
export type StoreGuiCpuRecovery = StoreMediaLaunch | StoreGuiCpuRetiredRecovery;

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
function deny(): never {
  throw new Error("STORE_GUI_CPU_CONTRACT_INVALID");
}
function requestId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) deny();
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
function bytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value));
}
function originalRequest(request: StoreMediaRequest): StoreMediaRequest {
  return parseStoreMediaRequest(bytes(request));
}
function boundLaunch(
  value: unknown,
  request: StoreMediaRequest,
  launch: StoreMediaLaunch,
): StoreMediaLaunch {
  const candidate = parseStoreMediaLaunch(bytes(value), request),
    original = parseStoreMediaLaunch(bytes(launch), request);
  // Reuse the existing event boundary to require the original prepare owner,
  // including its nonce, SID/session, PID and process creation time.
  const event = parseStoreMediaEvent(
    bytes({ ...candidate, state: "waiting" }),
    request,
    original,
  );
  return Object.freeze({
    version: event.version,
    requestId: event.requestId,
    inventorySha256: event.inventorySha256,
    owner: event.owner,
  });
}
function eventLaunch(row: Record<string, unknown>) {
  return {
    version: row.version,
    requestId: row.requestId,
    owner: row.owner,
    inventorySha256: row.inventorySha256,
  };
}

export function parseStoreGuiCpuRequestCommand(
  input: Uint8Array,
): StoreGuiCpuRequestCommand {
  try {
    const row = storeCpuFields(received(input, 18432), [
      "version",
      "requestId",
      "action",
      "request",
    ]);
    if (
      row.version !== 1 ||
      (row.action !== "cpu_launch" && row.action !== "cpu_recover")
    )
      deny();
    return Object.freeze({
      version: 1,
      requestId: requestId(row.requestId),
      action: row.action,
      request: parseStoreMediaRequest(bytes(row.request)),
    });
  } catch {
    return deny();
  }
}

export function parseStoreGuiCpuRecovery(
  input: Uint8Array,
  request: StoreMediaRequest,
): StoreGuiCpuRecovery {
  try {
    const value = received(input, 4096),
      original = originalRequest(request),
      state = Object.getOwnPropertyDescriptor(value as object, "state")?.value;
    if (state !== "retired")
      return parseStoreMediaLaunch(bytes(value), original);
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
      requestId(row.requestId) !== original.requestId ||
      row.inventorySha256 !== original.binding.inventorySha256 ||
      row.job !== "confirmed" ||
      row.gpu !== "not-required"
    )
      deny();
    return Object.freeze({
      version: 1,
      requestId: original.requestId,
      inventorySha256: original.binding.inventorySha256,
      state: "retired",
      job: "confirmed",
      gpu: "not-required",
    });
  } catch {
    return deny();
  }
}

export function parseStoreGuiCpuLaunchCommand(
  input: Uint8Array,
  request: StoreMediaRequest,
  launch: StoreMediaLaunch,
): StoreGuiCpuLaunchCommand {
  try {
    const row = storeCpuFields(received(input, 4096), [
      "version",
      "requestId",
      "action",
      "launch",
    ]);
    if (
      row.version !== 1 ||
      (row.action !== "cpu_ready" &&
        row.action !== "cpu_start" &&
        row.action !== "cpu_wait" &&
        row.action !== "cpu_cancel")
    )
      deny();
    return Object.freeze({
      version: 1,
      requestId: requestId(row.requestId),
      action: row.action,
      launch: boundLaunch(row.launch, originalRequest(request), launch),
    });
  } catch {
    return deny();
  }
}

export function parseStoreGuiCpuReadyEvent(
  input: Uint8Array,
  request: StoreMediaRequest,
  launch: StoreMediaLaunch,
): StoreGuiCpuReadyEvent {
  try {
    const value = received(input, 4096),
      state = Object.getOwnPropertyDescriptor(value as object, "state")?.value;
    if (state !== "waiting" && state !== "ready") deny();
    const row = storeCpuFields(value, [
        "version",
        "requestId",
        "owner",
        "inventorySha256",
        "state",
        ...(state === "ready" ? ["expectation"] : []),
      ]),
      original = originalRequest(request),
      base = boundLaunch(eventLaunch(row), original, launch);
    if (state === "waiting")
      return Object.freeze({ ...base, state: "waiting" });
    const expectation = parseStoreCpuOperationExpectation(
        row.expectation,
        original.binding.sid,
      ),
      configurationSha256 = createHash("sha256")
        .update(JSON.stringify(original.configuration))
        .digest("hex");
    if (
      expectation.requestId !== original.requestId ||
      expectation.operation !== original.configuration.operation ||
      expectation.inventorySha256 !== original.binding.inventorySha256 ||
      expectation.runtimeManifestSha256 !==
        original.binding.runtimeManifestSha256 ||
      expectation.configurationSha256 !== configurationSha256 ||
      expectation.nodeOwner.role !== "prepare" ||
      expectation.nodeOwner.nonce !== base.owner.nonce ||
      !sameConsumerProcess(expectation.nodeOwner.identity, base.owner.identity)
    )
      deny();
    return Object.freeze({ ...base, state: "ready", expectation });
  } catch {
    return deny();
  }
}

export function parseStoreGuiCpuWaitEvent(
  input: Uint8Array,
  request: StoreMediaRequest,
  launch: StoreMediaLaunch,
): StoreGuiCpuWaitEvent {
  try {
    const value = received(input, 4096),
      state = Object.getOwnPropertyDescriptor(value as object, "state")?.value,
      original = originalRequest(request);
    if (state !== "failed")
      return Object.freeze(parseStoreMediaEvent(input, original, launch));
    const row = storeCpuFields(value, [
      "version",
      "requestId",
      "owner",
      "inventorySha256",
      "state",
      "errorCode",
    ]);
    const errorCode = STORE_PREPARE_FAILURE_CODES.find(
      (code) => code === row.errorCode,
    );
    if (!errorCode) deny();
    return Object.freeze({
      ...boundLaunch(eventLaunch(row), original, launch),
      state: "failed",
      errorCode,
    });
  } catch {
    return deny();
  }
}

export function parseStoreGuiCpuStartAck(
  input: Uint8Array,
  request: StoreMediaRequest,
  launch: StoreMediaLaunch,
): StoreGuiCpuStartAck {
  try {
    const row = storeCpuFields(received(input, 4096), [
      "version",
      "requestId",
      "owner",
      "inventorySha256",
      "started",
    ]);
    if (row.started !== true) deny();
    return Object.freeze({
      ...boundLaunch(eventLaunch(row), originalRequest(request), launch),
      started: true,
    });
  } catch {
    return deny();
  }
}

export function parseStoreGuiCpuCleanup(
  input: Uint8Array,
  request: StoreMediaRequest,
  launch: StoreMediaLaunch,
): StoreGuiCpuCleanup {
  try {
    // CPU-only cleanup never claims retirement of the logged-in GPU model.
    return parseStoreMediaCleanup(input, originalRequest(request), launch);
  } catch {
    return deny();
  }
}

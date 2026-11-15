import { MODEL } from "../../../chrome-extension/src/shared/local-model.js";
import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
import { WORKER_RECIPE_IDS } from "../../../worker/protocol/v1/protocol.js";
import {
  parseDirectmlGpuIdentity,
  parseQualificationEvidence,
  resolveQualifiedGpuIdentity,
  type QualificationEvidence,
} from "../../../worker/src/enrollment/report-builder.js";
import {
  processIdentityFromWire,
  processIdentityToWire,
  sameConsumerProcess,
  type ConsumerOwnedProcess,
  type ConsumerGpuIdentity,
  type ConsumerProcessIdentity,
} from "../../../worker/src/platform/windows/consumer-native.js";
import { WINDOWS_CONSUMER_PINS } from "../../../worker/src/platform/windows/consumer-pins.js";
import {
  storePreparationTarget,
  type StorePreparationBinding,
} from "../main/prepare/store-model-ready.js";
import { PREPARATION_FIXTURE } from "../main/prepare/fixture.js";
import type { PrepareErrorCode } from "./prepare-contracts.js";
import type {
  StoreControlCommand,
  StoreControlAck,
} from "./store-control-contracts.js";

export const STORE_PREPARE_FAILURE_CODES = [
  "GPU_UNSUPPORTED",
  "INTEGRITY_INVALID",
  "PERMISSION_DENIED",
  "BUSY",
  "PREPARE_INTERRUPTED",
  "OPERATION_FAILED",
  "NATIVE_HELPER_UNAVAILABLE",
] as const satisfies readonly PrepareErrorCode[];

/** Receiving contracts only. These values never mint Store code, role, GPU,
 * model readiness or cleanup authority; production uses the living session. */
export type StorePrepareFixture =
  | { readonly kind: "fixed" }
  | {
      readonly kind: "approved";
      readonly relativePath: string;
      readonly sha256: string;
      readonly bytes: number;
    };
export interface StorePrepareLaunchRequest {
  readonly version: 1;
  readonly requestId: string;
  readonly operation: "qualify" | "inspect";
  readonly binding: StorePreparationBinding;
  readonly gpu: ConsumerGpuIdentity;
  readonly fixture: StorePrepareFixture;
}
export interface StorePrepareLaunch {
  readonly version: 1;
  readonly requestId: string;
  readonly owner: ConsumerOwnedProcess;
  readonly inventorySha256: string;
}
export interface StorePrepareResult extends StorePrepareLaunch {
  readonly operation: "qualify" | "inspect";
  readonly bootIdentity: string;
  readonly raw: unknown;
}
export interface StorePrepareCleanup extends StorePrepareLaunch {
  readonly job: "confirmed";
  readonly gpu: "confirmed";
}
const HASH = /^[a-f0-9]{64}$/u,
  UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
function deny(): never {
  throw new Error("STORE_PREPARE_CONTRACT_DENIED");
}
function exact(
  value: unknown,
  names: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny();
  const proto = Object.getPrototypeOf(value),
    keys = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value),
    out: Record<string, unknown> = Object.create(null);
  if (
    (proto !== Object.prototype && proto !== null) ||
    keys.length !== names.length ||
    keys.some((key) => typeof key !== "string" || !names.includes(key))
  )
    deny();
  for (const name of names) {
    const d = descriptors[name];
    if (!d?.enumerable || !("value" in d)) deny();
    out[name] = d.value;
  }
  return out;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) deny();
  return value;
}
function requestId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) deny();
  return value;
}
function received(bytes: Uint8Array, maximum: number): unknown {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 1 ||
    bytes.length > maximum
  )
    deny();
  const text = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
  if (text.charCodeAt(0) === 0xfeff) deny();
  return parseStrictJson(text, maximum, 2048);
}
function fixture(value: unknown): StorePrepareFixture {
  const head =
    value && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "kind")
      : undefined;
  if (!head || !("value" in head)) deny();
  if (head.value === "fixed") {
    exact(value, ["kind"]);
    return Object.freeze({ kind: "fixed" });
  }
  const row = exact(value, ["kind", "relativePath", "sha256", "bytes"]),
    sha256 = digest(row.sha256);
  if (
    row.kind !== "approved" ||
    row.relativePath !== `prepare\\approved\\${sha256}.wav` ||
    !Number.isSafeInteger(row.bytes) ||
    (row.bytes as number) < 44 ||
    (row.bytes as number) > 64 * 1024 ** 2
  )
    deny();
  return Object.freeze({
    kind: "approved",
    relativePath: row.relativePath as string,
    sha256,
    bytes: row.bytes as number,
  });
}
export function parseStorePrepareLaunch(
  bytes: Uint8Array,
): StorePrepareLaunchRequest {
  try {
    const row = exact(received(bytes, 8192), [
      "version",
      "requestId",
      "operation",
      "binding",
      "gpu",
      "fixture",
    ]);
    if (
      row.version !== 1 ||
      (row.operation !== "qualify" && row.operation !== "inspect")
    )
      deny();
    const bindingRow = exact(row.binding, [
      "package",
      "inventorySha256",
      "runtimeManifestSha256",
      "sid",
      "bootIdentity",
      "recipeDigests",
    ]);
    // Shared model receiving policy validates all package/current-generation,
    // SID, digest and both unchanged recipe fields, without granting Ready.
    const observed = bindingRow as unknown as StorePreparationBinding;
    storePreparationTarget(observed);
    const binding = Object.freeze({
      ...observed,
      package: Object.freeze({ ...observed.package }),
      recipeDigests: Object.freeze({ ...observed.recipeDigests }),
    });
    const gpu = Object.freeze(parseDirectmlGpuIdentity(row.gpu));
    return Object.freeze({
      version: 1,
      requestId: requestId(row.requestId),
      operation: row.operation,
      binding,
      gpu,
      fixture: fixture(row.fixture),
    });
  } catch {
    return deny();
  }
}
function owner(
  value: unknown,
  expected: StorePrepareLaunchRequest,
): ConsumerOwnedProcess {
  const row = exact(value, ["role", "nonce", "identity"]),
    observedIdentity = exact(row.identity, [
      "sid",
      "sessionId",
      "pid",
      "creationTime",
    ]),
    identity = processIdentityFromWire(
      processIdentityToWire(
        observedIdentity as unknown as ConsumerProcessIdentity,
      ),
    );
  if (row.role !== "prepare" || identity.sid !== expected.binding.sid) deny();
  return Object.freeze({
    role: "prepare",
    nonce: digest(row.nonce),
    identity: Object.freeze(identity),
  });
}
function launchRow(
  row: Record<string, unknown>,
  expected: StorePrepareLaunchRequest,
  launched?: StorePrepareLaunch,
): StorePrepareLaunch {
  if (
    row.version !== 1 ||
    requestId(row.requestId) !== expected.requestId ||
    digest(row.inventorySha256) !== expected.binding.inventorySha256
  )
    deny();
  const child = owner(row.owner, expected);
  if (
    launched &&
    (child.nonce !== launched.owner.nonce ||
      !sameConsumerProcess(child.identity, launched.owner.identity) ||
      launched.requestId !== expected.requestId ||
      launched.inventorySha256 !== expected.binding.inventorySha256)
  )
    deny();
  return Object.freeze({
    version: 1,
    requestId: expected.requestId,
    owner: child,
    inventorySha256: expected.binding.inventorySha256,
  });
}
export function parseStorePrepareLaunchResult(
  bytes: Uint8Array,
  expected: StorePrepareLaunchRequest,
): StorePrepareLaunch {
  try {
    return launchRow(
      exact(received(bytes, 4096), [
        "version",
        "requestId",
        "owner",
        "inventorySha256",
      ]),
      expected,
    );
  } catch {
    return deny();
  }
}
export function parseStorePrepareResult(
  bytes: Uint8Array,
  expected: StorePrepareLaunchRequest,
  launched: StorePrepareLaunch,
): { result: StorePrepareResult; evidence?: QualificationEvidence } {
  try {
    const row = exact(received(bytes, 32768), [
        "version",
        "requestId",
        "owner",
        "inventorySha256",
        "operation",
        "bootIdentity",
        "raw",
      ]),
      base = launchRow(row, expected, launched);
    if (
      row.operation !== expected.operation ||
      digest(row.bootIdentity) !== expected.binding.bootIdentity
    )
      deny();
    let evidence: QualificationEvidence | undefined;
    if (expected.operation === "qualify") {
      evidence = parseQualificationEvidence(row.raw, {
        runtimeProfile: "windows-user",
        expectedUserSid: expected.binding.sid,
        expectedFixtureDigest:
          expected.fixture.kind === "approved"
            ? expected.fixture.sha256
            : PREPARATION_FIXTURE.sha256,
      });
      if (
        evidence.releaseManifestDigest !==
          expected.binding.runtimeManifestSha256 ||
        evidence.modelDigest !== MODEL.sha256 ||
        evidence.runtimeDiagnostics?.onnxRuntime !==
          WINDOWS_CONSUMER_PINS.onnxRuntime ||
        WORKER_RECIPE_IDS.some(
          (id) =>
            evidence!.recipeDigests[id] !== expected.binding.recipeDigests[id],
        ) ||
        !evidence.gpuIdentity
      )
        deny();
      resolveQualifiedGpuIdentity(expected.gpu, [evidence.gpuIdentity]);
    } else {
      const inspection = exact(row.raw, ["version", "sid", "gpus"]);
      if (
        inspection.version !== 1 ||
        inspection.sid !== expected.binding.sid ||
        !Array.isArray(inspection.gpus) ||
        inspection.gpus.length < 1 ||
        inspection.gpus.length > 16
      )
        deny();
      const gpus = inspection.gpus.map(parseDirectmlGpuIdentity);
      if (
        new Set(gpus.map((g) => g.luid)).size !== gpus.length ||
        new Set(gpus.map((g) => g.deviceIndex)).size !== gpus.length
      )
        deny();
      resolveQualifiedGpuIdentity(expected.gpu, gpus);
    }
    return {
      result: Object.freeze({
        ...base,
        operation: expected.operation,
        bootIdentity: expected.binding.bootIdentity,
        raw: row.raw,
      }),
      ...(evidence ? { evidence } : {}),
    };
  } catch {
    return deny();
  }
}
export function parseStorePrepareCleanup(
  bytes: Uint8Array,
  expected: StorePrepareLaunchRequest,
  launched: StorePrepareLaunch,
): StorePrepareCleanup {
  try {
    const row = exact(received(bytes, 4096), [
        "version",
        "requestId",
        "owner",
        "inventorySha256",
        "job",
        "gpu",
      ]),
      base = launchRow(row, expected, launched);
    if (row.job !== "confirmed" || row.gpu !== "confirmed") deny();
    return Object.freeze({ ...base, job: "confirmed", gpu: "confirmed" });
  } catch {
    return deny();
  }
}

export type StoreSessionCommand =
  | StoreControlCommand
  | StoreControlAck
  | ({
      readonly version: 1;
      readonly requestId: string;
    } & (
      | {
          readonly action: "prepare_launch" | "prepare_recover";
          readonly request: StorePrepareLaunchRequest;
        }
      | {
          readonly action: "prepare_wait" | "prepare_cancel";
          readonly launch: StorePrepareLaunch;
        }
    ));
export interface StoreSessionObservation {
  readonly version: 1;
  readonly owner: ConsumerOwnedProcess;
  readonly creator: ConsumerProcessIdentity;
  readonly inventorySha256: string;
}
export function parseStoreSessionObservation(
  bytes: Uint8Array,
  binding: StorePreparationBinding,
  sessionId: number,
): StoreSessionObservation {
  try {
    const row = exact(received(bytes, 4096), [
        "version",
        "owner",
        "creator",
        "inventorySha256",
      ]),
      child = exact(row.owner, ["role", "nonce", "identity"]);
    if (
      row.version !== 1 ||
      child.role !== "session-agent" ||
      digest(row.inventorySha256) !== binding.inventorySha256
    )
      deny();
    const identity = processIdentityFromWire(
        processIdentityToWire(
          exact(child.identity, [
            "sid",
            "sessionId",
            "pid",
            "creationTime",
          ]) as unknown as ConsumerProcessIdentity,
        ),
      ),
      creator = processIdentityFromWire(
        processIdentityToWire(
          exact(row.creator, [
            "sid",
            "sessionId",
            "pid",
            "creationTime",
          ]) as unknown as ConsumerProcessIdentity,
        ),
      );
    if (
      [identity, creator].some(
        (p) => p.sid !== binding.sid || p.sessionId !== sessionId,
      ) ||
      sameConsumerProcess(identity, creator)
    )
      deny();
    return Object.freeze({
      version: 1,
      owner: Object.freeze({
        role: "session-agent",
        nonce: digest(child.nonce),
        identity: Object.freeze(identity),
      }),
      creator: Object.freeze(creator),
      inventorySha256: binding.inventorySha256,
    });
  } catch {
    return deny();
  }
}
export function parseStorePrepareEvent(
  bytes: Uint8Array,
  expected: StorePrepareLaunchRequest,
  launched: StorePrepareLaunch,
) {
  try {
    const value = received(bytes, 32768),
      tag =
        value && typeof value === "object"
          ? Object.getOwnPropertyDescriptor(value, "state")
          : undefined;
    if (!tag || !("value" in tag)) deny();
    const complete = tag.value === "completed",
      failed = tag.value === "failed",
      row = exact(value, [
        "version",
        "requestId",
        "owner",
        "inventorySha256",
        "state",
        ...(complete ? ["result"] : []),
        ...(failed ? ["errorCode"] : []),
      ]),
      base = launchRow(row, expected, launched);
    if (failed) {
      if (
        typeof row.errorCode !== "string" ||
        !STORE_PREPARE_FAILURE_CODES.some((code) => code === row.errorCode)
      )
        deny();
      return {
        ...base,
        state: "failed" as const,
        errorCode:
          row.errorCode as (typeof STORE_PREPARE_FAILURE_CODES)[number],
      };
    }
    if (!complete && tag.value !== "waiting") deny();
    return complete
      ? {
          ...base,
          state: "completed" as const,
          ...parseStorePrepareResult(
            Buffer.from(JSON.stringify(row.result)),
            expected,
            launched,
          ),
        }
      : { ...base, state: "waiting" as const };
  } catch {
    return deny();
  }
}

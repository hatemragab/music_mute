import {
  ConsumerNativeError,
  processIdentityFromWire,
  type ConsumerOwnedProcess,
} from "./consumer-native-policy.js";

export const STORE_CPU_OPERATIONS = [
  "cloud_prepare",
  "cloud_probe",
  "silence_analyze",
  "diagnostics_doctor",
  "browser_check_youtube",
] as const;
export type StoreCpuOperationKind = (typeof STORE_CPU_OPERATIONS)[number];
/** Receiving observations only. This record does not construct a private
 * Creator operation, child Job, code owner or workspace retirement authority. */
export interface StoreCpuOperationExpectation {
  readonly version: 1;
  readonly distribution: "microsoft-store";
  readonly kind: "cpu-tools";
  readonly requestId: string;
  readonly incarnation: string;
  readonly operation: StoreCpuOperationKind;
  readonly configurationSha256: string;
  readonly inventorySha256: string;
  readonly runtimeManifestSha256: string;
  readonly nodeOwner: ConsumerOwnedProcess;
  readonly token: string;
}
function fail(): never {
  throw new ConsumerNativeError("PROTOCOL_MISMATCH");
}
function exact(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    fail();
  const keys = Reflect.ownKeys(input),
    descriptors = Object.getOwnPropertyDescriptors(input),
    row: Record<string, unknown> = Object.create(null);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    fail();
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor?.enumerable || !("value" in descriptor)) fail();
    row[field] = descriptor.value;
  }
  return row;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail();
  return value;
}
function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      value,
    )
  )
    fail();
  return value;
}
export function parseStoreCpuOperationExpectation(
  input: unknown,
): StoreCpuOperationExpectation {
  const row = exact(input, [
      "version",
      "distribution",
      "kind",
      "requestId",
      "incarnation",
      "operation",
      "configurationSha256",
      "inventorySha256",
      "runtimeManifestSha256",
      "nodeOwner",
      "token",
    ]),
    owner = exact(row.nodeOwner, ["role", "nonce", "identity"]),
    identity = exact(owner.identity, [
      "sid",
      "sessionId",
      "pid",
      "creationTime",
    ]);
  if (
    row.version !== 1 ||
    row.distribution !== "microsoft-store" ||
    row.kind !== "cpu-tools" ||
    typeof row.operation !== "string" ||
    !STORE_CPU_OPERATIONS.some((operation) => operation === row.operation) ||
    (owner.role !== "personal" && owner.role !== "prepare")
  )
    fail();
  return Object.freeze({
    version: 1,
    distribution: "microsoft-store",
    kind: "cpu-tools",
    requestId: uuid(row.requestId),
    incarnation: uuid(row.incarnation),
    operation: row.operation as StoreCpuOperationKind,
    configurationSha256: digest(row.configurationSha256),
    inventorySha256: digest(row.inventorySha256),
    runtimeManifestSha256: digest(row.runtimeManifestSha256),
    nodeOwner: Object.freeze({
      role: owner.role,
      nonce: digest(owner.nonce),
      identity: Object.freeze(
        processIdentityFromWire({
          sid: identity.sid,
          session_id: identity.sessionId,
          pid: identity.pid,
          creation_time: identity.creationTime,
        }),
      ),
    }),
    token: digest(row.token),
  });
}

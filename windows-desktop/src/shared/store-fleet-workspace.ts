import {
  processIdentityFromWire,
  type ConsumerOwnedProcess,
} from "../../../worker/src/platform/windows/consumer-native.js";
import { storeCpuFields } from "./store-cpu-operation.js";

/** Original-row observations only. A token, directory birth or quiescent flag
 * cannot create a native lease, certify a Job, delete a directory or grant GPU. */
export interface StoreFleetAttemptExpectation {
  readonly version: 1;
  readonly distribution: "microsoft-store";
  readonly kind: "fleet-attempt";
  readonly attemptId: string;
  readonly token: string;
  readonly inventorySha256: string;
  readonly runtimeManifestSha256: string;
  readonly nodeOwner: Readonly<ConsumerOwnedProcess> & {
    readonly role: "fleet";
  };
  readonly directoryBirth: Readonly<{
    device: string;
    file_id: string;
    born_at: string;
  }>;
}
const HASH = /^[a-f0-9]{64}$/u,
  UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
  DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/u,
  UINT64_MAX = (1n << 64n) - 1n;
function denied(): never {
  throw new Error("STORE_FLEET_WORKSPACE_INVALID");
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) denied();
  return value;
}
function decimal(value: unknown): string {
  if (
    typeof value !== "string" ||
    !DECIMAL.test(value) ||
    BigInt(value) > UINT64_MAX
  )
    denied();
  return value;
}
export function parseStoreFleetAttemptExpectation(
  value: unknown,
): StoreFleetAttemptExpectation {
  try {
    const row = storeCpuFields(value, [
        "version",
        "distribution",
        "kind",
        "attemptId",
        "token",
        "inventorySha256",
        "runtimeManifestSha256",
        "nodeOwner",
        "directoryBirth",
      ]),
      owner = storeCpuFields(row.nodeOwner, ["role", "nonce", "identity"]),
      identity = storeCpuFields(owner.identity, [
        "sid",
        "sessionId",
        "pid",
        "creationTime",
      ]),
      birth = storeCpuFields(row.directoryBirth, [
        "device",
        "file_id",
        "born_at",
      ]);
    if (
      row.version !== 1 ||
      row.distribution !== "microsoft-store" ||
      row.kind !== "fleet-attempt" ||
      typeof row.attemptId !== "string" ||
      !UUID.test(row.attemptId) ||
      owner.role !== "fleet"
    )
      denied();
    const fileId = decimal(birth.file_id);
    if (fileId === "0") denied();
    return Object.freeze({
      version: 1,
      distribution: "microsoft-store",
      kind: "fleet-attempt",
      attemptId: row.attemptId,
      token: digest(row.token),
      inventorySha256: digest(row.inventorySha256),
      runtimeManifestSha256: digest(row.runtimeManifestSha256),
      nodeOwner: Object.freeze({
        role: "fleet" as const,
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
      directoryBirth: Object.freeze({
        device: decimal(birth.device),
        file_id: fileId,
        born_at: decimal(birth.born_at),
      }),
    });
  } catch {
    return denied();
  }
}
export function parseStoreFleetAttemptState(
  value: unknown,
): Readonly<{ quiescent: boolean; retired: boolean }> {
  try {
    const row = storeCpuFields(value, ["quiescent", "retired"]);
    if (
      typeof row.quiescent !== "boolean" ||
      typeof row.retired !== "boolean" ||
      (row.retired && !row.quiescent)
    )
      denied();
    return Object.freeze({ quiescent: row.quiescent, retired: row.retired });
  } catch {
    return denied();
  }
}

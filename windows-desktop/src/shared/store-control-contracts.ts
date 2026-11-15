import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
import {
  processIdentityFromWire,
  type ConsumerProcessIdentity,
} from "../../../worker/src/platform/windows/consumer-native.js";
import { parseSessionCommand } from "./session-contracts.js";
import { parsePersonalCommand } from "./personal-contracts.js";

const HASH = /^[a-f0-9]{64}$/u,
  UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
function deny(): never {
  throw new Error("STORE_CONTROL_CONTRACT_DENIED");
}
function exact(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny();
  const prototype = Object.getPrototypeOf(value),
    descriptors = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    deny();
  const row: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor?.enumerable || !("value" in descriptor)) deny();
    row[field] = descriptor.value;
  }
  return row;
}
function payload(value: unknown, maximum: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > Math.ceil(maximum / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  )
    deny();
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length < 1 ||
    bytes.length > maximum ||
    bytes.toString("base64") !== value
  )
    deny();
  const text = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
  if (text.charCodeAt(0) === 0xfeff) deny();
  parseStrictJson(text, maximum, 2048);
  return bytes;
}
export interface StoreControlCommand {
  readonly version: 1;
  readonly requestId: string;
  readonly action: "session_forward";
  readonly payload_base64: string;
}
export interface StoreControlAck {
  readonly version: 1;
  readonly requestId: string;
  readonly action: "session_forward_ack";
}
/** Receiving classification only. A retired transport never means the
 * business command, role, Job, GPU or model is ready/clean. */
export function parseStoreControlDelivery(value: unknown): boolean {
  const descriptor =
    value && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "transport_retired")
      : undefined;
  const row = exact(
    value,
    descriptor ? ["accepted", "transport_retired"] : ["accepted"],
  );
  if (row.accepted !== true || (descriptor && row.transport_retired !== true))
    deny();
  return descriptor === undefined;
}
/** Receiving-only GUI grammar. Actual Creator admission supplies the peer;
 * caller JSON cannot select a native endpoint, original peer or launch path. */
export function storeGuiControlCommand(
  bytes: Uint8Array,
  requestId: string,
): StoreControlCommand {
  try {
    if (
      !UUID.test(requestId) ||
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > 4096
    )
      deny();
    const encoded = Buffer.from(bytes).toString("base64"),
      decoded = payload(encoded, 4096),
      value = parseStrictJson(
        new TextDecoder("utf8", { fatal: true }).decode(decoded),
        4096,
      );
    if (!value || typeof value !== "object" || Array.isArray(value)) deny();
    const kind = Object.getOwnPropertyDescriptor(value, "kind");
    if (!kind) {
      const command = parseSessionCommand(decoded);
      if (
        command.action === "maintenance_commit" ||
        (command.action === "fleet_force" && command.reason === "update") ||
        (command.action === "personal_attach" &&
          command.owner_kind !== "desktop" &&
          command.owner_kind !== "chrome")
      )
        deny();
    } else {
      if (!("value" in kind)) deny();
      if (kind.value === "personal-owner-proof") {
        const proof = exact(value, [
          "version",
          "kind",
          "request_id",
          "owner_id",
          "owner_kind",
          "job_id",
          "video_id",
          "original_peer",
        ]);
        if (
          proof.version !== 1 ||
          (proof.owner_kind !== "desktop" && proof.owner_kind !== "chrome") ||
          ![proof.request_id, proof.owner_id, proof.job_id].every(
            (id) => typeof id === "string" && UUID.test(id),
          ) ||
          typeof proof.video_id !== "string" ||
          !/^[A-Za-z0-9_-]{11}$/u.test(proof.video_id)
        )
          deny();
        const identity = exact(proof.original_peer, [
          "sid",
          "sessionId",
          "pid",
          "creationTime",
        ]);
        processIdentityFromWire({
          sid: identity.sid,
          session_id: identity.sessionId,
          pid: identity.pid,
          creation_time: identity.creationTime,
        });
        return Object.freeze({
          version: 1,
          requestId,
          action: "session_forward",
          payload_base64: encoded,
        });
      }
      if (kind.value !== "personal-command") deny();
      const names = ["version", "kind", "owner_kind", "command"];
      if (Object.hasOwn(value, "submission_authority"))
        names.push("submission_authority");
      const row = exact(value, names);
      if (
        row.version !== 1 ||
        (row.owner_kind !== "desktop" && row.owner_kind !== "chrome")
      )
        deny();
      const command = parsePersonalCommand(
        Buffer.from(JSON.stringify(row.command)),
      );
      if (
        ![
          "status",
          "submit",
          "jobs",
          "cancel",
          "detach",
          "wait_changes",
        ].includes(command.action)
      )
        deny();
      if (row.submission_authority !== undefined) {
        if (command.action !== "submit") deny();
        const authority = row.submission_authority as Record<string, unknown>;
        if (authority?.kind === "guest") exact(authority, ["kind"]);
        else if (authority?.kind === "account") {
          exact(authority, ["kind", "scope"]);
          parseSessionCommand(
            Buffer.from(
              JSON.stringify({
                version: 1,
                request_id: requestId,
                action: "account_scope",
                scope: authority.scope,
              }),
            ),
          );
        } else deny();
      }
    }
    return Object.freeze({
      version: 1,
      requestId,
      action: "session_forward",
      payload_base64: encoded,
    });
  } catch {
    return deny();
  }
}
export function parseStoreControlEvent(
  value: unknown,
  requestId: string,
): Buffer | null {
  try {
    const state =
      value && typeof value === "object"
        ? Object.getOwnPropertyDescriptor(value, "state")
        : undefined;
    if (!state || !("value" in state)) deny();
    const row = exact(
      value,
      state.value === "waiting"
        ? ["version", "requestId", "state"]
        : ["version", "requestId", "state", "payload_base64"],
    );
    if (
      !UUID.test(requestId) ||
      row.version !== 1 ||
      row.requestId !== requestId
    )
      deny();
    if (row.state === "waiting") return null;
    if (row.state !== "completed") deny();
    return payload(row.payload_base64, 32768);
  } catch {
    return deny();
  }
}
export interface StoreControlReceived {
  readonly token: string;
  readonly payload: Buffer;
  readonly peer: ConsumerProcessIdentity;
}
export function parseStoreControlReceived(
  value: unknown,
): StoreControlReceived | null {
  try {
    if (value === null) return null;
    const row = exact(value, ["version", "token", "payload_base64", "peer"]);
    if (
      row.version !== 1 ||
      typeof row.token !== "string" ||
      !HASH.test(row.token)
    )
      deny();
    return Object.freeze({
      token: row.token,
      payload: payload(row.payload_base64, 4096),
      peer: Object.freeze(processIdentityFromWire(row.peer)),
    });
  } catch {
    return deny();
  }
}
export function storeControlReplyBytes(bytes: Uint8Array): string {
  try {
    if (!(bytes instanceof Uint8Array)) deny();
    const encoded = Buffer.from(bytes).toString("base64");
    payload(encoded, 32768);
    return encoded;
  } catch {
    return deny();
  }
}

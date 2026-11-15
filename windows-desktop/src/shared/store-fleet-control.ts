import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
import {
  processIdentityFromWire,
  type ConsumerOwnedProcess,
  type ConsumerProcessIdentity,
} from "../../../worker/src/platform/windows/consumer-native.js";
import { storeCpuFields } from "./store-cpu-operation.js";

/** Receiving observations only. Neither an owner row, null nor an owned flag
 * creates a native process/Job, admission, current code or Ready authority.
 * Production independently obtains these bytes from its retained native owner. */
export interface StoreFleetOwner extends Readonly<ConsumerOwnedProcess> {
  readonly role: "fleet";
  readonly identity: Readonly<ConsumerProcessIdentity>;
}
export interface StoreFleetOwnerObservation {
  readonly version: 1;
  readonly inventorySha256: string;
  readonly owner: StoreFleetOwner | null;
}

const HASH = /^[a-f0-9]{64}$/u,
  ARRAY_VIEW_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype),
  BYTE_LENGTH = Object.getOwnPropertyDescriptor(
    ARRAY_VIEW_PROTOTYPE,
    "byteLength",
  )!.get!,
  BYTE_OFFSET = Object.getOwnPropertyDescriptor(
    ARRAY_VIEW_PROTOTYPE,
    "byteOffset",
  )!.get!,
  BUFFER = Object.getOwnPropertyDescriptor(
    ARRAY_VIEW_PROTOTYPE,
    "buffer",
  )!.get!;

function deny(): never {
  throw new Error("STORE_FLEET_CONTROL_INVALID");
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) deny();
  return value;
}
function received(input: Uint8Array, maximum: number): unknown {
  // Ordinary typed bytes only; structural objects, Proxy views, subclasses and
  // extra serialization/accessor properties do not cross this boundary.
  if (!ArrayBuffer.isView(input) || !(input instanceof Uint8Array)) deny();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype)
    deny();
  const length = BYTE_LENGTH.call(input) as number;
  if (length < 1 || length > maximum) deny();
  for (const key of Reflect.ownKeys(input)) {
    if (
      typeof key !== "string" ||
      !/^(?:0|[1-9]\d*)$/u.test(key) ||
      Number(key) >= length
    )
      deny();
  }
  // Builtin view accessors bypass any caller properties. Decode only this
  // view's actual offset/extent, not the surrounding pooled Buffer allocation.
  const view = new Uint8Array(
      BUFFER.call(input) as ArrayBuffer,
      BYTE_OFFSET.call(input) as number,
      length,
    ),
    text = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(
      view,
    );
  if (text.charCodeAt(0) === 0xfeff) deny();
  return parseStrictJson(text, maximum, 128);
}
function fleetOwner(value: unknown): StoreFleetOwner {
  const row = storeCpuFields(value, ["role", "nonce", "identity"]),
    shape = storeCpuFields(row.identity, [
      "sid",
      "sessionId",
      "pid",
      "creationTime",
    ]);
  if (row.role !== "fleet") deny();
  const identity = processIdentityFromWire({
    sid: shape.sid,
    session_id: shape.sessionId,
    pid: shape.pid,
    creation_time: shape.creationTime,
  });
  return Object.freeze({
    role: "fleet",
    nonce: digest(row.nonce),
    identity: Object.freeze(identity),
  });
}

/** The expected digest must come from the caller's actual current code owner;
 * binding decoded data to it does not prove an OS observation. Null is solely
 * the received missing-row observation, never a process-exit certificate. */
export function parseStoreFleetOwnerObservation(
  bytes: Uint8Array,
  expectedInventorySha256: string,
): StoreFleetOwnerObservation {
  try {
    const expected = digest(expectedInventorySha256),
      row = storeCpuFields(received(bytes, 4096), [
        "version",
        "inventorySha256",
        "owner",
      ]);
    if (row.version !== 1 || digest(row.inventorySha256) !== expected) deny();
    return Object.freeze({
      version: 1,
      inventorySha256: expected,
      owner: row.owner === null ? null : fleetOwner(row.owner),
    });
  } catch {
    return deny();
  }
}

/** A syntactically valid boolean does not validate the expected owner/peer.
 * The genuine native inspector alone performs those retained-handle checks. */
export function parseStoreFleetPeerObservation(bytes: Uint8Array): boolean {
  try {
    const row = storeCpuFields(received(bytes, 256), ["owned"]);
    if (typeof row.owned !== "boolean") deny();
    return row.owned;
  } catch {
    return deny();
  }
}

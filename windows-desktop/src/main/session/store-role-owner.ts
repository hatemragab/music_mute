import {
  processIdentityFromWire,
  sameConsumerProcess,
  type ConsumerOwnedProcess,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import { parseStoreInstalledPackage } from "../../shared/store-contracts.js";
import type { StoreBootReceipt } from "../../shared/store-boot-receipt.js";

function denied(): never {
  throw new Error("STORE_ROLE_OWNER_DENIED");
}
function fields(value: unknown, names: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) denied();
  const prototype = Object.getPrototypeOf(value),
    keys = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value),
    row: Record<string, unknown> = Object.create(null);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== names.length ||
    keys.some((key) => typeof key !== "string" || !names.includes(key))
  )
    denied();
  for (const name of names) {
    const descriptor = descriptors[name];
    if (!descriptor?.enumerable || !("value" in descriptor)) denied();
    row[name] = descriptor.value;
  }
  return row;
}

/** Receiving validation only. A public object cannot mint a role or Job. The
 * caller must first hold the live creator-bound native Store transport. */
export function parseStoreRoleOwner(
  value: unknown,
  boot: StoreBootReceipt,
  expectedRole: "session-agent" | "personal" | "fleet" | "prepare",
  inventorySha256: string,
): ConsumerOwnedProcess {
  try {
    const row = fields(value, [
      "version",
      "role",
      "nonce",
      "node",
      "package",
      "inventory_sha256",
      "protocol_abi",
    ]);
    if (
      !["session-agent", "personal", "fleet", "prepare"].includes(
        expectedRole,
      ) ||
      row.version !== 1 ||
      row.role !== expectedRole ||
      typeof row.nonce !== "string" ||
      !/^[a-f0-9]{64}$/u.test(row.nonce) ||
      !/^[a-f0-9]{64}$/u.test(inventorySha256) ||
      row.inventory_sha256 !== inventorySha256 ||
      row.protocol_abi !== 1
    )
      denied();
    const packageValue = parseStoreInstalledPackage("worker", row.package),
      node = processIdentityFromWire(
        fields(row.node, ["sid", "session_id", "pid", "creation_time"]),
      );
    if (
      packageValue.fullName !== boot.package.fullName ||
      !sameConsumerProcess(node, boot.parent)
    )
      denied();
    return Object.freeze({
      role: expectedRole,
      nonce: row.nonce,
      identity: Object.freeze(node),
    });
  } catch {
    return denied();
  }
}

/** A role launched by the already authenticated live creator has a different
 * Node birth from its session caller. This remains receiving data only. */
export function parseStoreLaunchedOwner(
  value: unknown,
  boot: StoreBootReceipt,
  expectedRole: "personal" | "fleet" | "prepare",
): ConsumerOwnedProcess {
  try {
    const row = fields(value, ["role", "nonce", "identity"]);
    if (
      !["personal", "fleet", "prepare"].includes(expectedRole) ||
      row.role !== expectedRole ||
      typeof row.nonce !== "string" ||
      !/^[a-f0-9]{64}$/u.test(row.nonce)
    )
      denied();
    const identity = processIdentityFromWire(
      fields(row.identity, ["sid", "session_id", "pid", "creation_time"]),
    );
    if (
      identity.sid !== boot.parent.sid ||
      identity.sessionId !== boot.parent.sessionId ||
      sameConsumerProcess(identity, boot.parent) ||
      sameConsumerProcess(identity, boot.helper)
    )
      denied();
    return Object.freeze({
      role: expectedRole,
      nonce: row.nonce,
      identity: Object.freeze(identity),
    });
  } catch {
    return denied();
  }
}

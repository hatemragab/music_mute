import {
  isLogonSid,
  processIdentityFromWire,
  type ConsumerProcessIdentity,
} from "../../../worker/src/platform/windows/consumer-native-policy.js";
import {
  parseStoreInstalledPackage,
  type StoreInstalledPackage,
  type StoreProductRole,
} from "./store-contracts.js";

export interface StoreBootReceipt {
  readonly version: 1;
  readonly package: StoreInstalledPackage;
  readonly helper: ConsumerProcessIdentity;
  readonly parent: ConsumerProcessIdentity;
  readonly logonSid: string;
}
function denied(): never {
  throw new Error("STORE_AUTHORITY_DENIED");
}
function exact(value: unknown, names: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) denied();
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    denied();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== names.length ||
    keys.some((name) => typeof name !== "string" || !names.includes(name))
  )
    denied();
  const row: Record<string, unknown> = Object.create(null);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const name of names) {
    const descriptor = descriptors[name];
    if (!descriptor?.enumerable || !("value" in descriptor)) denied();
    row[name] = descriptor.value;
  }
  return row;
}
/** Receiving validation supplements native proof; JSON alone grants no authority. */
export function parseStoreBootReceipt(
  role: StoreProductRole,
  value: unknown,
  expectedParentPid: number,
  expectedHelperPid: number,
): StoreBootReceipt {
  try {
    const row = exact(value, [
      "version",
      "package",
      "helper",
      "parent",
      "logon_sid",
    ]);
    if (row.version !== 1 || !isLogonSid(row.logon_sid)) denied();
    exact(row.helper, ["sid", "session_id", "pid", "creation_time"]);
    exact(row.parent, ["sid", "session_id", "pid", "creation_time"]);
    const helper = processIdentityFromWire(row.helper);
    const parent = processIdentityFromWire(row.parent);
    if (
      !Number.isSafeInteger(expectedParentPid) ||
      expectedParentPid < 1 ||
      !Number.isSafeInteger(expectedHelperPid) ||
      expectedHelperPid < 1 ||
      parent.pid !== expectedParentPid ||
      helper.pid !== expectedHelperPid ||
      helper.pid === parent.pid ||
      helper.sid !== parent.sid ||
      helper.sessionId !== parent.sessionId
    )
      denied();
    return Object.freeze({
      version: 1,
      package: parseStoreInstalledPackage(role, row.package),
      helper: Object.freeze(helper),
      parent: Object.freeze(parent),
      logonSid: row.logon_sid,
    });
  } catch {
    return denied();
  }
}

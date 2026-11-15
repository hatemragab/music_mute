import {
  isLogonSid,
  processIdentityFromWire,
} from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import { parseStoreInstalledPackage } from "../../shared/store-contracts.js";
import type { StoreBootReceipt, StoreNativeAuthority } from "./store-native.js";

export const STORE_BROWSER_EXTENSION_ID = "acmgefmmndomcpdlgnafkjbgobinllep";
export const STORE_BROWSER_ORIGIN =
  `chrome-extension://${STORE_BROWSER_EXTENSION_ID}/` as const;
export type StoreBrowserIntent = "inspect" | "register" | "remove";
export interface StoreBrowserRegistration {
  readonly version: 1;
  readonly registered: boolean;
  readonly state: "registered" | "absent" | "repair-required" | "conflict";
  readonly packageFullName: string;
  readonly manifestSha256: string;
  readonly launchTarget: "current-package";
  readonly aliasRequired: false;
  readonly ordinaryRegistryVerified: boolean;
  readonly extensionId: typeof STORE_BROWSER_EXTENSION_ID;
}
export interface StoreBrowserAttachInput {
  readonly hostPid: number;
  readonly nonce: string;
  readonly origin: typeof STORE_BROWSER_ORIGIN;
}
export interface StoreBrowserAttachment {
  readonly version: 1;
  readonly accepted: true;
  readonly host: StoreBootReceipt["helper"];
  readonly gui: StoreBootReceipt["parent"];
  readonly chrome: StoreBootReceipt["parent"];
  readonly origin: typeof STORE_BROWSER_ORIGIN;
  readonly packageFullName: string;
}
const HASH = /^[a-f0-9]{64}$/u;
function denied(): never {
  throw new Error("STORE_BROWSER_DENIED");
}
function exact(value: unknown, names: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) denied();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) denied();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== names.length ||
    keys.some((key) => typeof key !== "string" || !names.includes(key))
  )
    denied();
  const row: Record<string, unknown> = Object.create(null);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of names) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) denied();
    row[key] = descriptor.value;
  }
  return row;
}
function guiReceipt(receipt: StoreBootReceipt) {
  const row = exact(receipt, [
    "version",
    "package",
    "helper",
    "parent",
    "logonSid",
  ]);
  const pkg = parseStoreInstalledPackage("gui", row.package);
  const process = (value: unknown) => {
    const item = exact(value, ["sid", "sessionId", "pid", "creationTime"]);
    return processIdentityFromWire({
      sid: item.sid,
      session_id: item.sessionId,
      pid: item.pid,
      creation_time: item.creationTime,
    });
  };
  const helper = process(row.helper),
    parent = process(row.parent);
  if (
    row.version !== 1 ||
    !isLogonSid(row.logonSid) ||
    helper.sid !== parent.sid ||
    helper.sessionId !== parent.sessionId ||
    helper.pid === parent.pid ||
    BigInt(helper.creationTime) < BigInt(parent.creationTime)
  )
    denied();
  return { pkg, helper, parent };
}
/** Receiving grammar only: a receipt or parser result cannot open a native port. */
export function parseStoreBrowserRegistration(
  value: unknown,
  receipt: StoreBootReceipt,
): StoreBrowserRegistration {
  try {
    const { pkg } = guiReceipt(receipt);
    const row = exact(value, [
      "version",
      "registered",
      "state",
      "package_full_name",
      "manifest_sha256",
      "launch_target",
      "alias_required",
      "ordinary_registry_verified",
      "extension_id",
    ]);
    if (
      row.version !== 1 ||
      typeof row.registered !== "boolean" ||
      !["registered", "absent", "repair-required", "conflict"].includes(
        row.state as string,
      ) ||
      row.registered !== (row.state === "registered") ||
      row.package_full_name !== pkg.fullName ||
      typeof row.manifest_sha256 !== "string" ||
      !HASH.test(row.manifest_sha256) ||
      row.launch_target !== "current-package" ||
      row.alias_required !== false ||
      row.ordinary_registry_verified !== row.registered ||
      row.extension_id !== STORE_BROWSER_EXTENSION_ID
    )
      denied();
    return Object.freeze({
      version: 1,
      registered: row.registered,
      state: row.state as StoreBrowserRegistration["state"],
      packageFullName: pkg.fullName,
      manifestSha256: row.manifest_sha256,
      launchTarget: "current-package",
      aliasRequired: false,
      ordinaryRegistryVerified: row.ordinary_registry_verified,
      extensionId: STORE_BROWSER_EXTENSION_ID,
    });
  } catch {
    return denied();
  }
}
export function parseStoreBrowserAttachInput(
  value: unknown,
): StoreBrowserAttachInput {
  try {
    const row = exact(value, ["hostPid", "nonce", "origin"]);
    if (
      !Number.isSafeInteger(row.hostPid) ||
      (row.hostPid as number) < 1 ||
      (row.hostPid as number) > 2_147_483_647 ||
      typeof row.nonce !== "string" ||
      !HASH.test(row.nonce) ||
      row.origin !== STORE_BROWSER_ORIGIN
    )
      denied();
    return Object.freeze({
      hostPid: row.hostPid as number,
      nonce: row.nonce,
      origin: STORE_BROWSER_ORIGIN,
    });
  } catch {
    return denied();
  }
}
export function parseStoreBrowserAttachment(
  value: unknown,
  receipt: StoreBootReceipt,
): StoreBrowserAttachment {
  try {
    const { pkg, helper, parent } = guiReceipt(receipt);
    const row = exact(value, [
      "version",
      "accepted",
      "host",
      "gui",
      "chrome",
      "origin",
      "package_full_name",
    ]);
    const peer = (raw: unknown) =>
      Object.freeze(
        processIdentityFromWire(
          exact(raw, ["sid", "session_id", "pid", "creation_time"]),
        ),
      );
    const host = peer(row.host),
      gui = peer(row.gui),
      chrome = peer(row.chrome);
    if (
      row.version !== 1 ||
      row.accepted !== true ||
      row.origin !== STORE_BROWSER_ORIGIN ||
      row.package_full_name !== pkg.fullName ||
      gui.pid !== parent.pid ||
      gui.creationTime !== parent.creationTime ||
      new Set([host.pid, gui.pid, chrome.pid, helper.pid]).size !== 4 ||
      [host, gui, chrome].some(
        (value) =>
          value.sid !== helper.sid || value.sessionId !== helper.sessionId,
      )
    )
      denied();
    return Object.freeze({
      version: 1,
      accepted: true,
      host,
      gui,
      chrome,
      origin: STORE_BROWSER_ORIGIN,
      packageFullName: pkg.fullName,
    });
  } catch {
    return denied();
  }
}
async function registration(
  authority: StoreNativeAuthority,
  intent: StoreBrowserIntent,
) {
  // Borrow the actual implementation rather than trusting a supplied object's
  // override. Its private brand/live transport/private-boot checks remain the
  // authority. Dynamic import avoids the parser's StoreNativeAuthority cycle.
  const { StoreNativeAuthority } = await import("./store-native.js");
  return StoreNativeAuthority.prototype.browserRegistration.call(
    authority,
    intent,
  );
}
export async function registerStoreBrowserIntegration(
  authority: StoreNativeAuthority,
): Promise<boolean> {
  const result = await registration(authority, "register");
  if (!result.registered || !result.ordinaryRegistryVerified) denied();
  return true;
}
export async function verifyStoreBrowserIntegration(
  authority: StoreNativeAuthority,
): Promise<boolean> {
  try {
    const result = await registration(authority, "inspect");
    return result.registered && result.ordinaryRegistryVerified;
  } catch {
    return false;
  }
}
export async function removeStoreBrowserIntegration(
  authority: StoreNativeAuthority,
): Promise<void> {
  const result = await registration(authority, "remove");
  if (result.state !== "absent" || result.registered) denied();
}

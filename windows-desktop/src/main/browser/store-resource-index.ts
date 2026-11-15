import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import {
  parseStoreBuildNumber,
  parseStorePackageIdentity,
  parseStorePackageVersion,
  STORE_PRODUCTS,
  STORE_PROTOCOL_ABI,
  type StorePackageIdentity,
  type StoreProductRole,
} from "../../shared/store-contracts.js";
import type { PackagedResourceEntry } from "./package-trust.js";
import { PACKAGE_AUTHORITY_KIND } from "../../shared/package-build-profile.js";

/** ASAR seal for Store resources. Code authority still requires native OS proof. */
export interface StoreResourceIndex {
  readonly version: 2;
  readonly authority: {
    readonly kind: typeof PACKAGE_AUTHORITY_KIND;
    readonly role: StoreProductRole;
    readonly identity: StorePackageIdentity;
    readonly packageVersion: string;
    readonly protocolAbi: 1;
  };
  readonly appVersion: string;
  readonly buildNumber: number;
  readonly entries: readonly PackagedResourceEntry[];
}

export const REQUIRED_STORE_GUI_RESOURCES = Object.freeze([
  "app:MusicMuteChromeHost.exe",
  "resources:native/musicmute-native.exe",
  "resources:native/manifest.json",
  "resources:native/browser-manifest.json",
  "resources:native/com.musicmute.local.json",
  "resources:native/browser-host.cjs",
  "resources:extension/manifest.json",
  "resources:extension/inventory.json",
  "resources:desktop-public-config.json",
  "resources:desktop-build.json",
]);
const HASH = /^[a-f0-9]{64}$/u;
function invalid(): never {
  throw new Error("STORE_RESOURCE_INDEX_INVALID");
}
function exact(value: unknown, names: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== names.length ||
    keys.some((key) => typeof key !== "string" || !names.includes(key))
  )
    invalid();
  const result: Record<string, unknown> = Object.create(null);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of names) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
export function parseStoreResourceIndex(value: unknown): StoreResourceIndex {
  try {
    const row = exact(value, [
      "version",
      "authority",
      "appVersion",
      "buildNumber",
      "entries",
    ]);
    const authority = exact(row.authority, [
      "kind",
      "role",
      "identity",
      "packageVersion",
      "protocolAbi",
    ]);
    if (
      row.version !== 2 ||
      authority.kind !== PACKAGE_AUTHORITY_KIND ||
      (authority.role !== "gui" && authority.role !== "worker") ||
      authority.protocolAbi !== STORE_PROTOCOL_ABI
    )
      invalid();
    const identity = parseStorePackageIdentity(
      authority.role,
      authority.identity,
    );
    const version = parseStorePackageVersion(authority.packageVersion, true);
    const buildNumber = parseStoreBuildNumber(row.buildNumber);
    if (
      row.appVersion !== version.semanticVersion ||
      row.appVersion !== STORE_PRODUCTS[authority.role].appVersion ||
      !Array.isArray(row.entries) ||
      row.entries.length < 1 ||
      row.entries.length > 256
    )
      invalid();
    const entries: PackagedResourceEntry[] = [];
    const names = new Set<string>();
    for (const candidate of row.entries) {
      const entry = exact(candidate, ["placement", "path", "bytes", "sha256"]);
      if (
        (entry.placement !== "app" && entry.placement !== "resources") ||
        typeof entry.path !== "string" ||
        entry.path.length > 256 ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(entry.path) ||
        entry.path
          .split("/")
          .some(
            (part) =>
              !part ||
              part === "." ||
              part === ".." ||
              /[. ]$/u.test(part) ||
              /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part),
          ) ||
        /(?:^|\/)(?:account-authority-manifest\.json|store-code-inventory\.json)$/iu.test(
          entry.path,
        ) ||
        /(?:^|\/)(?:runtime-metadata|runtime-source|update-channel|app-update-identity)\.json$/iu.test(
          entry.path,
        ) ||
        !Number.isSafeInteger(entry.bytes) ||
        (entry.bytes as number) < 1 ||
        (entry.bytes as number) > 256 * 1024 ** 2 ||
        typeof entry.sha256 !== "string" ||
        !HASH.test(entry.sha256)
      )
        invalid();
      const name = `${entry.placement}:${entry.path.toLowerCase()}`;
      if (names.has(name)) invalid();
      names.add(name);
      entries.push(
        Object.freeze({ ...entry }) as unknown as PackagedResourceEntry,
      );
    }
    if (authority.role === "gui")
      for (const name of REQUIRED_STORE_GUI_RESOURCES)
        if (!names.has(name.toLowerCase())) invalid();
    return Object.freeze({
      version: 2,
      authority: Object.freeze({
        kind: PACKAGE_AUTHORITY_KIND,
        role: authority.role,
        identity,
        packageVersion: version.text,
        protocolAbi: 1,
      }),
      appVersion: row.appVersion as string,
      buildNumber,
      entries: Object.freeze(entries),
    });
  } catch {
    return invalid();
  }
}
export function parseStoreResourceIndexBytes(
  bytes: Uint8Array,
): StoreResourceIndex {
  try {
    if (bytes.byteLength < 1 || bytes.byteLength > 65536) invalid();
    return parseStoreResourceIndex(
      parseStrictJson(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        65536,
        4096,
      ),
    );
  } catch {
    return invalid();
  }
}

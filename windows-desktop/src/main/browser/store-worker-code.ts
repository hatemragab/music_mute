import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { parseStoreBuildDocument } from "../../../packaging/store/document-json.js";
import {
  parseWindowsReleaseManifest,
  type WindowsReleaseManifest,
} from "../../../../worker/src/platform/windows/release-manifest.js";
import {
  evaluateStorePackagePair,
  parseStoreInstalledPackage,
  type StoreInstalledPackage,
} from "../../shared/store-contracts.js";

export const STORE_WORKER_MANIFEST_MAXIMUM = 8 * 1024 ** 2;
export interface StoreWorkerCodeObservation {
  readonly version: 1;
  readonly package: StoreInstalledPackage;
  readonly inventorySha256: string;
  readonly manifest: {
    readonly path: "worker/release-manifest.json";
    readonly bytes: number;
    readonly sha256: string;
  };
}
/** Receiving values from the same live code owner; these digests create no
 * replacement code lease, child process, model, GPU or Ready authority. */
export interface StoreWorkerBenchmarkObservation {
  readonly inventorySha256: string;
  readonly runtimeManifestSha256: string;
  readonly helperSha256: string;
  readonly engineDigest: string;
}
function denied(): never {
  throw new Error("STORE_WORKER_CODE_DENIED");
}
function exact(value: unknown, names: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) denied();
  const prototype = Object.getPrototypeOf(value),
    keys = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== names.length ||
    keys.some((key) => typeof key !== "string" || !names.includes(key))
  )
    denied();
  const row: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const field = descriptors[name];
    if (!field?.enumerable || !("value" in field)) denied();
    row[name] = field.value;
  }
  return row;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) denied();
  return value;
}
export function parseStoreWorkerBenchmarkObservation(
  input: unknown,
): StoreWorkerBenchmarkObservation {
  const row = exact(input, [
    "inventorySha256",
    "runtimeManifestSha256",
    "helperSha256",
    "engineDigest",
  ]);
  return Object.freeze({
    inventorySha256: digest(row.inventorySha256),
    runtimeManifestSha256: digest(row.runtimeManifestSha256),
    helperSha256: digest(row.helperSha256),
    engineDigest: digest(row.engineDigest),
  });
}
/** Receiving data only. The separate living native lease owns every code file;
 * this observation cannot be imported to create that lease or launch a role. */
export function parseStoreWorkerCodeObservation(
  input: unknown,
  gui: StoreInstalledPackage,
): StoreWorkerCodeObservation {
  try {
    const row = exact(input, [
        "version",
        "package",
        "inventory_sha256",
        "manifest",
      ]),
      installed = parseStoreInstalledPackage("worker", row.package),
      manifest = exact(row.manifest, ["path", "bytes", "sha256"]);
    if (
      row.version !== 1 ||
      !evaluateStorePackagePair(gui, installed).ready ||
      manifest.path !== "worker/release-manifest.json" ||
      !Number.isSafeInteger(manifest.bytes) ||
      (manifest.bytes as number) < 1 ||
      (manifest.bytes as number) > STORE_WORKER_MANIFEST_MAXIMUM
    )
      denied();
    return Object.freeze({
      version: 1,
      package: installed,
      inventorySha256: digest(row.inventory_sha256),
      manifest: Object.freeze({
        path: "worker/release-manifest.json",
        bytes: manifest.bytes as number,
        sha256: digest(manifest.sha256),
      }),
    });
  } catch {
    return denied();
  }
}
export function storeWorkerManifestPath(
  observation: StoreWorkerCodeObservation,
) {
  return win32.join(
    observation.package.installedLocation,
    "worker",
    "release-manifest.json",
  );
}
/** A protected, hash-bound internal manifest describes the unchanged runtime
 * recipe. The outer Store inventory remains its independent code authority. */
export function parseStoreWorkerRuntimeManifest(
  bytes: Uint8Array,
  observation: StoreWorkerCodeObservation,
): WindowsReleaseManifest {
  try {
    if (
      bytes.byteLength !== observation.manifest.bytes ||
      createHash("sha256").update(bytes).digest("hex") !==
        observation.manifest.sha256
    )
      denied();
    const manifest = parseWindowsReleaseManifest(
      parseStoreBuildDocument(bytes, STORE_WORKER_MANIFEST_MAXIMUM),
    );
    if (
      manifest.installationProfile !== "windows-user" ||
      manifest.releaseVersion !==
        observation.package.packageVersion.split(".").slice(0, 3).join(".")
    )
      denied();
    return manifest;
  } catch {
    return denied();
  }
}
export function parseStoreWorkerSessionActivation(
  input: unknown,
  gui: StoreInstalledPackage,
) {
  try {
    const row = exact(input, ["activated", "pid", "package"]),
      installed = parseStoreInstalledPackage("worker", row.package);
    if (
      row.activated !== true ||
      !Number.isSafeInteger(row.pid) ||
      (row.pid as number) < 1 ||
      (row.pid as number) > 2147483647 ||
      !evaluateStorePackagePair(gui, installed).ready
    )
      denied();
    // OS activation ACK only. Never a process, Job, Session or GPU grant.
    return Object.freeze({
      activated: true as const,
      pid: row.pid as number,
      package: installed,
    });
  } catch {
    return denied();
  }
}

import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
import { checkHostSupport, type HostIdentity } from "./host-support.js";
import {
  PACKAGE_AUTHORITY_PROFILE,
  PACKAGE_REQUIRED_SIGNATURE_KIND,
} from "./package-build-profile.js";

export type StoreProductRole = "gui" | "worker";
export const STORE_PROTOCOL_ABI = 1;
export const STORE_MINIMUM_WINDOWS_BUILD = 19045;
const LOCAL_TEST = PACKAGE_AUTHORITY_PROFILE === "local-test-v1";
export const STORE_PUBLISHER = LOCAL_TEST
  ? "CN=MusicMute Z440 Development"
  : "CN=8A81D011-D5B0-414F-B3F7-A768A6B8C95E";
export const STORE_PUBLISHER_ID = LOCAL_TEST
  ? "kthggmwhkdz4t"
  : "5q1esjnkz8cve";
const GUI_IDENTITY = LOCAL_TEST
  ? "MusicMute.Development"
  : "27120VCHATSDK.MusicMute";
const WORKER_IDENTITY = LOCAL_TEST
  ? "MusicMute.WorkerDevelopment"
  : "27120VCHATSDK.MusicMuteWorker";
export const STORE_PRODUCTS = Object.freeze({
  gui: Object.freeze({
    displayName: LOCAL_TEST ? "MusicMute Development" : "MusicMute",
    storeId: "9P7VX8JK8B68",
    identityName: GUI_IDENTITY,
    publisher: STORE_PUBLISHER,
    publisherId: STORE_PUBLISHER_ID,
    familyName: `${GUI_IDENTITY}_${STORE_PUBLISHER_ID}`,
    applicationId: "MusicMute",
    appVersion: "0.1.0",
    packageVersion: "0.1.0.0",
    appBuildNumber: 1,
  }),
  worker: Object.freeze({
    displayName: LOCAL_TEST
      ? "MusicMute Worker Development"
      : "MusicMute Worker",
    storeId: "9P4GXB0NRJDG",
    identityName: WORKER_IDENTITY,
    publisher: STORE_PUBLISHER,
    publisherId: STORE_PUBLISHER_ID,
    familyName: `${WORKER_IDENTITY}_${STORE_PUBLISHER_ID}`,
    applicationId: "MusicMuteWorker",
    appVersion: "0.1.3",
    packageVersion: "0.1.3.0",
    appBuildNumber: 1,
  }),
});

const HASH = /^[a-f0-9]{64}$/u;
const JSON_MAX_BYTES = 16384;
function invalid(): never {
  throw new Error("STORE_CONTRACT_INVALID");
}
function product(role: StoreProductRole) {
  if (role !== "gui" && role !== "worker") invalid();
  return STORE_PRODUCTS[role];
}
/** Read data descriptors once; a getter must not run during validation. */
function exact(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const names = Reflect.ownKeys(value);
  if (
    names.length !== fields.length ||
    names.some((name) => typeof name !== "string" || !fields.includes(name))
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
      invalid();
    result[field] = descriptor.value;
  }
  return result;
}
function json(bytes: string | Uint8Array): unknown {
  try {
    if (typeof bytes !== "string" && bytes.byteLength > JSON_MAX_BYTES)
      invalid();
    const text =
      typeof bytes === "string"
        ? bytes
        : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (
      text.length > JSON_MAX_BYTES ||
      new TextEncoder().encode(text).byteLength > JSON_MAX_BYTES
    )
      invalid();
    return parseStrictJson(text, JSON_MAX_BYTES, 256);
  } catch {
    return invalid();
  }
}

export interface StorePackageVersion {
  readonly text: string;
  readonly parts: readonly [number, number, number, number];
  readonly semanticVersion: string;
}
/** Store may assign a revision after submission; only submission reserves zero. */
export function parseStorePackageVersion(
  value: unknown,
  submission = false,
): StorePackageVersion {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,4})(?:\.(?:0|[1-9][0-9]{0,4})){3}$/u.test(value)
  )
    invalid();
  const parts = value.split(".").map(Number);
  if (parts.some((part) => part > 65535) || (submission && parts[3] !== 0))
    invalid();
  return Object.freeze({
    text: value,
    parts: Object.freeze(parts) as readonly [number, number, number, number],
    semanticVersion: parts.slice(0, 3).join("."),
  });
}
export function compareStorePackageVersions(left: unknown, right: unknown) {
  const a = parseStorePackageVersion(left).parts;
  const b = parseStorePackageVersion(right).parts;
  for (let i = 0; i < 4; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}
export function parseStoreBuildNumber(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 2147483647
  )
    invalid();
  return value as number;
}

export interface StorePackageIdentity {
  readonly identityName: string;
  readonly publisher: string;
  readonly publisherId: string;
  readonly familyName: string;
  readonly storeId: string;
}
export function parseStorePackageIdentity(
  expected: StoreProductRole,
  value: unknown,
): StorePackageIdentity {
  const wanted = product(expected);
  const row = exact(value, [
    "identityName",
    "publisher",
    "publisherId",
    "familyName",
    "storeId",
  ]);
  for (const field of [
    "identityName",
    "publisher",
    "publisherId",
    "familyName",
    "storeId",
  ] as const)
    if (row[field] !== wanted[field]) invalid();
  return Object.freeze({
    identityName: wanted.identityName,
    publisher: wanted.publisher,
    publisherId: wanted.publisherId,
    familyName: wanted.familyName,
    storeId: wanted.storeId,
  });
}
export function parseStorePackageIdentityJson(
  expected: StoreProductRole,
  bytes: string | Uint8Array,
) {
  return parseStorePackageIdentity(expected, json(bytes));
}

/** Native observation, never a renderer-supplied authority or package manifest. */
export interface StoreInstalledPackage {
  readonly identityName: string;
  readonly publisher: string;
  readonly publisherId: string;
  readonly familyName: string;
  readonly fullName: string;
  readonly packageVersion: string;
  readonly architecture: "x64";
  readonly signatureKind: typeof PACKAGE_REQUIRED_SIGNATURE_KIND;
  readonly healthy: true;
  readonly current: true;
  readonly installedLocation: string;
}
function installedLocation(value: unknown, fullName: string): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !/^[A-Za-z]:\\/u.test(value) ||
    /[\p{Cc}\p{Cf}<>"|?*]/u.test(value) ||
    value.includes("/") ||
    value.slice(2).includes(":")
  )
    invalid();
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (
      (point >= 0xd800 && point <= 0xdfff) ||
      (point >= 0xfdd0 && point <= 0xfdef) ||
      (point & 0xffff) >= 0xfffe
    )
      invalid();
  }
  const segments = value.slice(3).split("\\");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[. ]$/u.test(segment),
    ) ||
    segments.at(-1) !== fullName
  )
    invalid();
  return value;
}
export function parseStoreInstalledPackage(
  expected: StoreProductRole,
  value: unknown,
): StoreInstalledPackage {
  const wanted = product(expected);
  const row = exact(value, [
    "identityName",
    "publisher",
    "publisherId",
    "familyName",
    "fullName",
    "packageVersion",
    "architecture",
    "signatureKind",
    "healthy",
    "current",
    "installedLocation",
  ]);
  for (const field of [
    "identityName",
    "publisher",
    "publisherId",
    "familyName",
  ] as const)
    if (row[field] !== wanted[field]) invalid();
  const version = parseStorePackageVersion(row.packageVersion);
  const fullName = `${wanted.identityName}_${version.text}_x64__${wanted.publisherId}`;
  if (
    row.fullName !== fullName ||
    row.architecture !== "x64" ||
    row.signatureKind !== PACKAGE_REQUIRED_SIGNATURE_KIND ||
    row.healthy !== true ||
    row.current !== true
  )
    invalid();
  return Object.freeze({
    identityName: wanted.identityName,
    publisher: wanted.publisher,
    publisherId: wanted.publisherId,
    familyName: wanted.familyName,
    fullName,
    packageVersion: version.text,
    architecture: "x64",
    signatureKind: PACKAGE_REQUIRED_SIGNATURE_KIND,
    healthy: true,
    current: true,
    installedLocation: installedLocation(row.installedLocation, fullName),
  });
}
export function parseStoreInstalledPackageJson(
  expected: StoreProductRole,
  bytes: string | Uint8Array,
) {
  return parseStoreInstalledPackage(expected, json(bytes));
}
export function assertStoreHost(value: unknown): HostIdentity {
  const row = exact(value, [
    "platform",
    "processArchitecture",
    "nativeArchitecture",
    "osBuild",
  ]);
  if (
    typeof row.platform !== "string" ||
    typeof row.processArchitecture !== "string" ||
    typeof row.nativeArchitecture !== "string" ||
    !Number.isSafeInteger(row.osBuild)
  )
    invalid();
  const host = {
    platform: row.platform,
    processArchitecture: row.processArchitecture,
    nativeArchitecture: row.nativeArchitecture,
    osBuild: row.osBuild as number,
  };
  if (!checkHostSupport(host).supported) invalid();
  return Object.freeze(host);
}

export type StorePairEvaluation =
  | {
      readonly ready: true;
      readonly protocolAbi: 1;
      readonly workerMayContinue: true;
      readonly gui: StoreInstalledPackage;
      readonly worker: StoreInstalledPackage;
    }
  | {
      readonly ready: false;
      readonly reason:
        | "GUI_MISSING"
        | "WORKER_MISSING"
        | "BOTH_MISSING"
        | "PAIR_INCOMPATIBLE"
        | "PACKAGE_ROLLBACK";
      readonly workerMayContinue: boolean;
      readonly recover: readonly StoreProductRole[];
    };
export interface StorePairVersionFloor {
  readonly gui: string;
  readonly worker: string;
}
/** Semantic bases are explicitly qualified; Store-assigned revisions may differ. */
export function evaluateStorePackagePair(
  guiValue: unknown | null,
  workerValue: unknown | null,
  protocolAbi: unknown = STORE_PROTOCOL_ABI,
  floor: StorePairVersionFloor = {
    gui: STORE_PRODUCTS.gui.packageVersion,
    worker: STORE_PRODUCTS.worker.packageVersion,
  },
): StorePairEvaluation {
  const gui =
    guiValue === null ? null : parseStoreInstalledPackage("gui", guiValue);
  const worker =
    workerValue === null
      ? null
      : parseStoreInstalledPackage("worker", workerValue);
  const minimum = exact(floor, ["gui", "worker"]);
  parseStorePackageVersion(minimum.gui);
  parseStorePackageVersion(minimum.worker);
  const workerCompatible =
    worker !== null &&
    protocolAbi === STORE_PROTOCOL_ABI &&
    parseStorePackageVersion(worker.packageVersion).semanticVersion ===
      STORE_PRODUCTS.worker.appVersion &&
    compareStorePackageVersions(worker.packageVersion, minimum.worker) >= 0;
  if (!gui || !worker)
    return Object.freeze({
      ready: false,
      reason:
        !gui && !worker
          ? "BOTH_MISSING"
          : !gui
            ? "GUI_MISSING"
            : "WORKER_MISSING",
      workerMayContinue: workerCompatible,
      recover: Object.freeze(
        (!gui && !worker
          ? ["gui", "worker"]
          : !gui
            ? ["gui"]
            : ["worker"]) as StoreProductRole[],
      ),
    });
  if (
    compareStorePackageVersions(gui.packageVersion, minimum.gui) < 0 ||
    compareStorePackageVersions(worker.packageVersion, minimum.worker) < 0
  )
    return Object.freeze({
      ready: false,
      reason: "PACKAGE_ROLLBACK",
      workerMayContinue: workerCompatible,
      recover: Object.freeze(["gui", "worker"] as const),
    });
  if (
    !workerCompatible ||
    parseStorePackageVersion(gui.packageVersion).semanticVersion !==
      STORE_PRODUCTS.gui.appVersion
  )
    return Object.freeze({
      ready: false,
      reason: "PAIR_INCOMPATIBLE",
      workerMayContinue: workerCompatible,
      recover: Object.freeze(["gui", "worker"] as const),
    });
  return Object.freeze({
    ready: true,
    protocolAbi: 1,
    workerMayContinue: true,
    gui,
    worker,
  });
}

export const STORE_ROLE_OWNERS = Object.freeze({
  "desktop-main": "gui",
  "account-authority": "gui",
  preload: "gui",
  renderer: "gui",
  "chrome-proxy": "gui",
  "browser-host": "gui",
  "gui-native-helper": "gui",
  "gui-session-proxy": "gui",
  "worker-controls": "worker",
  "session-launcher": "worker",
  "session-agent": "worker",
  "login-worker": "worker",
  personal: "worker",
  fleet: "worker",
  prepare: "worker",
  "native-helper": "worker",
  node: "worker",
  python: "worker",
  engine: "worker",
  media: "worker",
  acquisition: "worker",
  "worker-code": "worker",
  "worker-dependency": "worker",
  electron: "gui",
} as const);
export type StoreCodeKind = keyof typeof STORE_ROLE_OWNERS;
export interface StoreCodeReference {
  readonly owner: StoreProductRole;
  readonly kind: StoreCodeKind;
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
}
function relativeCodePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !value ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /[\p{Cc}\p{Cf}<>:"|?*]/u.test(value)
  )
    invalid();
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/u.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part) ||
        /^(?:\.git|\.env.*|tests?|fixtures?|__pycache__)$/iu.test(part),
    ) ||
    /\.(?:map|pyc|pfx|p12|key)$/iu.test(value)
  )
    invalid();
  return value;
}
/** Classifies code only inside a sealed installed package, never a download root. */
export function classifyStoreCode(
  owner: StoreProductRole,
  value: unknown,
): StoreCodeKind {
  product(owner);
  const path = relativeCodePath(value);
  if (owner === "gui") {
    if (path === "MusicMute Local.exe") return "desktop-main";
    if (path === "MusicMuteChromeHost.exe") return "chrome-proxy";
    if (path === "resources/native/musicmute-native.exe")
      return "gui-native-helper";
    if (path === "MusicMuteSession.exe") return "gui-session-proxy";
    if (path === "resources/native/browser-host.cjs") return "browser-host";
    if (path === "resources/app.asar") return "electron";
    if (path === "dist/main/main.cjs") return "desktop-main";
    if (path === "dist/preload/index.cjs") return "preload";
    if (
      /^dist\/renderer\/.+\.(?:js|html)$/u.test(path) ||
      /^resources\/extension\/.+\.(?:js|html)$/u.test(path)
    )
      return "renderer";
    if (/^[A-Za-z0-9_.-]+\.dll$/u.test(path)) return "electron";
  } else {
    if (path === "MusicMuteWorker.exe") return "worker-controls";
    if (path === "MusicMuteSession.exe") return "session-launcher";
    if (path === "runtime/native/musicmute-native.exe") return "native-helper";
    if (path === "runtime/node/node.exe") return "node";
    if (/^runtime\/python\/.+\.(?:exe|dll|pyd|py|zip)$/u.test(path))
      return "python";
    if (/^app\/engine\/musicmute_engine\/[A-Za-z0-9_]+\.py$/u.test(path))
      return "engine";
    if (/^app\/dist\/.+\.js$/u.test(path)) return "worker-code";
    if (/^app\/node_modules\/.+\.(?:js|cjs|mjs|json|node|wasm)$/u.test(path))
      return "worker-dependency";
    if (/^runtime\/bin\/ff(?:mpeg|probe)\.exe$/u.test(path)) return "media";
    if (/^tools\/(?:downloader|youtube)\/.+$/u.test(path)) return "acquisition";
    const agents = {
      "agent/session-agent.cjs": "session-agent",
      "agent/login-worker.cjs": "login-worker",
      "agent/personal.cjs": "personal",
      "agent/fleet.cjs": "fleet",
      "agent/prepare.cjs": "prepare",
    } as const;
    if (Object.hasOwn(agents, path)) return agents[path as keyof typeof agents];
  }
  return invalid();
}
export function parseStoreCodeReference(value: unknown): StoreCodeReference {
  const row = exact(value, [
    "owner",
    "kind",
    "relativePath",
    "bytes",
    "sha256",
  ]);
  if (row.owner !== "gui" && row.owner !== "worker") invalid();
  const kind = classifyStoreCode(row.owner, row.relativePath);
  if (
    row.kind !== kind ||
    !Number.isSafeInteger(row.bytes) ||
    (row.bytes as number) < 1 ||
    (row.bytes as number) > 4 * 1024 ** 3 ||
    typeof row.sha256 !== "string" ||
    !HASH.test(row.sha256)
  )
    invalid();
  return Object.freeze({
    owner: row.owner,
    kind,
    relativePath: row.relativePath as string,
    bytes: row.bytes as number,
    sha256: row.sha256,
  });
}
export function parseStoreCodeReferenceJson(bytes: string | Uint8Array) {
  return parseStoreCodeReference(json(bytes));
}

export const STORE_DATA_OWNERSHIP = Object.freeze({
  model: "external-user-data",
  media: "external-user-data",
  jobs: "external-user-data",
  library: "external-user-data",
  preferences: "external-user-data",
  outbox: "external-user-data",
  "account-credentials": "external-user-data",
  "fleet-credentials": "external-user-data",
  leases: "external-user-data",
  "recovery-journals": "external-user-data",
  "gui-local-state": "gui-package",
  "worker-local-state": "worker-package",
} as const);
export type StoreLifecycleAction =
  | "close-gui"
  | "sign-out"
  | "remove-gui"
  | "remove-worker"
  | "remove-both"
  | "update-gui"
  | "update-worker"
  | "repair-gui"
  | "repair-worker"
  | "reset-gui"
  | "reset-worker"
  | "logoff";
export interface StoreLifecyclePlan {
  readonly action: StoreLifecycleAction;
  readonly removePackages: readonly StoreProductRole[];
  readonly retireGuiOwnedPersonalWork: boolean;
  readonly retireWorkerTree: boolean;
  readonly workerMayContinue: boolean;
  readonly clearGuiAccountSession: boolean;
  readonly deleteExternalData: false;
  readonly externalRetention: "requires-proven-nonvirtualized-root";
  readonly executableUpdates: "store-only";
}
/** A plan is not consent or permission to uninstall, reset, log off, or delete. */
export function planStoreLifecycle(
  action: unknown,
  value: unknown,
): StoreLifecyclePlan {
  const state = exact(value, ["guiInstalled", "workerInstalled", "loggedIn"]);
  if (Object.values(state).some((v) => typeof v !== "boolean")) invalid();
  const actions: readonly StoreLifecycleAction[] = [
    "close-gui",
    "sign-out",
    "remove-gui",
    "remove-worker",
    "remove-both",
    "update-gui",
    "update-worker",
    "repair-gui",
    "repair-worker",
    "reset-gui",
    "reset-worker",
    "logoff",
  ];
  if (
    typeof action !== "string" ||
    !actions.includes(action as StoreLifecycleAction)
  )
    invalid();
  const removeGui = action === "remove-gui" || action === "remove-both";
  const removeWorker = action === "remove-worker" || action === "remove-both";
  const retireWorker =
    removeWorker ||
    action === "update-worker" ||
    action === "repair-worker" ||
    action === "reset-worker" ||
    action === "logoff";
  return Object.freeze({
    action: action as StoreLifecycleAction,
    removePackages: Object.freeze([
      ...(removeGui && state.guiInstalled ? ["gui" as const] : []),
      ...(removeWorker && state.workerInstalled ? ["worker" as const] : []),
    ]),
    retireGuiOwnedPersonalWork:
      removeGui ||
      retireWorker ||
      ["close-gui", "update-gui", "repair-gui", "reset-gui"].includes(action),
    retireWorkerTree: retireWorker,
    workerMayContinue:
      state.workerInstalled === true &&
      state.loggedIn === true &&
      !retireWorker,
    clearGuiAccountSession: action === "sign-out" || action === "reset-gui",
    deleteExternalData: false,
    externalRetention: "requires-proven-nonvirtualized-root",
    executableUpdates: "store-only",
  });
}

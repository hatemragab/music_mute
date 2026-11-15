import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import { StoreNativeAuthority } from "./store-native.js";
import type { StoreResourceIndex } from "./store-resource-index.js";

export interface PackagedResourceEntry {
  placement: "app" | "resources";
  path: string;
  bytes: number;
  sha256: string;
}
export interface PackagedResourceIndex {
  version: 1;
  appId: "com.musicmute.local.windows";
  appVersion: string;
  payloadSha256: string;
  publisherSha256: string;
  entries: readonly PackagedResourceEntry[];
}
const HASH = /^[a-f0-9]{64}$/u;
const required = [
  "app:MusicMuteSession.exe",
  "app:MusicMuteChromeHost.exe",
  "resources:native/musicmute-native.exe",
  "resources:native/manifest.json",
  "resources:native/launcher-manifest.json",
  "resources:native/browser-manifest.json",
  "resources:native/browser-host.cjs",
  "resources:extension/manifest.json",
  "resources:extension/inventory.json",
  "resources:desktop-public-config.json",
  "resources:desktop-build.json",
  "resources:runtime-public-keys.json",
  "resources:runtime/runtime-metadata.json",
  "resources:runtime/runtime-source.json",
  "resources:update-channel.json",
  "resources:app-update-identity.json",
] as const;
export const REQUIRED_PACKAGED_RESOURCES: readonly string[] = required;
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys.sort().join()
  )
    throw new Error("PACKAGED_TRUST_INVALID");
  return value as Record<string, unknown>;
}
export function parsePackagedResourceIndex(
  value: unknown,
): PackagedResourceIndex {
  const row = exact(value, [
    "version",
    "appId",
    "appVersion",
    "payloadSha256",
    "publisherSha256",
    "entries",
  ]);
  if (
    row.version !== 1 ||
    row.appId !== "com.musicmute.local.windows" ||
    typeof row.appVersion !== "string" ||
    !/^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[A-Za-z0-9.-]+)?$/u.test(row.appVersion) ||
    typeof row.payloadSha256 !== "string" ||
    !HASH.test(row.payloadSha256) ||
    typeof row.publisherSha256 !== "string" ||
    !HASH.test(row.publisherSha256) ||
    !Array.isArray(row.entries) ||
    row.entries.length < required.length ||
    row.entries.length > 256
  )
    throw new Error("PACKAGED_TRUST_INVALID");
  const entries: PackagedResourceEntry[] = [],
    names = new Set<string>();
  for (const value of row.entries) {
    const entry = exact(value, ["placement", "path", "bytes", "sha256"]);
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
            part.endsWith(".") ||
            /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part),
        ) ||
      entry.path.toLowerCase() === "native/account-authority-manifest.json" ||
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) < 1 ||
      (entry.bytes as number) > 256 * 1024 ** 2 ||
      typeof entry.sha256 !== "string" ||
      !HASH.test(entry.sha256)
    )
      throw new Error("PACKAGED_TRUST_INVALID");
    const name = `${entry.placement}:${entry.path.toLowerCase()}`;
    if (names.has(name)) throw new Error("PACKAGED_TRUST_INVALID");
    names.add(name);
    entries.push(entry as unknown as PackagedResourceEntry);
  }
  for (const name of required)
    if (!names.has(name.toLowerCase()))
      throw new Error("PACKAGED_TRUST_INVALID");
  return {
    version: 1,
    appId: "com.musicmute.local.windows",
    appVersion: row.appVersion,
    payloadSha256: row.payloadSha256,
    publisherSha256: row.publisherSha256,
    entries,
  };
}
interface Trust {
  resources: string;
  app: string;
  index: PackagedResourceIndex;
  inventorySha256: string | null;
  entries: Map<string, PackagedResourceEntry>;
}
let trusted: Trust | undefined;
let storeAuthority: StoreNativeAuthority | undefined;
let storeMode = false;
let storeOpening: Promise<StoreNativeAuthority> | undefined;
let storeClosed = false;

function storePathsMatch(
  authority: StoreNativeAuthority,
  resourcesRoot: string,
  appPath: string,
): boolean {
  const resources = win32.join(
    authority.receipt.package.installedLocation,
    "app",
    "resources",
  );
  return (
    win32.isAbsolute(resourcesRoot) &&
    win32.isAbsolute(appPath) &&
    win32.resolve(resourcesRoot).toLowerCase() === resources.toLowerCase() &&
    win32.resolve(appPath).toLowerCase() ===
      win32.join(resources, "app.asar").toLowerCase()
  );
}

async function configureStoreResourceTrust(
  resourcesRoot: string,
  appPath: string,
): Promise<StoreResourceIndex> {
  if (trusted || storeClosed) throw new Error("PACKAGED_TRUST_INVALID");
  // Package presence selects the mode; only the fixed native bootstrap grants
  // authority. A failed Store bootstrap cannot fall back to legacy/source reads.
  storeMode = true;
  if (!storeAuthority) {
    storeOpening ??= StoreNativeAuthority.open();
    const opening = storeOpening;
    try {
      const authority = await opening;
      if (storeClosed || !storePathsMatch(authority, resourcesRoot, appPath)) {
        await authority.close();
        throw new Error("PACKAGED_TRUST_INVALID");
      }
      storeAuthority = authority;
    } finally {
      if (storeOpening === opening) storeOpening = undefined;
    }
  }
  if (!storePathsMatch(storeAuthority, resourcesRoot, appPath))
    throw new Error("PACKAGED_TRUST_INVALID");
  return storeAuthority.resourceIndex;
}

async function readStoreResource(
  path: string,
  maximum: number,
): Promise<Buffer> {
  const authority = storeAuthority;
  if (!authority || storeClosed) throw new Error("PACKAGED_TRUST_REQUIRED");
  if (
    !win32.isAbsolute(path) ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 256 * 1024 ** 2
  )
    throw new Error("PACKAGED_TRUST_INVALID");
  const appRoot = win32.join(
    authority.receipt.package.installedLocation,
    "app",
  );
  const resourcesRoot = win32.join(appRoot, "resources");
  const absolute = win32.resolve(path);
  const resourcesRelative = win32
    .relative(resourcesRoot, absolute)
    .split("\\")
    .join("/");
  const appRelative = win32.relative(appRoot, absolute).split("\\").join("/");
  const entry = authority.resourceIndex.entries.find(
    (candidate) =>
      candidate.path.toLowerCase() ===
      (candidate.placement === "resources"
        ? resourcesRelative
        : appRelative
      ).toLowerCase(),
  );
  if (!entry || entry.bytes > maximum)
    throw new Error("PACKAGED_TRUST_INVALID");
  return authority.readResource(
    `app/${entry.placement === "resources" ? "resources/" : ""}${entry.path}`,
    { bytes: entry.bytes, sha256: entry.sha256 },
    maximum,
  );
}

/** Release the resource helper after admitted desktop operations retire. Closing
 * keeps the Store mode fenced, including when bootstrap is still pending. */
export async function closePackagedResourceTrust(): Promise<void> {
  if (!storeMode) return;
  storeClosed = true;
  const authority = storeAuthority;
  storeAuthority = undefined;
  if (authority) await authority.close();
  else if (storeOpening)
    await storeOpening.then(
      (value) => value.close(),
      () => {},
    );
}
/** Activation may retain only these public, already sealed inputs for the independent worker. */
export const WORKER_RESOURCE_PATHS = [
  "desktop-build.json",
  "runtime-public-keys.json",
  "runtime/runtime-metadata.json",
  "runtime/runtime-source.json",
  "update-channel.json",
] as const;
export const WORKER_OPTIONAL_RESOURCE_PATHS = [
  "worker-catalog-update-channel.json",
] as const;
export interface WorkerResourceCapsule {
  version: 1;
  appVersion: string;
  publisherSha256: string;
  entries: readonly PackagedResourceEntry[];
}
export function parseWorkerResourceCapsule(
  value: unknown,
): WorkerResourceCapsule {
  const row = exact(value, [
    "version",
    "appVersion",
    "publisherSha256",
    "entries",
  ]);
  if (
    row.version !== 1 ||
    typeof row.appVersion !== "string" ||
    !/^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[A-Za-z0-9.-]+)?$/u.test(row.appVersion) ||
    typeof row.publisherSha256 !== "string" ||
    !HASH.test(row.publisherSha256) ||
    !Array.isArray(row.entries) ||
    (row.entries.length !== WORKER_RESOURCE_PATHS.length &&
      row.entries.length !== WORKER_RESOURCE_PATHS.length + 1)
  )
    throw new Error("PACKAGED_TRUST_INVALID");
  const entries = row.entries.map((value, i) => {
    const entry = exact(value, ["placement", "path", "bytes", "sha256"]);
    if (
      entry.placement !== "resources" ||
      entry.path !==
        [...WORKER_RESOURCE_PATHS, ...WORKER_OPTIONAL_RESOURCE_PATHS][i] ||
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) < 1 ||
      (entry.bytes as number) > 16384 ||
      typeof entry.sha256 !== "string" ||
      !HASH.test(entry.sha256)
    )
      throw new Error("PACKAGED_TRUST_INVALID");
    return structuredClone(entry) as unknown as PackagedResourceEntry;
  });
  return {
    version: 1,
    appVersion: row.appVersion,
    publisherSha256: row.publisherSha256,
    entries,
  };
}
/** There is deliberately no source-only fallback: publication requires the real ASAR seal. */
export async function captureWorkerResourceCapsule(): Promise<{
  capsule: WorkerResourceCapsule;
  files: readonly { path: string; bytes: Buffer }[];
}> {
  if (storeMode) throw new Error("PACKAGED_TRUST_INVALID");
  if (!trusted) throw new Error("PACKAGED_TRUST_REQUIRED");
  const entries = WORKER_RESOURCE_PATHS.map((path) => {
    const entry = trusted!.entries.get(`resources:${path}`);
    if (!entry) throw new Error("PACKAGED_TRUST_INVALID");
    return entry;
  });
  for (const path of WORKER_OPTIONAL_RESOURCE_PATHS) {
    const entry = trusted.entries.get(`resources:${path}`);
    if (entry) entries.push(entry);
  }
  const capsule = parseWorkerResourceCapsule({
    version: 1,
    appVersion: trusted.index.appVersion,
    publisherSha256: trusted.index.publisherSha256,
    entries,
  });
  const files = [];
  for (const entry of entries)
    files.push({ path: entry.path, bytes: await checked(trusted, entry) });
  return { capsule, files };
}
/** Only the authenticated signed-shim bootstrap can supply this protected capsule digest.
 * Node has no Electron resourcesPath; all later loaders still repeat the exact byte seal. */
export async function configureWorkerResourceTrust(
  resourcesRoot: string,
  capsuleBytes: Buffer,
  expectedDigest: string,
): Promise<WorkerResourceCapsule> {
  if (
    storeMode ||
    trusted ||
    typeof (process as NodeJS.Process & { resourcesPath?: string })
      .resourcesPath === "string" ||
    !HASH.test(expectedDigest) ||
    capsuleBytes.length > 8192 ||
    createHash("sha256").update(capsuleBytes).digest("hex") !== expectedDigest
  )
    throw new Error("PACKAGED_TRUST_INVALID");
  const capsule = parseWorkerResourceCapsule(
    parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(capsuleBytes),
      8192,
    ),
  );
  const next: Trust = {
    resources: resolve(resourcesRoot),
    app: dirname(resolve(resourcesRoot)),
    inventorySha256: null,
    index: {
      version: 1,
      appId: "com.musicmute.local.windows",
      appVersion: capsule.appVersion,
      publisherSha256: capsule.publisherSha256,
      payloadSha256: expectedDigest,
      entries: capsule.entries,
    },
    entries: new Map(
      capsule.entries.map((entry) => [`resources:${entry.path}`, entry]),
    ),
  };
  for (const entry of capsule.entries) await checked(next, entry);
  trusted = next;
  return structuredClone(capsule);
}
function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}
async function bounded(path: string, maximum: number): Promise<Buffer> {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > maximum
  )
    throw new Error("PACKAGED_TRUST_INVALID");
  const bytes = await readFile(path);
  if (bytes.length !== stat.size) throw new Error("PACKAGED_TRUST_INVALID");
  return bytes;
}
async function checked(
  trust: Trust,
  entry: PackagedResourceEntry,
): Promise<Buffer> {
  const root = entry.placement === "app" ? trust.app : trust.resources;
  const path = resolve(root, ...entry.path.split("/"));
  if (!isAbsolute(path) || relative(root, path).startsWith(`..${sep}`))
    throw new Error("PACKAGED_TRUST_INVALID");
  for (let directory = dirname(path); ;) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("PACKAGED_TRUST_INVALID");
    if (samePath(directory, root)) break;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("PACKAGED_TRUST_INVALID");
    directory = parent;
  }
  const bytes = await bounded(path, entry.bytes);
  if (
    bytes.length !== entry.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== entry.sha256
  )
    throw new Error("PACKAGED_TRUST_INVALID");
  return bytes;
}
/** The caller supplies Electron's real app.getAppPath()/process.resourcesPath.
 * Windows Electron must first enforce signed EXE + embedded ASAR integrity/fuses.
 * This reads the index from that ASAR, never from an outside mutable sidecar. */
export async function configurePackagedResourceTrust(
  resourcesRoot: string,
  appPath: string,
): Promise<PackagedResourceIndex | StoreResourceIndex> {
  if (
    (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore ===
    true
  )
    return configureStoreResourceTrust(resourcesRoot, appPath);
  if (storeMode || storeClosed) throw new Error("PACKAGED_TRUST_INVALID");
  if (!samePath(appPath, join(resourcesRoot, "app.asar")))
    throw new Error("PACKAGED_TRUST_INVALID");
  if (
    trusted &&
    (!samePath(trusted.resources, resourcesRoot) ||
      !samePath(join(trusted.resources, "app.asar"), appPath))
  )
    throw new Error("PACKAGED_TRUST_INVALID");
  const bytes = await bounded(join(appPath, "packaged-resources.json"), 65536);
  const index = parsePackagedResourceIndex(
    parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      65536,
    ),
  );
  const next: Trust = {
    resources: resolve(resourcesRoot),
    app: dirname(resolve(resourcesRoot)),
    index,
    inventorySha256: createHash("sha256").update(bytes).digest("hex"),
    entries: new Map(
      index.entries.map((entry) => [
        `${entry.placement}:${entry.path.toLowerCase()}`,
        entry,
      ]),
    ),
  };
  // Bounded small app/resource files, never runtime/model hashes or inference.
  for (const entry of index.entries) await checked(next, entry);
  if (trusted && JSON.stringify(trusted.index) !== JSON.stringify(index))
    throw new Error("PACKAGED_TRUST_INVALID");
  trusted = next;
  return structuredClone(index);
}
/** Digest of the actual index bytes inside the already validated sealed ASAR.
 * Development and the smaller worker capsule have no full app inventory. */
export function packagedResourceInventorySha256(): string | null {
  if (storeMode) return storeAuthority?.resourceInventorySha256 ?? null;
  return trusted?.inventorySha256 ?? null;
}
/** All later metadata/helper opens must repeat the sealed byte binding. */
export async function readPackagedResource(
  path: string,
  maximum: number,
): Promise<Buffer> {
  if (storeMode) return readStoreResource(path, maximum);
  if (!trusted) {
    if (
      typeof (process as NodeJS.Process & { resourcesPath?: string })
        .resourcesPath === "string"
    )
      throw new Error("PACKAGED_TRUST_REQUIRED");
    // Source-only Node fixtures do not establish packaged trust.
    return bounded(path, maximum);
  }
  const resourcesRelative = relative(trusted.resources, resolve(path))
    .split(sep)
    .join("/");
  const appRelative = relative(trusted.app, resolve(path)).split(sep).join("/");
  const entry =
    trusted.entries.get(`resources:${resourcesRelative.toLowerCase()}`) ??
    trusted.entries.get(`app:${appRelative.toLowerCase()}`);
  if (!entry || entry.bytes > maximum)
    throw new Error("PACKAGED_TRUST_INVALID");
  return checked(trusted, entry);
}
export function assertPackagedPublisher(publisherSha256: string): void {
  if (storeMode) throw new Error("PACKAGED_TRUST_INVALID");
  if (trusted && publisherSha256 !== trusted.index.publisherSha256)
    throw new Error("PACKAGED_TRUST_INVALID");
  if (
    !trusted &&
    typeof (process as NodeJS.Process & { resourcesPath?: string })
      .resourcesPath === "string"
  )
    throw new Error("PACKAGED_TRUST_REQUIRED");
}
/** Self EXE digest is derived after signing and cannot live in its own ASAR.
 * Native WinVerifyTrust must verify it against the ASAR-sealed publisher pin. */
export async function readPostSignAppPin(
  path: string,
  maximum: number,
): Promise<Buffer> {
  if (storeMode) throw new Error("PACKAGED_TRUST_INVALID");
  if (
    trusted &&
    !samePath(
      path,
      join(trusted.resources, "native", "account-authority-manifest.json"),
    )
  )
    throw new Error("PACKAGED_TRUST_INVALID");
  if (
    !trusted &&
    typeof (process as NodeJS.Process & { resourcesPath?: string })
      .resourcesPath === "string"
  )
    throw new Error("PACKAGED_TRUST_REQUIRED");
  return bounded(path, maximum);
}
export interface PackagedDesktopBuild {
  version: 1;
  appVersion: string;
  buildNumber: number;
}
export async function loadPackagedDesktopBuild(
  resourcesRoot: string,
  expectedAppVersion?: string,
): Promise<PackagedDesktopBuild> {
  const bytes = await readPackagedResource(
      join(resourcesRoot, "desktop-build.json"),
      4096,
    ),
    row = exact(
      parseStrictJson(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        4096,
      ),
      ["version", "appVersion", "buildNumber"],
    );
  if (
    row.version !== 1 ||
    typeof row.appVersion !== "string" ||
    !/^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[A-Za-z0-9.-]+)?$/u.test(row.appVersion) ||
    !Number.isSafeInteger(row.buildNumber) ||
    (row.buildNumber as number) < 1 ||
    (row.buildNumber as number) > 2147483647 ||
    (trusted && row.appVersion !== trusted.index.appVersion) ||
    (storeMode &&
      (!storeAuthority ||
        row.appVersion !== storeAuthority.resourceIndex.appVersion ||
        row.buildNumber !== storeAuthority.resourceIndex.buildNumber)) ||
    (expectedAppVersion !== undefined && row.appVersion !== expectedAppVersion)
  )
    throw new Error("PACKAGED_TRUST_INVALID");
  return {
    version: 1,
    appVersion: row.appVersion,
    buildNumber: row.buildNumber as number,
  };
}

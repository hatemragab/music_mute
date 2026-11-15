import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Configuration } from "electron-builder";
import type { AfterExtractContext } from "app-builder-lib";
import type { Entry, ZipFile } from "yauzl";
import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
import { auditWindowsX64Binary } from "../../../worker/src/platform/windows/pe-audit.js";
import { nativeAcceptanceEnvironment } from "../../acceptance/native-run.js";
import {
  validatePublicAccountConfiguration,
  type PublicAccountConfiguration,
} from "../../src/main/account/account-controller.js";
import {
  parseStoreResourceIndex,
  parseStoreResourceIndexBytes,
  type StoreResourceIndex,
} from "../../src/main/browser/store-resource-index.js";
import {
  STORE_PRODUCTS,
  parseStoreBuildNumber,
} from "../../src/shared/store-contracts.js";
import {
  PACKAGE_AUTHORITY_KIND,
  PACKAGE_AUTHORITY_PROFILE,
} from "../../src/shared/package-build-profile.js";
import {
  assertSecretFreePublicBytes,
  packageEntry,
  packageFile,
  packageInventory,
} from "../validate-assets.js";
import {
  auditStoreGui,
  auditStorePayload,
  parseStoreBuildGraphs,
} from "./audit.js";
import {
  buildStoreIcon,
  stageStoreAssets,
  STORE_ICON_SOURCE,
} from "./assets.js";
import {
  hashStoreFile,
  listStorePayload,
  safeStoreRelativePath,
  type StoreInventoryEntry,
} from "./inventory.js";
import { storeElectronDirectoryConfig } from "./manifest.js";
import { StoreAsarWriterJoin } from "./asar-writer.js";
import {
  parseStoreNativeBuildInputs,
  verifyStoreNativeProvenance,
  type StoreNativeBuildInputs,
} from "./native-provenance.js";

const require = createRequire(import.meta.url),
  execute = promisify(execFile);
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
// Retrieved from the actual public GitHub release metadata and corroborated
// against the exact SHASUMS256.txt binary-marker row on 2026-10-12. The builder
// accepts this pre-downloaded archive only; no download/mirror fallback exists.
export const STORE_GUI_ELECTRON = Object.freeze({
  version: "44.7.0",
  builderVersion: "26.15.3",
  file: "electron-v44.7.0-win32-x64.zip",
  bytes: 158293649,
  sha256: "eee30dc8fa1f5ea95490e59f44e46ea68dd24c6e93d22facf70fe5c2d4c2665c",
  source:
    "https://github.com/electron/electron/releases/download/v44.7.0/electron-v44.7.0-win32-x64.zip",
  releaseMetadata:
    "https://api.github.com/repos/electron/electron/releases/tags/v44.7.0",
  releaseId: 405956019,
  assetId: 619269304,
  retrievedAt: "2026-10-12",
  checksumsSha256:
    "ae1159fdb6d008ca267c267edb6dd82ded692529c9a930386452511aaaddb7b1",
});
export const STORE_GUI_NATIVE_FILES = Object.freeze([
  "MusicMuteChromeHost.exe",
  "MusicMuteSession.exe",
  "musicmute-native.exe",
] as const);
interface FilePin {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface StoreGuiBuildInputs {
  readonly version: 1;
  readonly purpose: "unsigned-store-gui-directory";
  readonly appBuildNumber: number;
  readonly electronArchivePath: string;
  readonly publicConfiguration: FilePin;
  readonly nativeBuild: StoreNativeBuildInputs;
}
function invalid(code = "STORE_GUI_INPUT_INVALID"): never {
  throw new Error(code);
}
function exact(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value),
    names = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    names.length !== fields.length ||
    names.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    invalid();
  const row: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
    row[field] = descriptor.value;
  }
  return row;
}
function path(value: unknown) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value === dirname(value) ||
    value.length > 4096 ||
    /[\p{Cc}\p{Cf};"$<>|*?]/u.test(value)
  )
    invalid();
  return value;
}
function pin(value: unknown, maximum: number, relativePath = false): FilePin {
  const row = exact(value, ["path", "bytes", "sha256"]);
  const name = relativePath ? safeStoreRelativePath(row.path) : path(row.path);
  if (
    !Number.isSafeInteger(row.bytes) ||
    (row.bytes as number) < 1 ||
    (row.bytes as number) > maximum ||
    typeof row.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.sha256)
  )
    invalid();
  return Object.freeze({
    path: name,
    bytes: row.bytes as number,
    sha256: row.sha256,
  });
}
export function parseStoreGuiBuildInputs(value: unknown): StoreGuiBuildInputs {
  const row = exact(value, [
    "version",
    "purpose",
    "appBuildNumber",
    "electronArchivePath",
    "publicConfiguration",
    "nativeBuild",
  ]);
  if (row.version !== 1 || row.purpose !== "unsigned-store-gui-directory")
    invalid();
  let nativeBuild: StoreNativeBuildInputs;
  try {
    nativeBuild = parseStoreNativeBuildInputs(row.nativeBuild, "gui");
  } catch {
    invalid();
  }
  const archive = path(row.electronArchivePath);
  if (basename(archive) !== STORE_GUI_ELECTRON.file) invalid();
  return Object.freeze({
    version: 1,
    purpose: row.purpose,
    appBuildNumber: parseStoreBuildNumber(row.appBuildNumber),
    electronArchivePath: archive,
    publicConfiguration: pin(row.publicConfiguration, 4096),
    nativeBuild,
  });
}
export function parseStoreGuiBuildInputsBytes(bytes: Uint8Array) {
  if (bytes.byteLength < 1 || bytes.byteLength > 16384) invalid();
  return parseStoreGuiBuildInputs(
    parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      16384,
      256,
    ),
  );
}
async function physical(value: string, directory: boolean) {
  const resolved = await realpath(value);
  if (resolved !== value) invalid();
  for (let candidate = value; ; candidate = dirname(candidate)) {
    const info = await lstat(candidate);
    if (
      info.isSymbolicLink() ||
      ((candidate !== value || directory) && !info.isDirectory())
    )
      invalid();
    if (candidate === dirname(candidate)) break;
  }
}
/** The pinned custom ZIP retains Electron's default ASAR. Retire it before the
 * builder enumerates archives for its embedded integrity resource. */
export function storeGuiAfterExtractHook(
  stageRoot: string,
  framework: readonly StoreInventoryEntry[],
) {
  const stage = path(stageRoot),
    outDir = join(stage, "electron-output"),
    output = join(outDir, "win-unpacked"),
    defaultArchive = framework.find(
      (row) => row.path === "resources/default_app.asar",
    );
  if (!defaultArchive) invalid("STORE_GUI_DEFAULT_ARCHIVE_MISSING");
  const expected = {
    bytes: defaultArchive.bytes,
    sha256: defaultArchive.sha256,
  };
  return async (
    context: Pick<
      AfterExtractContext,
      "appOutDir" | "outDir" | "electronPlatformName" | "arch"
    >,
  ) => {
    if (
      context.appOutDir !== output ||
      context.outDir !== outDir ||
      context.electronPlatformName !== "win32" ||
      context.arch !== 1 // Pinned builder Arch.x64.
    )
      invalid("STORE_GUI_EXTRACTED_OUTPUT_DENIED");
    await physical(stage, true);
    await physical(output, true);
    const file = join(output, "resources", "default_app.asar");
    await physical(file, false);
    const actual = await hashStoreFile(file);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
      invalid("STORE_GUI_DEFAULT_ARCHIVE_CHANGED");
    await rm(file);
  };
}
async function readPin(value: FilePin, maximum: number) {
  await physical(value.path, false);
  const bytes = await packageFile(value.path, maximum);
  if (bytes.length !== value.bytes || digest(bytes) !== value.sha256)
    invalid("STORE_GUI_INPUT_CHANGED");
  return bytes;
}
async function newStage(
  stage: string,
  component: string,
  inputs: StoreGuiBuildInputs,
) {
  await physical(dirname(stage), true);
  await physical(component, true);
  const lower = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const inside = (parent: string, child: string) =>
    lower(parent) === lower(child) ||
    lower(child).startsWith(lower(parent) + sep);
  const sourceRoots = [
    resolve(component, ".."),
    inputs.nativeBuild.directory,
    dirname(inputs.electronArchivePath),
    dirname(inputs.publicConfiguration.path),
  ];
  if (sourceRoots.some((root) => inside(root, stage) || inside(stage, root)))
    invalid();
  try {
    await lstat(stage);
    invalid("STORE_GUI_STAGE_EXISTS");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
function json(bytes: Uint8Array, maximum: number) {
  return parseStrictJson(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    maximum,
    16384,
  );
}

const GUI_BUILD_FILES = [
  "windows-desktop/package.json",
  "windows-desktop/package-lock.json",
  "windows-desktop/tsconfig.json",
  "windows-desktop/scripts/build.mjs",
  "windows-desktop/scripts/agent-build-inputs.mjs",
  "windows-desktop/packaging/validate-assets.ts",
  "windows-desktop/packaging/inventory.cjs",
  "windows-desktop/packaging/shared-extension.mjs",
  "windows-desktop/packaging/store/document-json.ts",
  "windows-desktop/packaging/store/inventory.ts",
  "windows-desktop/packaging/notices/google-branding.txt",
  "chrome-extension/package.json",
  "chrome-extension/tsconfig.json",
  "chrome-extension/scripts/build-extension.mjs",
  "chrome-extension/scripts/package-chrome.mjs",
  "chrome-extension/macos/Resources/Fonts/NotoSansArabic.ttf",
  "chrome-extension/macos/Resources/licenses/noto_sans_arabic_ofl.txt",
  "worker/package.json",
  "worker/tsconfig.json",
] as const;
const GUI_BUILD_TREES = [
  ["windows-desktop/src", true],
  ["windows-desktop/acceptance", true],
  ["windows-desktop/node_modules", false],
  ["chrome-extension/src", true],
  ["chrome-extension/node_modules/esbuild", false],
  ["chrome-extension/node_modules/@esbuild", false],
  ["worker/src", true],
  ["worker/protocol", true],
  ["worker/native/windows-consumer", false],
] as const;
const GUI_SOURCE_SUFFIX = /\.(?:ts|tsx|json|html|css|svg|png|ttf|woff2)$/u;
const GUI_IDENTITY_FIELDS = [
  "dev",
  "ino",
  "size",
  "nlink",
  "ctimeNs",
  "mtimeNs",
  "birthtimeNs",
] as const;
type GuiInputIdentity = Awaited<ReturnType<typeof guiInputIdentity>>;
async function guiInputIdentity(name: string) {
  const info = await lstat(name, { bigint: true });
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1n ||
    info.size < 0n ||
    info.size > 512n * 1024n ** 2n
  )
    invalid("STORE_GUI_BUILD_INPUT_INVALID");
  return info;
}
function sameGuiInput(before: GuiInputIdentity, after: GuiInputIdentity) {
  if (GUI_IDENTITY_FIELDS.some((field) => before[field] !== after[field]))
    invalid("STORE_GUI_BUILD_INPUT_CHANGED");
}

async function copyGuiBuildInput(
  source: string,
  destination: string,
  pin: Omit<StoreInventoryEntry, "path">,
  identity: GuiInputIdentity,
) {
  const input = await open(
    source,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let output: Awaited<ReturnType<typeof open>> | undefined, failure: unknown;
  try {
    sameGuiInput(identity, await input.stat({ bigint: true }));
    output = await open(destination, "wx");
    const buffer = Buffer.alloc(1024 ** 2),
      hash = createHash("sha256");
    let at = 0;
    while (at < pin.bytes) {
      const read = await input.read(
        buffer,
        0,
        Math.min(buffer.length, pin.bytes - at),
        at,
      );
      if (!read.bytesRead) invalid("STORE_GUI_BUILD_COPY_CHANGED");
      hash.update(buffer.subarray(0, read.bytesRead));
      for (let written = 0; written < read.bytesRead;) {
        const result = await output.write(
          buffer,
          written,
          read.bytesRead - written,
          at + written,
        );
        if (!result.bytesWritten) invalid("STORE_GUI_BUILD_COPY_CHANGED");
        written += result.bytesWritten;
      }
      at += read.bytesRead;
    }
    if (
      (await input.read(buffer, 0, 1, at)).bytesRead ||
      hash.digest("hex") !== pin.sha256
    )
      invalid("STORE_GUI_BUILD_COPY_CHANGED");
    sameGuiInput(identity, await input.stat({ bigint: true }));
    sameGuiInput(identity, await guiInputIdentity(source));
    await output.sync();
  } catch (error) {
    failure = error;
  }
  const closes = await Promise.allSettled([
    input.close(),
    ...(output ? [output.close()] : []),
  ]);
  const errors = closes
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failure || errors.length)
    throw failure && errors.length
      ? new AggregateError(
          [failure, ...errors],
          "STORE_GUI_BUILD_COPY_CLOSE_FAILED",
        )
      : (failure ??
          new AggregateError(errors, "STORE_GUI_BUILD_COPY_CLOSE_FAILED"));
}

/** Only this exclusive physical copy may execute build tools. Source inputs
 * retain all seven identity fields; generated dist is published separately. */
export async function createStoreGuiBuildWorkspace(
  componentRootValue: string,
  workspaceRootValue: string,
) {
  const component = path(componentRootValue),
    workspace = path(workspaceRootValue),
    repository = dirname(component);
  if (basename(component) !== "windows-desktop")
    invalid("STORE_GUI_BUILD_WORKSPACE_INVALID");
  await physical(component, true);
  await physical(dirname(workspace), true);
  const lower = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  if (
    lower(workspace) === lower(repository) ||
    lower(workspace).startsWith(lower(repository) + sep) ||
    lower(repository).startsWith(lower(workspace) + sep)
  )
    invalid("STORE_GUI_BUILD_WORKSPACE_INVALID");
  type Source = {
    key: string;
    info: GuiInputIdentity;
    pin: Omit<StoreInventoryEntry, "path">;
  };
  async function collect() {
    const rows: Source[] = [],
      names = new Set<string>(),
      directoryNames = new Set<string>();
    let total = 0,
      directories = 0;
    async function leaf(key: string) {
      safeStoreRelativePath(key);
      if (names.has(key.toLowerCase()) || rows.length >= 16384)
        invalid("STORE_GUI_BUILD_INPUT_INVALID");
      names.add(key.toLowerCase());
      const name = join(repository, ...key.split("/"));
      await physical(dirname(name), true);
      const info = await guiInputIdentity(name),
        pin = await hashStoreFile(name);
      sameGuiInput(info, await guiInputIdentity(name));
      total += pin.bytes;
      if (total > 2 * 1024 ** 3) invalid("STORE_GUI_BUILD_INPUT_INVALID");
      rows.push({ key, info, pin });
    }
    async function tree(key: string, sourcesOnly: boolean, depth = 0) {
      if (depth > 32 || ++directories > 8192)
        invalid("STORE_GUI_BUILD_INPUT_INVALID");
      safeStoreRelativePath(key);
      if (directoryNames.has(key.toLowerCase()))
        invalid("STORE_GUI_BUILD_INPUT_INVALID");
      directoryNames.add(key.toLowerCase());
      const directory = join(repository, ...key.split("/"));
      await physical(directory, true);
      for (const name of (await readdir(directory)).sort()) {
        // PATH shims and private development state never enter this copy.
        if (name.startsWith(".")) continue;
        const next = safeStoreRelativePath(key + "/" + name),
          info = await lstat(join(repository, ...next.split("/")));
        if (info.isSymbolicLink()) invalid("STORE_GUI_BUILD_INPUT_INVALID");
        if (info.isDirectory()) await tree(next, sourcesOnly, depth + 1);
        else if (
          info.isFile() &&
          (!sourcesOnly || GUI_SOURCE_SUFFIX.test(name))
        )
          await leaf(next);
        else if (!info.isFile()) invalid("STORE_GUI_BUILD_INPUT_INVALID");
      }
    }
    for (const key of GUI_BUILD_FILES) await leaf(key);
    for (const [key, sourcesOnly] of GUI_BUILD_TREES)
      await tree(key, sourcesOnly);
    return rows.sort((a, b) => a.key.localeCompare(b.key));
  }
  const original = await collect();
  await mkdir(workspace); // No adoption or overwrite of another build folder.
  for (const row of original) {
    const source = join(repository, ...row.key.split("/")),
      destination = join(workspace, ...row.key.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await physical(dirname(destination), true);
    await copyGuiBuildInput(source, destination, row.pin, row.info);
    const copied = await guiInputIdentity(destination),
      pin = await hashStoreFile(destination);
    if (
      (copied.dev === row.info.dev && copied.ino === row.info.ino) ||
      JSON.stringify(pin) !== JSON.stringify(row.pin)
    )
      invalid("STORE_GUI_BUILD_COPY_CHANGED");
    sameGuiInput(row.info, await guiInputIdentity(source));
  }
  async function verifySource() {
    const current = await collect();
    if (current.length !== original.length)
      invalid("STORE_GUI_BUILD_INPUT_CHANGED");
    for (let index = 0; index < original.length; index++) {
      const before = original[index]!,
        after = current[index]!;
      if (
        before.key !== after.key ||
        JSON.stringify(before.pin) !== JSON.stringify(after.pin)
      )
        invalid("STORE_GUI_BUILD_INPUT_CHANGED");
      sameGuiInput(before.info, after.info);
      const copied = join(workspace, ...before.key.split("/"));
      await physical(dirname(copied), true);
      const identity = await guiInputIdentity(copied);
      if (
        (identity.dev === before.info.dev &&
          identity.ino === before.info.ino) ||
        JSON.stringify(await hashStoreFile(copied)) !==
          JSON.stringify(before.pin)
      )
        invalid("STORE_GUI_BUILD_COPY_CHANGED");
    }
  }
  await verifySource();
  return { componentRoot: join(workspace, "windows-desktop"), verifySource };
}

async function publishStoreGuiBuildOutputs(source: string, component: string) {
  const built = join(source, "dist"),
    output = join(component, "dist"),
    names = await packageInventory(built);
  await mkdir(output, { recursive: true });
  await physical(output, true);
  for (const key of names) {
    safeStoreRelativePath(key);
    const input = join(built, ...key.split("/")),
      destination = join(output, ...key.split("/")),
      pin = await hashStoreFile(input);
    await mkdir(dirname(destination), { recursive: true });
    await physical(dirname(destination), true);
    try {
      await guiInputIdentity(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = destination + ".store-build-new";
    await copyGuiBuildInput(
      input,
      temporary,
      pin,
      await guiInputIdentity(input),
    );
    await physical(dirname(destination), true);
    await rename(temporary, destination);
    if (
      JSON.stringify(await hashStoreFile(destination)) !==
        JSON.stringify(pin) ||
      JSON.stringify(await hashStoreFile(input)) !== JSON.stringify(pin)
    )
      invalid("STORE_GUI_BUILD_OUTPUT_CHANGED");
  }
}
export async function verifyStoreGuiNativeProvenance(
  inputsValue: unknown,
  componentRootValue: string,
) {
  const inputs = parseStoreGuiBuildInputs(inputsValue),
    componentRoot = path(componentRootValue);
  try {
    return await verifyStoreNativeProvenance(
      inputs.nativeBuild,
      "gui",
      componentRoot,
    );
  } catch {
    invalid("STORE_GUI_NATIVE_PROVENANCE_INVALID");
  }
}
async function nativeBytes(inputs: StoreGuiBuildInputs) {
  const { NtExecutable, NtExecutableResource } =
    require("resedit") as typeof import("resedit");
  const result = new Map<string, Buffer>();
  for (const row of inputs.nativeBuild.executables) {
    const name = join(inputs.nativeBuild.directory, row.path),
      bytes = await readPin({ ...row, path: name }, 16 * 1024 ** 2);
    await auditWindowsX64Binary(name);
    const pe = NtExecutable.from(bytes),
      resource = NtExecutableResource.from(pe);
    const manifests = resource.entries.filter(
      (entry) => entry.type === 24 && entry.id === 1,
    );
    if (manifests.length !== 1) invalid("STORE_GUI_NATIVE_MANIFEST_INVALID");
    const manifest = new TextDecoder("utf-8", { fatal: true }).decode(
      manifests[0]!.bin,
    );
    const levels = [
      ...manifest.matchAll(/<requestedExecutionLevel\s+([^>]+)\/?\s*>/gu),
    ];
    if (
      /<!DOCTYPE|<!ENTITY/iu.test(manifest) ||
      levels.length !== 1 ||
      !/\blevel=["']asInvoker["']/u.test(levels[0]![1]!) ||
      !/\buiAccess=["']false["']/u.test(levels[0]![1]!) ||
      (levels[0]![1]!.match(/\blevel\s*=/gu)?.length ?? 0) !== 1 ||
      (levels[0]![1]!.match(/\buiAccess\s*=/gu)?.length ?? 0) !== 1
    )
      invalid("STORE_GUI_NATIVE_MANIFEST_INVALID");
    if (
      JSON.stringify(await hashStoreFile(name)) !==
      JSON.stringify({ bytes: row.bytes, sha256: row.sha256 })
    )
      invalid("STORE_GUI_INPUT_CHANGED");
    result.set(row.path, bytes);
  }
  return result;
}
interface InventoryHelpers {
  executedBuildGraphs(value: unknown): unknown[];
  bundledNotices(root: string, graphs: unknown[]): Promise<string>;
  verifyLicensedBuildAssets(root: string, dist: string): Promise<string[]>;
}
const compiledPayloadPath =
  /^(?:main\/main\.cjs|preload\/index\.cjs|renderer\/.*\.(?:html|js|css|ttf|woff2|png|svg)|licenses\/.*\.txt)$/u;
/** Only executed compiler outputs and verified fixed assets belong in ASAR.
 * Old renderer/license files left by an earlier build cannot enter a candidate. */
export function storeGuiCompiledPayload(
  built: readonly string[],
  executedGraphs: readonly unknown[],
  licensedAssets: readonly string[],
) {
  const expected = new Set<string>(["renderer/index.html"]);
  for (const name of licensedAssets) {
    if (!compiledPayloadPath.test(safeStoreRelativePath(name))) invalid();
    expected.add(name);
  }
  for (const value of executedGraphs) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    const outputs = (value as { outputs?: unknown }).outputs;
    if (!outputs || typeof outputs !== "object" || Array.isArray(outputs))
      invalid();
    for (const name of Object.keys(outputs)) {
      if (!name.startsWith("dist/")) invalid();
      const relative = safeStoreRelativePath(name.slice(5));
      if (compiledPayloadPath.test(relative)) expected.add(relative);
    }
  }
  const selected = built
    .filter((name) => compiledPayloadPath.test(name))
    .sort();
  if (
    JSON.stringify(selected) !== JSON.stringify([...expected].sort()) ||
    ![
      "main/main.cjs",
      "preload/index.cjs",
      "renderer/index.html",
      "renderer/app.js",
    ].every((name) => expected.has(name))
  )
    invalid("STORE_GUI_SOURCE_BUILD_CENSUS_INVALID");
  return selected;
}
/** Portable source/resource staging only. This never starts a consumer app,
 * builder, signer or installer, and cannot create production Store authority. */
export async function stageStoreGuiResources(
  inputsValue: unknown,
  componentRootValue: string,
  stageRootValue: string,
) {
  const inputs = parseStoreGuiBuildInputs(inputsValue),
    componentRoot = path(componentRootValue),
    stage = path(stageRootValue);
  await newStage(stage, componentRoot, inputs);
  const provenance = await verifyStoreGuiNativeProvenance(
      inputs,
      componentRoot,
    ),
    native = await nativeBytes(inputs);
  const publicBytes = await readPin(inputs.publicConfiguration, 4096);
  assertSecretFreePublicBytes(publicBytes);
  const configuration = exact(json(publicBytes, 4096), [
    "backend_base_url",
    "firebase_api_key",
    "firebase_project_id",
    "google_desktop_client_id",
  ]);
  const account = validatePublicAccountConfiguration(
    configuration as unknown as PublicAccountConfiguration,
  );
  if (!account.google_desktop_client_id)
    invalid("STORE_GUI_PUBLIC_CONFIG_INVALID");
  const originalValue = json(
    await packageFile(join(componentRoot, "package.json"), 65536),
    65536,
  );
  const original = exact(originalValue, Object.keys(originalValue as object));
  if (
    original.version !== STORE_PRODUCTS.gui.appVersion ||
    original.name !== "musicmute-windows-desktop"
  )
    invalid();
  const inventory = require(
    join(componentRoot, "packaging/inventory.cjs"),
  ) as InventoryHelpers;
  const graphBytes = await packageFile(
      join(componentRoot, "dist/build-metafiles.json"),
      4 * 1024 ** 2,
    ),
    graphs = parseStoreBuildGraphs(graphBytes);
  const executedGraphs = inventory.executedBuildGraphs(graphs);
  const licensedAssets = await inventory.verifyLicensedBuildAssets(
    componentRoot,
    join(componentRoot, "dist"),
  );
  const built = await packageInventory(join(componentRoot, "dist"));
  const selected = storeGuiCompiledPayload(
    built,
    executedGraphs,
    licensedAssets,
  );
  const code = new Map<string, Buffer>();
  for (const name of selected)
    code.set(
      name,
      await packageFile(join(componentRoot, "dist", name), 64 * 1024 ** 2),
    );
  const browserHost = await packageFile(
    join(componentRoot, "dist/agent/browser-host.cjs"),
    32 * 1024 ** 2,
  );
  const artwork = await packageFile(
    join(componentRoot, "..", ...STORE_ICON_SOURCE.path.split("/")),
    STORE_ICON_SOURCE.bytes,
  );
  const notices = Buffer.from(
    await inventory.bundledNotices(componentRoot, graphs),
  );
  await mkdir(stage);
  for (const folder of [
    "application/dist",
    "resources/native",
    "resources/extension",
    "resources/notices",
    "root",
  ])
    await mkdir(join(stage, folder), { recursive: true });
  const put = async (name: string, bytes: Uint8Array) => {
    await mkdir(dirname(join(stage, name)), { recursive: true });
    await writeFile(join(stage, name), bytes, { flag: "wx" });
  };
  for (const [name, bytes] of code)
    await put(`application/dist/${name}`, bytes);
  await put("resources/desktop-public-config.json", publicBytes);
  await put(
    "resources/native/musicmute-native.exe",
    native.get("musicmute-native.exe")!,
  );
  await put("root/MusicMuteSession.exe", native.get("MusicMuteSession.exe")!);
  await put(
    "root/MusicMuteChromeHost.exe",
    native.get("MusicMuteChromeHost.exe")!,
  );
  await put("resources/native/browser-host.cjs", browserHost);
  await put("resources/notices/bundled.txt", notices);
  await stageStoreAssets(artwork, join(stage, "assets"));
  await put("assets/app-icon.ico", buildStoreIcon(artwork));
  const { stageSharedExtension } = (await import(
    pathToFileURL(join(componentRoot, "packaging/shared-extension.mjs")).href
  )) as {
    stageSharedExtension(
      destination: string,
      read: typeof packageFile,
    ): Promise<{ extensionId: string }>;
  };
  const extension = await stageSharedExtension(
    join(stage, "resources/extension"),
    packageFile,
  );
  const putJson = (name: string, value: unknown) =>
    put(name, Buffer.from(JSON.stringify(value) + "\n"));
  if (extension.extensionId !== "acmgefmmndomcpdlgnafkjbgobinllep")
    invalid("STORE_GUI_SHARED_EXTENSION_ID_INVALID");
  await putJson("resources/native/com.musicmute.local.json", {
    name: "com.musicmute.local",
    description: "MusicMute Windows companion",
    path: "../../MusicMuteChromeHost.exe",
    type: "stdio",
    allowed_origins: ["chrome-extension://acmgefmmndomcpdlgnafkjbgobinllep/"],
  });
  await putJson("resources/desktop-build.json", {
    version: 1,
    appVersion: STORE_PRODUCTS.gui.appVersion,
    buildNumber: inputs.appBuildNumber,
  });
  await putJson("resources/native/manifest.json", {
    version: 1,
    sha256: digest(native.get("musicmute-native.exe")!),
  });
  await putJson("resources/native/launcher-manifest.json", {
    version: 1,
    sha256: digest(native.get("MusicMuteSession.exe")!),
    bytes: native.get("MusicMuteSession.exe")!.length,
  });
  await putJson("resources/native/browser-manifest.json", {
    version: 1,
    extensionId: extension.extensionId,
    hostSha256: digest(native.get("MusicMuteChromeHost.exe")!),
    hostBytes: native.get("MusicMuteChromeHost.exe")!.length,
    entrySha256: digest(browserHost),
    entryBytes: browserHost.length,
  });
  const entries = [];
  for (const placement of ["resources", "root"] as const)
    for (const name of await packageInventory(join(stage, placement)))
      entries.push(
        packageEntry(
          placement === "root" ? "app" : "resources",
          name,
          await packageFile(join(stage, placement, name), 64 * 1024 ** 2),
        ),
      );
  entries.sort((a, b) =>
    `${a.placement}:${a.path}` < `${b.placement}:${b.path}` ? -1 : 1,
  );
  const product = STORE_PRODUCTS.gui;
  const resourceIndex = parseStoreResourceIndex({
    version: 2,
    authority: {
      kind: PACKAGE_AUTHORITY_KIND,
      role: "gui",
      identity: {
        identityName: product.identityName,
        publisher: product.publisher,
        publisherId: product.publisherId,
        familyName: product.familyName,
        storeId: product.storeId,
      },
      packageVersion: product.packageVersion,
      protocolAbi: 1,
    },
    appVersion: STORE_PRODUCTS.gui.appVersion,
    buildNumber: inputs.appBuildNumber,
    entries,
  });
  const indexBytes = Buffer.from(JSON.stringify(resourceIndex) + "\n");
  parseStoreResourceIndexBytes(indexBytes);
  await put("application/packaged-resources.json", indexBytes);
  await putJson("application/package.json", {
    name: original.name,
    version: STORE_PRODUCTS.gui.appVersion,
    private: true,
    main: "dist/main/main.cjs",
    description: "MusicMute Local for Windows",
    author: { name: "VCHATSDK" },
  });
  const sourceCode = [...code.entries()].map(([name, bytes]) => ({
    path: `dist/${name}`,
    bytes: bytes.length,
    sha256: digest(bytes),
  }));
  // Re-read all selected inputs after the fresh extension build; concurrent
  // source/native/input changes cannot produce a success receipt.
  for (const [name, bytes] of code)
    if (
      !(
        await packageFile(join(componentRoot, "dist", name), 64 * 1024 ** 2)
      ).equals(bytes)
    )
      invalid("STORE_GUI_SOURCE_CHANGED");
  if (
    !(
      await packageFile(
        join(componentRoot, "dist/agent/browser-host.cjs"),
        32 * 1024 ** 2,
      )
    ).equals(browserHost) ||
    !(
      await packageFile(
        join(componentRoot, "dist/build-metafiles.json"),
        4 * 1024 ** 2,
      )
    ).equals(graphBytes)
  )
    invalid("STORE_GUI_SOURCE_CHANGED");
  await verifyStoreGuiNativeProvenance(inputs, componentRoot);
  await nativeBytes(inputs);
  await readPin(inputs.publicConfiguration, 4096);
  const receipt = {
    version: 1,
    purpose: inputs.purpose,
    appBuildNumber: inputs.appBuildNumber,
    sourceGraphSha256: digest(graphBytes),
    sourceCode,
    nativeProvenance: provenance,
    nativeExecutables: inputs.nativeBuild.executables,
    publicConfiguration: {
      bytes: publicBytes.length,
      sha256: digest(publicBytes),
    },
    resourceIndexSha256: digest(indexBytes),
    extensionId: extension.extensionId,
    sourceResourcesStaged: true,
    electronDirectoryBuilt: false,
    signed: false,
    installable: false,
    releaseReady: false,
    functionalStoreFlowsVerified: false,
    published: false,
  };
  await putJson("gui-source-receipt.json", receipt);
  return { stage, resourceIndex, receipt };
}

/** Archive hash is pinned to primary metadata. Every regular entry is streamed
 * and retained as the complete unchanged framework read-back census. */
export async function inspectStoreElectronArchive(archivePathValue: string) {
  const archivePath = path(archivePathValue);
  await physical(archivePath, false);
  const before = await hashStoreFile(archivePath);
  if (
    basename(archivePath) !== STORE_GUI_ELECTRON.file ||
    before.bytes !== STORE_GUI_ELECTRON.bytes ||
    before.sha256 !== STORE_GUI_ELECTRON.sha256
  )
    invalid("STORE_GUI_ELECTRON_ARCHIVE_INVALID");
  const yauzl = require("yauzl") as typeof import("yauzl");
  const archive = await new Promise<ZipFile>((resolve, reject) =>
    yauzl.open(
      archivePath,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, value) => (error || !value ? reject(error) : resolve(value)),
    ),
  );
  const rows: StoreInventoryEntry[] = [],
    seen = new Set<string>();
  let total = 0,
    version = "";
  try {
    await new Promise<void>((resolve, reject) => {
      archive.on("error", reject);
      archive.on("end", resolve);
      archive.on("entry", (entry: Entry) => {
        void (async () => {
          const name = safeStoreRelativePath(
            entry.fileName.replace(/\/$/u, ""),
          );
          if (
            seen.has(name.toLowerCase()) ||
            seen.size >= 1024 ||
            entry.generalPurposeBitFlag & 1 ||
            ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
          )
            invalid("STORE_GUI_ELECTRON_ARCHIVE_INVALID");
          seen.add(name.toLowerCase());
          if (entry.fileName.endsWith("/")) {
            if (entry.uncompressedSize !== 0) invalid();
            archive.readEntry();
            return;
          }
          if (
            entry.uncompressedSize < 1 ||
            entry.uncompressedSize > 512 * 1024 ** 2 ||
            (total += entry.uncompressedSize) > 1024 ** 3
          )
            invalid();
          const stream = await new Promise<NodeJS.ReadableStream>(
            (resolve, reject) =>
              archive.openReadStream(entry, (error, value) =>
                error || !value ? reject(error) : resolve(value),
              ),
          );
          const hash = createHash("sha256"),
            prefix: Buffer[] = [];
          let bytes = 0,
            prefixBytes = 0;
          for await (const chunk of stream as AsyncIterable<Buffer>) {
            const buffer = Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > entry.uncompressedSize) invalid();
            hash.update(buffer);
            if (prefixBytes < 2 * 1024 ** 2) {
              const part = buffer.subarray(0, 2 * 1024 ** 2 - prefixBytes);
              prefix.push(part);
              prefixBytes += part.length;
            }
          }
          if (bytes !== entry.uncompressedSize) invalid();
          const header = Buffer.concat(prefix);
          if (/\.(?:exe|dll)$/iu.test(name)) {
            const offset = header.length >= 64 ? header.readUInt32LE(0x3c) : -1;
            if (
              header.toString("ascii", 0, 2) !== "MZ" ||
              offset < 64 ||
              offset > 1024 ** 2 ||
              offset + 26 > header.length ||
              header.toString("binary", offset, offset + 4) !== "PE\0\0" ||
              header.readUInt16LE(offset + 4) !== 0x8664 ||
              header.readUInt16LE(offset + 24) !== 0x20b
            )
              invalid();
          }
          if (name === "version") version = header.toString("utf8");
          rows.push({ path: name, bytes, sha256: hash.digest("hex") });
          archive.readEntry();
        })().catch((error) => {
          archive.close();
          reject(error);
        });
      });
      archive.readEntry();
    });
  } finally {
    archive.close();
  }
  if (
    version !== STORE_GUI_ELECTRON.version ||
    rows.length !== 73 ||
    ![
      "electron.exe",
      "LICENSE",
      "LICENSES.chromium.html",
      "resources/default_app.asar",
      "dxcompiler.dll",
      "dxil.dll",
      "ffmpeg.dll",
      "d3dcompiler_47.dll",
      "vk_swiftshader.dll",
      "vulkan-1.dll",
    ].every((name) => rows.some((row) => row.path === name)) ||
    JSON.stringify(await hashStoreFile(archivePath)) !== JSON.stringify(before)
  )
    invalid("STORE_GUI_ELECTRON_ARCHIVE_INVALID");
  return Object.freeze(rows.sort((a, b) => (a.path < b.path ? -1 : 1)));
}
async function assertStagedResources(stage: string, seal: StoreResourceIndex) {
  for (const entry of seal.entries) {
    const actual = await hashStoreFile(
      join(
        stage,
        entry.placement === "resources" ? "resources" : "root",
        ...entry.path.split("/"),
      ),
    );
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256)
      invalid("STORE_GUI_STAGE_CHANGED");
  }
  if (
    JSON.stringify(
      parseStoreResourceIndexBytes(
        await packageFile(
          join(stage, "application/packaged-resources.json"),
          65536,
        ),
      ),
    ) !== JSON.stringify(seal)
  )
    invalid();
}
/** Native Windows only; caller must run this CLI under the approved owned QA
 * Job. This is a directory build, never signing, setup, install or publication. */
export async function buildStoreGuiDirectory(
  inputsValue: unknown,
  componentRootValue: string,
  stageRootValue: string,
) {
  if (process.platform !== "win32" || process.arch !== "x64")
    invalid("WINDOWS_STORE_BUILD_REQUIRED");
  const inputs = parseStoreGuiBuildInputs(inputsValue),
    sourceComponent = path(componentRootValue),
    stage = path(stageRootValue);
  await newStage(stage, sourceComponent, inputs);
  await verifyStoreGuiNativeProvenance(inputs, sourceComponent);
  const workspace = await createStoreGuiBuildWorkspace(
      sourceComponent,
      stage + "-build-work",
    ),
    componentRoot = workspace.componentRoot;
  const framework = await inspectStoreElectronArchive(
    inputs.electronArchivePath,
  );
  const packageVersion = async (name: string) =>
    json(
      await packageFile(
        join(componentRoot, "node_modules", name, "package.json"),
        65536,
      ),
      65536,
    ) as { version?: string };
  if (
    (await packageVersion("electron")).version !== STORE_GUI_ELECTRON.version ||
    (await packageVersion("electron-builder")).version !==
      STORE_GUI_ELECTRON.builderVersion ||
    (await packageVersion("app-builder-lib")).version !==
      STORE_GUI_ELECTRON.builderVersion
  )
    invalid("STORE_GUI_BUILDER_VERSION_MISMATCH");
  await execute(
    process.execPath,
    [
      join(componentRoot, "scripts/build.mjs"),
      ...(PACKAGE_AUTHORITY_PROFILE === "local-test-v1"
        ? ["--local-test-v1"]
        : []),
    ],
    {
      cwd: componentRoot,
      windowsHide: true,
      timeout: 600000,
      maxBuffer: 1024 * 1024,
      env: nativeAcceptanceEnvironment(process.env),
    },
  );
  const staged = await stageStoreGuiResources(inputs, componentRoot, stage);
  const archive = join(stage, "framework", STORE_GUI_ELECTRON.file);
  await mkdir(dirname(archive));
  await copyFile(inputs.electronArchivePath, archive, constants.COPYFILE_EXCL);
  await inspectStoreElectronArchive(archive);
  await assertStagedResources(stage, staged.resourceIndex);
  const originalEnvironment = { ...process.env },
    safeEnvironment = nativeAcceptanceEnvironment(process.env);
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, safeEnvironment);
    const builder = require(
      join(componentRoot, "node_modules/electron-builder"),
    ) as typeof import("electron-builder");
    const template = storeElectronDirectoryConfig(stage);
    let archiveWriter: StoreAsarWriterJoin | undefined;
    const config: Configuration = {
      ...template,
      // All runtime JS is bundled and audited before packaging. The pinned
      // builder calls this supported hook only when npmRebuild is true; false
      // marks modules as handled externally and skips both rebuild/install and
      // its later npm module collector. No package-manager/PATH fallback runs.
      npmRebuild: true,
      beforeBuild: async () => false,
      afterExtract: storeGuiAfterExtractHook(stage, framework),
      afterPack: async (context) => {
        if (
          !archiveWriter ||
          context.appOutDir !== join(stage, "electron-output", "win-unpacked")
        )
          invalid("STORE_GUI_ASAR_WRITER_DENIED");
        await archiveWriter.assertCompleted();
      },
      win: {
        ...template.win,
        requestedExecutionLevel: "asInvoker",
        target: [{ target: "dir", arch: ["x64"] }],
      },
      electronDist: archive,
      buildVersion: STORE_PRODUCTS.gui.packageVersion,
    };
    try {
      archiveWriter = await StoreAsarWriterJoin.open(componentRoot, stage);
      await builder.build({
        projectDir: componentRoot,
        config,
        targets: builder.createTargets(
          [builder.Platform.WINDOWS],
          "dir",
          "x64",
        ),
        publish: "never",
      });
      await archiveWriter.assertCompleted();
      await archiveWriter.close();
      archiveWriter = undefined;
    } catch (error) {
      // The stage has been created exclusively and every input is already
      // pinned. Keep bounded build-side diagnostics here; the CLI's public
      // output remains a stable code without a stack or configuration values.
      const failure =
        error instanceof Error ? error : new Error("Unknown builder failure");
      let writerCleanupError: string | null = null;
      try {
        await archiveWriter?.close();
      } catch (cleanupError) {
        writerCleanupError =
          cleanupError instanceof Error
            ? cleanupError.message
            : "STORE_GUI_ASAR_WRITER_DENIED";
      }
      const redact = (text: string, maximum: number) =>
        text
          .slice(0, maximum)
          .replace(
            /(bearer\s+|(?:token|password|secret|authorization)\s*[=:]\s*)[^\s,;]+/giu,
            "$1[redacted]",
          );
      await writeFile(
        join(stage, "gui-builder-failure.json"),
        JSON.stringify(
          {
            version: 1,
            phase: "electron-builder",
            name: redact(failure.name, 128),
            message: redact(failure.message, 2048),
            stack: redact(failure.stack ?? "", 8192),
            writerCleanupError:
              writerCleanupError === null
                ? null
                : redact(writerCleanupError, 256),
            signed: false,
            installed: false,
            published: false,
          },
          null,
          2,
        ) + "\n",
        { flag: "wx" },
      );
      invalid("STORE_GUI_BUILDER_FAILED");
    }
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
  }
  const output = join(stage, "electron-output", "win-unpacked");
  await physical(output, true);
  // Custom electronDist preserves these default files. Retire only exact pinned
  // entries in this newly owned output; never touch the input ZIP or user data.
  for (const name of ["version", "resources/default_app.asar"]) {
    const file = join(output, ...name.split("/")),
      expected = framework.find((row) => row.path === name)!;
    try {
      await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const actual = await hashStoreFile(file);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
      invalid();
    await rm(file);
  }
  const frameworkNames = [];
  for (const row of framework) {
    if (
      ["electron.exe", "version", "resources/default_app.asar"].includes(
        row.path,
      )
    )
      continue;
    const name = row.path === "LICENSE" ? "LICENSE.electron.txt" : row.path,
      actual = await hashStoreFile(join(output, ...name.split("/")));
    if (actual.bytes !== row.bytes || actual.sha256 !== row.sha256)
      invalid("STORE_GUI_FRAMEWORK_CHANGED");
    frameworkNames.push(name);
  }
  await assertStagedResources(stage, staged.resourceIndex);
  await verifyStoreGuiNativeProvenance(inputs, componentRoot);
  await nativeBytes(inputs);
  await readPin(inputs.publicConfiguration, 4096);
  if (
    digest(
      await packageFile(
        join(componentRoot, "dist/build-metafiles.json"),
        4 * 1024 ** 2,
      ),
    ) !== staged.receipt.sourceGraphSha256
  )
    invalid("STORE_GUI_SOURCE_CHANGED");
  const expectedNames = [
    ...frameworkNames,
    "MusicMute Local.exe",
    "resources/app.asar",
    ...staged.resourceIndex.entries.map(
      (entry) =>
        `${entry.placement === "resources" ? "resources/" : ""}${entry.path}`,
    ),
  ].sort();
  const actualFiles = await listStorePayload(output, "gui");
  if (
    JSON.stringify(actualFiles.map((row) => row.path)) !==
    JSON.stringify(expectedNames)
  )
    invalid("STORE_GUI_OUTPUT_CENSUS_INVALID");
  const audit = await auditStoreGui(
    output,
    componentRoot,
    inputs.appBuildNumber,
  );
  const files = await auditStorePayload(
    output,
    "gui",
    componentRoot,
    inputs.appBuildNumber,
  );
  await workspace.verifySource();
  await verifyStoreGuiNativeProvenance(inputs, sourceComponent);
  // Existing receiving audits use component/dist. Publish only fresh compiler
  // outputs; source build executables remain unexecuted and identity-pinned.
  await publishStoreGuiBuildOutputs(componentRoot, sourceComponent);
  await workspace.verifySource();
  const receipt = {
    version: 1,
    purpose: inputs.purpose,
    guiPayloadRoot: output,
    appBuildNumber: inputs.appBuildNumber,
    framework: STORE_GUI_ELECTRON,
    frameworkFileCount: frameworkNames.length,
    frameworkClosureReadback: "passed",
    nativeProvenance: staged.receipt.nativeProvenance,
    sourceGraphSha256: staged.receipt.sourceGraphSha256,
    resourceIndexSha256: staged.receipt.resourceIndexSha256,
    asarHeaderSha256: audit.asarHeaderSha256,
    files,
    electronDirectoryBuilt: true,
    sourceResourcesStaged: true,
    signed: false,
    installable: false,
    releaseReady: false,
    functionalStoreFlowsVerified: false,
    published: false,
  };
  await writeFile(
    join(stage, "gui-directory-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx" },
  );
  return receipt;
}
export async function readStoreGuiBuildInputsFile(file: string) {
  return parseStoreGuiBuildInputsBytes(await packageFile(path(file), 16384));
}

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, readdir, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { packageFile } from "../validate-assets.js";
import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
import { NATIVE_HOST } from "../../../chrome-extension/src/shared/protocol.js";
import { auditWindowsX64Binary } from "../../../worker/src/platform/windows/pe-audit.js";
import { verifyWindowsRelease } from "../../../worker/src/platform/windows/release-manifest.js";
import { auditWindowsConsumerDlls } from "../../../worker/src/platform/windows/consumer-dlls.js";
import { shouldCopyReleaseTreeEntry } from "../../../worker/src/platform/release-tree-filter.js";
import {
  parsePackageLock,
  STORE_KIM_MDX_PYTHON_PROFILE,
  windowsConsumerPackagesForProfile,
  WINDOWS_CONSUMER_PINS,
} from "../../../worker/src/platform/windows/consumer-package.js";
import { verifyStoreWorkerAcquisition } from "./acquisition.js";
import { parseStoreBuildDocument } from "./document-json.js";
import { verifyStoreMdxRetainedPythonSources } from "./python-projection.js";
import {
  STORE_PYTHON_NOTICE_FILES,
  verifyStorePythonNotices,
} from "./python-notices.js";
import {
  STORE_AGENT_NOTICE_PATH,
  verifyStoreAgentNotices,
} from "./agent-notices.js";
import {
  STORE_PRODUCTS,
  parseStoreBuildNumber,
  type StoreProductRole,
} from "../../src/shared/store-contracts.js";
import { parseStoreResourceIndexBytes } from "../../src/main/browser/store-resource-index.js";
import { projectStoreEngineSource } from "./engine-profile.js";
import {
  hashStoreFile,
  listStorePayload,
  assertStorePayloadPath,
  safeStoreRelativePath,
  type StoreInventoryEntry,
} from "./inventory.js";

const require = createRequire(import.meta.url);
/** ASAR lists rooted host paths; policy keys stay relative and slash-separated. */
export function parseStoreAsarEntryPath(value: unknown): string {
  if (typeof value !== "string") invalid();
  const separator = value[0];
  if (
    (separator !== "/" && separator !== "\\") ||
    value.slice(1).includes(separator === "/" ? "\\" : "/")
  )
    invalid();
  return safeStoreRelativePath(value.slice(1).split(separator).join("/"));
}
export const STORE_GUI_REQUIRED_FILES = Object.freeze([
  "MusicMute Local.exe",
  "MusicMuteChromeHost.exe",
  "MusicMuteSession.exe",
  "resources/app.asar",
  "resources/native/musicmute-native.exe",
  "resources/native/manifest.json",
  "resources/native/browser-manifest.json",
  "resources/native/com.musicmute.local.json",
  "resources/native/browser-host.cjs",
  "resources/extension/manifest.json",
  "resources/extension/inventory.json",
  "resources/desktop-public-config.json",
  "resources/desktop-build.json",
  "resources/notices/bundled.txt",
]);
export const STORE_WORKER_REQUIRED_FILES = Object.freeze([
  "MusicMuteWorker.exe",
  "MusicMuteSession.exe",
  "release-manifest.json",
  "runtime/native/musicmute-native.exe",
  "runtime/node/node.exe",
  "runtime/node/LICENSE",
  "runtime/python/python.exe",
  "runtime/python/LICENSE.txt",
  "runtime/requirements-directml.lock.txt",
  "runtime/consumer-source-manifest.json",
  "runtime/media-source-manifest.json",
  "runtime/bin/ffmpeg.exe",
  "runtime/bin/ffprobe.exe",
  "runtime/licenses/ffmpeg/COPYING.LGPLv2.1",
  "runtime/licenses/lame/COPYING",
  STORE_AGENT_NOTICE_PATH,
  ...STORE_PYTHON_NOTICE_FILES,
  "app/package.json",
  "app/pnpm-lock.yaml",
  "app/node_modules/@sentry/node/package.json",
  "app/dist/src/cli/main.js",
  "app/dist/src/runtime/store-transfer-process.js",
  "app/engine/musicmute_engine/consumer_personal.py",
  "app/engine/musicmute_engine/store_consumer_personal.py",
  "app/engine/musicmute_engine/store_qualification.py",
  "app/engine/musicmute_engine/store_benchmark_file.py",
  "app/engine/musicmute_engine/store_benchmark_capacity.py",
  "app/engine/musicmute_engine/store_benchmark_context.py",
  "app/engine/musicmute_engine/windows_guardian.py",
  "app/engine/musicmute_engine/store_code_reader.py",
  "agent/session-agent.cjs",
  "agent/login-worker.cjs",
  "agent/personal.cjs",
  "agent/fleet.cjs",
  "agent/prepare.cjs",
  "tools/downloader/identity.json",
  "tools/downloader/store_downloader_bootstrap.py",
  "tools/youtube/identity.json",
  "tools/youtube/bin/deno.exe",
  "tools/youtube/provider/deno.json",
  "tools/youtube/provider/deno.lock",
  "tools/youtube/provider/src/generate_once.ts",
  "tools/youtube/provider/src/session_manager.ts",
]);
export class StoreInputsMissing extends Error {
  readonly code = "STORE_INPUTS_MISSING";
  constructor(
    readonly role: StoreProductRole,
    readonly missing: readonly string[],
  ) {
    super("STORE_INPUTS_MISSING");
  }
}
function invalid(): never {
  throw new Error("STORE_PAYLOAD_INVALID");
}
/** Chrome's Windows path is relative to this protected manifest's directory.
 * This is a sealed configuration check; OS package/held-host proofs authorize
 * execution separately. The shared extension build independently checks its ID.
 */
export function parseStoreNativeMessagingManifest(bytes: Uint8Array) {
  if (bytes.byteLength < 1 || bytes.byteLength > 16384) invalid();
  const row = parseStrictJson(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    16384,
    32,
  ) as Record<string, unknown>;
  const origin =
    "chrome-extension://acmgefmmndomcpdlgnafkjbgobinllep/" as const;
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).sort().join() !==
      "allowed_origins,description,name,path,type" ||
    row.name !== NATIVE_HOST ||
    row.description !== "MusicMute Windows companion" ||
    row.path !== "../../MusicMuteChromeHost.exe" ||
    row.type !== "stdio" ||
    !Array.isArray(row.allowed_origins) ||
    row.allowed_origins.length !== 1 ||
    row.allowed_origins[0] !== origin
  )
    invalid();
  return Object.freeze({
    name: NATIVE_HOST,
    description: "MusicMute Windows companion" as const,
    path: "../../MusicMuteChromeHost.exe" as const,
    type: "stdio" as const,
    allowed_origins: Object.freeze([origin]),
  });
}
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
/** Full DLL import inventories exceed ordinary IPC's aggregate node cap. */
export function parseStoreWorkerSourceManifest(bytes: Uint8Array): unknown {
  return parseStoreBuildDocument(bytes, 8 * 1024 ** 2);
}
/** A reduced runtime must disclose the complete upstream source census rather
 * than relabel its product-specific imports as the full pip dependency closure. */
export function storeWorkerDistributionPackages(
  value: unknown,
  lock: string,
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const source = value as Record<string, unknown>,
    full = parsePackageLock(lock),
    samePackages = (actual: unknown, expected: Record<string, string>) =>
      actual !== null &&
      typeof actual === "object" &&
      !Array.isArray(actual) &&
      JSON.stringify(Object.entries(actual).sort()) ===
        JSON.stringify(Object.entries(expected).sort());
  if (source.pythonDistributionProfile === undefined) {
    if (
      [
        "pythonDependencyClosure",
        "sourcePackages",
        "omittedDistributions",
      ].some((key) => Object.hasOwn(source, key))
    )
      invalid();
    return full;
  }
  if (
    source.pythonDistributionProfile !== STORE_KIM_MDX_PYTHON_PROFILE ||
    source.pythonDependencyClosure !== "product-specific-not-full-upstream" ||
    !samePackages(source.sourcePackages, full) ||
    !samePackages(source.omittedDistributions, { "diffq-fixed": "0.2.4" })
  )
    invalid();
  return windowsConsumerPackagesForProfile(lock, STORE_KIM_MDX_PYTHON_PROFILE);
}
/** Read the actual relocated distribution metadata independently of the prior
 * subprocess receipt. Original upstream metadata remains byte-for-byte intact. */
export async function auditStorePythonDistributionMetadata(
  pythonRoot: string,
  expected: Record<string, string>,
): Promise<void> {
  const root = join(pythonRoot, "Lib/site-packages"),
    packages: Record<string, string> = Object.create(null);
  for (const name of (await readdir(root)).sort()) {
    if (
      !Object.hasOwn(expected, "diffq-fixed") &&
      /^diffq(?:[./_-]|$)/iu.test(name)
    )
      invalid();
    if (/\.egg-info$/iu.test(name)) invalid();
    if (!/\.dist-info$/iu.test(name)) continue;
    const directory = join(root, name),
      stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
    const header = (await bounded(join(directory, "METADATA"), 2 * 1024 ** 2))
        .toString("utf8")
        .split(/\r?\n\r?\n/u, 1)[0]!,
      names = [...header.matchAll(/^Name: ([A-Za-z0-9._-]+)\r?$/gmu)],
      versions = [...header.matchAll(/^Version: ([A-Za-z0-9.+_-]+)\r?$/gmu)];
    if (names.length !== 1 || versions.length !== 1) invalid();
    const key = names[0]![1]!.toLowerCase().replaceAll(/[-_.]+/gu, "-"),
      version = versions[0]![1]!;
    if (
      Object.hasOwn(packages, key) ||
      expected[key] !== version ||
      name
        .slice(0, -".dist-info".length)
        .toLowerCase()
        .replaceAll(/[-_.]+/gu, "-") !==
        `${key}-${version}`.toLowerCase().replaceAll(/[-_.]+/gu, "-")
    )
      invalid();
    packages[key] = version;
  }
  if (Object.keys(packages).length !== Object.keys(expected).length) invalid();
}
/** The twelve fixed compiler graphs exceed ordinary IPC's aggregate node cap. */
export function parseStoreBuildGraphs(bytes: Uint8Array): unknown[] {
  if (bytes.byteLength < 1 || bytes.byteLength > 4 * 1024 ** 2) invalid();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let at = 0;
  const graphs: unknown[] = [];
  const whitespace = () => {
    while (/[\t\n\r ]/u.test(text[at] ?? "x")) at++;
  };
  whitespace();
  if (text[at++] !== "[") invalid();
  whitespace();
  while (text[at] !== "]") {
    if (text[at] !== "{" || graphs.length >= 12) invalid();
    const begin = at;
    let depth = 0;
    do {
      const c = text[at++]!;
      if (c === '"') {
        let closed = false;
        while (at < text.length) {
          const ch = text[at++]!;
          if (ch === '"') {
            closed = true;
            break;
          }
          if (ch === "\\") at++;
        }
        if (!closed) invalid();
      } else if (c === "{" || c === "[") {
        if (++depth > 32) invalid();
      } else if (c === "}" || c === "]") depth--;
      if (at > text.length || at - begin > 1024 ** 2) invalid();
    } while (depth > 0);
    graphs.push(parseStrictJson(text.slice(begin, at), 1024 ** 2, 16384));
    whitespace();
    if (text[at] === "]") break;
    if (text[at++] !== ",") invalid();
    whitespace();
    if (text[at] === "]") invalid();
  }
  at++;
  whitespace();
  if (at !== text.length || graphs.length !== 12) invalid();
  return graphs;
}
async function bounded(path: string, max = 8 * 1024 ** 2) {
  const bytes = await packageFile(path, max);
  const after = await hashStoreFile(path);
  if (bytes.length !== after.bytes || hash(bytes) !== after.sha256) invalid();
  return bytes;
}
/** Fresh shared source/notices are the reference, not a self-consistent old copy. */
export async function auditStoreSharedExtension(
  folder: string,
  componentRoot: string,
) {
  const temporary = await mkdtemp(
    join(tmpdir(), "musicmute-store-extension-audit-"),
  );
  try {
    const fresh = join(temporary, "extension");
    await mkdir(fresh);
    const { stageSharedExtension } = (await import(
      pathToFileURL(join(componentRoot, "packaging/shared-extension.mjs")).href
    )) as {
      stageSharedExtension(
        destination: string,
        read: typeof bounded,
      ): Promise<{ entries: StoreInventoryEntry[] }>;
    };
    const inventory = await stageSharedExtension(fresh, bounded);
    const expected = [
      ...inventory.entries.map((entry) => entry.path),
      "inventory.json",
    ].sort();
    const actual: string[] = [];
    async function visit(directory: string, prefix = "", depth = 0) {
      if (depth > 3 || actual.length > 32) invalid();
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) invalid();
      for (const name of (await readdir(directory)).sort()) {
        const relative = prefix ? `${prefix}/${name}` : name,
          path = join(directory, name),
          s = await lstat(path);
        if (s.isSymbolicLink()) invalid();
        if (s.isDirectory()) {
          if (
            !["_locales", "_locales/en", "_locales/ar", "icons"].includes(
              relative,
            )
          )
            invalid();
          await visit(path, relative, depth + 1);
        } else {
          if (!s.isFile() || s.nlink !== 1 || !expected.includes(relative))
            invalid();
          if (
            !(await bounded(path)).equals(
              await bounded(join(fresh, ...relative.split("/"))),
            )
          )
            invalid();
          actual.push(relative);
        }
      }
    }
    await visit(folder);
    if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) invalid();
    return inventory;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function auditStoreWorkerCompiledOutputs(
  payload: string,
  workerRoot: string,
) {
  const source = join(workerRoot, "dist"),
    target = join(payload, "app/dist");
  async function collect(root: string, filtered: boolean) {
    const paths: string[] = [];
    async function visit(directory: string, depth = 0) {
      if (depth > 32 || paths.length > 4096) invalid();
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) invalid();
      for (const name of (await readdir(directory)).sort()) {
        const path = join(directory, name),
          key = relative(root, path).split(sep).join("/"),
          s = await lstat(path);
        if (s.isSymbolicLink()) invalid();
        if (
          filtered &&
          (!shouldCopyReleaseTreeEntry(root, path) || key.endsWith(".map"))
        )
          continue;
        if (s.isDirectory()) await visit(path, depth + 1);
        else {
          if (!s.isFile() || s.nlink !== 1) invalid();
          assertStorePayloadPath("worker", `app/dist/${key}`);
          paths.push(key);
        }
      }
    }
    await visit(root);
    return paths.sort();
  }
  const expected = await collect(source, true),
    actual = await collect(target, false);
  if (!expected.length || JSON.stringify(actual) !== JSON.stringify(expected))
    invalid();
  for (const key of expected)
    if (
      !(await bounded(join(target, ...key.split("/")))).equals(
        await bounded(join(source, ...key.split("/"))),
      )
    )
      invalid();
  return Object.freeze(expected.map((key) => `app/dist/${key}`));
}
export async function requireStorePayloadFiles(
  root: string,
  role: StoreProductRole,
) {
  const missing: string[] = [];
  for (const path of role === "gui"
    ? STORE_GUI_REQUIRED_FILES
    : STORE_WORKER_REQUIRED_FILES) {
    try {
      const info = await lstat(join(root, ...path.split("/")));
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size < 1
      )
        missing.push(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      missing.push(path);
    }
  }
  if (missing.length)
    throw new StoreInputsMissing(role, Object.freeze(missing));
}
export function parseStoreGuiBuildMetadata(
  bytes: Uint8Array,
  expectedBuildNumber: number,
) {
  const buildNumber = parseStoreBuildNumber(expectedBuildNumber);
  if (bytes.byteLength < 1 || bytes.byteLength > 16384) invalid();
  const row = parseStrictJson(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    16384,
    32,
  ) as Record<string, unknown>;
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).sort().join() !== "appVersion,buildNumber,version" ||
    row.version !== 1 ||
    row.appVersion !== STORE_PRODUCTS.gui.appVersion ||
    row.buildNumber !== buildNumber
  )
    invalid();
  return Object.freeze({
    version: 1 as const,
    appVersion: STORE_PRODUCTS.gui.appVersion,
    buildNumber,
  });
}
export async function auditStoreGui(
  root: string,
  componentRoot: string,
  expectedBuildNumber = STORE_PRODUCTS.gui.appBuildNumber as number,
) {
  expectedBuildNumber = parseStoreBuildNumber(expectedBuildNumber);
  await requireStorePayloadFiles(root, "gui");
  const { extractFile, listPackage, statFile, getRawHeader } =
    require("@electron/asar") as typeof import("@electron/asar");
  const { getCurrentFuseWire, FuseV1Options } =
    require("@electron/fuses") as typeof import("@electron/fuses");
  const { NtExecutable, NtExecutableResource } =
    require("resedit") as typeof import("resedit");
  const inventory = require(join(componentRoot, "packaging/inventory.cjs")) as {
    executedBuildGraphs(value: unknown): unknown;
    verifyLicensedBuildAssets(root: string, dist: string): Promise<unknown>;
    verifyPackagedLicensedAssets(
      asar: string,
      staged: string,
    ): Promise<unknown>;
    bundledNotices(componentRoot: string, graphs: unknown[]): Promise<string>;
  };
  const graphs = parseStoreBuildGraphs(
    await bounded(
      join(componentRoot, "dist/build-metafiles.json"),
      4 * 1024 ** 2,
    ),
  );
  inventory.executedBuildGraphs(graphs);
  if (
    !(
      await bounded(join(root, "resources/notices/bundled.txt"), 4 * 1024 ** 2)
    ).equals(Buffer.from(await inventory.bundledNotices(componentRoot, graphs)))
  )
    invalid();
  await inventory.verifyLicensedBuildAssets(
    componentRoot,
    join(componentRoot, "dist"),
  );
  const asar = join(root, "resources/app.asar"),
    executable = join(root, "MusicMute Local.exe");
  const beforeAsar = await hashStoreFile(asar),
    beforeExe = await hashStoreFile(executable);
  const seal = parseStoreResourceIndexBytes(
    extractFile(asar, "packaged-resources.json"),
  );
  if (seal.authority.role !== "gui" || seal.buildNumber !== expectedBuildNumber)
    invalid();
  const chromeManifest = await bounded(
    join(root, "resources/native/com.musicmute.local.json"),
    16384,
  );
  parseStoreNativeMessagingManifest(chromeManifest);
  if (
    !seal.entries.some(
      (entry) =>
        entry.placement === "resources" &&
        entry.path === "native/com.musicmute.local.json" &&
        entry.bytes === chromeManifest.length &&
        entry.sha256 === hash(chromeManifest),
    )
  )
    invalid();
  parseStoreGuiBuildMetadata(
    await bounded(join(root, "resources/desktop-build.json"), 16384),
    expectedBuildNumber,
  );
  if (
    !(await bounded(join(root, "resources/native/browser-host.cjs"))).equals(
      await bounded(join(componentRoot, "dist/agent/browser-host.cjs")),
    )
  )
    invalid();
  await auditStoreSharedExtension(
    join(root, "resources/extension"),
    componentRoot,
  );
  for (const path of listPackage(asar, { isPack: false })) {
    const relative = parseStoreAsarEntryPath(path),
      archivePath = join(...relative.split("/"));
    const stat = statFile(asar, archivePath, false);
    if ("link" in stat || stat.unpacked) invalid();
    assertStorePayloadPath("gui", relative);
    if (
      !("files" in stat) &&
      !/^(?:package\.json|packaged-resources\.json|dist\/(?:main\/main\.cjs|preload\/index\.cjs|renderer\/[^]*|licenses\/[^]*))$/u.test(
        relative,
      )
    )
      invalid();
    if (!("files" in stat) && relative.startsWith("dist/")) {
      const compiled = await bounded(join(componentRoot, relative));
      if (!compiled.equals(extractFile(asar, archivePath, false))) invalid();
    }
  }
  for (const entry of seal.entries) {
    const actual = await hashStoreFile(
      join(
        root,
        ...(entry.placement === "resources" ? ["resources"] : []),
        ...entry.path.split("/"),
      ),
    );
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256)
      invalid();
  }
  await inventory.verifyPackagedLicensedAssets(asar, componentRoot);
  const wire = await getCurrentFuseWire(executable);
  if (wire.version !== "1") invalid();
  for (const [name, expected] of [
    [FuseV1Options.RunAsNode, 48],
    [FuseV1Options.EnableCookieEncryption, 49],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, 48],
    [FuseV1Options.EnableNodeCliInspectArguments, 48],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, 49],
    [FuseV1Options.OnlyLoadAppFromAsar, 49],
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, 48],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, 48],
  ] as const)
    if (wire[name] !== expected) invalid();
  const pe = NtExecutable.from(await bounded(executable, 512 * 1024 ** 2)),
    resources = NtExecutableResource.from(pe);
  const integrity = resources.entries.filter(
    (entry) =>
      String(entry.type).toUpperCase() === "INTEGRITY" &&
      String(entry.id).toUpperCase() === "ELECTRONASAR",
  );
  if (integrity.length !== 1) invalid();
  const value = parseStrictJson(
    new TextDecoder("utf-8", { fatal: true }).decode(integrity[0]!.bin),
    65536,
    64,
  );
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    JSON.stringify(Object.keys(value[0]).sort()) !==
      JSON.stringify(["alg", "file", "value"]) ||
    value[0].file !== "resources\\app.asar" ||
    (value[0].alg !== "SHA256" && value[0].alg !== "sha256") ||
    value[0].value !== hash(Buffer.from(getRawHeader(asar).headerString))
  )
    invalid();
  const manifest = resources.entries.filter(
    (entry) => entry.type === 24 && entry.id === 1,
  );
  if (manifest.length !== 1) invalid();
  const execution = [
    ...new TextDecoder("utf-8", { fatal: true })
      .decode(manifest[0]!.bin)
      .matchAll(/<requestedExecutionLevel\s+([^>]+)\/?\s*>/gu),
  ];
  if (
    execution.length !== 1 ||
    !/\blevel=["']asInvoker["']/u.test(execution[0]![1]!) ||
    !/\buiAccess=["']false["']/u.test(execution[0]![1]!) ||
    (execution[0]![1]!.match(/\blevel\s*=/gu)?.length ?? 0) !== 1 ||
    (execution[0]![1]!.match(/\buiAccess\s*=/gu)?.length ?? 0) !== 1
  )
    invalid();
  if (
    JSON.stringify(await hashStoreFile(asar)) !== JSON.stringify(beforeAsar) ||
    JSON.stringify(await hashStoreFile(executable)) !==
      JSON.stringify(beforeExe)
  )
    invalid();
  return {
    seal,
    asarHeaderSha256: hash(Buffer.from(getRawHeader(asar).headerString)),
  };
}
/** Closed runtime source/DLL/import receipts must come from fresh assembly. */
export async function auditStoreWorker(root: string, workerRoot: string) {
  await requireStorePayloadFiles(root, "worker");
  const manifest = await verifyWindowsRelease(root, "windows-user");
  if (manifest.releaseVersion !== STORE_PRODUCTS.worker.appVersion) invalid();
  const packageInfo = parseStrictJson(
    (await bounded(join(root, "app/package.json"), 65536)).toString("utf8"),
    65536,
    256,
  ) as { version?: unknown };
  if (packageInfo.version !== STORE_PRODUCTS.worker.appVersion) invalid();
  if (
    !(await bounded(join(root, "app/package.json"), 65536)).equals(
      await bounded(join(workerRoot, "package.json"), 65536),
    ) ||
    !(await bounded(join(root, "app/pnpm-lock.yaml"))).equals(
      await bounded(join(workerRoot, "pnpm-lock.yaml")),
    )
  )
    invalid();
  await auditStoreWorkerCompiledOutputs(root, workerRoot);
  const lock = await bounded(
    join(root, "runtime/requirements-directml.lock.txt"),
    65536,
  );
  const originalLock = await bounded(
    join(
      workerRoot,
      "../tools/worker-gpu-feasibility/requirements-directml.lock.txt",
    ),
    65536,
  );
  if (!lock.equals(originalLock)) invalid();
  const source = parseStoreWorkerSourceManifest(
    await bounded(join(root, "runtime/consumer-source-manifest.json")),
  ) as {
    schemaVersion?: unknown;
    installationProfile?: unknown;
    requirementsLockSha256?: unknown;
    pins?: unknown;
    observed?: {
      packages?: Record<string, string>;
      nativeArchitecture?: unknown;
      node?: unknown;
      python?: unknown;
      onnxRuntime?: unknown;
      audioSeparator?: unknown;
      ffmpeg?: unknown;
      deno?: unknown;
    };
  };
  const packages = storeWorkerDistributionPackages(
    source,
    lock.toString("utf8"),
  );
  if (
    source.schemaVersion !== 1 ||
    source.installationProfile !== "windows-user" ||
    source.requirementsLockSha256 !== hash(lock) ||
    JSON.stringify(source.pins) !== JSON.stringify(WINDOWS_CONSUMER_PINS) ||
    source.observed?.nativeArchitecture !== "x64" ||
    (
      [
        "node",
        "python",
        "onnxRuntime",
        "audioSeparator",
        "ffmpeg",
        "deno",
      ] as const
    ).some((key) => source.observed?.[key] !== WINDOWS_CONSUMER_PINS[key]) ||
    JSON.stringify(Object.entries(source.observed.packages ?? {}).sort()) !==
      JSON.stringify(Object.entries(packages).sort())
  )
    invalid();
  await auditStorePythonDistributionMetadata(
    join(root, "runtime/python"),
    packages,
  );
  if (Object.hasOwn(source, "pythonDistributionProfile"))
    await verifyStoreMdxRetainedPythonSources(join(root, "runtime/python"));
  for (const agent of [
    "session-agent",
    "login-worker",
    "personal",
    "fleet",
    "prepare",
  ])
    if (
      !(await bounded(join(root, "agent", `${agent}.cjs`))).equals(
        await bounded(
          join(workerRoot, "../windows-desktop/dist/agent", `${agent}.cjs`),
        ),
      )
    )
      invalid();
  await verifyStoreWorkerAcquisition(
    root,
    join(workerRoot, "../windows-desktop"),
  );
  await verifyStoreAgentNotices(root, join(workerRoot, "../windows-desktop"));
  await verifyStorePythonNotices(root, join(workerRoot, "../windows-desktop"));
  const originals = (await readdir(join(workerRoot, "engine/musicmute_engine")))
    .filter((name) => name.endsWith(".py"))
    .sort();
  const copied = (
    await readdir(join(root, "app/engine/musicmute_engine"))
  ).sort();
  if (JSON.stringify(originals) !== JSON.stringify(copied)) invalid();
  for (const name of originals)
    if (
      !(await bounded(join(root, "app/engine/musicmute_engine", name))).equals(
        projectStoreEngineSource(
          name,
          await bounded(join(workerRoot, "engine/musicmute_engine", name)),
        ),
      )
    )
      invalid();
  const files = await listStorePayload(root, "worker");
  await auditWindowsConsumerDlls(
    root,
    files.map((entry) => join(root, ...entry.path.split("/"))),
  );
  return { manifest, files };
}
/** Audit one admitted payload entry without relaxing ordinary file readers. */
export async function auditStorePayloadEntry(
  root: string,
  role: StoreProductRole,
  row: StoreInventoryEntry,
): Promise<void> {
  assertStorePayloadPath(role, row.path);
  const file = join(root, ...row.path.split("/"));
  if (/\.(?:exe|dll|pyd|node)$/iu.test(row.path))
    await auditWindowsX64Binary(file);
  else if (/\.(?:json|js|cjs|mjs|py|txt|pem|xml|yaml)$/iu.test(row.path)) {
    if (row.bytes === 0) {
      // An empty text file cannot contain secrets; revalidate its admitted pin
      // through the held-file reader before skipping the nonempty-only reader.
      const actual = await hashStoreFile(file);
      if (actual.bytes !== row.bytes || actual.sha256 !== row.sha256) invalid();
      return;
    }
    const bytes = await bounded(file),
      text = bytes.toString("utf8");
    if (
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/]{16}|"(?:refreshToken|refresh_token|private_key|client_secret)"\s*:\s*"[^"\s]+"|(?<![A-Za-z0-9])AKIA[A-Z0-9]{16}(?![A-Za-z0-9])/u.test(
        text,
      )
    )
      invalid();
  }
}
export async function auditStorePayload(
  root: string,
  role: StoreProductRole,
  componentRoot: string,
  expectedBuildNumber = STORE_PRODUCTS[role].appBuildNumber as number,
): Promise<readonly StoreInventoryEntry[]> {
  expectedBuildNumber = parseStoreBuildNumber(expectedBuildNumber);
  let rows: readonly StoreInventoryEntry[];
  if (role === "gui") {
    await auditStoreGui(root, componentRoot, expectedBuildNumber);
    rows = await listStorePayload(root, role);
  } else if (role === "worker")
    rows = (await auditStoreWorker(root, join(componentRoot, "../worker")))
      .files;
  else invalid();
  for (const row of rows) await auditStorePayloadEntry(root, role, row);
  return rows;
}

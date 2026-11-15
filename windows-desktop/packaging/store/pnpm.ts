import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { auditWindowsX64Binary } from "../../../worker/src/platform/windows/pe-audit.js";
import { packageFile } from "../validate-assets.js";
import {
  hashStoreFile,
  safeStoreRelativePath,
  type StoreInventoryEntry,
} from "./inventory.js";

const execute = promisify(execFile);
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export const STORE_PNPM_TOOL = Object.freeze({
  version: "10.14.0",
  archive: "pnpm-10.14.0.tgz",
  bytes: 4205866,
  sha256: "297534e65d5842450539c1e8022c8831ab5e1fe2eb74664787a815519542d620",
  source: "https://registry.npmjs.org/pnpm/-/pnpm-10.14.0.tgz",
  metadata: "https://registry.npmjs.org/pnpm/10.14.0",
  integrity:
    "sha512-rSenlkG0nD5IGhaoBbqnGBegS74Go40X5g4urug/ahRsamiBJfV5LkjdW6MOfaUqXNpMOZK5zPMz+c4iOvhHSA==",
  files: 1111,
  cli: "package/bin/pnpm.cjs",
  cliBytes: 1102,
  cliSha256: "b276da51dc8ca5b0d3ee3371695b50fc8b3244b281b091c63a3f082a88dadeb9",
});
export const STORE_NODE_EXECUTABLE_SHA256 =
  "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de";
export const STORE_WORKER_PNPM_LOCK_SHA256 =
  "417eb9fb31557e8a72f0c163e78515228dd540d63fba8cba90497e5e7f1ecc72";
// Actual zero-byte leaves in this checksum-pinned archive, not placeholders.
const pnpmEmptyLeaves = Object.freeze([
  "package/dist/node_modules/node-gyp/gyp/pylib/gyp/generator/__init__.py",
  "package/dist/node_modules/node-gyp/gyp/pylib/packaging/py.typed",
]);
function invalid(code = "STORE_PNPM_TOOL_INVALID"): never {
  throw new Error(code);
}
async function canonicalDirectory(path: string) {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path === dirname(path) ||
    path.length > 4096 ||
    /[\p{Cc}\p{Cf};"$<>|*?]/u.test(path) ||
    (await realpath(path)) !== path
  )
    invalid();
  for (let cursor = path; ; cursor = dirname(cursor)) {
    const state = await lstat(cursor);
    if (!state.isDirectory() || state.isSymbolicLink()) invalid();
    if (cursor === dirname(cursor)) break;
  }
}
async function admitFreshBuildRoots(
  inputs: readonly string[],
  outputs: readonly string[],
) {
  for (const root of inputs) await canonicalDirectory(root);
  const inside = (parent: string, child: string) =>
    parent.toLowerCase() === child.toLowerCase() ||
    child.toLowerCase().startsWith(parent.toLowerCase() + sep);
  for (const output of outputs) {
    if (
      !isAbsolute(output) ||
      resolve(output) !== output ||
      output === dirname(output) ||
      output.length > 4096 ||
      /[\p{Cc}\p{Cf};"$<>|*?]/u.test(output)
    )
      invalid();
    await canonicalDirectory(dirname(output));
    for (const other of [
      ...inputs,
      ...outputs.filter((path) => path !== output),
    ])
      if (inside(other, output) || inside(output, other)) invalid();
    try {
      await lstat(output);
      invalid("STORE_PNPM_OUTPUT_EXISTS");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
export async function storePnpmArchiveFiles(
  bytes: Uint8Array,
  componentRoot: string,
) {
  if (
    bytes.byteLength !== STORE_PNPM_TOOL.bytes ||
    hash(bytes) !== STORE_PNPM_TOOL.sha256
  )
    invalid();
  const helpers = (await import(
    pathToFileURL(
      join(componentRoot, "../worker/scripts/setup-windows-acquisition.mjs"),
    ).href
  )) as {
    pinnedTarFiles(
      value: Uint8Array,
      select: (name: string, type: string) => boolean,
    ): Map<string, Buffer>;
  };
  const files = helpers.pinnedTarFiles(bytes, (name, type) => {
    if (pnpmEmptyLeaves.includes(name)) {
      if (type !== "0" && type !== "\0") invalid();
      return false;
    }
    return true;
  });
  if (
    !(files instanceof Map) ||
    files.size !== STORE_PNPM_TOOL.files - pnpmEmptyLeaves.length
  )
    invalid();
  for (const key of pnpmEmptyLeaves) files.set(key, Buffer.alloc(0));
  for (const [key, value] of files) {
    safeStoreRelativePath(key);
    if (!key.startsWith("package/") || !Buffer.isBuffer(value)) invalid();
  }
  const cli = files.get(STORE_PNPM_TOOL.cli);
  if (
    !cli ||
    cli.length !== STORE_PNPM_TOOL.cliBytes ||
    hash(cli) !== STORE_PNPM_TOOL.cliSha256
  )
    invalid();
  return files;
}
async function toolFiles(root: string) {
  if ((await realpath(root)) !== root) invalid();
  for (let cursor = root; ; cursor = dirname(cursor)) {
    const state = await lstat(cursor);
    if (!state.isDirectory() || state.isSymbolicLink()) invalid();
    if (cursor === dirname(cursor)) break;
  }
  const result: string[] = [];
  async function visit(path: string, depth = 0) {
    if (depth > 32 || result.length > 16384) invalid();
    const state = await lstat(path);
    if (!state.isDirectory() || state.isSymbolicLink()) invalid();
    for (const name of (await readdir(path)).sort()) {
      const file = join(path, name),
        state = await lstat(file);
      if (state.isSymbolicLink()) invalid();
      if (state.isDirectory()) await visit(file, depth + 1);
      else {
        if (!state.isFile() || state.nlink !== 1) invalid();
        const key = relative(root, file).split(sep).join("/");
        safeStoreRelativePath(key);
        result.push(key);
      }
    }
  }
  await visit(join(root, "package"));
  return result.sort();
}
/** Full official tool closure checked before and after execution. It remains
 * build-side material and can never enter a Worker code inventory. */
export async function verifyStorePnpmTool(root: string, componentRoot: string) {
  const archive = await packageFile(
      join(root, STORE_PNPM_TOOL.archive),
      8 * 1024 ** 2,
    ),
    files = await storePnpmArchiveFiles(archive, componentRoot),
    expected = [...files.keys()].sort(),
    actual = await toolFiles(root),
    entries: StoreInventoryEntry[] = [];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) invalid();
  for (const key of expected) {
    const bytes = files.get(key)!,
      actual = await hashStoreFile(join(root, ...key.split("/")));
    if (actual.bytes !== bytes.length || actual.sha256 !== hash(bytes))
      invalid();
    entries.push({ path: key, ...actual });
  }
  if (JSON.stringify(await toolFiles(root)) !== JSON.stringify(expected))
    invalid();
  return Object.freeze({
    cli: join(root, ...STORE_PNPM_TOOL.cli.split("/")),
    entries: Object.freeze(entries),
    censusSha256: hash(Buffer.from(JSON.stringify(entries))),
  });
}
export function storePnpmInstallArguments(cli: string, store: string) {
  return Object.freeze([
    cli,
    "install",
    "--prod",
    "--offline",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--ignore-workspace",
    "--config.ignore-pnpmfile=true",
    "--config.node-linker=hoisted",
    "--config.package-import-method=copy",
    "--config.verify-store-integrity=true",
    "--config.use-store-server=false",
    "--config.manage-package-manager-versions=false",
    "--config.update-notifier=false",
    "--store-dir",
    store,
  ]);
}
/** The networked build-input phase is separate from the strictly offline
 * consumer installer. Empty private config and a fixed registry prevent an
 * ambient workspace, credential file or alternate registry from participating. */
export function storePnpmFetchArguments(cli: string, store: string) {
  return Object.freeze([
    cli,
    "fetch",
    "--prod",
    "--ignore-scripts",
    "--ignore-workspace",
    "--config.ignore-pnpmfile=true",
    "--config.registry=https://registry.npmjs.org/",
    "--config.fetch-retries=0",
    "--config.node-linker=hoisted",
    "--config.package-import-method=copy",
    "--config.verify-store-integrity=true",
    "--config.use-store-server=false",
    "--config.manage-package-manager-versions=false",
    "--config.update-notifier=false",
    "--store-dir",
    store,
  ]);
}
export function storePnpmEnvironment(data: string) {
  return {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    SystemDrive: "C:",
    PATH: "C:\\Windows\\System32;C:\\Windows",
    USERPROFILE: data,
    HOME: data,
    APPDATA: join(data, "appdata"),
    LOCALAPPDATA: join(data, "localappdata"),
    XDG_CONFIG_HOME: join(data, "config"),
    XDG_CACHE_HOME: join(data, "cache"),
    PNPM_HOME: join(data, "pnpm-home"),
    TEMP: join(data, "temp"),
    TMP: join(data, "temp"),
    CI: "1",
    NPM_CONFIG_USERCONFIG: join(data, "user.npmrc"),
    NPM_CONFIG_GLOBALCONFIG: join(data, "global.npmrc"),
  };
}
/** Fetch only the current locked production closure into a new, exclusive
 * build-side store. This must run under the original guardian; completing it
 * alone does not qualify the later offline install or its executable census. */
export async function prepareStoreProductionDependencyCache(options: {
  workerRoot: string;
  componentRoot: string;
  nodeRoot: string;
  toolRoot: string;
  storeRoot: string;
  workRoot: string;
}) {
  if (process.platform !== "win32" || process.arch !== "x64")
    invalid("STORE_WORKER_WINDOWS_REQUIRED");
  await admitFreshBuildRoots(
    [options.workerRoot, options.nodeRoot, options.toolRoot],
    [options.workRoot, options.storeRoot],
  );
  const node = join(options.nodeRoot, "node.exe"),
    nodePin = await hashStoreFile(node);
  if (nodePin.sha256 !== STORE_NODE_EXECUTABLE_SHA256) invalid();
  await auditWindowsX64Binary(node);
  const tool = await verifyStorePnpmTool(
      options.toolRoot,
      options.componentRoot,
    ),
    lock = await packageFile(
      join(options.workerRoot, "pnpm-lock.yaml"),
      8 * 1024 ** 2,
    );
  if (hash(lock) !== STORE_WORKER_PNPM_LOCK_SHA256)
    invalid("STORE_WORKER_LOCK_CHANGED");
  // No reuse or global installation: both roots must be absent at admission.
  await mkdir(options.workRoot);
  await mkdir(options.storeRoot);
  const data = join(options.workRoot, "private"),
    environment = storePnpmEnvironment(data);
  await mkdir(data);
  for (const key of [
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "PNPM_HOME",
    "TEMP",
  ] as const)
    await mkdir(environment[key]);
  for (const key of [
    "NPM_CONFIG_USERCONFIG",
    "NPM_CONFIG_GLOBALCONFIG",
  ] as const)
    await writeFile(environment[key], "", { flag: "wx" });
  await writeFile(join(options.workRoot, "pnpm-lock.yaml"), lock, {
    flag: "wx",
  });
  const manifest = await packageFile(
    join(options.workerRoot, "package.json"),
    65536,
  );
  await writeFile(join(options.workRoot, "package.json"), manifest, {
    flag: "wx",
  });
  try {
    const result = await execute(
      node,
      [...storePnpmFetchArguments(tool.cli, options.storeRoot)],
      {
        cwd: options.workRoot,
        env: environment,
        shell: false,
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 4 * 1024 ** 2,
      },
    );
    await writeFile(join(data, "fetch.stdout.log"), result.stdout, {
      flag: "wx",
    });
    await writeFile(join(data, "fetch.stderr.log"), result.stderr, {
      flag: "wx",
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    await writeFile(
      join(data, "fetch-failed.stdout.log"),
      String(failure.stdout ?? "").slice(0, 4 * 1024 ** 2),
      { flag: "wx" },
    );
    await writeFile(
      join(data, "fetch-failed.stderr.log"),
      String(failure.stderr ?? "").slice(0, 4 * 1024 ** 2),
      { flag: "wx" },
    );
    invalid("STORE_WORKER_DEPENDENCY_FETCH_FAILED");
  }
  const after = await verifyStorePnpmTool(
    options.toolRoot,
    options.componentRoot,
  );
  if (
    after.censusSha256 !== tool.censusSha256 ||
    (await hashStoreFile(node)).sha256 !== nodePin.sha256 ||
    !(
      await packageFile(join(options.workRoot, "pnpm-lock.yaml"), 8 * 1024 ** 2)
    ).equals(lock) ||
    !(await packageFile(join(options.workRoot, "package.json"), 65536)).equals(
      manifest,
    )
  )
    invalid("STORE_WORKER_DEPENDENCY_FETCH_INPUT_CHANGED");
  return Object.freeze({
    officialToolClosureSha256: tool.censusSha256,
    workerLockSha256: STORE_WORKER_PNPM_LOCK_SHA256,
    primaryRegistry: "https://registry.npmjs.org/",
    productionCacheFetchCompleted: true,
    offlineInstallQualified: false,
    guardedWindowsQualification: false,
  });
}
/** Only this real dependency installer replaces the legacy build-side helper.
 * Host/native/probe/acquisition defaults are retained by the caller. */
export async function installStoreProductionDependencies(options: {
  workerRoot: string;
  appRoot: string;
  componentRoot: string;
  nodeRoot: string;
  toolRoot: string;
  storeRoot: string;
  dataRoot: string;
}) {
  if (process.platform !== "win32" || process.arch !== "x64")
    invalid("STORE_WORKER_WINDOWS_REQUIRED");
  const node = join(options.nodeRoot, "node.exe"),
    nodePin = await hashStoreFile(node);
  if (nodePin.sha256 !== STORE_NODE_EXECUTABLE_SHA256) invalid();
  await auditWindowsX64Binary(node);
  const tool = await verifyStorePnpmTool(
      options.toolRoot,
      options.componentRoot,
    ),
    environment = storePnpmEnvironment(options.dataRoot);
  await mkdir(options.dataRoot);
  for (const key of [
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "PNPM_HOME",
    "TEMP",
  ] as const)
    await mkdir(environment[key]);
  for (const key of [
    "NPM_CONFIG_USERCONFIG",
    "NPM_CONFIG_GLOBALCONFIG",
  ] as const)
    await writeFile(environment[key], "", { flag: "wx" });
  const lock = await packageFile(
    join(options.workerRoot, "pnpm-lock.yaml"),
    8 * 1024 ** 2,
  );
  if (hash(lock) !== STORE_WORKER_PNPM_LOCK_SHA256)
    invalid("STORE_WORKER_LOCK_CHANGED");
  await writeFile(join(options.appRoot, "pnpm-lock.yaml"), lock, {
    flag: "wx",
  });
  let result;
  try {
    result = await execute(
      node,
      [...storePnpmInstallArguments(tool.cli, options.storeRoot)],
      {
        cwd: options.appRoot,
        env: environment,
        shell: false,
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 4 * 1024 ** 2,
      },
    );
    await writeFile(
      join(options.dataRoot, "install.stdout.log"),
      result.stdout,
      { flag: "wx" },
    );
    await writeFile(
      join(options.dataRoot, "install.stderr.log"),
      result.stderr,
      { flag: "wx" },
    );
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    await writeFile(
      join(options.dataRoot, "install-failed.stdout.log"),
      String(failure.stdout ?? "").slice(0, 4 * 1024 ** 2),
      { flag: "wx" },
    );
    await writeFile(
      join(options.dataRoot, "install-failed.stderr.log"),
      String(failure.stderr ?? "").slice(0, 4 * 1024 ** 2),
      { flag: "wx" },
    );
    invalid("STORE_WORKER_OFFLINE_DEPENDENCIES_FAILED");
  }
  if (
    !(
      await packageFile(join(options.appRoot, "pnpm-lock.yaml"), 8 * 1024 ** 2)
    ).equals(lock)
  )
    invalid();
  const after = await verifyStorePnpmTool(
    options.toolRoot,
    options.componentRoot,
  );
  if (
    after.censusSha256 !== tool.censusSha256 ||
    (await hashStoreFile(node)).sha256 !== nodePin.sha256
  )
    invalid();
  // Only known package-manager metadata inside this newly owned app stage.
  for (const relative of [
    "node_modules/.bin",
    "node_modules/.modules.yaml",
    "node_modules/.pnpm-workspace-state-v1.json",
    "node_modules/.package-lock.json",
  ])
    await rm(join(options.appRoot, relative), { recursive: true, force: true });
  return Object.freeze({
    officialToolClosureSha256: tool.censusSha256,
    offlineInstallCompleted: true,
    guardedWindowsQualification: false,
  });
}

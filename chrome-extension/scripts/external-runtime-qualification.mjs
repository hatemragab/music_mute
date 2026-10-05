import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";
import {
  assertRuntimeArchiveListing,
  collectRuntimeInventory,
  verifyRuntimeCodeSignature,
} from "./macos-runtime-artifact.mjs";

const run = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BUILD_ROOT =
  /^build-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.noindex$/;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

function ensure(condition, code) {
  if (!condition) throw new Error(code);
}

function contained(root, path) {
  const child = relative(root, path);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function boundedRegularFile(path, maximum, code) {
  let information;
  try {
    information = await lstat(path);
  } catch {
    throw new Error(code);
  }
  ensure(
    information.isFile() &&
      !information.isSymbolicLink() &&
      information.nlink === 1 &&
      information.uid === process.getuid?.() &&
      !(information.mode & 0o022) &&
      information.size > 0 &&
      information.size <= maximum,
    code,
  );
  return information;
}

async function privateDirectory(path, { create = false } = {}) {
  let information;
  try {
    if (create) await mkdir(path, { mode: 0o700 });
    information = await lstat(path);
  } catch {
    throw new Error("QUALIFICATION_RUNTIME_DIRECTORY_UNSAFE");
  }
  ensure(
    information.isDirectory() &&
      !information.isSymbolicLink() &&
      information.uid === process.getuid?.() &&
      !(information.mode & 0o077),
    "QUALIFICATION_RUNTIME_DIRECTORY_UNSAFE",
  );
}

function validateManifest(document, packaged) {
  const runtime = document?.runtime;
  ensure(
    document?.schema_version === 1 &&
      runtime &&
      !Array.isArray(runtime) &&
      RUNTIME_ID.test(runtime.id ?? "") &&
      runtime.api_version === 1 &&
      runtime.platform === "darwin" &&
      runtime.arch === "arm64" &&
      runtime.archive_format === "zip" &&
      SHA256.test(runtime.archive_sha256 ?? "") &&
      Number.isSafeInteger(runtime.archive_bytes) &&
      runtime.archive_bytes > 0 &&
      runtime.archive_bytes <= 2_000_000_000 &&
      Number.isSafeInteger(runtime.installed_bytes) &&
      runtime.installed_bytes > 0 &&
      runtime.installed_bytes <= 4_000_000_000 &&
      Array.isArray(runtime.files) &&
      runtime.files.length >= 5 &&
      runtime.files.length <= 50_000 &&
      ((runtime.signing?.mode === "ad_hoc" &&
        runtime.signing.team_id == null) ||
        (runtime.signing?.mode === "developer_id" &&
          /^[A-Z0-9]{10}$/.test(runtime.signing.team_id ?? ""))),
    "QUALIFICATION_RUNTIME_MANIFEST_INVALID",
  );
  let url;
  try {
    url = new URL(runtime.url);
  } catch {
    throw new Error("QUALIFICATION_RUNTIME_MANIFEST_INVALID");
  }
  const hosts = runtime.download_hosts;
  ensure(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (!url.port || url.port === "443") &&
      Array.isArray(hosts) &&
      hosts.length >= 1 &&
      hosts.length <= 8 &&
      new Set(hosts).size === hosts.length &&
      hosts.includes(url.hostname) &&
      hosts.every(
        (host) =>
          typeof host === "string" &&
          /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
            host,
          ),
      ) &&
      runtime.id === packaged.id &&
      runtime.archive_sha256 === packaged.archive_sha256 &&
      runtime.archive_bytes === packaged.archive_bytes &&
      runtime.installed_bytes === packaged.installed_bytes &&
      runtime.url === packaged.url &&
      runtime.files.length === packaged.files &&
      JSON.stringify(runtime.signing) === JSON.stringify(packaged.signing),
    "QUALIFICATION_RUNTIME_MANIFEST_INVALID",
  );
  return runtime;
}

async function freezeRelease(releaseRoot, files) {
  const entries = new Map(files.map((entry) => [entry.path, entry]));
  const directories = [];
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const information = await lstat(path);
      if (information.isSymbolicLink()) continue;
      if (information.isDirectory()) {
        directories.push(path);
        await visit(path);
      } else {
        const manifestPath = relative(releaseRoot, path);
        const entry = entries.get(manifestPath);
        ensure(
          entry?.type === "file",
          "QUALIFICATION_RUNTIME_INVENTORY_INVALID",
        );
        await chmod(path, entry.executable === true ? 0o500 : 0o400);
      }
    }
  }
  await visit(releaseRoot);
  for (const directory of directories.reverse()) await chmod(directory, 0o500);
  await chmod(releaseRoot, 0o500);
}

async function verifyFrozenRelease(releaseRoot, files) {
  const expected = new Map(files.map((entry) => [entry.path, entry]));
  async function visit(directory) {
    const directoryInfo = await lstat(directory);
    ensure(
      directoryInfo.isDirectory() &&
        !directoryInfo.isSymbolicLink() &&
        directoryInfo.uid === process.getuid?.() &&
        (directoryInfo.mode & 0o777) === 0o500,
      "QUALIFICATION_RUNTIME_PERMISSIONS_INVALID",
    );
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const information = await lstat(path);
      if (information.isDirectory() && !information.isSymbolicLink()) {
        await visit(path);
        continue;
      }
      const manifestPath = relative(releaseRoot, path);
      const entry = expected.get(manifestPath);
      ensure(entry, "QUALIFICATION_RUNTIME_INVENTORY_INVALID");
      if (entry.type === "symlink") {
        ensure(
          information.isSymbolicLink() &&
            information.uid === process.getuid?.(),
          "QUALIFICATION_RUNTIME_PERMISSIONS_INVALID",
        );
      } else {
        ensure(
          information.isFile() &&
            !information.isSymbolicLink() &&
            information.nlink === 1 &&
            information.uid === process.getuid?.() &&
            (information.mode & 0o777) ===
              (entry.executable === true ? 0o500 : 0o400),
          "QUALIFICATION_RUNTIME_PERMISSIONS_INVALID",
        );
      }
    }
  }
  await visit(releaseRoot);
}

/**
 * Re-audit the staged release after a qualification process has consumed it.
 * The exact bytes, links, signatures, permissions and active pointer must still
 * match the package-bound manifest.
 */
export async function verifyExternalRuntimeForQualification({
  releaseRoot,
  activePath,
  runtime,
  packageResult,
  exec = run,
}) {
  const runtimePackage = packageResult?.runtime;
  ensure(
    isAbsolute(releaseRoot) &&
      isAbsolute(activePath) &&
      runtime &&
      runtimePackage &&
      basename(releaseRoot) === runtime.id &&
      basename(dirname(releaseRoot)) === "releases" &&
      activePath === join(dirname(dirname(releaseRoot)), "active.json") &&
      (await realpath(releaseRoot)) === releaseRoot,
    "QUALIFICATION_RUNTIME_DIRECTORY_UNSAFE",
  );
  const bootstrapLock = join(dirname(activePath), "bootstrap.lock");
  let bootstrapLockInfo;
  try {
    bootstrapLockInfo = await lstat(bootstrapLock);
  } catch {
    throw new Error("QUALIFICATION_RUNTIME_ACTIVE_INVALID");
  }
  ensure(
    bootstrapLockInfo.isFile() &&
      !bootstrapLockInfo.isSymbolicLink() &&
      bootstrapLockInfo.uid === process.getuid?.() &&
      bootstrapLockInfo.nlink === 1 &&
      (bootstrapLockInfo.mode & 0o777) === 0o600 &&
      bootstrapLockInfo.size === 0,
    "QUALIFICATION_RUNTIME_ACTIVE_INVALID",
  );
  let extracted;
  try {
    extracted = await collectRuntimeInventory(releaseRoot);
  } catch {
    throw new Error("QUALIFICATION_RUNTIME_INVENTORY_INVALID");
  }
  ensure(
    extracted.installedBytes === runtime.installed_bytes &&
      JSON.stringify(extracted.files) === JSON.stringify(runtime.files),
    "QUALIFICATION_RUNTIME_INVENTORY_INVALID",
  );
  const signed = extracted.files.filter(
    (entry) => entry.type === "file" && entry.code_signed === true,
  );
  ensure(
    signed.length === runtimePackage.native_binaries &&
      (runtimePackage.native_binaries_verified == null ||
        runtimePackage.native_binaries_verified === signed.length),
    "QUALIFICATION_RUNTIME_SIGNATURE_COUNT_INVALID",
  );
  for (const entry of signed)
    await verifyRuntimeCodeSignature(
      join(releaseRoot, entry.path),
      runtime.signing,
      { exec },
    );
  await verifyFrozenRelease(releaseRoot, extracted.files);
  const activeInfo = await boundedRegularFile(
    activePath,
    16 * 1024,
    "QUALIFICATION_RUNTIME_ACTIVE_INVALID",
  );
  const expectedActive = {
    api_version: runtime.api_version,
    archive_sha256: runtime.archive_sha256,
    release_path: `releases/${runtime.id}`,
    runtime_id: runtime.id,
    schema_version: 1,
  };
  ensure(
    (activeInfo.mode & 0o777) === 0o400 &&
      (await readFile(activePath, "utf8")) ===
        `${JSON.stringify(expectedActive)}\n`,
    "QUALIFICATION_RUNTIME_ACTIVE_INVALID",
  );
  return extracted;
}

/**
 * Recreate only the native installer's verified active-runtime state in a
 * disposable qualification root. No network, user state or app mutation occurs.
 */
export async function stageExternalRuntimeForQualification({
  app,
  stateRoot,
  packageResultPath,
  exec = run,
}) {
  ensure(
    isAbsolute(app) && isAbsolute(stateRoot),
    "INVALID_QUALIFICATION_ARGUMENTS",
  );
  const resolvedApp = await realpath(app);
  const buildRoot = dirname(resolvedApp);
  const resolvedState = resolve(stateRoot);
  const match = BUILD_ROOT.exec(basename(buildRoot));
  ensure(
    match &&
      basename(resolvedApp) === "MusicMute Local.app" &&
      resolvedState === stateRoot &&
      resolvedState !== resolvedApp &&
      resolvedState !== buildRoot &&
      !contained(resolvedApp, resolvedState) &&
      !contained(buildRoot, resolvedState) &&
      !contained(resolvedState, buildRoot),
    "QUALIFICATION_PACKAGE_ROOT_INVALID",
  );
  await privateDirectory(stateRoot);
  ensure(
    (await realpath(stateRoot)) === stateRoot,
    "QUALIFICATION_RUNTIME_DIRECTORY_UNSAFE",
  );
  const resultPath =
    packageResultPath ?? join(buildRoot, "package-result.json");
  ensure(
    resolve(resultPath) === resultPath &&
      dirname(resultPath) === buildRoot &&
      basename(resultPath) === "package-result.json",
    "QUALIFICATION_PACKAGE_RESULT_INVALID",
  );
  await boundedRegularFile(
    resultPath,
    MAX_MANIFEST_BYTES,
    "QUALIFICATION_PACKAGE_RESULT_INVALID",
  );
  let packaged;
  try {
    packaged = JSON.parse(await readFile(resultPath, "utf8"));
  } catch {
    throw new Error("QUALIFICATION_PACKAGE_RESULT_INVALID");
  }
  const runtimePackage = packaged?.runtime;
  ensure(
    packaged?.schema_version === 1 &&
      packaged.build_id === match[1] &&
      packaged.build_root === buildRoot &&
      packaged.app === resolvedApp &&
      packaged.public_ready === false &&
      runtimePackage?.delivery === "EXTERNAL_PREPARE" &&
      RUNTIME_ID.test(runtimePackage.id ?? "") &&
      SHA256.test(runtimePackage.archive_sha256 ?? "") &&
      SHA256.test(runtimePackage.manifest_sha256 ?? "") &&
      Number.isSafeInteger(runtimePackage.archive_bytes) &&
      runtimePackage.archive_bytes > 0 &&
      Number.isSafeInteger(runtimePackage.installed_bytes) &&
      runtimePackage.installed_bytes > 0 &&
      Number.isSafeInteger(runtimePackage.files) &&
      runtimePackage.files >= 5 &&
      runtimePackage.files <= 50_000 &&
      Number.isSafeInteger(runtimePackage.native_binaries) &&
      runtimePackage.native_binaries > 0 &&
      runtimePackage.native_binaries <= runtimePackage.files &&
      runtimePackage.notarized === false &&
      runtimePackage.public_ready === false &&
      ((runtimePackage.signing?.mode === "ad_hoc" &&
        packaged.signing === "AD_HOC_LOCAL" &&
        packaged.release_mode === false &&
        runtimePackage.native_binaries_verified == null) ||
        (runtimePackage.signing?.mode === "developer_id" &&
          packaged.signing === "DEVELOPER_ID_DISTRIBUTION" &&
          packaged.release_mode === true &&
          packaged.team_identifier === runtimePackage.signing.team_id &&
          runtimePackage.native_binaries_verified ===
            runtimePackage.native_binaries)),
    "QUALIFICATION_PACKAGE_RESULT_INVALID",
  );
  let archive;
  let sidecar;
  try {
    ensure(
      isAbsolute(runtimePackage.archive) && isAbsolute(runtimePackage.manifest),
      "QUALIFICATION_RUNTIME_PATH_INVALID",
    );
    archive = await realpath(runtimePackage.archive);
    sidecar = await realpath(runtimePackage.manifest);
  } catch (error) {
    if (error.message === "QUALIFICATION_RUNTIME_PATH_INVALID") throw error;
    throw new Error("QUALIFICATION_RUNTIME_PATH_INVALID");
  }
  ensure(
    runtimePackage.archive === archive &&
      runtimePackage.manifest === sidecar &&
      contained(buildRoot, archive) &&
      contained(buildRoot, sidecar),
    "QUALIFICATION_RUNTIME_PATH_INVALID",
  );
  const resources = join(resolvedApp, "Contents/Resources");
  const embedded = join(resources, "runtime-bootstrap.json");
  await boundedRegularFile(
    sidecar,
    MAX_MANIFEST_BYTES,
    "QUALIFICATION_RUNTIME_MANIFEST_INVALID",
  );
  await boundedRegularFile(
    embedded,
    MAX_MANIFEST_BYTES,
    "QUALIFICATION_RUNTIME_MANIFEST_INVALID",
  );
  try {
    await lstat(join(resources, "runtime"));
    throw new Error("QUALIFICATION_THIN_APP_INVALID");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const [sidecarBytes, embeddedBytes] = await Promise.all([
    readFile(sidecar),
    readFile(embedded),
  ]);
  ensure(
    sidecarBytes.equals(embeddedBytes) &&
      createHash("sha256").update(sidecarBytes).digest("hex") ===
        runtimePackage.manifest_sha256,
    "QUALIFICATION_RUNTIME_MANIFEST_MISMATCH",
  );
  let manifestDocument;
  try {
    manifestDocument = JSON.parse(sidecarBytes.toString("utf8"));
  } catch {
    throw new Error("QUALIFICATION_RUNTIME_MANIFEST_INVALID");
  }
  const runtime = validateManifest(manifestDocument, runtimePackage);
  const archiveInfo = await boundedRegularFile(
    archive,
    2_000_000_000,
    "QUALIFICATION_RUNTIME_ARCHIVE_INVALID",
  );
  ensure(
    archiveInfo.size === runtime.archive_bytes &&
      (await digest(archive)) === runtime.archive_sha256,
    "QUALIFICATION_RUNTIME_ARCHIVE_INVALID",
  );
  const { stdout } = await exec("/usr/bin/unzip", ["-Z1", archive], {
    timeout: 10 * 60_000,
    maxBuffer: MAX_MANIFEST_BYTES,
  });
  assertRuntimeArchiveListing(String(stdout), runtime.files);

  const runtimeDirectory = join(stateRoot, "runtime");
  const releases = join(runtimeDirectory, "releases");
  await privateDirectory(runtimeDirectory, { create: true });
  await privateDirectory(releases, { create: true });
  await writeFile(join(runtimeDirectory, "bootstrap.lock"), Buffer.alloc(0), {
    flag: "wx",
    mode: 0o600,
  });
  const releaseRoot = join(releases, runtime.id);
  await privateDirectory(releaseRoot, { create: true });
  await exec(
    "/usr/bin/ditto",
    ["-x", "-k", "--noextattr", "--noqtn", "--noacl", archive, releaseRoot],
    { timeout: 20 * 60_000, maxBuffer: 256 * 1024 },
  );
  const extracted = await collectRuntimeInventory(releaseRoot);
  ensure(
    extracted.installedBytes === runtime.installed_bytes &&
      JSON.stringify(extracted.files) === JSON.stringify(runtime.files),
    "QUALIFICATION_RUNTIME_INVENTORY_INVALID",
  );
  const signed = extracted.files.filter(
    (entry) => entry.type === "file" && entry.code_signed === true,
  );
  ensure(
    signed.length === runtimePackage.native_binaries &&
      (runtimePackage.native_binaries_verified == null ||
        runtimePackage.native_binaries_verified === signed.length),
    "QUALIFICATION_RUNTIME_SIGNATURE_COUNT_INVALID",
  );
  for (const entry of signed)
    await verifyRuntimeCodeSignature(
      join(releaseRoot, entry.path),
      runtime.signing,
      { exec },
    );
  await freezeRelease(releaseRoot, extracted.files);
  const active = {
    api_version: runtime.api_version,
    archive_sha256: runtime.archive_sha256,
    release_path: `releases/${runtime.id}`,
    runtime_id: runtime.id,
    schema_version: 1,
  };
  const activePath = join(runtimeDirectory, "active.json");
  await writeFile(activePath, `${JSON.stringify(active)}\n`, {
    flag: "wx",
    mode: 0o400,
  });
  await verifyExternalRuntimeForQualification({
    releaseRoot,
    activePath,
    runtime,
    packageResult: packaged,
    exec,
  });
  return {
    resources,
    runtimeRoot: join(releaseRoot, "runtime"),
    releaseRoot,
    activePath,
    runtime,
    packageResult: packaged,
  };
}

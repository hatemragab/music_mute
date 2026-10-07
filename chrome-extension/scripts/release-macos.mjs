import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";

const command = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, "..");
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digestPattern = /^[a-f0-9]{64}$/;
const identityPattern = /^[A-F0-9]{40}$/;
const teamPattern = /^[A-Z0-9]{10}$/;
const runtimeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const maximumRuntimeManifestBytes = 16 * 1024 * 1024;
const maximumRuntimeArchiveBytes = 2_000_000_000;
const maximumRuntimeInstalledBytes = 4_000_000_000;
const maximumRuntimeFiles = 50_000;
const runtimeRequiredLaunchers = [
  "runtime/runtime/node/bin/node",
  "runtime/runtime/python/bin/python3",
  "runtime/runtime/bin/ffmpeg",
  "runtime/runtime/bin/ffprobe",
  "runtime/tools/youtube/bin/deno",
];
const machOMagics = new Set([
  "cffaedfe",
  "cefaedfe",
  "feedfacf",
  "feedface",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
]);
const notarizationStates = new Set([
  "PREPARED",
  "SUBMITTING",
  "SUBMITTED",
  "IN_PROGRESS",
  "ACCEPTED",
  "INVALID",
  "REJECTED",
  "STAPLED",
  "READY",
]);
const safeEnvironment = {
  HOME: homedir(),
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "en_US.UTF-8",
};

/** Credentials must already exist in Keychain; secret-bearing flags are rejected. */
export function parseReleaseOptions(args) {
  const options = {};
  const names = {
    "--package-result": "packageResult",
    "--identity": "identity",
    "--keychain-profile": "keychainProfile",
    "--release-root": "releaseRoot",
    "--resume": "resume",
  };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const name = names[flag];
    if (flag === "--prepare-only" || flag === "--submit") {
      const key = flag === "--submit" ? "submit" : "prepareOnly";
      if (options[key]) throw new Error("INVALID_RELEASE_OPTIONS");
      options[key] = true;
    } else if (
      name &&
      !Object.hasOwn(options, name) &&
      typeof args[index + 1] === "string" &&
      args[index + 1].length > 0 &&
      !args[index + 1].startsWith("--") &&
      args[index + 1].length <= 4096 &&
      !Array.from(args[index + 1]).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      options[name] = args[++index];
    } else throw new Error("INVALID_RELEASE_OPTIONS");
  }
  if (
    (options.identity && !identityPattern.test(options.identity)) ||
    (options.resume && !uuidPattern.test(options.resume)) ||
    (options.keychainProfile &&
      !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,79}$/.test(options.keychainProfile)) ||
    (options.prepareOnly && (options.submit || options.keychainProfile))
  )
    throw new Error("INVALID_RELEASE_OPTIONS");
  if (options.releaseRoot) {
    if (
      options.packageResult ||
      options.identity ||
      options.prepareOnly ||
      !options.keychainProfile ||
      Boolean(options.resume) === Boolean(options.submit)
    )
      throw new Error("INVALID_RELEASE_OPTIONS");
  } else if (
    !options.packageResult ||
    !options.identity ||
    options.resume ||
    options.submit ||
    (!options.prepareOnly && !options.keychainProfile)
  )
    throw new Error("INVALID_RELEASE_OPTIONS");
  return options;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

async function ownedPath(
  path,
  { directory = false, maximum = 0, singleLink = false } = {},
) {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o022 ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (!directory && singleLink && info.nlink !== 1) ||
    (!directory && maximum && info.size > maximum)
  )
    throw new Error("UNSAFE_RELEASE_PATH");
  return info;
}

async function readJson(path, maximum = 64 * 1024) {
  await ownedPath(path, { maximum });
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("INVALID_RELEASE_RECORD");
  }
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function displayDecimalBytes(bytes) {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000)
    return `${Math.round(bytes / 1_000_000).toLocaleString("en-US")} MB`;
  if (bytes >= 1_000)
    return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  return `${bytes} B`;
}

async function readRuntimeManifest(path) {
  try {
    const initial = await lstat(path);
    if (initial.size > maximumRuntimeManifestBytes)
      throw new Error("RUNTIME_MANIFEST_TOO_LARGE");
    const before = await ownedPath(path, {
      maximum: maximumRuntimeManifestBytes,
      singleLink: true,
    });
    if (before.size < 2) throw new Error("INVALID_RUNTIME_MANIFEST");
    const bytes = await readFile(path);
    const after = await ownedPath(path, {
      maximum: maximumRuntimeManifestBytes,
      singleLink: true,
    });
    if (
      bytes.length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size
    )
      throw new Error("RUNTIME_MANIFEST_CHANGED_DURING_READ");
    let manifest;
    try {
      manifest = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("INVALID_RUNTIME_MANIFEST");
    }
    return { bytes, manifest, sha256: sha256Bytes(bytes) };
  } catch (error) {
    if (/^[A-Z][A-Z0-9_]{1,120}$/.test(error?.message ?? "")) throw error;
    throw new Error("RUNTIME_MANIFEST_READ_FAILED");
  }
}

async function writeJson(path, data) {
  try {
    await ownedPath(path, { maximum: 1024 * 1024 });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = join(dirname(path), `.record-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function releaseLock(directory) {
  const path = join(directory, ".release-lock.json");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.sync();
      const identity = await handle.stat();
      await handle.close();
      return async () => {
        const info = await ownedPath(path, { maximum: 1024 });
        if (info.ino !== identity.ino || info.dev !== identity.dev)
          throw new Error("RELEASE_LOCK_CHANGED");
        await rm(path);
      };
    } catch (error) {
      if (error.code !== "EEXIST" || attempt !== 0) throw error;
      const info = await ownedPath(path, { maximum: 1024 });
      const record = await readJson(path, 1024);
      if (!Number.isSafeInteger(record.pid) || record.pid <= 0)
        throw new Error("INVALID_RELEASE_LOCK");
      try {
        process.kill(record.pid, 0);
        throw new Error("RELEASE_ALREADY_RUNNING");
      } catch (inspectionError) {
        if (inspectionError.code !== "ESRCH") throw inspectionError;
      }
      const current = await ownedPath(path, { maximum: 1024 });
      if (info.ino !== current.ino || info.dev !== current.dev)
        throw new Error("RELEASE_LOCK_CHANGED");
      await rm(path);
    }
  }
  throw new Error("RELEASE_ALREADY_RUNNING");
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function positiveSafeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function nonnegativeSafeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function exactKeys(value, keys) {
  return (
    record(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function safeRuntimePath(path) {
  if (
    typeof path !== "string" ||
    !path.startsWith("runtime/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    Buffer.byteLength(path, "utf8") > 4096 ||
    Array.from(path).some((character) => {
      const code = character.codePointAt(0);
      return code == null || code < 32 || code === 127;
    })
  )
    return false;
  return path
    .split("/")
    .every(
      (component) =>
        component &&
        component !== "." &&
        component !== ".." &&
        Buffer.byteLength(component, "utf8") <= 255,
    );
}

function expectedRuntimeDirectories(files) {
  const directories = new Set(["runtime"]);
  for (const { path } of files) {
    const components = path.split("/");
    for (let index = 1; index < components.length; index++)
      directories.add(components.slice(0, index).join("/"));
  }
  return directories;
}

function runtimeLinkDestination(path, target, entries) {
  if (
    typeof target !== "string" ||
    !target ||
    isAbsolute(target) ||
    target.includes("\\") ||
    Buffer.byteLength(target, "utf8") > 4096 ||
    Array.from(target).some((character) => {
      const code = character.codePointAt(0);
      return code == null || code < 32 || code === 127;
    })
  )
    return null;
  const components = dirname(path).split("/");
  const targetComponents = target.split("/");
  let descended = false;
  for (let index = 0; index < targetComponents.length; index++) {
    const component = targetComponents[index];
    if (!component || component === ".") return null;
    if (component === "..") {
      if (descended || components.length <= 1) return null;
      components.pop();
      continue;
    }
    if (Buffer.byteLength(component, "utf8") > 255) return null;
    descended = true;
    components.push(component);
    if (
      index < targetComponents.length - 1 &&
      entries.has(components.join("/"))
    )
      return null;
  }
  const destination = components.join("/");
  return safeRuntimePath(destination) ? destination : null;
}

function validateRuntimeSymlinkGraph(files) {
  const entries = new Map(files.map((entry) => [entry.path, entry]));
  const directories = expectedRuntimeDirectories(files);
  const terminals = new Map();
  for (const entry of files) {
    if (entry.type !== "symlink") continue;
    const origin = entry.path;
    let current = entry;
    const visited = new Set();
    while (current.type === "symlink") {
      if (visited.has(current.path))
        throw new Error("RUNTIME_LINK_DANGLING_OR_CYCLIC");
      visited.add(current.path);
      const destination = runtimeLinkDestination(
        current.path,
        current.link_target,
        entries,
      );
      if (!destination) throw new Error("RUNTIME_LINK_UNSAFE");
      const next = entries.get(destination);
      if (next) {
        if (next.type === "symlink") {
          current = next;
          continue;
        }
        if (next.type !== "file")
          throw new Error("RUNTIME_LINK_DANGLING_OR_CYCLIC");
        terminals.set(origin, destination);
        break;
      }
      if (!directories.has(destination) || origin.startsWith(`${destination}/`))
        throw new Error("RUNTIME_LINK_DANGLING_OR_CYCLIC");
      terminals.set(origin, destination);
      break;
    }
  }
  return { directories, terminals };
}

function validateRuntimeManifestShape(manifest, packaged, teamIdentifier) {
  const runtime = record(manifest)?.runtime;
  const signing = record(runtime)?.signing;
  const packagedSigning = record(packaged)?.signing;
  if (
    record(manifest)?.schema_version !== 1 ||
    !record(runtime) ||
    !runtimeIdPattern.test(runtime.id ?? "") ||
    runtime.api_version !== 1 ||
    runtime.platform !== "darwin" ||
    runtime.arch !== "arm64" ||
    runtime.archive_format !== "zip" ||
    !digestPattern.test(runtime.archive_sha256 ?? "") ||
    !positiveSafeInteger(runtime.archive_bytes, maximumRuntimeArchiveBytes) ||
    !positiveSafeInteger(
      runtime.installed_bytes,
      maximumRuntimeInstalledBytes,
    ) ||
    !Array.isArray(runtime.download_hosts) ||
    runtime.download_hosts.length < 1 ||
    runtime.download_hosts.length > 8 ||
    !exactKeys(signing, ["mode", "team_id"]) ||
    signing.mode !== "developer_id" ||
    signing.team_id !== teamIdentifier ||
    !Array.isArray(runtime.files) ||
    runtime.files.length < runtimeRequiredLaunchers.length ||
    runtime.files.length > maximumRuntimeFiles ||
    packaged?.delivery !== "EXTERNAL_PREPARE" ||
    packaged.id !== runtime.id ||
    packaged.archive_sha256 !== runtime.archive_sha256 ||
    packaged.archive_bytes !== runtime.archive_bytes ||
    packaged.installed_bytes !== runtime.installed_bytes ||
    packaged.url !== runtime.url ||
    packaged.files !== runtime.files.length ||
    packaged.notarized !== false ||
    packaged.public_ready !== false ||
    !exactKeys(packagedSigning, ["mode", "team_id"]) ||
    packagedSigning.mode !== signing.mode ||
    packagedSigning.team_id !== signing.team_id
  )
    throw new Error("RUNTIME_PACKAGE_METADATA_MISMATCH");
  let url;
  try {
    url = new URL(runtime.url);
  } catch {
    throw new Error("RUNTIME_DOWNLOAD_URL_INVALID");
  }
  const hosts = runtime.download_hosts;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== "443") ||
    hosts[0] !== url.hostname.toLowerCase() ||
    new Set(hosts).size !== hosts.length ||
    hosts.some(
      (host) =>
        typeof host !== "string" ||
        host !== host.toLowerCase() ||
        !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
          host,
        ),
    )
  )
    throw new Error("RUNTIME_DOWNLOAD_URL_INVALID");
  const archiveFilename = `MusicMuteLocal-runtime-${runtime.id}-${runtime.archive_sha256.slice(0, 16)}.zip`;
  let urlFilename;
  try {
    urlFilename = decodeURIComponent(basename(url.pathname));
  } catch {
    throw new Error("RUNTIME_DOWNLOAD_URL_INVALID");
  }
  if (urlFilename !== archiveFilename)
    throw new Error("RUNTIME_DOWNLOAD_URL_INVALID");
  const paths = new Set();
  let installedBytes = 0;
  let nativeBinaries = 0;
  let previousPath = "";
  for (const entry of runtime.files) {
    if (
      !record(entry) ||
      !safeRuntimePath(entry.path) ||
      paths.has(entry.path) ||
      (previousPath && previousPath.localeCompare(entry.path) >= 0)
    )
      throw new Error("RUNTIME_INVENTORY_INVALID");
    paths.add(entry.path);
    previousPath = entry.path;
    if (entry.type === "file") {
      if (
        !exactKeys(entry, [
          "path",
          "type",
          "bytes",
          "sha256",
          "executable",
          "code_signed",
        ]) ||
        !nonnegativeSafeInteger(entry.bytes, 1_000_000_000) ||
        !digestPattern.test(entry.sha256 ?? "") ||
        typeof entry.executable !== "boolean" ||
        typeof entry.code_signed !== "boolean"
      )
        throw new Error("RUNTIME_INVENTORY_INVALID");
      installedBytes += entry.bytes;
      if (
        !Number.isSafeInteger(installedBytes) ||
        installedBytes > maximumRuntimeInstalledBytes
      )
        throw new Error("RUNTIME_INVENTORY_INVALID");
      if (entry.code_signed) nativeBinaries++;
    } else if (
      entry.type !== "symlink" ||
      !exactKeys(entry, ["path", "type", "link_target"]) ||
      typeof entry.link_target !== "string" ||
      !entry.link_target ||
      isAbsolute(entry.link_target) ||
      entry.link_target.includes("\\") ||
      Buffer.byteLength(entry.link_target, "utf8") > 4096 ||
      Array.from(entry.link_target).some((character) => {
        const code = character.codePointAt(0);
        return code == null || code < 32 || code === 127;
      })
    )
      throw new Error("RUNTIME_INVENTORY_INVALID");
  }
  validateRuntimeSymlinkGraph(runtime.files);
  if (
    installedBytes !== runtime.installed_bytes ||
    !positiveSafeInteger(packaged.native_binaries, maximumRuntimeFiles) ||
    packaged.native_binaries !== nativeBinaries ||
    packaged.native_binaries_verified !== nativeBinaries ||
    nativeBinaries < 1 ||
    runtimeRequiredLaunchers.some((path) => {
      const entry = runtime.files.find((candidate) => candidate.path === path);
      return entry?.type !== "file" || entry.executable !== true;
    })
  )
    throw new Error("RUNTIME_INVENTORY_INVALID");
  return { archiveFilename, runtime, nativeBinaries };
}

async function assertPackageArtifact(path, packageRoot, maximum) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path)
    throw new Error("RUNTIME_PACKAGE_PATH_INVALID");
  const fromRoot = relative(packageRoot, path);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot))
    throw new Error("RUNTIME_PACKAGE_PATH_INVALID");
  let parent = dirname(path);
  while (parent !== packageRoot) {
    if (parent === dirname(parent))
      throw new Error("RUNTIME_PACKAGE_PATH_INVALID");
    await ownedPath(parent, { directory: true });
    parent = dirname(parent);
  }
  const information = await ownedPath(path, { maximum, singleLink: true });
  if ((await realpath(path)) !== path)
    throw new Error("RUNTIME_PACKAGE_PATH_INVALID");
  return information;
}

function assertRuntimeArchiveListing(listing, files) {
  if (
    typeof listing !== "string" ||
    Buffer.byteLength(listing, "utf8") > maximumRuntimeManifestBytes
  )
    throw new Error("RUNTIME_ARCHIVE_LISTING_INVALID");
  const leaves = new Set(files.map((entry) => entry.path));
  const directories = expectedRuntimeDirectories(files);
  const seen = new Set();
  for (const raw of listing.split(/\r?\n/).filter(Boolean)) {
    const directory = raw.endsWith("/");
    const normalized = raw.startsWith("./") ? raw.slice(2) : raw;
    const path = normalized.replace(/\/+$/, "");
    if (
      !safeRuntimePath(directory ? `${path}/placeholder` : path) ||
      seen.has(path) ||
      (directory ? !directories.has(path) : !leaves.has(path))
    )
      throw new Error("RUNTIME_ARCHIVE_LISTING_INVALID");
    seen.add(path);
  }
  if ([...leaves].some((path) => !seen.has(path)))
    throw new Error("RUNTIME_ARCHIVE_LISTING_INVALID");
}

async function fileStartsWithMachOMagic(path) {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(4);
    const { bytesRead } = await handle.read(bytes, 0, 4, 0);
    return bytesRead === 4 && machOMagics.has(bytes.toString("hex"));
  } finally {
    await handle.close();
  }
}

async function validateExtractedRuntime(
  extraction,
  files,
  signing,
  configuration,
  exec,
) {
  const expected = new Map(files.map((entry) => [entry.path, entry]));
  const { directories, terminals } = validateRuntimeSymlinkGraph(files);
  const seen = new Set();
  const seenDirectories = new Set();
  const symlinks = [];
  let nativeBinaries = 0;
  async function walk(directory) {
    const children = await readdir(directory);
    children.sort((left, right) => left.localeCompare(right));
    for (const name of children) {
      const absolute = join(directory, name);
      const path = relative(extraction, absolute);
      if (path !== "runtime" && !safeRuntimePath(path))
        throw new Error("RUNTIME_EXTRACTED_PATH_INVALID");
      const information = await lstat(absolute);
      if (information.isDirectory() && !information.isSymbolicLink()) {
        if (
          !directories.has(path) ||
          seenDirectories.has(path) ||
          information.uid !== process.getuid?.() ||
          information.mode & 0o7022
        )
          throw new Error("RUNTIME_EXTRACTED_DIRECTORY_INVALID");
        seenDirectories.add(path);
        await walk(absolute);
        continue;
      }
      const entry = expected.get(path);
      if (!entry || seen.has(path))
        throw new Error("RUNTIME_EXTRACTED_INVENTORY_MISMATCH");
      seen.add(path);
      if (information.isSymbolicLink()) {
        if (entry.type !== "symlink" || information.uid !== process.getuid?.())
          throw new Error("RUNTIME_EXTRACTED_INVENTORY_MISMATCH");
        const target = await readlink(absolute);
        if (target !== entry.link_target)
          throw new Error("RUNTIME_EXTRACTED_INVENTORY_MISMATCH");
        symlinks.push({ absolute, path, target });
        continue;
      }
      if (
        entry.type !== "file" ||
        !information.isFile() ||
        information.uid !== process.getuid?.() ||
        information.nlink !== 1 ||
        information.mode & 0o7022 ||
        information.size !== entry.bytes ||
        Boolean(information.mode & 0o111) !== entry.executable ||
        (await hashFile(absolute)) !== entry.sha256
      )
        throw new Error("RUNTIME_EXTRACTED_INVENTORY_MISMATCH");
      const machO = await fileStartsWithMachOMagic(absolute);
      if (machO !== entry.code_signed)
        throw new Error("RUNTIME_CODE_SIGNING_INVENTORY_MISMATCH");
      if (entry.code_signed) {
        nativeBinaries++;
        await signing.verifyDeveloperIdSignature(absolute, configuration, {
          kind: "binary",
          exec: (file, commandArgs, settings) =>
            exec(file, commandArgs, { ...settings, env: safeEnvironment }),
        });
      }
    }
  }
  await walk(extraction);
  if (
    seen.size !== expected.size ||
    seenDirectories.size !== directories.size ||
    [...directories].some((path) => !seenDirectories.has(path))
  )
    throw new Error("RUNTIME_EXTRACTED_INVENTORY_MISMATCH");
  const payload = join(extraction, "runtime");
  if ((await realpath(payload)) !== payload)
    throw new Error("RUNTIME_EXTRACTED_PATH_INVALID");
  for (const { absolute, path } of symlinks) {
    const expectedDestination = terminals.get(path);
    if (!expectedDestination) throw new Error("RUNTIME_LINK_UNSAFE");
    let destination;
    try {
      destination = await realpath(absolute);
    } catch {
      throw new Error("RUNTIME_LINK_DANGLING_OR_CYCLIC");
    }
    const fromPayload = relative(payload, destination);
    if (!fromPayload || fromPayload.startsWith("..") || isAbsolute(fromPayload))
      throw new Error("RUNTIME_LINK_UNSAFE");
    const destinationPath = relative(extraction, destination);
    if (destinationPath !== expectedDestination)
      throw new Error("RUNTIME_LINK_UNSAFE");
    const destinationEntry = expected.get(destinationPath);
    const destinationDirectory = directories.has(destinationPath);
    let information;
    try {
      information = await lstat(destination);
    } catch {
      throw new Error("RUNTIME_LINK_DANGLING_OR_CYCLIC");
    }
    if (destinationEntry?.type === "file") {
      if (
        !information.isFile() ||
        information.isSymbolicLink() ||
        information.uid !== process.getuid?.() ||
        information.nlink !== 1 ||
        information.mode & 0o7022
      )
        throw new Error("RUNTIME_LINK_DANGLING_OR_CYCLIC");
    } else if (destinationDirectory && seenDirectories.has(destinationPath)) {
      if (
        path.startsWith(`${destinationPath}/`) ||
        !information.isDirectory() ||
        information.isSymbolicLink() ||
        information.uid !== process.getuid?.() ||
        information.mode & 0o7022
      )
        throw new Error("RUNTIME_LINK_DANGLING_OR_CYCLIC");
    } else {
      throw new Error("RUNTIME_LINK_DANGLING_OR_CYCLIC");
    }
  }
  return nativeBinaries;
}

async function removeRuntimeValidationExtraction(extraction) {
  try {
    await rm(extraction, { force: true, recursive: true });
  } catch {
    throw new Error("RUNTIME_VALIDATION_CLEANUP_FAILED");
  }
}

async function validateRuntimeReleaseArtifacts({
  packaged,
  packageRoot,
  app,
  temporaryParent,
  run,
  signing,
  configuration,
  exec,
}) {
  let extraction;
  try {
    if (!record(packaged.runtime))
      throw new Error("EXTERNAL_RUNTIME_PACKAGE_REQUIRED");
    const runtimePackage = packaged.runtime;
    const archiveInformation = await assertPackageArtifact(
      runtimePackage.archive,
      packageRoot,
      maximumRuntimeArchiveBytes,
    );
    const manifestInformation = await assertPackageArtifact(
      runtimePackage.manifest,
      packageRoot,
      0,
    );
    if (manifestInformation.size > maximumRuntimeManifestBytes)
      throw new Error("RUNTIME_MANIFEST_TOO_LARGE");
    if (
      archiveInformation.size < 1 ||
      manifestInformation.size < 2 ||
      basename(runtimePackage.manifest) !== "runtime-bootstrap.json"
    )
      throw new Error("RUNTIME_PACKAGE_PATH_INVALID");
    const sidecar = await readRuntimeManifest(runtimePackage.manifest);
    if (
      !digestPattern.test(runtimePackage.manifest_sha256 ?? "") ||
      runtimePackage.manifest_sha256 !== sidecar.sha256
    )
      throw new Error("RUNTIME_MANIFEST_DIGEST_MISMATCH");
    const embeddedPath = join(app, "Contents/Resources/runtime-bootstrap.json");
    if ((await realpath(embeddedPath)) !== embeddedPath)
      throw new Error("RUNTIME_EMBEDDED_MANIFEST_MISMATCH");
    const embedded = await readRuntimeManifest(embeddedPath);
    if (
      embedded.sha256 !== sidecar.sha256 ||
      !embedded.bytes.equals(sidecar.bytes)
    )
      throw new Error("RUNTIME_EMBEDDED_MANIFEST_MISMATCH");
    try {
      await lstat(join(app, "Contents/Resources/runtime"));
      throw new Error("THIN_APP_CONTAINS_RUNTIME");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const validated = validateRuntimeManifestShape(
      sidecar.manifest,
      runtimePackage,
      configuration.teamIdentifier,
    );
    if (basename(runtimePackage.archive) !== validated.archiveFilename)
      throw new Error("RUNTIME_ARCHIVE_FILENAME_MISMATCH");
    if (
      archiveInformation.size !== validated.runtime.archive_bytes ||
      (await hashFile(runtimePackage.archive)) !==
        validated.runtime.archive_sha256
    )
      throw new Error("RUNTIME_ARCHIVE_DIGEST_MISMATCH");
    const listing = await run(
      "/usr/bin/unzip",
      ["-Z1", runtimePackage.archive],
      "RUNTIME_ARCHIVE_LISTING_FAILED",
      10 * 60_000,
      maximumRuntimeManifestBytes,
    );
    assertRuntimeArchiveListing(listing.stdout, validated.runtime.files);
    extraction = await mkdtemp(join(temporaryParent, ".runtime-validation-"));
    await chmod(extraction, 0o700);
    await run(
      "/usr/bin/ditto",
      [
        "-x",
        "-k",
        "--noextattr",
        "--noqtn",
        "--noacl",
        runtimePackage.archive,
        extraction,
      ],
      "RUNTIME_ARCHIVE_EXTRACTION_FAILED",
      20 * 60_000,
      1024 * 1024,
    );
    const verifiedNativeBinaries = await validateExtractedRuntime(
      extraction,
      validated.runtime.files,
      signing,
      configuration,
      exec,
    );
    if (verifiedNativeBinaries !== validated.nativeBinaries)
      throw new Error("RUNTIME_SIGNATURE_COUNT_MISMATCH");
    return {
      archive: runtimePackage.archive,
      archiveFilename: validated.archiveFilename,
      archiveBytes: archiveInformation.size,
      archiveSha256: validated.runtime.archive_sha256,
      manifest: runtimePackage.manifest,
      manifestBytes: sidecar.bytes,
      manifestSha256: sidecar.sha256,
      id: validated.runtime.id,
      url: validated.runtime.url,
      installedBytes: validated.runtime.installed_bytes,
      files: validated.runtime.files.length,
      nativeBinaries: verifiedNativeBinaries,
      signing: validated.runtime.signing,
    };
  } catch (error) {
    if (/^[A-Z][A-Z0-9_]{1,120}$/.test(error?.message ?? "")) throw error;
    throw new Error("RUNTIME_RELEASE_VALIDATION_FAILED");
  } finally {
    if (extraction) await removeRuntimeValidationExtraction(extraction);
  }
}

async function durableRuntimeCopy(runtime, directory) {
  const archive = join(directory, runtime.archiveFilename);
  const manifest = join(directory, "runtime-bootstrap.json");
  try {
    await copyFile(runtime.archive, archive, constants.COPYFILE_EXCL);
    await copyFile(runtime.manifest, manifest, constants.COPYFILE_EXCL);
    await chmod(archive, 0o600);
    await chmod(manifest, 0o600);
    for (const path of [archive, manifest]) {
      const handle = await open(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const copiedManifest = await readRuntimeManifest(manifest);
    const archiveInformation = await ownedPath(archive, {
      maximum: maximumRuntimeArchiveBytes,
      singleLink: true,
    });
    if (
      archiveInformation.size !== runtime.archiveBytes ||
      (await hashFile(archive)) !== runtime.archiveSha256 ||
      copiedManifest.sha256 !== runtime.manifestSha256 ||
      !copiedManifest.bytes.equals(runtime.manifestBytes)
    )
      throw new Error("RUNTIME_RELEASE_COPY_MISMATCH");
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return { archive, manifest };
  } catch (error) {
    if (/^[A-Z][A-Z0-9_]{1,120}$/.test(error?.message ?? "")) throw error;
    throw new Error("RUNTIME_RELEASE_COPY_FAILED");
  }
}

/** Never persist notarytool's paths, accounts, URLs or raw issue text. */
export function sanitizeNotaryLog(log, expected) {
  if (
    !log ||
    typeof log !== "object" ||
    typeof log.jobId !== "string" ||
    log.jobId.toLowerCase() !== expected.id.toLowerCase() ||
    log.archiveFilename !== expected.filename ||
    typeof log.sha256 !== "string" ||
    !digestPattern.test(log.sha256) ||
    log.sha256 !== expected.sha256 ||
    !["Accepted", "Invalid", "Rejected"].includes(log.status) ||
    (log.issues != null && !Array.isArray(log.issues))
  )
    throw new Error("NOTARIZATION_LOG_MISMATCH");
  const issues = (log.issues ?? []).slice(0, 128).map((issue) => {
    const message = typeof issue?.message === "string" ? issue.message : "";
    let reason = "OTHER_NOTARIZATION_ISSUE";
    for (const [pattern, code] of [
      [/secure timestamp/i, "SECURE_TIMESTAMP_REQUIRED"],
      [/hardened runtime/i, "HARDENED_RUNTIME_REQUIRED"],
      [/get-task-allow/i, "DEBUG_ENTITLEMENT_FORBIDDEN"],
      [/signature.*invalid|not signed/i, "INVALID_CODE_SIGNATURE"],
      [/certificate|developer id/i, "DEVELOPER_ID_CERTIFICATE_ISSUE"],
      [/entitlement/i, "INVALID_ENTITLEMENTS"],
      [/SDK/i, "UNSUPPORTED_SDK"],
      [/malware|malicious/i, "SECURITY_SCAN_REJECTION"],
    ])
      if (pattern.test(message)) {
        reason = code;
        break;
      }
    // Only known public bundle-relative paths are useful; outside paths stay hidden.
    let path = null;
    if (typeof issue?.path === "string") {
      const marker = "MusicMute Local.app/Contents/";
      const index = issue.path.indexOf(marker);
      const candidate = index < 0 ? "" : issue.path.slice(index);
      if (
        candidate.length <= 400 &&
        /^[A-Za-z0-9_ .+/@()-]+$/.test(candidate) &&
        !candidate.split("/").some((part) => part === "..")
      )
        path = candidate;
    }
    return {
      severity: ["error", "warning", "info"].includes(issue?.severity)
        ? issue.severity
        : "unknown",
      code:
        typeof issue?.code === "number" && Number.isSafeInteger(issue.code)
          ? issue.code
          : null,
      reason,
      bundle_path: path,
      architecture: ["arm64", "x86_64"].includes(issue?.architecture)
        ? issue.architecture
        : null,
    };
  });
  return {
    submission_id: expected.id.toLowerCase(),
    status: log.status,
    archive_sha256: expected.sha256,
    issue_count: log.issues?.length ?? 0,
    issues_truncated: (log.issues?.length ?? 0) > issues.length,
    issues,
  };
}

function derivedReleaseState(receipt) {
  const dmg = receipt.notarization.dmg.state;
  const runtime = receipt.notarization.runtime.state;
  if (dmg === "READY" && runtime === "ACCEPTED") return "READY";
  if (dmg === "STAPLED" && runtime === "ACCEPTED") return "STAPLED";
  if (dmg === "REJECTED" || runtime === "REJECTED") return "REJECTED";
  if (dmg === "INVALID" || runtime === "INVALID") return "INVALID";
  if (dmg === "SUBMITTING" || runtime === "SUBMITTING") return "SUBMITTING";
  if (dmg === "IN_PROGRESS" || runtime === "IN_PROGRESS") return "IN_PROGRESS";
  if (dmg === "ACCEPTED" && runtime === "ACCEPTED") return "ACCEPTED";
  if (
    ["SUBMITTED", "ACCEPTED", "STAPLED", "READY"].includes(dmg) ||
    ["SUBMITTED", "ACCEPTED"].includes(runtime)
  )
    return "SUBMITTED";
  return "PREPARED";
}

function refreshReceiptState(receipt) {
  receipt.submission_id = receipt.notarization.dmg.submission_id;
  receipt.runtime_submission_id = receipt.notarization.runtime.submission_id;
  receipt.state = derivedReleaseState(receipt);
  receipt.public_ready =
    receipt.state === "READY" &&
    receipt.release_gates.clean_user_launch_tested === true &&
    receipt.release_gates.relocated_runtime_tested === true &&
    receipt.last_failure == null;
  return receipt;
}

function safeTimestamp(value, { optional = true } = {}) {
  return (
    (optional && value == null) ||
    (typeof value === "string" &&
      value.length >= 20 &&
      value.length <= 40 &&
      Number.isFinite(Date.parse(value)))
  );
}

function validReceiptRuntimeURL(value, filename) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (!url.port || url.port === "443") &&
      decodeURIComponent(basename(url.pathname)) === filename
    );
  } catch {
    return false;
  }
}

function safeNotarizationArtifact(artifact, { runtime = false } = {}) {
  if (
    !record(artifact) ||
    typeof artifact.filename !== "string" ||
    basename(artifact.filename) !== artifact.filename ||
    artifact.filename.length > 240 ||
    !digestPattern.test(artifact.submitted_sha256 ?? "") ||
    !positiveSafeInteger(
      artifact.bytes,
      runtime ? maximumRuntimeArchiveBytes : Number.MAX_SAFE_INTEGER,
    ) ||
    !notarizationStates.has(artifact.state) ||
    (runtime && ["STAPLED", "READY"].includes(artifact.state)) ||
    (artifact.submission_id != null &&
      !uuidPattern.test(artifact.submission_id)) ||
    ([
      "SUBMITTED",
      "IN_PROGRESS",
      "ACCEPTED",
      "INVALID",
      "REJECTED",
      "STAPLED",
      "READY",
    ].includes(artifact.state) &&
      !uuidPattern.test(artifact.submission_id ?? "")) ||
    (["PREPARED", "SUBMITTING"].includes(artifact.state) &&
      artifact.submission_id != null) ||
    !safeTimestamp(artifact.submission_attempted_at) ||
    !safeTimestamp(artifact.last_checked_at)
  )
    throw new Error("INVALID_RELEASE_RECORD");
  return artifact;
}

function safeReceipt(value, directory) {
  const receipt = record(value);
  const runtime = record(receipt?.runtime);
  const notarization = record(receipt?.notarization);
  const gates = record(receipt?.release_gates);
  const dmgNotarization = safeNotarizationArtifact(record(notarization?.dmg));
  const runtimeNotarization = safeNotarizationArtifact(
    record(notarization?.runtime),
    { runtime: true },
  );
  if (
    receipt?.schema_version !== 2 ||
    !uuidPattern.test(receipt.release_id ?? "") ||
    !uuidPattern.test(receipt.package_build_id ?? "") ||
    basename(directory) !== `release-${receipt.release_id}.noindex` ||
    !identityPattern.test(receipt.signing_identity_sha1 ?? "") ||
    !teamPattern.test(receipt.team_identifier ?? "") ||
    !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(receipt.version ?? "") ||
    !/^[1-9]\d{0,17}$/.test(receipt.build ?? "") ||
    receipt.filename !==
      `MusicMute-${receipt.version}-arm64-${receipt.release_id}.dmg` ||
    dmgNotarization.filename !== receipt.filename ||
    receipt.submitted_sha256 !== dmgNotarization.submitted_sha256 ||
    receipt.submission_id !== dmgNotarization.submission_id ||
    receipt.runtime_submission_id !== runtimeNotarization.submission_id ||
    !record(runtime) ||
    !runtimeIdPattern.test(runtime.id ?? "") ||
    runtime.filename !== runtimeNotarization.filename ||
    runtime.filename !==
      `MusicMuteLocal-runtime-${runtime.id}-${runtime.archive_sha256?.slice?.(0, 16)}.zip` ||
    runtime.manifest_filename !== "runtime-bootstrap.json" ||
    runtime.archive_sha256 !== runtimeNotarization.submitted_sha256 ||
    runtime.archive_bytes !== runtimeNotarization.bytes ||
    !digestPattern.test(runtime.manifest_sha256 ?? "") ||
    !positiveSafeInteger(runtime.manifest_bytes, maximumRuntimeManifestBytes) ||
    !positiveSafeInteger(
      runtime.installed_bytes,
      maximumRuntimeInstalledBytes,
    ) ||
    !positiveSafeInteger(runtime.files, maximumRuntimeFiles) ||
    !positiveSafeInteger(runtime.native_binaries, maximumRuntimeFiles) ||
    !exactKeys(runtime.signing, ["mode", "team_id"]) ||
    runtime.signing.mode !== "developer_id" ||
    runtime.signing.team_id !== receipt.team_identifier ||
    !validReceiptRuntimeURL(runtime.url, runtime.filename) ||
    !record(gates) ||
    typeof gates.clean_user_launch_tested !== "boolean" ||
    typeof gates.relocated_runtime_tested !== "boolean" ||
    !safeTimestamp(receipt.created_at, { optional: false }) ||
    !safeTimestamp(receipt.submission_authorized_at) ||
    (receipt.state !== "PREPARED" && !receipt.submission_authorized_at) ||
    (receipt.last_failure != null &&
      !/^[A-Z][A-Z0-9_]{1,120}$/.test(receipt.last_failure)) ||
    receipt.state !== derivedReleaseState(receipt) ||
    receipt.public_ready !==
      (receipt.state === "READY" &&
        gates.clean_user_launch_tested &&
        gates.relocated_runtime_tested &&
        receipt.last_failure == null) ||
    (receipt.stapled_sha256 != null &&
      !digestPattern.test(receipt.stapled_sha256)) ||
    (["STAPLED", "READY"].includes(dmgNotarization.state) &&
      !digestPattern.test(receipt.stapled_sha256 ?? ""))
  )
    throw new Error("INVALID_RELEASE_RECORD");
  return receipt;
}

export async function releaseMacos(args, dependencies = {}) {
  const options = parseReleaseOptions(args);
  if (
    (dependencies.platform ?? process.platform) !== "darwin" ||
    (dependencies.arch ?? process.arch) !== "arm64"
  )
    throw new Error("UNSUPPORTED_PLATFORM");
  const root = resolve(dependencies.root ?? projectRoot);
  const exec = dependencies.exec ?? command;
  const signing = dependencies.signing ?? (await import("./macos-signing.mjs"));
  async function run(
    file,
    commandArgs,
    code,
    timeout = 60_000,
    maximum = 64 * 1024,
  ) {
    try {
      return await exec(file, commandArgs, {
        timeout,
        maxBuffer: maximum,
        env: safeEnvironment,
        windowsHide: true,
      });
    } catch {
      // Tool errors contain raw stdout/stderr. Never retain or print them.
      throw new Error(code);
    }
  }
  async function mountedImages(directory) {
    const maximum = 512 * 1024;
    const response = await run(
      "/usr/bin/hdiutil",
      ["info", "-plist"],
      "DMG_MOUNT_INSPECTION_FAILED",
      30_000,
      maximum,
    );
    if (Buffer.byteLength(response.stdout ?? "") > maximum)
      throw new Error("DMG_MOUNT_INSPECTION_TOO_LARGE");
    // hdiutil's metadata can contain other users' private paths. This short-lived
    // private conversion file is never included in receipts, exports or output.
    const temporary = join(
      directory,
      `.mount-inspection-${randomUUID()}.plist`,
    );
    await writeFile(temporary, response.stdout, { flag: "wx", mode: 0o600 });
    let converted;
    try {
      converted = await run(
        "/usr/bin/plutil",
        ["-convert", "json", "-o", "-", temporary],
        "DMG_MOUNT_INSPECTION_INVALID",
        30_000,
        maximum,
      );
    } finally {
      await ownedPath(temporary, { maximum });
      await rm(temporary);
    }
    let state;
    try {
      state = JSON.parse(converted.stdout);
    } catch {
      throw new Error("DMG_MOUNT_INSPECTION_INVALID");
    }
    if (!Array.isArray(state?.images) || state.images.length > 128)
      throw new Error("DMG_MOUNT_INSPECTION_INVALID");
    const mounted = [];
    for (const image of state.images) {
      if (
        typeof image?.["image-path"] !== "string" ||
        !Array.isArray(image["system-entities"]) ||
        image["system-entities"].length > 128
      )
        throw new Error("DMG_MOUNT_INSPECTION_INVALID");
      for (const entity of image["system-entities"])
        if (typeof entity?.["mount-point"] === "string")
          mounted.push({
            image: image["image-path"],
            mount: entity["mount-point"],
            device: entity["dev-entry"],
          });
    }
    return mounted;
  }
  async function clearOwnedMount(
    directory,
    ticketedImage,
    receipt,
    configuration,
  ) {
    const mount = join(directory, "mount.noindex");
    let info;
    try {
      info = await lstat(mount);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("UNSAFE_RELEASE_MOUNT_PATH");
    const matches = (await mountedImages(directory)).filter(
      (entry) => entry.mount === mount,
    );
    if (matches.length > 1) throw new Error("DMG_MOUNT_IDENTITY_AMBIGUOUS");
    if (matches.length === 1) {
      const match = matches[0];
      if (
        match.image !== ticketedImage ||
        typeof match.device !== "string" ||
        !/^\/dev\/disk\d+(?:s\d+)*$/.test(match.device)
      )
        throw new Error("DMG_MOUNT_IMAGE_MISMATCH");
      await ownedPath(ticketedImage);
      if (
        !digestPattern.test(receipt.stapled_sha256 ?? "") ||
        (await hashFile(ticketedImage)) !== receipt.stapled_sha256
      )
        throw new Error("DMG_MOUNT_IMAGE_UNVERIFIED");
      await signing.verifyDeveloperIdSignature(ticketedImage, configuration, {
        kind: "dmg",
        exec: (file, commandArgs, settings) =>
          exec(file, commandArgs, { ...settings, env: safeEnvironment }),
      });
      // Fence a registry change immediately before acting. Target the observed
      // device, so a replacement mounted at the same path is never blindly detached.
      const current = (await mountedImages(directory)).filter(
        (entry) => entry.mount === mount,
      );
      if (
        current.length !== 1 ||
        current[0].image !== match.image ||
        current[0].device !== match.device
      )
        throw new Error("DMG_MOUNT_IDENTITY_CHANGED");
      await run(
        "/usr/bin/hdiutil",
        ["detach", match.device],
        "DMG_DETACH_FAILED",
        120_000,
      );
      if (
        (await mountedImages(directory)).some((entry) => entry.mount === mount)
      )
        throw new Error("DMG_DETACH_INCOMPLETE");
    }
    // No registry entry remains. Only an empty owned staging directory may go.
    await ownedPath(mount, { directory: true });
    if ((await readdir(mount)).length !== 0)
      throw new Error("DMG_MOUNT_DIRECTORY_NOT_EMPTY");
    await rmdir(mount);
  }
  const releaseParent = join(root, "output/macos-release");
  await mkdir(releaseParent, { recursive: true, mode: 0o700 });
  await ownedPath(releaseParent, { directory: true });
  if ((await realpath(releaseParent)) !== releaseParent)
    throw new Error("INVALID_RELEASE_ROOT");
  let directory;
  let receipt;
  let configuration;
  let preparedRuntime;
  if (!options.releaseRoot) {
    const resultPath = resolve(options.packageResult);
    const packageParent = dirname(resultPath);
    const buildId = /^build-([a-f0-9-]{36})\.noindex$/.exec(
      basename(packageParent),
    )?.[1];
    if (
      basename(resultPath) !== "package-result.json" ||
      !uuidPattern.test(buildId ?? "") ||
      dirname(packageParent) !== join(root, "output/macos") ||
      (await realpath(packageParent)) !== packageParent
    )
      throw new Error("EXPLICIT_RELEASE_PACKAGE_REQUIRED");
    await ownedPath(packageParent, { directory: true });
    const packaged = await readJson(resultPath);
    if (
      packaged.schema_version !== 1 ||
      packaged.build_id !== buildId ||
      packaged.signing !== "DEVELOPER_ID_DISTRIBUTION" ||
      packaged.release_mode !== true ||
      packaged.architecture !== "arm64" ||
      packaged.secure_timestamp !== true ||
      packaged.hardened_runtime !== true ||
      packaged.notarized !== false ||
      packaged.public_ready !== false ||
      packaged.signing_identity_sha1 !== options.identity ||
      !teamPattern.test(packaged.team_identifier ?? "") ||
      packaged.build_root !== packageParent ||
      packaged.app !== join(packageParent, "MusicMute Local.app")
    )
      throw new Error("NOT_A_DISTRIBUTION_PACKAGE");
    await ownedPath(packaged.app, { directory: true });
    configuration = await signing.resolveSigningConfiguration({
      release: true,
      identity: options.identity,
      exec: (file, commandArgs, settings) =>
        exec(file, commandArgs, { ...settings, env: safeEnvironment }),
    });
    if (configuration.teamIdentifier !== packaged.team_identifier)
      throw new Error("SIGNING_TEAM_MISMATCH");
    await signing.verifyDeveloperIdSignature(packaged.app, configuration, {
      kind: "app",
      exec: (file, commandArgs, settings) =>
        exec(file, commandArgs, { ...settings, env: safeEnvironment }),
    });
    preparedRuntime = await validateRuntimeReleaseArtifacts({
      packaged,
      packageRoot: packageParent,
      app: packaged.app,
      temporaryParent: releaseParent,
      run,
      signing,
      configuration,
      exec,
    });
    const bundle = await run(
      "/usr/bin/plutil",
      [
        "-extract",
        "CFBundleIdentifier",
        "raw",
        "-o",
        "-",
        join(packaged.app, "Contents/Info.plist"),
      ],
      "APP_BUNDLE_INSPECTION_FAILED",
    );
    if (bundle.stdout.trim() !== "com.hatem.musicmute.local")
      throw new Error("FOREIGN_RELEASE_APP");
    const manifest = await readJson(join(root, "package.json"));
    const version = packaged.version ?? manifest.version;
    if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version ?? ""))
      throw new Error("INVALID_RELEASE_VERSION");
    const versionInfo = await run(
      "/usr/bin/plutil",
      [
        "-extract",
        "CFBundleShortVersionString",
        "raw",
        "-o",
        "-",
        join(packaged.app, "Contents/Info.plist"),
      ],
      "APP_VERSION_INSPECTION_FAILED",
    );
    const buildInfo = await run(
      "/usr/bin/plutil",
      [
        "-extract",
        "CFBundleVersion",
        "raw",
        "-o",
        "-",
        join(packaged.app, "Contents/Info.plist"),
      ],
      "APP_BUILD_INSPECTION_FAILED",
    );
    const build = buildInfo.stdout.trim();
    if (
      versionInfo.stdout.trim() !== version ||
      !/^[1-9]\d{0,17}$/.test(build) ||
      (packaged.build != null && packaged.build !== build)
    )
      throw new Error("RELEASE_PACKAGE_VERSION_MISMATCH");
    const releaseId = randomUUID();
    directory = join(releaseParent, `release-${releaseId}.noindex`);
    await mkdir(directory, { mode: 0o700 });
    // Preserve the exact external runtime inputs durably before a receipt can
    // authorize or resume either Apple submission.
    await durableRuntimeCopy(preparedRuntime, directory);
    const imageSource = join(directory, "image-source.noindex");
    await mkdir(imageSource, { mode: 0o700 });
    const copiedApp = join(imageSource, "MusicMute Local.app");
    await run(
      "/usr/bin/ditto",
      [packaged.app, copiedApp],
      "APP_COPY_FAILED",
      300_000,
    );
    await signing.verifyDeveloperIdSignature(copiedApp, configuration, {
      kind: "app",
      exec: (file, commandArgs, settings) =>
        exec(file, commandArgs, { ...settings, env: safeEnvironment }),
    });
    await symlink("/Applications", join(imageSource, "Applications"));
    await writeFile(
      join(imageSource, "Install MusicMute.txt"),
      "MusicMute for Apple Silicon Macs\n\n" +
        "Requires macOS 14 or later and an Apple Silicon Mac.\n\n" +
        "1. Drag MusicMute Local.app onto Applications in this window.\n" +
        "2. Open MusicMute Local from Applications, then eject this disk image.\n" +
        "3. Choose Prepare my Mac. The app downloads and verifies the signed processing runtime\n" +
        `   (${displayDecimalBytes(preparedRuntime.archiveBytes)} download; ${displayDecimalBytes(preparedRuntime.installedBytes)} installed)\n` +
        "   plus the separate 66.8 MB voice model. Keep an internet connection for setup.\n" +
        "   Runtime tools and model weights are not included in this installer.\n" +
        "4. For YouTube controls, load the separate Chrome extension in Developer mode:\n" +
        "   open chrome://extensions, choose Load unpacked, and select\n" +
        "   ~/Library/Application Support/MusicMuteLocal/extension.\n" +
        "   Setup's Reveal folder and Copy path buttons show this folder.\n\n" +
        "The Chrome Web Store release is separate and is not included in this installer.\n" +
        "You do not need Homebrew, Node.js, Python, or a worker service.\n" +
        "Local audio processing stays on your Mac. Account saving requires sign-in.\n" +
        "Apple may show its normal first-open confirmation for an internet download.\n",
      { flag: "wx", mode: 0o644 },
    );
    const filename = `MusicMute-${version}-arm64-${releaseId}.dmg`;
    const image = join(directory, filename);
    // The enclosing private stage is 0700; the future mounted volume must be readable by a fresh user.
    await chmod(imageSource, 0o755);
    await run(
      "/usr/bin/hdiutil",
      [
        "create",
        "-volname",
        "MusicMute",
        "-srcfolder",
        imageSource,
        "-format",
        "UDZO",
        "-imagekey",
        "zlib-level=6",
        image,
      ],
      "DMG_CREATION_FAILED",
      600_000,
      128 * 1024,
    );
    await chmod(image, 0o600);
    await run(
      "/usr/bin/codesign",
      [...signing.signingArguments(configuration, { kind: "dmg" }), image],
      "DMG_SIGNING_FAILED",
      120_000,
    );
    await signing.verifyDeveloperIdSignature(image, configuration, {
      kind: "dmg",
      exec: (file, commandArgs, settings) =>
        exec(file, commandArgs, { ...settings, env: safeEnvironment }),
    });
    await run(
      "/usr/bin/hdiutil",
      ["verify", image],
      "DMG_INTEGRITY_FAILED",
      120_000,
    );
    const submittedSha256 = await hashFile(image);
    const imageBytes = (await ownedPath(image, { singleLink: true })).size;
    receipt = refreshReceiptState({
      schema_version: 2,
      release_id: releaseId,
      package_build_id: buildId,
      version,
      build,
      filename,
      signing_identity_sha1: options.identity,
      team_identifier: packaged.team_identifier,
      submitted_sha256: submittedSha256,
      submission_id: null,
      runtime_submission_id: null,
      runtime: {
        id: preparedRuntime.id,
        filename: preparedRuntime.archiveFilename,
        manifest_filename: "runtime-bootstrap.json",
        archive_sha256: preparedRuntime.archiveSha256,
        archive_bytes: preparedRuntime.archiveBytes,
        manifest_sha256: preparedRuntime.manifestSha256,
        manifest_bytes: preparedRuntime.manifestBytes.length,
        installed_bytes: preparedRuntime.installedBytes,
        files: preparedRuntime.files,
        native_binaries: preparedRuntime.nativeBinaries,
        url: preparedRuntime.url,
        signing: preparedRuntime.signing,
      },
      notarization: {
        dmg: {
          filename,
          submitted_sha256: submittedSha256,
          bytes: imageBytes,
          state: "PREPARED",
          submission_id: null,
        },
        runtime: {
          filename: preparedRuntime.archiveFilename,
          submitted_sha256: preparedRuntime.archiveSha256,
          bytes: preparedRuntime.archiveBytes,
          state: "PREPARED",
          submission_id: null,
        },
      },
      release_gates: {
        // Package metadata is not evidence of a quarantined clean-user run.
        // A release stays non-public until a dedicated evidence workflow records
        // these post-notarization gates against the exact durable artifacts.
        clean_user_launch_tested: false,
        relocated_runtime_tested: false,
      },
      public_ready: false,
      created_at: new Date().toISOString(),
    });
    await writeJson(join(directory, "notarization-receipt.json"), receipt);
    // Only the uniquely created disposable image source is removed. The original package stays intact.
    await rm(imageSource, { recursive: true });
  } else {
    directory = resolve(options.releaseRoot);
    if (
      dirname(directory) !== releaseParent ||
      (await realpath(directory)) !== directory
    )
      throw new Error("INVALID_RELEASE_ROOT");
    await ownedPath(directory, { directory: true });
    receipt = safeReceipt(
      await readJson(join(directory, "notarization-receipt.json")),
      directory,
    );
    configuration = await signing.resolveSigningConfiguration({
      release: true,
      identity: receipt.signing_identity_sha1,
      exec: (file, commandArgs, settings) =>
        exec(file, commandArgs, { ...settings, env: safeEnvironment }),
    });
    if (configuration.teamIdentifier !== receipt.team_identifier)
      throw new Error("SIGNING_TEAM_MISMATCH");
  }
  const receiptPath = join(directory, "notarization-receipt.json");
  const image = join(directory, receipt.filename);
  const runtimeArchive = join(directory, receipt.runtime.filename);
  const runtimeManifest = join(directory, receipt.runtime.manifest_filename);
  const unlock = await releaseLock(directory);
  let validatedReceipt = false;
  try {
    // Re-read under the exclusive lock: a concurrent run may have uploaded since inspection.
    receipt = safeReceipt(await readJson(receiptPath), directory);
    validatedReceipt = true;
    if (
      receipt.signing_identity_sha1 !== configuration.identity ||
      receipt.team_identifier !== configuration.teamIdentifier
    )
      throw new Error("SIGNING_TEAM_MISMATCH");
    const imageInformation = await ownedPath(image, { singleLink: true });
    const currentDigest = await hashFile(image);
    if (
      currentDigest !== receipt.submitted_sha256 ||
      imageInformation.size !== receipt.notarization.dmg.bytes
    )
      throw new Error("RELEASE_IMAGE_CHANGED");
    const runtimeArchiveInformation = await ownedPath(runtimeArchive, {
      maximum: maximumRuntimeArchiveBytes,
      singleLink: true,
    });
    const durableManifest = await readRuntimeManifest(runtimeManifest);
    if (
      runtimeArchiveInformation.size !== receipt.runtime.archive_bytes ||
      (await hashFile(runtimeArchive)) !== receipt.runtime.archive_sha256 ||
      durableManifest.bytes.length !== receipt.runtime.manifest_bytes ||
      durableManifest.sha256 !== receipt.runtime.manifest_sha256
    )
      throw new Error("RELEASE_RUNTIME_CHANGED");
    await signing.verifyDeveloperIdSignature(image, configuration, {
      kind: "dmg",
      exec: (file, commandArgs, settings) =>
        exec(file, commandArgs, { ...settings, env: safeEnvironment }),
    });
    if (options.prepareOnly)
      return {
        release_root: directory,
        dmg: image,
        runtime_zip: runtimeArchive,
        runtime_manifest: runtimeManifest,
        runtime_id: receipt.runtime.id,
        state: "PREPARED",
        notarized: false,
        runtime_notarized: false,
        public_ready: false,
      };
    const targets = [
      {
        key: "dmg",
        path: image,
        journal: receipt.notarization.dmg,
        log: "notarization-log.json",
        unknown:
          "NOTARIZATION_SUBMISSION_OUTCOME_UNKNOWN_USE_HISTORY_AND_RESUME",
        rejected: "NOTARIZATION_REJECTED_INSPECT_SANITIZED_LOG",
      },
      {
        key: "runtime",
        path: runtimeArchive,
        journal: receipt.notarization.runtime,
        log: "runtime-notarization-log.json",
        unknown:
          "RUNTIME_NOTARIZATION_SUBMISSION_OUTCOME_UNKNOWN_USE_HISTORY_AND_RESUME",
        rejected: "RUNTIME_NOTARIZATION_REJECTED_INSPECT_SANITIZED_LOG",
      },
    ];
    const persistReceipt = async () => {
      refreshReceiptState(receipt);
      await writeJson(receiptPath, receipt);
    };
    const statusState = {
      Accepted: "ACCEPTED",
      "In Progress": "IN_PROGRESS",
      Invalid: "INVALID",
      Rejected: "REJECTED",
    };
    const readNotaryInfo = async (target, id) => {
      const infoResponse = await run(
        "/usr/bin/xcrun",
        [
          "notarytool",
          "info",
          id,
          "--keychain-profile",
          options.keychainProfile,
          "--output-format",
          "json",
        ],
        "NOTARIZATION_STATUS_UNAVAILABLE_RESUME_SAME_SUBMISSION",
        60_000,
      );
      let info;
      try {
        info = JSON.parse(infoResponse.stdout);
      } catch {
        throw new Error("INVALID_NOTARIZATION_STATUS");
      }
      if (
        typeof info?.id !== "string" ||
        info.id.toLowerCase() !== id ||
        info.name !== target.journal.filename ||
        !Object.hasOwn(statusState, info.status)
      )
        throw new Error("NOTARIZATION_STATUS_MISMATCH");
      return info;
    };
    const cachedInfo = new Map();
    const startsSubmission = options.submit || !options.releaseRoot;
    if (startsSubmission) {
      if (
        targets.some(
          (target) =>
            target.journal.state !== "PREPARED" ||
            target.journal.submission_id != null,
        )
      )
        throw new Error("SUBMISSION_ALREADY_ATTEMPTED_USE_RESUME");
      receipt.submission_authorized_at = new Date().toISOString();
      await persistReceipt();
    } else {
      if (!receipt.submission_authorized_at)
        throw new Error("NOTARIZATION_RESUME_MISMATCH");
      const resumeId = options.resume.toLowerCase();
      const ambiguous = targets.filter(
        (target) =>
          target.journal.state === "SUBMITTING" &&
          target.journal.submission_id == null,
      );
      if (ambiguous.length > 1)
        throw new Error("NOTARIZATION_RESUME_TARGET_AMBIGUOUS");
      if (ambiguous.length === 1) {
        // Bind an ambiguous upload only after Apple's name and ID match that
        // exact artifact. The other artifact remains independently fenced.
        const target = ambiguous[0];
        const info = await readNotaryInfo(target, resumeId);
        target.journal.submission_id = resumeId;
        target.journal.state = statusState[info.status];
        target.journal.last_checked_at = new Date().toISOString();
        cachedInfo.set(target.key, info);
        await persistReceipt();
      } else if (
        !targets.some((target) => target.journal.submission_id === resumeId)
      ) {
        throw new Error("NOTARIZATION_RESUME_MISMATCH");
      }
    }
    if (
      !targets.some((target) =>
        ["INVALID", "REJECTED"].includes(target.journal.state),
      )
    )
      for (const target of targets) {
        if (target.journal.state !== "PREPARED") continue;
        // Persist the per-artifact fence before invoking upload. A lost response
        // can bind only through resume and can never resubmit these bytes.
        target.journal.state = "SUBMITTING";
        target.journal.submission_attempted_at = new Date().toISOString();
        await persistReceipt();
        const uploaded = await run(
          "/usr/bin/xcrun",
          [
            "notarytool",
            "submit",
            target.path,
            "--keychain-profile",
            options.keychainProfile,
            "--output-format",
            "json",
          ],
          target.unknown,
          900_000,
        );
        let submission;
        try {
          submission = JSON.parse(uploaded.stdout);
        } catch {
          throw new Error(target.unknown);
        }
        const submissionId = submission?.id?.toLowerCase?.();
        if (
          !uuidPattern.test(submissionId ?? "") ||
          targets.some(
            (other) =>
              other !== target && other.journal.submission_id === submissionId,
          )
        )
          throw new Error(target.unknown);
        target.journal.submission_id = submissionId;
        target.journal.state = "SUBMITTED";
        await persistReceipt();
      }
    let inProgress = false;
    for (const target of targets) {
      if (
        target.journal.state === "ACCEPTED" ||
        (target.key === "dmg" &&
          ["STAPLED", "READY"].includes(target.journal.state))
      )
        continue;
      if (!uuidPattern.test(target.journal.submission_id ?? ""))
        throw new Error("NOTARIZATION_RESUME_MISMATCH");
      const info =
        cachedInfo.get(target.key) ??
        (await readNotaryInfo(target, target.journal.submission_id));
      target.journal.state = statusState[info.status];
      target.journal.last_checked_at = new Date().toISOString();
      await persistReceipt();
      if (info.status === "In Progress") {
        inProgress = true;
        continue;
      }
      const logResponse = await run(
        "/usr/bin/xcrun",
        [
          "notarytool",
          "log",
          target.journal.submission_id,
          "--keychain-profile",
          options.keychainProfile,
        ],
        "NOTARIZATION_LOG_UNAVAILABLE_RESUME_SAME_SUBMISSION",
        60_000,
        1024 * 1024,
      );
      let log;
      try {
        log = JSON.parse(logResponse.stdout);
      } catch {
        throw new Error("INVALID_NOTARIZATION_LOG");
      }
      const safeLog = sanitizeNotaryLog(log, {
        id: target.journal.submission_id,
        filename: target.journal.filename,
        sha256: target.journal.submitted_sha256,
      });
      await writeJson(join(directory, target.log), safeLog);
      if (log.status !== info.status)
        throw new Error("NOTARIZATION_LOG_MISMATCH");
      if (info.status !== "Accepted") throw new Error(target.rejected);
    }
    if (inProgress) {
      await persistReceipt();
      return {
        release_root: directory,
        submission_id: receipt.submission_id,
        runtime_submission_id: receipt.runtime_submission_id,
        state: receipt.state,
        notarized: false,
        runtime_notarized: receipt.notarization.runtime.state === "ACCEPTED",
        public_ready: false,
      };
    }
    if (
      !["ACCEPTED", "STAPLED", "READY"].includes(
        receipt.notarization.dmg.state,
      ) ||
      receipt.notarization.runtime.state !== "ACCEPTED"
    )
      throw new Error("NOTARIZATION_ACCEPTANCE_INCOMPLETE");
    const ticketedImage = join(directory, `stapled-${receipt.filename}`);
    await clearOwnedMount(directory, ticketedImage, receipt, configuration);
    if (receipt.notarization.dmg.state === "ACCEPTED") {
      try {
        await ownedPath(ticketedImage, { singleLink: true });
        if ((await hashFile(ticketedImage)) !== receipt.stapled_sha256) {
          // This is a disposable, owned working copy. Preserve the immutable uploaded image.
          await rm(ticketedImage);
          await copyFile(image, ticketedImage, constants.COPYFILE_EXCL);
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await copyFile(image, ticketedImage, constants.COPYFILE_EXCL);
      }
      await run(
        "/usr/bin/xcrun",
        ["stapler", "staple", ticketedImage],
        "DMG_STAPLING_FAILED_RESUME_SAME_SUBMISSION",
        120_000,
      );
      // Stapling changes DMG bytes; bind them durably before later validation can fail.
      receipt.stapled_sha256 = await hashFile(ticketedImage);
      receipt.notarization.dmg.state = "STAPLED";
      await persistReceipt();
    } else {
      await ownedPath(ticketedImage, { singleLink: true });
      if ((await hashFile(ticketedImage)) !== receipt.stapled_sha256)
        throw new Error("RELEASE_IMAGE_CHANGED");
    }
    await run(
      "/usr/bin/xcrun",
      ["stapler", "validate", ticketedImage],
      "DMG_STAPLE_VALIDATION_FAILED",
      120_000,
    );
    await signing.verifyDeveloperIdSignature(ticketedImage, configuration, {
      kind: "dmg",
      exec: (file, commandArgs, settings) =>
        exec(file, commandArgs, { ...settings, env: safeEnvironment }),
    });
    await run(
      "/usr/bin/hdiutil",
      ["verify", ticketedImage],
      "DMG_INTEGRITY_FAILED",
      120_000,
    );
    const dmgAssessment = await run(
      "/usr/sbin/spctl",
      [
        "--assess",
        "--type",
        "open",
        "--context",
        "context:primary-signature",
        "--verbose=4",
        ticketedImage,
      ],
      "DMG_GATEKEEPER_REJECTED",
      120_000,
    );
    if (
      !/source=Notarized Developer ID/.test(
        `${dmgAssessment.stdout}\n${dmgAssessment.stderr}`,
      )
    )
      throw new Error("DMG_NOTARIZATION_ASSESSMENT_MISSING");
    const mount = join(directory, "mount.noindex");
    await mkdir(mount, { mode: 0o700 });
    try {
      await run(
        "/usr/bin/hdiutil",
        [
          "attach",
          "-readonly",
          "-nobrowse",
          "-noautoopen",
          "-mountpoint",
          mount,
          ticketedImage,
        ],
        "DMG_MOUNT_FAILED",
        120_000,
      );
      const contained = join(mount, "MusicMute Local.app");
      await signing.verifyDeveloperIdSignature(contained, configuration, {
        kind: "app",
        exec: (file, commandArgs, settings) =>
          exec(file, commandArgs, { ...settings, env: safeEnvironment }),
      });
      const appAssessment = await run(
        "/usr/sbin/spctl",
        ["--assess", "--type", "exec", "--verbose=4", contained],
        "APP_GATEKEEPER_REJECTED",
        120_000,
      );
      if (
        !/source=Notarized Developer ID/.test(
          `${appAssessment.stdout}\n${appAssessment.stderr}`,
        )
      )
        throw new Error("APP_NOTARIZATION_ASSESSMENT_MISSING");
    } finally {
      // A timeout can occur after attach succeeded. Inspect exact image/device
      // identity rather than trusting the command's exit status or deleting paths.
      await clearOwnedMount(directory, ticketedImage, receipt, configuration);
    }
    if ((await hashFile(ticketedImage)) !== receipt.stapled_sha256)
      throw new Error("RELEASE_IMAGE_CHANGED");
    const publicDirectory = join(directory, "accepted.noindex");
    await mkdir(publicDirectory, { mode: 0o700, recursive: true });
    await ownedPath(publicDirectory, { directory: true });
    const finalImage = join(
      publicDirectory,
      `MusicMute-${receipt.version}-arm64.dmg`,
    );
    try {
      await copyFile(ticketedImage, finalImage, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await ownedPath(finalImage);
    }
    await chmod(finalImage, 0o644);
    if ((await hashFile(finalImage)) !== receipt.stapled_sha256)
      throw new Error("FINAL_RELEASE_IMAGE_CHANGED");
    receipt.notarization.dmg.state = "READY";
    delete receipt.last_failure;
    refreshReceiptState(receipt);
    const result = {
      schema_version: 2,
      release_root: directory,
      version: receipt.version,
      build: receipt.build,
      dmg: finalImage,
      submission_id: receipt.submission_id,
      runtime_zip: runtimeArchive,
      runtime_manifest: runtimeManifest,
      runtime_id: receipt.runtime.id,
      runtime_url: receipt.runtime.url,
      runtime_submission_id: receipt.runtime_submission_id,
      state: "READY",
      notarized: true,
      dmg_notarized: true,
      runtime_notarized: true,
      stapled: true,
      runtime_stapled: false,
      dmg_code_signature_verified: true,
      dmg_gatekeeper_accepted: true,
      contained_app_gatekeeper_accepted: true,
      runtime_archive_verified: true,
      runtime_manifest_verified: true,
      runtime_inventory_verified: true,
      runtime_code_signatures_verified: true,
      clean_user_launch_tested: receipt.release_gates.clean_user_launch_tested,
      relocated_runtime_tested: receipt.release_gates.relocated_runtime_tested,
      pending_release_gates: [
        ...(receipt.release_gates.clean_user_launch_tested
          ? []
          : ["CLEAN_USER_LAUNCH"]),
        ...(receipt.release_gates.relocated_runtime_tested
          ? []
          : ["RELOCATED_RUNTIME"]),
      ],
      public_ready: receipt.public_ready,
      sha256: receipt.stapled_sha256,
      bytes: (await lstat(finalImage)).size,
      runtime_sha256: receipt.runtime.archive_sha256,
      runtime_bytes: receipt.runtime.archive_bytes,
      runtime_manifest_sha256: receipt.runtime.manifest_sha256,
    };
    await writeJson(receiptPath, receipt);
    await writeJson(join(directory, "release-result.json"), result);
    return result;
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{1,120}$/.test(error?.message ?? "")
      ? error.message
      : "MACOS_RELEASE_FAILED";
    const safeError = new Error(code);
    safeError.release_root = directory;
    safeError.submission_id = receipt.submission_id;
    safeError.runtime_submission_id = receipt.runtime_submission_id;
    receipt.last_failure = code;
    refreshReceiptState(receipt);
    if (validatedReceipt)
      try {
        await writeJson(receiptPath, receipt);
      } catch {
        // The existing durable submission fence remains authoritative if the disk write fails.
      }
    throw safeError;
  } finally {
    await unlock();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    const result = await releaseMacos(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (result.state === "IN_PROGRESS") process.exitCode = 2;
  } catch (error) {
    // Only fixed codes generated here or in the signing helper may reach the console.
    const code = /^[A-Z][A-Z0-9_]{1,120}$/.test(error?.message ?? "")
      ? error.message
      : "MACOS_RELEASE_FAILED";
    console.error(
      JSON.stringify({
        error: code,
        public_ready: false,
        ...(typeof error?.release_root === "string"
          ? { release_root: error.release_root }
          : {}),
        ...(uuidPattern.test(error?.submission_id ?? "")
          ? { submission_id: error.submission_id }
          : {}),
        ...(uuidPattern.test(error?.runtime_submission_id ?? "")
          ? { runtime_submission_id: error.runtime_submission_id }
          : {}),
      }),
    );
    process.exitCode = 1;
  }
}

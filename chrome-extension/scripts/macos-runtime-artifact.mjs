import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MACH_O_MAGICS = new Set([
  "cffaedfe",
  "cefaedfe",
  "feedfacf",
  "feedface",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
]);
const MAX_FILES = 50_000;
const MAX_ARCHIVE_BYTES = 2_000_000_000;
const MAX_INSTALLED_BYTES = 4_000_000_000;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_RESULT_BYTES = 2 * 1024 * 1024;
const RUNTIME_SOURCE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const MACOS_APP_VERSION = /^\d+\.\d+\.\d+(?:\.\d+)?$/;
const BUILD_ROOT =
  /^build-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.noindex$/;
export const MACOS_RUNTIME_API_VERSION = 1;
export const MACOS_APPROVED_MODEL_BYTES = 66_759_214;
const REQUIRED_PATHS = [
  "runtime/runtime/node/bin/node",
  "runtime/runtime/python/bin/python3",
  "runtime/runtime/bin/ffmpeg",
  "runtime/runtime/bin/ffprobe",
  "runtime/tools/youtube/bin/deno",
];

export function macosSteadyStateBytes({ appBytes, runtimeInstalledBytes }) {
  if (
    !Number.isSafeInteger(appBytes) ||
    appBytes < 1 ||
    !Number.isSafeInteger(runtimeInstalledBytes) ||
    runtimeInstalledBytes < 1
  )
    throw new Error("MACOS_STEADY_STATE_BYTES_INVALID");
  const total = appBytes + runtimeInstalledBytes + MACOS_APPROVED_MODEL_BYTES;
  if (!Number.isSafeInteger(total))
    throw new Error("MACOS_STEADY_STATE_BYTES_INVALID");
  return {
    scope: "BASE_PROCESSING_ONE_APP_ONE_RUNTIME_ONE_MODEL",
    app: appBytes,
    runtime: runtimeInstalledBytes,
    model: MACOS_APPROVED_MODEL_BYTES,
    total,
    runtime_releases: 1,
  };
}

export function macosSetupMetadata(model) {
  if (
    !model ||
    typeof model !== "object" ||
    typeof model.filename !== "string" ||
    basename(model.filename) !== model.filename ||
    !safeRelativePath(model.filename) ||
    !SHA256.test(model.sha256 ?? "") ||
    model.bytes !== MACOS_APPROVED_MODEL_BYTES
  )
    throw new Error("MACOS_SETUP_MODEL_INVALID");
  return {
    schema_version: 1,
    model: {
      filename: model.filename,
      bytes: model.bytes,
      sha256: model.sha256,
    },
  };
}

export function runtimeDownloadConfiguration({ baseURL, redirectHosts = "" }) {
  if (typeof baseURL !== "string" || !baseURL) {
    throw new Error("RUNTIME_DOWNLOAD_BASE_URL_REQUIRED");
  }
  let url;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error("RUNTIME_DOWNLOAD_BASE_URL_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    throw new Error("RUNTIME_DOWNLOAD_BASE_URL_INVALID");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  const hosts = [
    url.hostname.toLowerCase(),
    ...String(redirectHosts)
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  ];
  if (
    hosts.length > 8 ||
    new Set(hosts).size !== hosts.length ||
    hosts.some((host) => !SAFE_HOST.test(host))
  )
    throw new Error("RUNTIME_DOWNLOAD_HOSTS_INVALID");
  return { baseURL: url, downloadHosts: hosts };
}

export function runtimeSigningManifest(signing) {
  if (
    signing?.release === true &&
    signing.signing === "DEVELOPER_ID_DISTRIBUTION" &&
    /^[A-Z0-9]{10}$/.test(signing.teamIdentifier ?? "")
  )
    return { mode: "developer_id", team_id: signing.teamIdentifier };
  if (
    signing?.release === false &&
    signing.identity === "-" &&
    signing.signing === "AD_HOC_LOCAL"
  )
    return { mode: "ad_hoc" };
  throw new Error("RUNTIME_SIGNING_MODE_UNSUPPORTED");
}

function safeRelativePath(path) {
  if (
    typeof path !== "string" ||
    !path ||
    Buffer.byteLength(path, "utf8") > 4096 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    [...path].some((character) => {
      const value = character.codePointAt(0);
      return value === undefined || value < 32 || value === 127;
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

function safeLinkTarget(root, path, target) {
  if (
    typeof target !== "string" ||
    !target ||
    Buffer.byteLength(target, "utf8") > 4096 ||
    isAbsolute(target) ||
    target.includes("\\") ||
    [...target].some((character) => {
      const value = character.codePointAt(0);
      return value === undefined || value < 32 || value === 127;
    })
  )
    return false;
  const destination = resolve(dirname(join(root, path)), target);
  const payload = join(root, "runtime");
  return destination.startsWith(`${payload}/`);
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
    Buffer.byteLength(target, "utf8") > 4096
  )
    return null;
  const components = dirname(path).split("/");
  const targetComponents = target.split("/");
  let descended = false;
  for (let index = 0; index < targetComponents.length; index++) {
    const component = targetComponents[index];
    if (!component || component === ".") return null;
    if (component === "..") {
      // POSIX resolves a component, including a symlink, before applying a
      // later `..`. Refuse targets whose lexical and physical meanings can
      // therefore differ instead of guessing during manifest-only reuse.
      if (descended || components.length <= 1) return null;
      components.pop();
      continue;
    }
    if (
      Buffer.byteLength(component, "utf8") > 255 ||
      [...component].some((character) => {
        const value = character.codePointAt(0);
        return value === undefined || value < 32 || value === 127;
      })
    )
      return null;
    descended = true;
    components.push(component);
    // Files and symlinks are manifest leaves, never safe intermediate
    // directories. This also rejects composed directory-alias traversal.
    if (
      index < targetComponents.length - 1 &&
      entries.has(components.join("/"))
    )
      return null;
  }
  const destination = components.join("/");
  return safeRelativePath(destination) && destination.startsWith("runtime/")
    ? destination
    : null;
}

function validateRuntimeSymlinkGraph(files, code) {
  const entries = new Map(files.map((entry) => [entry.path, entry]));
  const directories = expectedRuntimeDirectories(files);
  const terminals = new Map();
  for (const entry of files) {
    if (entry.type !== "symlink") continue;
    const origin = entry.path;
    let current = entry;
    const visited = new Set();
    while (current.type === "symlink") {
      if (visited.has(current.path)) throw new Error(code);
      visited.add(current.path);
      const destination = runtimeLinkDestination(
        current.path,
        current.link_target,
        entries,
      );
      if (!destination) throw new Error(code);
      const next = entries.get(destination);
      if (next) {
        if (next.type === "symlink") {
          current = next;
          continue;
        }
        if (next.type !== "file") throw new Error(code);
        terminals.set(origin, destination);
        break;
      }
      // A directory is trusted only when the leaf inventory proves that it is
      // part of this payload. Pointing back at an ancestor would create a
      // traversal cycle even though realpath(3) can resolve the link itself.
      if (!directories.has(destination) || origin.startsWith(`${destination}/`))
        throw new Error(code);
      terminals.set(origin, destination);
      break;
    }
  }
  return { directories, terminals };
}

async function sha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function contained(root, path) {
  const child = relative(root, path);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function ownedDirectory(path, code) {
  let information;
  try {
    information = await lstat(path);
  } catch {
    throw new Error(code);
  }
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    !information.isDirectory() ||
    information.isSymbolicLink() ||
    information.uid !== process.getuid?.() ||
    information.mode & 0o022
  )
    throw new Error(code);
  try {
    if ((await realpath(path)) !== path) throw new Error(code);
  } catch {
    throw new Error(code);
  }
  return information;
}

async function ownedRegularFile(path, root, maximumBytes, code) {
  let information;
  if (!isAbsolute(path) || resolve(path) !== path || !contained(root, path))
    throw new Error(code);
  try {
    information = await lstat(path);
    if ((await realpath(path)) !== path) throw new Error(code);
  } catch {
    throw new Error(code);
  }
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.nlink !== 1 ||
    information.uid !== process.getuid?.() ||
    information.mode & 0o022 ||
    information.size < 1 ||
    information.size > maximumBytes
  )
    throw new Error(code);
  return information;
}

async function readOwnedJson(path, root, maximumBytes, code) {
  const before = await ownedRegularFile(path, root, maximumBytes, code);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    throw new Error(code);
  }
  let after;
  try {
    after = await lstat(path);
  } catch {
    throw new Error(code);
  }
  if (bytes.length !== before.size || !sameFileIdentity(before, after))
    throw new Error(code);
  try {
    return {
      bytes,
      document: JSON.parse(bytes.toString("utf8")),
      information: after,
    };
  } catch {
    throw new Error(code);
  }
}

async function assertStableOwnedFile(path, expected, code) {
  let current;
  try {
    current = await lstat(path);
    if ((await realpath(path)) !== path) throw new Error(code);
  } catch {
    throw new Error(code);
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.nlink !== 1 ||
    current.uid !== process.getuid?.() ||
    current.mode & 0o022 ||
    !sameFileIdentity(expected, current)
  )
    throw new Error(code);
}

function signingMatches(actual, expected) {
  if (!actual || Array.isArray(actual) || typeof actual !== "object")
    return false;
  const keys = Object.keys(actual).sort();
  if (expected.mode === "ad_hoc")
    return keys.length === 1 && keys[0] === "mode" && actual.mode === "ad_hoc";
  return (
    keys.length === 2 &&
    keys[0] === "mode" &&
    keys[1] === "team_id" &&
    actual.mode === "developer_id" &&
    actual.team_id === expected.team_id
  );
}

function runtimeManifestForReuse(
  document,
  { sourceVersion, signing, downloadConfiguration },
) {
  const runtime = document?.runtime;
  if (
    document?.schema_version !== 1 ||
    !runtime ||
    Array.isArray(runtime) ||
    typeof runtime !== "object" ||
    !SAFE_IDENTIFIER.test(runtime.id ?? "") ||
    runtime.api_version !== MACOS_RUNTIME_API_VERSION ||
    runtime.source_version !== sourceVersion ||
    runtime.platform !== "darwin" ||
    runtime.arch !== "arm64" ||
    runtime.archive_format !== "zip" ||
    !SHA256.test(runtime.archive_sha256 ?? "") ||
    !Number.isSafeInteger(runtime.archive_bytes) ||
    runtime.archive_bytes < 1 ||
    runtime.archive_bytes > MAX_ARCHIVE_BYTES ||
    !Number.isSafeInteger(runtime.installed_bytes) ||
    runtime.installed_bytes < 1 ||
    runtime.installed_bytes > MAX_INSTALLED_BYTES ||
    !Array.isArray(runtime.files) ||
    runtime.files.length < 5 ||
    runtime.files.length > MAX_FILES ||
    !signingMatches(runtime.signing, signing)
  )
    throw new Error("RUNTIME_REUSE_MANIFEST_MISMATCH");
  let url;
  try {
    url = new URL(runtime.url);
  } catch {
    throw new Error("RUNTIME_REUSE_MANIFEST_MISMATCH");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== "443") ||
    !Array.isArray(runtime.download_hosts)
  )
    throw new Error("RUNTIME_REUSE_MANIFEST_MISMATCH");
  const sealedDownload = runtimeDownloadConfiguration({
    baseURL: new URL(".", url).href,
    redirectHosts: runtime.download_hosts.slice(1).join(","),
  });
  if (
    sealedDownload.downloadHosts.length !== runtime.download_hosts.length ||
    sealedDownload.downloadHosts.some(
      (host, index) => host !== runtime.download_hosts[index],
    ) ||
    (downloadConfiguration?.baseURL &&
      downloadConfiguration.baseURL.href !== sealedDownload.baseURL.href)
  )
    throw new Error("RUNTIME_REUSE_DOWNLOAD_MISMATCH");
  if (downloadConfiguration?.redirectHosts != null) {
    const expectedDownload = runtimeDownloadConfiguration({
      baseURL: sealedDownload.baseURL.href,
      redirectHosts: downloadConfiguration.redirectHosts,
    });
    if (
      expectedDownload.downloadHosts.length !==
        sealedDownload.downloadHosts.length ||
      expectedDownload.downloadHosts.some(
        (host, index) => host !== sealedDownload.downloadHosts[index],
      )
    )
      throw new Error("RUNTIME_REUSE_DOWNLOAD_MISMATCH");
  } else if (downloadConfiguration?.downloadHosts) {
    if (
      downloadConfiguration.downloadHosts.length !==
        sealedDownload.downloadHosts.length ||
      downloadConfiguration.downloadHosts.some(
        (host, index) => host !== sealedDownload.downloadHosts[index],
      )
    )
      throw new Error("RUNTIME_REUSE_DOWNLOAD_MISMATCH");
  }
  const archiveFilename = `MusicMuteLocal-runtime-${runtime.id}-${runtime.archive_sha256.slice(0, 16)}.zip`;
  let urlFilename;
  try {
    urlFilename = decodeURIComponent(basename(url.pathname));
  } catch {
    throw new Error("RUNTIME_REUSE_MANIFEST_MISMATCH");
  }
  if (urlFilename !== archiveFilename)
    throw new Error("RUNTIME_REUSE_MANIFEST_MISMATCH");
  return { runtime, archiveFilename };
}

function validateRuntimeManifestInventory(files) {
  const entries = new Map();
  let previousPath = "";
  let installedBytes = 0;
  let nativeBinaries = 0;
  for (const entry of files) {
    if (
      !entry ||
      Array.isArray(entry) ||
      typeof entry !== "object" ||
      !safeRelativePath(entry.path) ||
      !entry.path.startsWith("runtime/") ||
      entries.has(entry.path) ||
      (previousPath && previousPath.localeCompare(entry.path) >= 0)
    )
      throw new Error("RUNTIME_REUSE_MANIFEST_INVENTORY_INVALID");
    previousPath = entry.path;
    const keys = Object.keys(entry).sort();
    if (entry.type === "file") {
      if (
        JSON.stringify(keys) !==
          JSON.stringify([
            "bytes",
            "code_signed",
            "executable",
            "path",
            "sha256",
            "type",
          ]) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        entry.bytes > 1_000_000_000 ||
        !SHA256.test(entry.sha256 ?? "") ||
        typeof entry.executable !== "boolean" ||
        typeof entry.code_signed !== "boolean"
      )
        throw new Error("RUNTIME_REUSE_MANIFEST_INVENTORY_INVALID");
      installedBytes += entry.bytes;
      if (
        !Number.isSafeInteger(installedBytes) ||
        installedBytes > MAX_INSTALLED_BYTES
      )
        throw new Error("RUNTIME_REUSE_MANIFEST_INVENTORY_INVALID");
      if (entry.code_signed) nativeBinaries++;
    } else if (
      entry.type !== "symlink" ||
      JSON.stringify(keys) !==
        JSON.stringify(["link_target", "path", "type"]) ||
      !safeLinkTarget(
        "/runtime-manifest-validation",
        entry.path,
        entry.link_target,
      )
    )
      throw new Error("RUNTIME_REUSE_MANIFEST_INVENTORY_INVALID");
    entries.set(entry.path, entry);
  }
  validateRuntimeSymlinkGraph(
    files,
    "RUNTIME_REUSE_MANIFEST_INVENTORY_INVALID",
  );
  const paths = new Set(entries.keys());
  if (REQUIRED_PATHS.some((path) => !paths.has(path)) || nativeBinaries < 1)
    throw new Error("RUNTIME_REUSE_MANIFEST_INVENTORY_INVALID");
  return { installedBytes, nativeBinaries };
}

async function isMachO(path) {
  const stream = createReadStream(path, { start: 0, end: 3 });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return MACH_O_MAGICS.has(Buffer.concat(chunks).toString("hex"));
}

export async function collectRuntimeInventory(releaseRoot) {
  const root = resolve(releaseRoot);
  const rootInfo = await lstat(root);
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    basename(root) === "runtime" ||
    rootInfo.uid !== process.getuid?.() ||
    rootInfo.mode & 0o022
  )
    throw new Error("RUNTIME_RELEASE_ROOT_UNSAFE");
  const payload = join(root, "runtime");
  const payloadInfo = await lstat(payload);
  if (
    !payloadInfo.isDirectory() ||
    payloadInfo.isSymbolicLink() ||
    payloadInfo.uid !== process.getuid?.() ||
    payloadInfo.mode & 0o022
  )
    throw new Error("RUNTIME_PAYLOAD_UNSAFE");
  let canonicalPayload;
  try {
    if ((await realpath(root)) !== root) throw new Error();
    canonicalPayload = await realpath(payload);
    if (canonicalPayload !== payload) throw new Error();
  } catch {
    throw new Error("RUNTIME_PAYLOAD_UNSAFE");
  }
  const files = [];
  const enumeratedDirectories = new Set(["runtime"]);
  let installedBytes = 0;
  async function walk(directory) {
    const children = await readdir(directory);
    children.sort((left, right) => left.localeCompare(right));
    for (const name of children) {
      const absolute = join(directory, name);
      const path = relative(root, absolute);
      if (!safeRelativePath(path) || !path.startsWith("runtime/"))
        throw new Error("RUNTIME_PATH_UNSAFE");
      const information = await lstat(absolute);
      if (information.isDirectory()) {
        if (
          information.isSymbolicLink() ||
          information.uid !== process.getuid?.() ||
          information.mode & 0o022
        )
          throw new Error("RUNTIME_DIRECTORY_UNSAFE");
        enumeratedDirectories.add(path);
        await walk(absolute);
        continue;
      }
      if (information.isSymbolicLink()) {
        const target = await readlink(absolute);
        if (
          information.uid !== process.getuid?.() ||
          !safeLinkTarget(root, path, target)
        )
          throw new Error("RUNTIME_LINK_UNSAFE");
        files.push({ path, type: "symlink", link_target: target });
        if (files.length > MAX_FILES)
          throw new Error("RUNTIME_FILE_COUNT_INVALID");
        continue;
      }
      if (
        !information.isFile() ||
        information.uid !== process.getuid?.() ||
        information.mode & 0o022
      )
        throw new Error("RUNTIME_FILE_UNSAFE");
      const codeSigned = await isMachO(absolute);
      const normalized = information;
      if (normalized.size > 1_000_000_000)
        throw new Error("RUNTIME_FILE_TOO_LARGE");
      installedBytes += normalized.size;
      if (
        !Number.isSafeInteger(installedBytes) ||
        installedBytes > MAX_INSTALLED_BYTES
      )
        throw new Error("RUNTIME_INSTALLED_BYTES_INVALID");
      files.push({
        path,
        type: "file",
        bytes: normalized.size,
        sha256: await sha256(absolute),
        executable: Boolean(normalized.mode & 0o111),
        code_signed: codeSigned,
      });
      if (files.length > MAX_FILES)
        throw new Error("RUNTIME_FILE_COUNT_INVALID");
    }
  }
  await walk(payload);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const { directories, terminals } = validateRuntimeSymlinkGraph(
    files,
    "RUNTIME_LINK_UNSAFE",
  );
  const entries = new Map(files.map((entry) => [entry.path, entry]));
  for (const [path, expectedDestination] of terminals) {
    let destination;
    let information;
    try {
      destination = await realpath(join(root, path));
      if (!contained(canonicalPayload, destination)) throw new Error();
      information = await lstat(destination);
    } catch {
      throw new Error("RUNTIME_LINK_UNSAFE");
    }
    const actualDestination = relative(root, destination);
    if (actualDestination !== expectedDestination)
      throw new Error("RUNTIME_LINK_UNSAFE");
    const destinationEntry = entries.get(actualDestination);
    if (destinationEntry?.type === "file") {
      if (
        !information.isFile() ||
        information.isSymbolicLink() ||
        information.uid !== process.getuid?.() ||
        information.nlink !== 1 ||
        information.mode & 0o022
      )
        throw new Error("RUNTIME_LINK_UNSAFE");
    } else if (
      !directories.has(actualDestination) ||
      !enumeratedDirectories.has(actualDestination) ||
      path.startsWith(`${actualDestination}/`) ||
      !information.isDirectory() ||
      information.isSymbolicLink() ||
      information.uid !== process.getuid?.() ||
      information.mode & 0o022
    ) {
      throw new Error("RUNTIME_LINK_UNSAFE");
    }
  }
  const paths = new Set(files.map((entry) => entry.path));
  if (
    files.length < 5 ||
    REQUIRED_PATHS.some((path) => !paths.has(path)) ||
    !files.some((entry) => entry.code_signed === true)
  )
    throw new Error("RUNTIME_SHAPE_INVALID");
  return { files, installedBytes };
}

export async function verifyRuntimeCodeSignature(
  path,
  signing,
  { exec = run } = {},
) {
  try {
    const verification = ["--verify", "--strict", "--all-architectures"];
    if (signing.mode === "developer_id") {
      if (!/^[A-Z0-9]{10}$/.test(signing.team_id ?? ""))
        throw new Error("RUNTIME_SIGNATURE_INVALID");
      verification.push(
        "--test-requirement",
        `=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${signing.team_id}"`,
      );
    }
    verification.push(path);
    await exec("/usr/bin/codesign", verification, {
      timeout: 60_000,
      maxBuffer: 128 * 1024,
    });
    const result = await exec(
      "/usr/bin/codesign",
      ["-d", "--verbose=4", path],
      { timeout: 30_000, maxBuffer: 128 * 1024 },
    );
    const details = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (signing.mode === "developer_id") {
      if (
        !details.includes(`TeamIdentifier=${signing.team_id}`) ||
        !details.includes("Authority=Developer ID Application:") ||
        !/flags=.*\bruntime\b/.test(details)
      )
        throw new Error("RUNTIME_SIGNATURE_INVALID");
    } else if (
      signing.mode !== "ad_hoc" ||
      !details.includes("Signature=adhoc") ||
      !/flags=.*\bruntime\b/.test(details) ||
      (details.includes("TeamIdentifier=") &&
        !details.includes("TeamIdentifier=not set"))
    )
      throw new Error("RUNTIME_SIGNATURE_INVALID");
  } catch {
    throw new Error("RUNTIME_SIGNATURE_INVALID");
  }
}

function runtimeIdentifier(files) {
  const digest = createHash("sha256")
    .update(JSON.stringify(files))
    .digest("hex");
  const identifier = `macos-arm64-v1-${digest.slice(0, 24)}`;
  if (!SAFE_IDENTIFIER.test(identifier))
    throw new Error("RUNTIME_IDENTIFIER_INVALID");
  return identifier;
}

export function assertRuntimeArchiveListing(listing, files) {
  if (
    typeof listing !== "string" ||
    Buffer.byteLength(listing, "utf8") > MAX_MANIFEST_BYTES
  )
    throw new Error("RUNTIME_ARCHIVE_LISTING_INVALID");
  const expectedLeaves = new Set(files.map((entry) => entry.path));
  const expectedDirectories = expectedRuntimeDirectories(files);
  const seen = new Set();
  for (const raw of listing.split(/\r?\n/).filter(Boolean)) {
    const directory = raw.endsWith("/");
    const path = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    if (
      !safeRelativePath(path) ||
      seen.has(path) ||
      (directory ? !expectedDirectories.has(path) : !expectedLeaves.has(path))
    )
      throw new Error("RUNTIME_ARCHIVE_LISTING_INVALID");
    seen.add(path);
  }
  if ([...expectedLeaves].some((path) => !seen.has(path)))
    throw new Error("RUNTIME_ARCHIVE_LISTING_INVALID");
}

export async function createMacRuntimeArtifact({
  releaseRoot,
  outputDirectory,
  downloadBaseURL,
  redirectHosts,
  sourceVersion,
  signing,
  exec = run,
  signatureVerifier = (path, manifest) =>
    verifyRuntimeCodeSignature(path, manifest, { exec }),
}) {
  if (
    typeof sourceVersion !== "string" ||
    !RUNTIME_SOURCE_VERSION.test(sourceVersion)
  )
    throw new Error("RUNTIME_SOURCE_VERSION_INVALID");
  const configuration = runtimeDownloadConfiguration({
    baseURL: downloadBaseURL,
    redirectHosts,
  });
  const signingManifest = runtimeSigningManifest(signing);
  const releasePath = resolve(releaseRoot);
  if (
    typeof outputDirectory !== "string" ||
    !isAbsolute(outputDirectory) ||
    resolve(outputDirectory) !== outputDirectory ||
    outputDirectory === releasePath ||
    contained(releasePath, outputDirectory)
  )
    throw new Error("RUNTIME_OUTPUT_UNSAFE");
  const { files, installedBytes } = await collectRuntimeInventory(releaseRoot);
  if (typeof signatureVerifier !== "function")
    throw new Error("RUNTIME_SIGNATURE_VERIFIER_REQUIRED");
  for (const entry of files) {
    if (entry.type !== "file" || entry.code_signed !== true) continue;
    try {
      await signatureVerifier(join(releaseRoot, entry.path), signingManifest);
    } catch {
      throw new Error("RUNTIME_SIGNATURE_INVALID");
    }
  }
  const id = runtimeIdentifier(files);
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  const temporary = join(outputDirectory, `.${id}.${randomUUID()}.tmp.zip`);
  const extraction = join(outputDirectory, `.${id}.${randomUUID()}.extract`);
  let completedArchive;
  try {
    // Store links as links and omit all directory records. Extraction then
    // reconstructs only directories proved by manifest leaves, so unrelated
    // empty source directories cannot become unauthenticated archive entries.
    await exec(
      "/usr/bin/zip",
      ["-q", "-D", "-y", "-X", "-r", temporary, "runtime"],
      {
        cwd: releaseRoot,
        timeout: 20 * 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const archive = await lstat(temporary);
    if (
      !archive.isFile() ||
      archive.isSymbolicLink() ||
      archive.size < 1 ||
      archive.size > MAX_ARCHIVE_BYTES
    )
      throw new Error("RUNTIME_ARCHIVE_INVALID");
    const archiveSha256 = await sha256(temporary);
    if (!SHA256.test(archiveSha256)) throw new Error("RUNTIME_ARCHIVE_INVALID");
    const { stdout } = await exec("/usr/bin/unzip", ["-Z1", temporary], {
      timeout: 10 * 60_000,
      maxBuffer: MAX_MANIFEST_BYTES,
    });
    assertRuntimeArchiveListing(stdout, files);
    await mkdir(extraction, { mode: 0o700 });
    await exec(
      "/usr/bin/ditto",
      ["-x", "-k", "--noextattr", "--noqtn", "--noacl", temporary, extraction],
      { timeout: 20 * 60_000, maxBuffer: 1024 * 1024 },
    );
    const extracted = await collectRuntimeInventory(extraction);
    if (
      extracted.installedBytes !== installedBytes ||
      JSON.stringify(extracted.files) !== JSON.stringify(files)
    )
      throw new Error("RUNTIME_ARCHIVE_INVALID");
    const filename = `MusicMuteLocal-runtime-${id}-${archiveSha256.slice(0, 16)}.zip`;
    const archivePath = join(outputDirectory, filename);
    await rename(temporary, archivePath);
    completedArchive = archivePath;
    await chmod(archivePath, 0o600);
    const url = new URL(encodeURIComponent(filename), configuration.baseURL);
    const manifest = {
      schema_version: 1,
      runtime: {
        id,
        api_version: MACOS_RUNTIME_API_VERSION,
        source_version: sourceVersion,
        platform: "darwin",
        arch: "arm64",
        url: url.href,
        archive_format: "zip",
        archive_sha256: archiveSha256,
        archive_bytes: archive.size,
        installed_bytes: installedBytes,
        download_hosts: configuration.downloadHosts,
        signing: signingManifest,
        files,
      },
    };
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    if (Buffer.byteLength(manifestBytes, "utf8") > MAX_MANIFEST_BYTES)
      throw new Error("RUNTIME_MANIFEST_TOO_LARGE");
    const manifestPath = join(outputDirectory, "runtime-bootstrap.json");
    await writeFile(manifestPath, manifestBytes, {
      mode: 0o600,
      flag: "wx",
    });
    return {
      id,
      api_version: MACOS_RUNTIME_API_VERSION,
      source_version: sourceVersion,
      archive: archivePath,
      archive_bytes: archive.size,
      archive_sha256: archiveSha256,
      installed_bytes: installedBytes,
      manifest: manifestPath,
      manifest_sha256: await sha256(manifestPath),
      url: url.href,
      files: files.length,
      native_binaries: files.filter((entry) => entry.code_signed === true)
        .length,
      reused: false,
      signing: signingManifest,
    };
  } catch (error) {
    await rm(temporary, { force: true });
    if (completedArchive) await rm(completedArchive, { force: true });
    throw error;
  } finally {
    await rm(extraction, { recursive: true, force: true });
  }
}

/**
 * Copy one exact runtime artifact from a prior package result into a new build.
 * The source result is an explicit opt-in trust root, but every referenced path,
 * byte count, digest, inventory entry and code signature is still revalidated.
 */
export async function reuseMacRuntimeArtifact({
  packageResultPath,
  outputDirectory,
  sourceVersion,
  signing,
  downloadConfiguration,
  exec = run,
  signatureVerifier = (path, manifest) =>
    verifyRuntimeCodeSignature(path, manifest, { exec }),
}) {
  if (
    typeof sourceVersion !== "string" ||
    !RUNTIME_SOURCE_VERSION.test(sourceVersion)
  )
    throw new Error("RUNTIME_SOURCE_VERSION_INVALID");
  if (
    typeof packageResultPath !== "string" ||
    !isAbsolute(packageResultPath) ||
    resolve(packageResultPath) !== packageResultPath ||
    basename(packageResultPath) !== "package-result.json"
  )
    throw new Error("RUNTIME_REUSE_PACKAGE_RESULT_UNSAFE");
  const packageRoot = dirname(packageResultPath);
  await ownedDirectory(packageRoot, "RUNTIME_REUSE_PACKAGE_RESULT_UNSAFE");
  if (!BUILD_ROOT.test(basename(packageRoot)))
    throw new Error("RUNTIME_REUSE_PACKAGE_RESULT_UNSAFE");
  const packageRead = await readOwnedJson(
    packageResultPath,
    packageRoot,
    MAX_PACKAGE_RESULT_BYTES,
    "RUNTIME_REUSE_PACKAGE_RESULT_UNSAFE",
  );
  const packaged = packageRead.document;
  const expectedSigning = runtimeSigningManifest(signing);
  const runtimePackage = packaged?.runtime;
  if (
    packaged?.schema_version !== 1 ||
    typeof packaged.build_id !== "string" ||
    !BUILD_ROOT.test(`build-${packaged.build_id}.noindex`) ||
    basename(packageRoot) !== `build-${packaged.build_id}.noindex` ||
    packaged.build_root !== packageRoot ||
    packaged.app !== join(packageRoot, "MusicMute Local.app") ||
    packaged.architecture !== "arm64" ||
    typeof packaged.version !== "string" ||
    !MACOS_APP_VERSION.test(packaged.version) ||
    typeof packaged.build !== "string" ||
    !/^[1-9][0-9]{0,17}$/.test(packaged.build) ||
    packaged.release_mode !== (expectedSigning.mode === "developer_id") ||
    packaged.signing !== signing.signing ||
    !runtimePackage ||
    Array.isArray(runtimePackage) ||
    typeof runtimePackage !== "object" ||
    runtimePackage.delivery !== "EXTERNAL_PREPARE" ||
    runtimePackage.api_version !== MACOS_RUNTIME_API_VERSION ||
    runtimePackage.source_version !== sourceVersion ||
    typeof runtimePackage.reused !== "boolean" ||
    !SHA256.test(runtimePackage.archive_sha256 ?? "") ||
    !SHA256.test(runtimePackage.manifest_sha256 ?? "") ||
    !Number.isSafeInteger(runtimePackage.archive_bytes) ||
    runtimePackage.archive_bytes < 1 ||
    runtimePackage.archive_bytes > MAX_ARCHIVE_BYTES ||
    !Number.isSafeInteger(runtimePackage.installed_bytes) ||
    runtimePackage.installed_bytes < 1 ||
    runtimePackage.installed_bytes > MAX_INSTALLED_BYTES ||
    !Number.isSafeInteger(runtimePackage.files) ||
    runtimePackage.files < 5 ||
    runtimePackage.files > MAX_FILES ||
    !Number.isSafeInteger(runtimePackage.native_binaries) ||
    runtimePackage.native_binaries < 1 ||
    runtimePackage.native_binaries > runtimePackage.files ||
    !signingMatches(runtimePackage.signing, expectedSigning)
  )
    throw new Error("RUNTIME_REUSE_PACKAGE_MISMATCH");
  if (
    expectedSigning.mode === "developer_id" &&
    (packaged.team_identifier !== expectedSigning.team_id ||
      runtimePackage.native_binaries_verified !==
        runtimePackage.native_binaries)
  )
    throw new Error("RUNTIME_REUSE_PACKAGE_MISMATCH");
  const artifactRoot = join(packageRoot, "runtime-release.noindex");
  await ownedDirectory(artifactRoot, "RUNTIME_REUSE_ARTIFACT_PATH_UNSAFE");
  await ownedDirectory(packaged.app, "RUNTIME_REUSE_PACKAGE_RESULT_UNSAFE");
  const archivePath = runtimePackage.archive;
  const manifestPath = runtimePackage.manifest;
  if (
    typeof archivePath !== "string" ||
    typeof manifestPath !== "string" ||
    dirname(archivePath) !== artifactRoot ||
    dirname(manifestPath) !== artifactRoot ||
    basename(manifestPath) !== "runtime-bootstrap.json"
  )
    throw new Error("RUNTIME_REUSE_ARTIFACT_PATH_UNSAFE");
  const archiveInfo = await ownedRegularFile(
    archivePath,
    packageRoot,
    MAX_ARCHIVE_BYTES,
    "RUNTIME_REUSE_ARTIFACT_PATH_UNSAFE",
  );
  const manifestRead = await readOwnedJson(
    manifestPath,
    packageRoot,
    MAX_MANIFEST_BYTES,
    "RUNTIME_REUSE_ARTIFACT_PATH_UNSAFE",
  );
  const embeddedManifestPath = join(
    packaged.app,
    "Contents/Resources/runtime-bootstrap.json",
  );
  const embeddedManifest = await readOwnedJson(
    embeddedManifestPath,
    packageRoot,
    MAX_MANIFEST_BYTES,
    "RUNTIME_REUSE_EMBEDDED_MANIFEST_MISMATCH",
  );
  try {
    await lstat(join(packaged.app, "Contents/Resources/runtime"));
    throw new Error("RUNTIME_REUSE_PRIOR_APP_NOT_THIN");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const manifestSha256 = await sha256(manifestPath);
  await assertStableOwnedFile(
    manifestPath,
    manifestRead.information,
    "RUNTIME_REUSE_ARTIFACT_CHANGED",
  );
  if (
    archiveInfo.size !== runtimePackage.archive_bytes ||
    manifestRead.bytes.length < 2 ||
    manifestSha256 !== runtimePackage.manifest_sha256 ||
    !embeddedManifest.bytes.equals(manifestRead.bytes)
  )
    throw new Error("RUNTIME_REUSE_ARTIFACT_DIGEST_MISMATCH");
  const { runtime, archiveFilename } = runtimeManifestForReuse(
    manifestRead.document,
    {
      sourceVersion,
      signing: expectedSigning,
      downloadConfiguration,
    },
  );
  const manifestInventory = validateRuntimeManifestInventory(runtime.files);
  if (
    basename(archivePath) !== archiveFilename ||
    runtime.id !== runtimePackage.id ||
    runtimeIdentifier(runtime.files) !== runtime.id ||
    runtime.archive_sha256 !== runtimePackage.archive_sha256 ||
    runtime.archive_bytes !== runtimePackage.archive_bytes ||
    runtime.installed_bytes !== runtimePackage.installed_bytes ||
    manifestInventory.installedBytes !== runtime.installed_bytes ||
    runtime.url !== runtimePackage.url ||
    runtime.files.length !== runtimePackage.files ||
    manifestInventory.nativeBinaries !== runtimePackage.native_binaries ||
    !signingMatches(runtimePackage.signing, runtime.signing)
  )
    throw new Error("RUNTIME_REUSE_PACKAGE_MISMATCH");
  const archiveSha256 = await sha256(archivePath);
  await assertStableOwnedFile(
    archivePath,
    archiveInfo,
    "RUNTIME_REUSE_ARTIFACT_CHANGED",
  );
  if (archiveSha256 !== runtime.archive_sha256)
    throw new Error("RUNTIME_REUSE_ARTIFACT_DIGEST_MISMATCH");
  const { stdout } = await exec("/usr/bin/unzip", ["-Z1", archivePath], {
    timeout: 10 * 60_000,
    maxBuffer: MAX_MANIFEST_BYTES,
  });
  assertRuntimeArchiveListing(stdout, runtime.files);

  if (
    typeof outputDirectory !== "string" ||
    !isAbsolute(outputDirectory) ||
    resolve(outputDirectory) !== outputDirectory ||
    basename(outputDirectory) !== "runtime-release.noindex"
  )
    throw new Error("RUNTIME_REUSE_OUTPUT_UNSAFE");
  const outputParent = dirname(outputDirectory);
  await ownedDirectory(outputParent, "RUNTIME_REUSE_OUTPUT_UNSAFE");
  if (!BUILD_ROOT.test(basename(outputParent)))
    throw new Error("RUNTIME_REUSE_OUTPUT_UNSAFE");
  let extraction;
  let outputCreated = false;
  try {
    extraction = await mkdtemp(
      join(outputParent, ".runtime-reuse-validation-"),
    );
    await chmod(extraction, 0o700);
    await exec(
      "/usr/bin/ditto",
      [
        "-x",
        "-k",
        "--noextattr",
        "--noqtn",
        "--noacl",
        archivePath,
        extraction,
      ],
      { timeout: 20 * 60_000, maxBuffer: 1024 * 1024 },
    );
    const extracted = await collectRuntimeInventory(extraction);
    if (
      extracted.installedBytes !== runtime.installed_bytes ||
      JSON.stringify(extracted.files) !== JSON.stringify(runtime.files) ||
      runtimeIdentifier(extracted.files) !== runtime.id
    )
      throw new Error("RUNTIME_REUSE_INVENTORY_MISMATCH");
    if (typeof signatureVerifier !== "function")
      throw new Error("RUNTIME_SIGNATURE_VERIFIER_REQUIRED");
    const nativeFiles = extracted.files.filter(
      (entry) => entry.type === "file" && entry.code_signed === true,
    );
    if (nativeFiles.length !== runtimePackage.native_binaries)
      throw new Error("RUNTIME_REUSE_INVENTORY_MISMATCH");
    for (const entry of nativeFiles) {
      try {
        await signatureVerifier(join(extraction, entry.path), expectedSigning);
      } catch {
        throw new Error("RUNTIME_SIGNATURE_INVALID");
      }
    }
    await assertStableOwnedFile(
      archivePath,
      archiveInfo,
      "RUNTIME_REUSE_ARTIFACT_CHANGED",
    );
    await assertStableOwnedFile(
      manifestPath,
      manifestRead.information,
      "RUNTIME_REUSE_ARTIFACT_CHANGED",
    );
    await assertStableOwnedFile(
      embeddedManifestPath,
      embeddedManifest.information,
      "RUNTIME_REUSE_EMBEDDED_MANIFEST_CHANGED",
    );
    await assertStableOwnedFile(
      packageResultPath,
      packageRead.information,
      "RUNTIME_REUSE_PACKAGE_RESULT_CHANGED",
    );
    await mkdir(outputDirectory, { mode: 0o700 });
    outputCreated = true;
    const copiedArchive = join(outputDirectory, archiveFilename);
    const copiedManifest = join(outputDirectory, "runtime-bootstrap.json");
    await copyFile(archivePath, copiedArchive, constants.COPYFILE_EXCL);
    await copyFile(manifestPath, copiedManifest, constants.COPYFILE_EXCL);
    await chmod(copiedArchive, 0o600);
    await chmod(copiedManifest, 0o600);
    const copiedArchiveInfo = await lstat(copiedArchive);
    const copiedManifestInfo = await lstat(copiedManifest);
    if (
      !copiedArchiveInfo.isFile() ||
      copiedArchiveInfo.isSymbolicLink() ||
      copiedArchiveInfo.nlink !== 1 ||
      copiedArchiveInfo.uid !== process.getuid?.() ||
      copiedArchiveInfo.mode & 0o022 ||
      !copiedManifestInfo.isFile() ||
      copiedManifestInfo.isSymbolicLink() ||
      copiedManifestInfo.nlink !== 1 ||
      copiedManifestInfo.uid !== process.getuid?.() ||
      copiedManifestInfo.mode & 0o022 ||
      copiedArchiveInfo.size !== runtime.archive_bytes ||
      copiedManifestInfo.size !== manifestRead.bytes.length ||
      (await sha256(copiedArchive)) !== runtime.archive_sha256 ||
      (await sha256(copiedManifest)) !== runtimePackage.manifest_sha256
    )
      throw new Error("RUNTIME_REUSE_COPY_MISMATCH");
    return {
      id: runtime.id,
      api_version: runtime.api_version,
      source_version: runtime.source_version,
      archive: copiedArchive,
      archive_bytes: runtime.archive_bytes,
      archive_sha256: runtime.archive_sha256,
      installed_bytes: runtime.installed_bytes,
      manifest: copiedManifest,
      manifest_sha256: runtimePackage.manifest_sha256,
      url: runtime.url,
      files: runtime.files.length,
      native_binaries: nativeFiles.length,
      reused: true,
      reuse_source: {
        package_result: packageResultPath,
        build_id: packaged.build_id,
        version: packaged.version,
        build: packaged.build,
      },
      signing: expectedSigning,
    };
  } catch (error) {
    if (outputCreated)
      await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    if (extraction) await rm(extraction, { recursive: true, force: true });
  }
}

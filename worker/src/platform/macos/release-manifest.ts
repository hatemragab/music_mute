import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  open,
  readFile,
  readlink,
  readdir,
  stat,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MAC_RELEASE_MANIFEST = "release-manifest.json";
export const MAC_RELEASE_SCHEMA_VERSION = 1;
const MAX_MAC_RELEASE_MANIFEST_BYTES = 16 * 1024 * 1024;

const RELEASE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REQUIRED_EXECUTABLES = [
  "app/dist/src/cli/main.js",
  "runtime/node/bin/node",
  "runtime/python/bin/python3",
  "runtime/bin/ffmpeg",
  "runtime/bin/ffprobe",
] as const;
const REQUIRED_DIRECTORIES = ["app/engine"] as const;
const REQUIRED_REGULAR_FILES = [
  "runtime/media-source-manifest.json",
  "runtime/licenses/ffmpeg/COPYING.LGPLv2.1",
  "runtime/licenses/lame/COPYING",
] as const;

export interface MacReleaseFileEntry {
  path: string;
  kind: "file";
  bytes: number;
  mode: number;
  sha256: string;
}

export interface MacReleaseLinkEntry {
  path: string;
  kind: "symlink";
  target: string;
}

export interface MacReleaseDirectoryEntry {
  path: string;
  kind: "directory";
  mode: number;
}

export type MacReleaseEntry =
  MacReleaseFileEntry | MacReleaseLinkEntry | MacReleaseDirectoryEntry;

export interface MacReleaseManifest {
  schemaVersion: 1;
  platform: "darwin";
  architecture: "arm64";
  releaseVersion: string;
  entries: MacReleaseEntry[];
}

export async function createMacReleaseManifest(
  releaseRoot: string,
  releaseVersion: string,
): Promise<MacReleaseManifest> {
  const root = assertSafeRoot(releaseRoot);
  const rootInfo = await lstat(root);
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    (rootInfo.mode & 0o022) !== 0
  )
    throw new TypeError("Mac release root is unsafe");
  assertReleaseVersion(releaseVersion);
  const entries: MacReleaseEntry[] = [];
  await walkRelease(root, root, entries);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  if (
    entries.some(
      (entry) => entry.kind !== "symlink" && (entry.mode & 0o022) !== 0,
    )
  )
    throw new TypeError("Mac release contains a writable entry");
  const manifest: MacReleaseManifest = {
    schemaVersion: MAC_RELEASE_SCHEMA_VERSION,
    platform: "darwin",
    architecture: "arm64",
    releaseVersion,
    entries,
  };
  await assertRuntimeShape(root);
  return manifest;
}

export async function writeMacReleaseManifest(
  releaseRoot: string,
  releaseVersion: string,
): Promise<MacReleaseManifest> {
  const root = assertSafeRoot(releaseRoot);
  const manifestPath = join(root, MAC_RELEASE_MANIFEST);
  const manifest = await createMacReleaseManifest(root, releaseVersion);
  const handle = await open(manifestPath, "wx", 0o644);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(manifestPath, 0o644);
  return manifest;
}

export async function verifyMacRelease(
  releaseRoot: string,
): Promise<MacReleaseManifest> {
  const root = assertSafeRoot(releaseRoot);
  const manifestInfo = await lstat(join(root, MAC_RELEASE_MANIFEST));
  if (
    !manifestInfo.isFile() ||
    manifestInfo.isSymbolicLink() ||
    manifestInfo.size < 2 ||
    manifestInfo.size > MAX_MAC_RELEASE_MANIFEST_BYTES ||
    (manifestInfo.mode & 0o022) !== 0
  )
    throw new TypeError("Mac release manifest is unsafe");
  const raw = await readFile(join(root, MAC_RELEASE_MANIFEST), "utf8");
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new TypeError("Mac release manifest is not valid JSON");
  }
  const expected = parseManifest(decoded);
  const actual = await createMacReleaseManifest(root, expected.releaseVersion);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new TypeError("Mac release manifest does not match release contents");
  return expected;
}

async function walkRelease(
  root: string,
  directory: string,
  entries: MacReleaseEntry[],
): Promise<void> {
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const absolute = join(directory, child.name);
    const path = toReleasePath(root, absolute);
    if (path === MAC_RELEASE_MANIFEST) continue;
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      entries.push({ path, kind: "directory", mode: info.mode & 0o777 });
      await walkRelease(root, absolute, entries);
      continue;
    }
    if (info.isSymbolicLink()) {
      const target = await readlink(absolute);
      assertSafeLink(root, absolute, target);
      entries.push({ path, kind: "symlink", target });
      continue;
    }
    if (!info.isFile())
      throw new TypeError(`Mac release contains unsupported entry: ${path}`);
    entries.push({
      path,
      kind: "file",
      bytes: info.size,
      mode: info.mode & 0o777,
      sha256: await sha256(absolute),
    });
  }
}

function parseManifest(value: unknown): MacReleaseManifest {
  const record = strictRecord(
    value,
    new Set([
      "schemaVersion",
      "platform",
      "architecture",
      "releaseVersion",
      "entries",
    ]),
    "Mac release manifest",
  );
  if (
    record.schemaVersion !== MAC_RELEASE_SCHEMA_VERSION ||
    record.platform !== "darwin" ||
    record.architecture !== "arm64"
  )
    throw new TypeError("Mac release manifest target is unsupported");
  if (typeof record.releaseVersion !== "string")
    throw new TypeError("Mac release version is invalid");
  assertReleaseVersion(record.releaseVersion);
  if (!Array.isArray(record.entries) || record.entries.length < 1)
    throw new TypeError("Mac release manifest entries are invalid");
  const entries = record.entries.map((entry, index) =>
    parseEntry(entry, index),
  );
  const ordered = [...entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (JSON.stringify(entries) !== JSON.stringify(ordered))
    throw new TypeError("Mac release manifest entries are not ordered");
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length)
    throw new TypeError("Mac release manifest contains duplicate paths");
  return {
    schemaVersion: MAC_RELEASE_SCHEMA_VERSION,
    platform: "darwin",
    architecture: "arm64",
    releaseVersion: record.releaseVersion,
    entries,
  };
}

function parseEntry(value: unknown, index: number): MacReleaseEntry {
  const base = strictRecord(
    value,
    new Set(["path", "kind", "bytes", "mode", "sha256", "target"]),
    `Mac release entry ${index}`,
  );
  if (typeof base.path !== "string")
    throw new TypeError(`Mac release entry ${index} path is invalid`);
  assertRelativePath(base.path);
  if (base.kind === "symlink") {
    if (
      Object.hasOwn(base, "bytes") ||
      Object.hasOwn(base, "mode") ||
      Object.hasOwn(base, "sha256") ||
      typeof base.target !== "string" ||
      base.target.length < 1 ||
      base.target.length > 4096 ||
      isAbsolute(base.target)
    )
      throw new TypeError(`Mac release symlink ${index} is invalid`);
    return { path: base.path, kind: "symlink", target: base.target };
  }
  if (base.kind === "directory") {
    if (
      Object.hasOwn(base, "target") ||
      Object.hasOwn(base, "bytes") ||
      Object.hasOwn(base, "sha256") ||
      !Number.isSafeInteger(base.mode) ||
      (base.mode as number) < 0 ||
      (base.mode as number) > 0o777 ||
      ((base.mode as number) & 0o022) !== 0
    )
      throw new TypeError(`Mac release directory ${index} is invalid`);
    return { path: base.path, kind: "directory", mode: base.mode as number };
  }
  if (
    base.kind !== "file" ||
    Object.hasOwn(base, "target") ||
    !Number.isSafeInteger(base.bytes) ||
    (base.bytes as number) < 0 ||
    !Number.isSafeInteger(base.mode) ||
    (base.mode as number) < 0 ||
    (base.mode as number) > 0o777 ||
    ((base.mode as number) & 0o022) !== 0 ||
    typeof base.sha256 !== "string" ||
    !SHA256.test(base.sha256)
  )
    throw new TypeError(`Mac release file ${index} is invalid`);
  return {
    path: base.path,
    kind: "file",
    bytes: base.bytes as number,
    mode: base.mode as number,
    sha256: base.sha256,
  };
}

async function assertRuntimeShape(root: string): Promise<void> {
  for (const path of REQUIRED_EXECUTABLES) {
    const info = await stat(join(root, path));
    if (!info.isFile() || (info.mode & 0o111) === 0)
      throw new TypeError(`Mac release executable is invalid: ${path}`);
  }
  for (const path of REQUIRED_DIRECTORIES) {
    const info = await stat(join(root, path));
    if (!info.isDirectory())
      throw new TypeError(`Mac release directory is invalid: ${path}`);
  }
  for (const path of REQUIRED_REGULAR_FILES) {
    const info = await lstat(join(root, path));
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1)
      throw new TypeError(`Mac release file is invalid: ${path}`);
  }
}

function assertSafeLink(root: string, path: string, target: string): void {
  if (isAbsolute(target))
    throw new TypeError("Mac release contains an absolute symlink");
  const destination = resolve(dirname(path), target);
  if (destination !== root && !destination.startsWith(`${root}${sep}`))
    throw new TypeError("Mac release symlink escapes the release root");
}

function assertSafeRoot(value: string): string {
  if (!isAbsolute(value))
    throw new TypeError("Mac release root must be absolute");
  const root = resolve(value);
  if (root === resolve(sep)) throw new TypeError("Mac release root is unsafe");
  return root;
}

function toReleasePath(root: string, absolute: string): string {
  const value = relative(root, absolute).split(sep).join("/");
  assertRelativePath(value);
  return value;
}

function assertRelativePath(value: string): void {
  if (
    value.length < 1 ||
    value.length > 4096 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  )
    throw new TypeError("Mac release path is unsafe");
}

function assertReleaseVersion(value: string): void {
  if (!RELEASE_VERSION.test(value))
    throw new TypeError("Mac release version is invalid");
}

function strictRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.has(key)))
    throw new TypeError(`${label} contains an unknown field`);
  return result;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const WINDOWS_RELEASE_MANIFEST = "release-manifest.json";
export const WINDOWS_RELEASE_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const RELEASE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

const REQUIRED_FILES = [
  "app/dist/src/cli/main.js",
  "installer/manage-windows-service.ps1",
  "runtime/node/node.exe",
  "runtime/python/python.exe",
  "runtime/bin/ffmpeg.exe",
  "runtime/bin/ffprobe.exe",
  "runtime/service/MusicMuteWorkerService.exe",
  "runtime/service/LICENSE.txt",
  "runtime/service/source-manifest.json",
  "runtime/media-source-manifest.json",
  "runtime/licenses/ffmpeg/COPYING.LGPLv2.1",
  "runtime/licenses/lame/COPYING",
] as const;

export interface WindowsReleaseFileEntry {
  path: string;
  kind: "file";
  bytes: number;
  sha256: string;
}

export interface WindowsReleaseDirectoryEntry {
  path: string;
  kind: "directory";
}

export type WindowsReleaseEntry =
  WindowsReleaseFileEntry | WindowsReleaseDirectoryEntry;

export interface WindowsReleaseManifest {
  schemaVersion: 1;
  platform: "win32";
  architecture: "x64";
  releaseVersion: string;
  entries: WindowsReleaseEntry[];
}

export async function createWindowsReleaseManifest(
  releaseRoot: string,
  releaseVersion: string,
): Promise<WindowsReleaseManifest> {
  const root = safeRoot(releaseRoot);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new TypeError("Windows release root is unsafe");
  assertVersion(releaseVersion);
  const entries: WindowsReleaseEntry[] = [];
  await walk(root, root, entries);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  if (entries.length > MAX_ENTRIES)
    throw new TypeError("Windows release contains too many entries");
  await assertShape(root);
  return {
    schemaVersion: WINDOWS_RELEASE_SCHEMA_VERSION,
    platform: "win32",
    architecture: "x64",
    releaseVersion,
    entries,
  };
}

export async function writeWindowsReleaseManifest(
  releaseRoot: string,
  releaseVersion: string,
): Promise<WindowsReleaseManifest> {
  const root = safeRoot(releaseRoot);
  const manifest = await createWindowsReleaseManifest(root, releaseVersion);
  const handle = await open(join(root, WINDOWS_RELEASE_MANIFEST), "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return manifest;
}

export async function verifyWindowsRelease(
  releaseRoot: string,
): Promise<WindowsReleaseManifest> {
  const root = safeRoot(releaseRoot);
  const path = join(root, WINDOWS_RELEASE_MANIFEST);
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > MAX_MANIFEST_BYTES
  )
    throw new TypeError("Windows release manifest is unsafe");
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new TypeError("Windows release manifest is not valid JSON");
  }
  const expected = parseManifest(decoded);
  const actual = await createWindowsReleaseManifest(
    root,
    expected.releaseVersion,
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new TypeError(
      "Windows release manifest does not match release contents",
    );
  return expected;
}

async function walk(
  root: string,
  directory: string,
  entries: WindowsReleaseEntry[],
): Promise<void> {
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const absolute = join(directory, child.name);
    const path = releasePath(root, absolute);
    if (path === WINDOWS_RELEASE_MANIFEST) continue;
    const info = await lstat(absolute);
    if (info.isSymbolicLink())
      throw new TypeError(`Windows release contains a link: ${path}`);
    if (info.isDirectory()) {
      entries.push({ path, kind: "directory" });
      await walk(root, absolute, entries);
      continue;
    }
    if (!info.isFile())
      throw new TypeError(
        `Windows release contains unsupported entry: ${path}`,
      );
    entries.push({
      path,
      kind: "file",
      bytes: info.size,
      sha256: await sha256(absolute),
    });
  }
}

function parseManifest(value: unknown): WindowsReleaseManifest {
  const record = strictRecord(
    value,
    new Set([
      "schemaVersion",
      "platform",
      "architecture",
      "releaseVersion",
      "entries",
    ]),
    "Windows release manifest",
  );
  if (
    record.schemaVersion !== WINDOWS_RELEASE_SCHEMA_VERSION ||
    record.platform !== "win32" ||
    record.architecture !== "x64"
  )
    throw new TypeError("Windows release manifest target is unsupported");
  if (typeof record.releaseVersion !== "string")
    throw new TypeError("Windows release version is invalid");
  assertVersion(record.releaseVersion);
  if (
    !Array.isArray(record.entries) ||
    record.entries.length < 1 ||
    record.entries.length > MAX_ENTRIES
  )
    throw new TypeError("Windows release manifest entries are invalid");
  const entries = record.entries.map(parseEntry);
  const ordered = [...entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (JSON.stringify(entries) !== JSON.stringify(ordered))
    throw new TypeError("Windows release manifest entries are not ordered");
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length)
    throw new TypeError("Windows release manifest contains duplicate paths");
  return {
    schemaVersion: WINDOWS_RELEASE_SCHEMA_VERSION,
    platform: "win32",
    architecture: "x64",
    releaseVersion: record.releaseVersion,
    entries,
  };
}

function parseEntry(value: unknown, index: number): WindowsReleaseEntry {
  const record = strictRecord(
    value,
    new Set(["path", "kind", "bytes", "sha256"]),
    `Windows release entry ${index}`,
  );
  if (typeof record.path !== "string")
    throw new TypeError(`Windows release entry ${index} path is invalid`);
  assertRelativePath(record.path);
  if (record.kind === "directory") {
    if (Object.hasOwn(record, "bytes") || Object.hasOwn(record, "sha256"))
      throw new TypeError(`Windows release entry ${index} is invalid`);
    return { path: record.path, kind: "directory" };
  }
  if (
    record.kind !== "file" ||
    !Number.isSafeInteger(record.bytes) ||
    (record.bytes as number) < 0 ||
    typeof record.sha256 !== "string" ||
    !SHA256.test(record.sha256)
  )
    throw new TypeError(`Windows release entry ${index} is invalid`);
  return {
    path: record.path,
    kind: "file",
    bytes: record.bytes as number,
    sha256: record.sha256,
  };
}

async function assertShape(root: string): Promise<void> {
  const engine = await lstat(join(root, "app", "engine"));
  if (!engine.isDirectory() || engine.isSymbolicLink())
    throw new TypeError("Windows release engine is missing");
  for (const path of REQUIRED_FILES) {
    const info = await lstat(join(root, ...path.split("/")));
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1)
      throw new TypeError(`Windows release file is missing: ${path}`);
  }
}

function strictRecord(
  value: unknown,
  keys: Set<string>,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} is invalid`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.has(key)))
    throw new TypeError(`${label} contains unknown fields`);
  return record;
}

function assertVersion(value: string): void {
  if (!RELEASE_VERSION.test(value))
    throw new TypeError("Windows release version is invalid");
}

function assertRelativePath(value: string): void {
  if (
    value.length < 1 ||
    value.length > 1024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  )
    throw new TypeError("Windows release path is invalid");
}

function releasePath(root: string, absolute: string): string {
  const value = relative(root, absolute).split(sep).join("/");
  assertRelativePath(value);
  return value;
}

function safeRoot(value: string): string {
  if (!isAbsolute(value))
    throw new TypeError("Windows release root must be absolute");
  return resolve(value);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

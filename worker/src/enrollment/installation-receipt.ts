import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { WorkerPlatform } from "../../protocol/v1/protocol.js";

const RECEIPT_FILE = "installation-artifacts.json";
const ARTIFACTS_DIRECTORY = "installation-artifacts";
const RECEIPT_LIMIT_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024 * 1024;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const RELEASE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;

export interface PreparedArtifact {
  path: string;
  bytes: number;
  sha256: string;
  contentType: string;
}

export interface PreparedReleaseArtifact extends PreparedArtifact {
  releaseRoot: string;
}

export interface InstallationArtifactsReceipt {
  schemaVersion: 1;
  installationId: string;
  platform: WorkerPlatform;
  releaseVersion: string;
  release: PreparedReleaseArtifact;
  model: PreparedArtifact;
  fixture: PreparedArtifact;
}

export async function readInstallationArtifactsReceipt(
  outputRoot: string,
): Promise<InstallationArtifactsReceipt> {
  if (!isAbsolute(outputRoot))
    throw new TypeError("Installation receipt root must be absolute");
  await assertProtectedDirectory(outputRoot);
  const artifactRoot = resolve(outputRoot, ARTIFACTS_DIRECTORY);
  await assertProtectedDirectory(artifactRoot);
  const receiptPath = join(outputRoot, RECEIPT_FILE);
  const receiptInfo = await lstat(receiptPath);
  if (
    !receiptInfo.isFile() ||
    receiptInfo.isSymbolicLink() ||
    receiptInfo.size < 2 ||
    receiptInfo.size > RECEIPT_LIMIT_BYTES ||
    (process.platform !== "win32" && (receiptInfo.mode & 0o077) !== 0)
  )
    throw new TypeError("Installation artifact receipt is unsafe");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(receiptPath, "utf8")) as unknown;
  } catch {
    throw new TypeError("Installation artifact receipt is invalid JSON");
  }
  const root = strictRecord(
    value,
    new Set([
      "schemaVersion",
      "installationId",
      "platform",
      "releaseVersion",
      "release",
      "model",
      "fixture",
    ]),
  );
  if (
    root.schemaVersion !== 1 ||
    typeof root.installationId !== "string" ||
    !UUID_V4.test(root.installationId) ||
    (root.platform !== "darwin-arm64" && root.platform !== "windows-amd64") ||
    typeof root.releaseVersion !== "string" ||
    !RELEASE_VERSION.test(root.releaseVersion)
  )
    throw new TypeError("Installation artifact receipt is invalid");
  const platform = root.platform;
  const release = parseArtifact(
    root.release,
    artifactRoot,
    [platform === "darwin-arm64" ? "application/gzip" : "application/zip"],
    true,
  );
  const model = parseArtifact(
    root.model,
    artifactRoot,
    ["application/octet-stream"],
    false,
  );
  const fixture = parseArtifact(
    root.fixture,
    artifactRoot,
    ["audio/wav"],
    false,
  );
  await Promise.all([
    verifyArtifact(release),
    verifyArtifact(model),
    verifyArtifact(fixture),
  ]);
  await assertContainedDirectory(release.releaseRoot!, artifactRoot);
  return {
    schemaVersion: 1,
    installationId: root.installationId,
    platform,
    releaseVersion: root.releaseVersion,
    release: release as PreparedReleaseArtifact,
    model,
    fixture,
  };
}

function parseArtifact(
  value: unknown,
  artifactRoot: string,
  contentTypes: readonly string[],
  release: boolean,
): PreparedReleaseArtifact {
  const root = strictRecord(
    value,
    new Set([
      "path",
      "bytes",
      "sha256",
      "contentType",
      ...(release ? ["releaseRoot"] : []),
    ]),
  );
  if (
    typeof root.path !== "string" ||
    !isContained(root.path, artifactRoot) ||
    !Number.isSafeInteger(root.bytes) ||
    (root.bytes as number) < 1 ||
    (root.bytes as number) > MAX_ARTIFACT_BYTES ||
    typeof root.sha256 !== "string" ||
    !SHA256.test(root.sha256) ||
    typeof root.contentType !== "string" ||
    !contentTypes.includes(root.contentType) ||
    (release &&
      (typeof root.releaseRoot !== "string" ||
        !isContained(root.releaseRoot, artifactRoot)))
  )
    throw new TypeError("Installation artifact receipt is invalid");
  return {
    path: root.path,
    bytes: root.bytes as number,
    sha256: root.sha256,
    contentType: root.contentType,
    ...(release ? { releaseRoot: root.releaseRoot as string } : {}),
  } as PreparedReleaseArtifact;
}

async function verifyArtifact(artifact: PreparedArtifact): Promise<void> {
  const info = await lstat(artifact.path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== artifact.bytes ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new TypeError("Prepared installation artifact is unsafe");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(artifact.path))
    digest.update(chunk);
  if (digest.digest("hex") !== artifact.sha256)
    throw new TypeError("Prepared installation artifact digest changed");
}

async function assertProtectedDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new TypeError("Installation receipt directory is unsafe");
}

async function assertContainedDirectory(
  path: string,
  parent: string,
): Promise<void> {
  if (!isContained(path, parent))
    throw new TypeError("Prepared release root is unsafe");
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new TypeError("Prepared release root is unsafe");
}

function isContained(path: string, parent: string): boolean {
  if (!isAbsolute(path)) return false;
  const child = resolve(path);
  const offset = relative(resolve(parent), child);
  return offset !== "" && !offset.startsWith("..") && !isAbsolute(offset);
}

function strictRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Installation artifact receipt is invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.has(key)))
    throw new TypeError("Installation artifact receipt is invalid");
  return record;
}

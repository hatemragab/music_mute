import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  open,
  rm,
  statfs,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type {
  InstallationArtifactGrant,
  InstallationArtifactsResult,
  InstallationModelDescriptor,
} from "./enrollment-client.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024 * 1024;

export interface VerifiedArtifactDownloadOptions {
  url: string;
  outputPath: string;
  expectedBytes: number;
  expectedSha256: string;
  expectedContentType: string;
  fetch?: typeof fetch;
  allowInsecureLoopback?: boolean;
  timeoutMs?: number;
  allowedRedirectHosts?: readonly string[];
  maxRedirects?: number;
}

export interface VerifiedArtifactDownload {
  path: string;
  bytes: number;
  sha256: string;
  reused: boolean;
}

export interface InstallationArtifactDownloadOptions {
  outputRoot: string;
  reusableModelPath?: string;
  fetch?: typeof fetch;
  allowInsecureLoopback?: boolean;
  timeoutMs?: number;
  availableDiskBytes?: () => Promise<number>;
}

export interface InstallationArtifactDownloads {
  release: VerifiedArtifactDownload;
  model: VerifiedArtifactDownload;
  fixture: VerifiedArtifactDownload;
}

export async function downloadInstallationArtifacts(
  manifest: InstallationArtifactsResult,
  options: InstallationArtifactDownloadOptions,
): Promise<InstallationArtifactDownloads> {
  if (!isAbsolute(options.outputRoot))
    throw new TypeError("Artifact output root must be absolute");
  await assertProtectedDirectory(options.outputRoot);
  const entries = [manifest.release, manifest.model, manifest.fixture] as const;
  if (new Set(entries.map((entry) => entry.filename)).size !== entries.length)
    throw new TypeError("Installation artifact filenames conflict");
  for (const entry of entries) assertSafeManifestEntry(entry);
  assertFreshGrant([manifest.release, manifest.fixture]);
  await assertInstallationDiskBudget(manifest, options);
  if (options.reusableModelPath !== undefined) {
    await seedReusableArtifact(
      options.reusableModelPath,
      join(options.outputRoot, manifest.model.filename),
      manifest.model,
    );
  }

  const common = {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.allowInsecureLoopback === undefined
      ? {}
      : { allowInsecureLoopback: options.allowInsecureLoopback }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  };
  return {
    release: await downloadManifestEntry(
      manifest.release,
      options.outputRoot,
      common,
    ),
    model: await downloadModelDescriptor(
      manifest.model,
      options.outputRoot,
      common,
    ),
    fixture: await downloadManifestEntry(
      manifest.fixture,
      options.outputRoot,
      common,
    ),
  };
}

async function assertInstallationDiskBudget(
  manifest: InstallationArtifactsResult,
  options: InstallationArtifactDownloadOptions,
): Promise<void> {
  const available = await (
    options.availableDiskBytes ??
    (async () => {
      const filesystem = await statfs(options.outputRoot);
      return filesystem.bavail * filesystem.bsize;
    })
  )();
  const required =
    ((await exactArtifactExists(
      join(options.outputRoot, manifest.release.filename),
      manifest.release,
    ))
      ? 0
      : manifest.release.bytes * 3) +
    ((await exactArtifactExists(
      join(options.outputRoot, manifest.model.filename),
      manifest.model,
    ))
      ? 0
      : manifest.model.bytes) +
    ((await exactArtifactExists(
      join(options.outputRoot, manifest.fixture.filename),
      manifest.fixture,
    ))
      ? 0
      : manifest.fixture.bytes) +
    512 * 1024 * 1024;
  if (!Number.isSafeInteger(available) || available < required)
    throw new Error("Insufficient disk space for verified installation");
}

async function seedReusableArtifact(
  sourcePath: string,
  outputPath: string,
  artifact: InstallationModelDescriptor,
): Promise<void> {
  if (!isAbsolute(sourcePath))
    throw new TypeError("Reusable model path must be absolute");
  if (!(await exactArtifactExists(sourcePath, artifact))) return;
  const temporary = `${outputPath}.${randomUUID()}.seed`;
  try {
    await copyFile(sourcePath, temporary, 0);
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    if (!(await exactArtifactExists(temporary, artifact)))
      throw new TypeError("Reusable model copy failed integrity verification");
    await link(temporary, outputPath);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function exactArtifactExists(
  path: string,
  artifact: { bytes: number; sha256: string },
): Promise<boolean> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== artifact.bytes ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    return false;
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex") === artifact.sha256;
}

export async function downloadVerifiedArtifact(
  options: VerifiedArtifactDownloadOptions,
): Promise<VerifiedArtifactDownload> {
  validateOptions(options);
  await assertProtectedDirectory(dirname(options.outputPath));
  const existing = await verifyExisting(options);
  if (existing) return result(options, true);

  const temporary = `${options.outputPath}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    const response = await fetchArtifact(options);
    if (!response.ok || response.body === null)
      throw new Error("Artifact download failed");
    assertResponseHeaders(response, options);

    handle = await open(temporary, "wx", 0o600);
    const reader = response.body.getReader();
    const digest = createHash("sha256");
    let bytes = 0;
    try {
      while (true) {
        const current = await reader.read();
        if (current.done) break;
        const chunk = current.value;
        bytes += chunk.byteLength;
        if (bytes > options.expectedBytes)
          throw new TypeError("Artifact download exceeds its declared size");
        digest.update(chunk);
        await handle.write(chunk);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    if (
      bytes !== options.expectedBytes ||
      digest.digest("hex") !== options.expectedSha256
    )
      throw new TypeError("Artifact download integrity check failed");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, options.outputPath);
    } catch (error) {
      if (isAlreadyExists(error) && (await verifyExisting(options))) {
        await rm(temporary);
        return result(options, true);
      }
      throw error;
    }
    await rm(temporary);
    if (process.platform !== "win32") await chmod(options.outputPath, 0o600);
    return result(options, false);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

async function downloadModelDescriptor(
  model: InstallationModelDescriptor,
  outputRoot: string,
  common: Pick<
    VerifiedArtifactDownloadOptions,
    "fetch" | "allowInsecureLoopback" | "timeoutMs"
  >,
): Promise<VerifiedArtifactDownload> {
  return await downloadVerifiedArtifact({
    url: model.url,
    outputPath: join(outputRoot, model.filename),
    expectedBytes: model.bytes,
    expectedSha256: model.sha256,
    expectedContentType: model.contentType,
    allowedRedirectHosts: model.allowedHosts,
    maxRedirects: model.maxRedirects,
    ...common,
  });
}

async function fetchArtifact(
  options: VerifiedArtifactDownloadOptions,
): Promise<Response> {
  const allowedHosts = new Set(options.allowedRedirectHosts ?? []);
  let current = new URL(options.url);
  if (allowedHosts.size > 0 && !allowedHosts.has(current.hostname))
    throw new TypeError("Artifact download host is not approved");
  const maximum = options.maxRedirects ?? 0;
  for (let redirect = 0; ; redirect += 1) {
    const response = await (options.fetch ?? fetch)(current, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10 * 60_000),
      headers: { Accept: options.expectedContentType },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirect >= maximum)
      throw new TypeError("Artifact download exceeded approved redirects");
    const location = response.headers.get("location");
    if (location === null)
      throw new TypeError("Artifact download redirect is invalid");
    const next = new URL(location, current);
    if (
      next.protocol !== "https:" ||
      next.username !== "" ||
      next.password !== "" ||
      next.hash !== "" ||
      !allowedHosts.has(next.hostname)
    )
      throw new TypeError("Artifact download redirect host is not approved");
    current = next;
  }
}

async function downloadManifestEntry(
  artifact: InstallationArtifactGrant,
  outputRoot: string,
  common: Pick<
    VerifiedArtifactDownloadOptions,
    "fetch" | "allowInsecureLoopback" | "timeoutMs"
  >,
): Promise<VerifiedArtifactDownload> {
  return await downloadVerifiedArtifact({
    url: artifact.url,
    outputPath: join(outputRoot, artifact.filename),
    expectedBytes: artifact.bytes,
    expectedSha256: artifact.sha256,
    expectedContentType: artifact.contentType,
    ...common,
  });
}

function assertSafeManifestEntry(artifact: { filename: string }): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(artifact.filename))
    throw new TypeError("Installation artifact filename is unsafe");
}

function assertFreshGrant(
  artifacts: readonly InstallationArtifactGrant[],
): void {
  const now = Date.now();
  if (
    artifacts.some(
      (artifact) =>
        !Number.isFinite(Date.parse(artifact.expiresAt)) ||
        Date.parse(artifact.expiresAt) <= now,
    )
  )
    throw new TypeError("Installation artifact grant is expired");
}

function validateOptions(options: VerifiedArtifactDownloadOptions): void {
  const url = new URL(options.url);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    url.username !== "" ||
    url.password !== "" ||
    (url.protocol !== "https:" &&
      !(options.allowInsecureLoopback === true && loopback))
  )
    throw new TypeError("Artifact download URL is unsafe");
  if (!isAbsolute(options.outputPath))
    throw new TypeError("Artifact output path must be absolute");
  if (
    !Number.isSafeInteger(options.expectedBytes) ||
    options.expectedBytes < 1 ||
    options.expectedBytes > MAX_ARTIFACT_BYTES ||
    !SHA256.test(options.expectedSha256) ||
    !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/u.test(
      options.expectedContentType,
    ) ||
    !Number.isSafeInteger(options.timeoutMs ?? 10 * 60_000) ||
    (options.timeoutMs ?? 10 * 60_000) < 1_000 ||
    (options.timeoutMs ?? 10 * 60_000) > 60 * 60_000 ||
    !Number.isSafeInteger(options.maxRedirects ?? 0) ||
    (options.maxRedirects ?? 0) < 0 ||
    (options.maxRedirects ?? 0) > 4 ||
    (options.allowedRedirectHosts !== undefined &&
      (options.allowedRedirectHosts.length < 1 ||
        options.allowedRedirectHosts.length > 8 ||
        options.allowedRedirectHosts.some(
          (host) => !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(host),
        )))
  )
    throw new TypeError("Artifact download metadata is invalid");
}

function assertResponseHeaders(
  response: Response,
  options: VerifiedArtifactDownloadOptions,
): void {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) !== options.expectedBytes)
    throw new TypeError("Artifact response size does not match metadata");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== options.expectedContentType)
    throw new TypeError("Artifact response type does not match metadata");
}

async function assertProtectedDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new TypeError("Artifact output directory is unsafe");
}

async function verifyExisting(
  options: VerifiedArtifactDownloadOptions,
): Promise<boolean> {
  let info;
  try {
    info = await lstat(options.outputPath);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== options.expectedBytes ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new TypeError("Existing artifact conflicts with download metadata");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(options.outputPath))
    digest.update(chunk);
  if (digest.digest("hex") !== options.expectedSha256)
    throw new TypeError("Existing artifact conflicts with download metadata");
  return true;
}

function result(
  options: VerifiedArtifactDownloadOptions,
  reused: boolean,
): VerifiedArtifactDownload {
  return {
    path: options.outputPath,
    bytes: options.expectedBytes,
    sha256: options.expectedSha256,
    reused,
  };
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  MacReleaseEntry,
  MacReleaseManifest,
} from "./release-manifest.js";
import { verifyMacRelease } from "./release-manifest.js";
import type { MacUserLayout } from "./user-paths.js";
import { withDarwinSharedFileLock } from "../../runtime/darwin-file-lock.js";
import { AppControlError } from "./app-control-protocol.js";

export const APP_MODEL_SHA256 =
  "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";
export const APP_MODEL_BYTES = 66_759_214;
const HASH = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;
const execute = promisify(execFile);
const MANIFEST_LIMIT = 16 * 1024 * 1024;

export interface AppServiceManifest {
  schema_version: 1;
  platform: "darwin";
  architecture: "arm64";
  worker_version: string;
  api_version: 1;
  entries: MacReleaseEntry[];
  payload_sha256: string;
}
export interface AppExternalReleaseManifest {
  schemaVersion: 2;
  platform: "darwin";
  architecture: "arm64";
  distribution: "app-external";
  releaseVersion: string;
  serviceId: string;
  serviceManifestSha256: string;
  payloadSha256: string;
  base: {
    supportRoot: string;
    runtimeId: string;
    archiveSha256: string;
    bootstrapSha256: string;
  };
  model: { sha256: string; bytes: number };
}
export type ManagedMacReleaseManifest =
  MacReleaseManifest | AppExternalReleaseManifest;
export interface AppRuntimeBootstrap {
  schema_version: 1;
  runtime: {
    id: string;
    api_version: 1;
    platform: "darwin";
    arch: "arm64";
    archive_sha256: string;
    signing: { mode: "ad_hoc" | "developer_id"; team_id?: string | null };
    files: {
      path: string;
      type: "file" | "symlink";
      bytes?: number;
      sha256?: string;
      executable?: boolean;
      code_signed?: boolean;
      link_target?: string;
    }[];
  };
}

export async function readAppBinding(
  releaseRoot: string,
): Promise<AppExternalReleaseManifest | null> {
  const path = join(releaseRoot, "release-manifest.json");
  const value = await readBoundedJson(path, MANIFEST_LIMIT);
  if (value.schemaVersion === 1) return null;
  strict(value, [
    "schemaVersion",
    "platform",
    "architecture",
    "distribution",
    "releaseVersion",
    "serviceId",
    "serviceManifestSha256",
    "payloadSha256",
    "base",
    "model",
  ]);
  const base = record(value.base);
  const model = record(value.model);
  strict(base, [
    "supportRoot",
    "runtimeId",
    "archiveSha256",
    "bootstrapSha256",
  ]);
  strict(model, ["sha256", "bytes"]);
  if (
    value.schemaVersion !== 2 ||
    value.platform !== "darwin" ||
    value.architecture !== "arm64" ||
    value.distribution !== "app-external" ||
    !IDENTIFIER.test(String(value.releaseVersion)) ||
    !HASH.test(String(value.serviceId)) ||
    !HASH.test(String(value.serviceManifestSha256)) ||
    !HASH.test(String(value.payloadSha256)) ||
    !IDENTIFIER.test(String(base.runtimeId)) ||
    !HASH.test(String(base.archiveSha256)) ||
    !HASH.test(String(base.bootstrapSha256)) ||
    typeof base.supportRoot !== "string" ||
    !isAbsolute(base.supportRoot) ||
    resolve(base.supportRoot) !== base.supportRoot ||
    model.sha256 !== APP_MODEL_SHA256 ||
    model.bytes !== APP_MODEL_BYTES
  )
    throw new TypeError("App worker binding is invalid");
  const prefix =
    "/Library/Application Support/MusicMuteWorker/runtime/releases/";
  const boundary = resolve(releaseRoot).lastIndexOf(prefix);
  if (
    boundary < 1 ||
    base.supportRoot !==
      `${resolve(releaseRoot).slice(0, boundary)}/Library/Application Support/MusicMuteLocal`
  )
    throw new TypeError("App worker binding escapes its user installation");
  if (
    value.serviceId !==
    hash(
      Buffer.concat([
        await readBoundedBytes(
          join(releaseRoot, "service-manifest.json"),
          MANIFEST_LIMIT,
        ),
        await readBoundedBytes(
          join(releaseRoot, "runtime-bootstrap.json"),
          MANIFEST_LIMIT,
        ),
      ]),
    )
  )
    throw new TypeError("App worker binding identity changed");
  return value as unknown as AppExternalReleaseManifest;
}

/** Legacy releases retain their complete, unchanged verifier; external bases are explicit. */
export async function verifyManagedMacRelease(
  releaseRoot: string,
): Promise<ManagedMacReleaseManifest> {
  const binding = await readAppBinding(releaseRoot);
  if (binding === null) return await verifyMacRelease(releaseRoot);
  const verify = async () => {
    const service = await verifyAppServicePayload(
      releaseRoot,
      binding.serviceManifestSha256,
      binding.payloadSha256,
    );
    const bootstrap = parseBootstrap(
      JSON.parse(
        (
          await readBoundedBytes(
            join(releaseRoot, "runtime-bootstrap.json"),
            MANIFEST_LIMIT,
          )
        ).toString("utf8"),
      ) as unknown,
    );
    await verifyAppServiceNativeCode(
      releaseRoot,
      service,
      bootstrap.runtime.signing,
    );
    await verifyAppRuntimeBase(
      binding,
      join(releaseRoot, "runtime-bootstrap.json"),
    );
  };
  if (process.platform === "darwin")
    await withDarwinSharedFileLock(
      join(binding.base.supportRoot, "runtime", "bootstrap.lock"),
      verify,
    );
  else await verify();
  return binding;
}

export async function verifyAppServiceNativeCode(
  root: string,
  manifest: AppServiceManifest,
  signing: AppRuntimeBootstrap["runtime"]["signing"],
  verifier = verifyNativeSignature,
): Promise<void> {
  const magic = new Set([
    "cffaedfe",
    "cefaedfe",
    "feedfacf",
    "feedface",
    "cafebabe",
    "bebafeca",
    "cafebabf",
    "bfbafeca",
  ]);
  for (const entry of manifest.entries) {
    if (entry.kind !== "file") continue;
    const path = join(root, entry.path);
    const handle = await open(path, "r");
    const prefix = Buffer.alloc(4);
    try {
      await handle.read(prefix, 0, 4, 0);
    } finally {
      await handle.close();
    }
    const native = magic.has(prefix.toString("hex"));
    if (/\.(?:node|dylib|so)$/u.test(entry.path) && !native)
      throw new TypeError("App service native addon target is invalid");
    if (native) await verifier(path, signing);
  }
}

export async function verifyAppServicePayload(
  root: string,
  expectedManifestHash?: string,
  expectedPayloadHash?: string,
): Promise<AppServiceManifest> {
  await safeDirectory(root, false);
  const bytes = await readBoundedBytes(
    join(root, "service-manifest.json"),
    MANIFEST_LIMIT,
  );
  if (
    expectedManifestHash !== undefined &&
    hash(bytes) !== expectedManifestHash
  )
    throw new TypeError("App service manifest identity changed");
  const value = record(JSON.parse(bytes.toString("utf8")) as unknown);
  strict(value, [
    "schema_version",
    "platform",
    "architecture",
    "worker_version",
    "api_version",
    "entries",
    "payload_sha256",
  ]);
  if (
    value.schema_version !== 1 ||
    value.platform !== "darwin" ||
    value.architecture !== "arm64" ||
    value.api_version !== 1 ||
    !IDENTIFIER.test(String(value.worker_version)) ||
    !Array.isArray(value.entries) ||
    value.entries.length < 5 ||
    value.entries.length > 50_000 ||
    !HASH.test(String(value.payload_sha256))
  )
    throw new TypeError("App service manifest is invalid");
  const actual: MacReleaseEntry[] = [];
  await serviceInventory(root, join(root, "app"), actual);
  actual.sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
  if (
    JSON.stringify(actual) !== JSON.stringify(value.entries) ||
    hash(Buffer.from(JSON.stringify(value.entries))) !== value.payload_sha256 ||
    (expectedPayloadHash !== undefined &&
      value.payload_sha256 !== expectedPayloadHash)
  )
    throw new TypeError("App service inventory changed");
  for (const required of [
    "app/dist/src/cli/main.js",
    "app/package.json",
    "app/engine/musicmute_engine/child.py",
    "app/engine/musicmute_engine/qualification.py",
    "app/engine/musicmute_engine/capacity_benchmark.py",
  ])
    if (
      !actual.some((entry) => entry.path === required && entry.kind === "file")
    )
      throw new TypeError("App service payload is incomplete");
  return value as unknown as AppServiceManifest;
}

async function serviceInventory(
  root: string,
  directory: string,
  entries: MacReleaseEntry[],
): Promise<void> {
  await safeDirectory(directory, false);
  entries.push({
    path: relative(root, directory),
    kind: "directory",
    mode: (await lstat(directory)).mode & 0o777,
  });
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const key = relative(root, path);
    safeRelative(key);
    const info = await lstat(path);
    if (info.isDirectory()) await serviceInventory(root, path, entries);
    else if (info.isSymbolicLink()) {
      const target = await readlink(path);
      const destination = resolve(dirname(path), target);
      if (
        isAbsolute(target) ||
        !destination.startsWith(`${join(root, "app")}/`) ||
        !(await realpath(path)).startsWith(
          `${await realpath(join(root, "app"))}/`,
        )
      )
        throw new TypeError("App service link escapes payload");
      entries.push({ path: key, kind: "symlink", target });
    } else {
      if (!info.isFile() || (info.mode & 0o022) !== 0)
        throw new TypeError("App service entry is unsafe");
      entries.push({
        path: key,
        kind: "file",
        bytes: info.size,
        mode: info.mode & 0o777,
        sha256: await fileHash(path),
      });
    }
    if (entries.length > 50_000)
      throw new TypeError("App service inventory is too large");
  }
}

export async function verifyAppRuntimeBase(
  binding: AppExternalReleaseManifest,
  bootstrapPath: string,
  signatureVerifier = verifyNativeSignature,
): Promise<void> {
  const bytes = await readBoundedBytes(bootstrapPath, MANIFEST_LIMIT);
  if (hash(bytes) !== binding.base.bootstrapSha256)
    throw new TypeError("App runtime bootstrap identity changed");
  const bootstrap = parseBootstrap(
    JSON.parse(bytes.toString("utf8")) as unknown,
  );
  if (
    bootstrap.runtime.id !== binding.base.runtimeId ||
    bootstrap.runtime.archive_sha256 !== binding.base.archiveSha256
  )
    throw new TypeError("App runtime identity disagrees with binding");
  const support = binding.base.supportRoot;
  if (!support.endsWith("/Library/Application Support/MusicMuteLocal"))
    throw new TypeError("App runtime support path is invalid");
  const root = appBaseRelease(binding);
  for (const path of [
    support,
    join(support, "runtime"),
    join(support, "runtime", "releases"),
    root,
  ])
    await safeDirectory(path, true);
  const expected = new Set(bootstrap.runtime.files.map((entry) => entry.path));
  if (expected.size !== bootstrap.runtime.files.length)
    throw new TypeError("App runtime inventory has duplicates");
  const actual: string[] = [];
  const directories = new Set<string>();
  for (const path of expected) {
    let parent = dirname(path);
    while (parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  await walkBase(root, join(root, "runtime"), actual, directories);
  if (
    actual.length !== expected.size ||
    actual.some((path) => !expected.has(path))
  )
    throw new TypeError("App runtime leaf inventory changed");
  for (const entry of bootstrap.runtime.files) {
    const path = join(root, entry.path);
    const info = await lstat(path);
    if (entry.type === "symlink") {
      if (
        !info.isSymbolicLink() ||
        (await readlink(path)) !== entry.link_target ||
        !(await realpath(path)).startsWith(`${join(root, "runtime")}/`)
      )
        throw new TypeError("App runtime link changed");
    } else {
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (info.mode & 0o022) !== 0 ||
        info.size !== entry.bytes ||
        Boolean(info.mode & 0o111) !== entry.executable ||
        (await fileHash(path)) !== entry.sha256
      )
        throw new TypeError("App runtime file changed");
      if (entry.code_signed)
        await signatureVerifier(path, bootstrap.runtime.signing);
    }
  }
  const model = join(support, "models", APP_MODEL_SHA256, "Kim_Vocal_2.onnx");
  await safeDirectory(join(support, "models"), true);
  await safeDirectory(join(support, "models", APP_MODEL_SHA256), true);
  const info = await lstat(model);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== APP_MODEL_BYTES ||
    (info.mode & 0o077) !== 0 ||
    (await fileHash(model)) !== APP_MODEL_SHA256
  )
    throw new TypeError("App shared model identity changed");
}

function parseBootstrap(value: unknown): AppRuntimeBootstrap {
  const document = record(value);
  const runtime = record(document.runtime);
  const signing = record(runtime.signing);
  if (
    document.schema_version !== 1 ||
    runtime.api_version !== 1 ||
    runtime.platform !== "darwin" ||
    runtime.arch !== "arm64" ||
    !IDENTIFIER.test(String(runtime.id)) ||
    !HASH.test(String(runtime.archive_sha256)) ||
    !Array.isArray(runtime.files) ||
    runtime.files.length < 4 ||
    runtime.files.length > 50_000 ||
    !["ad_hoc", "developer_id"].includes(String(signing.mode)) ||
    (signing.mode === "developer_id" &&
      !/^[A-Z0-9]{10}$/u.test(String(signing.team_id)))
  )
    throw new TypeError("App runtime bootstrap is invalid");
  let installedBytes = 0;
  for (const raw of runtime.files) {
    const entry = record(raw);
    safeRelative(String(entry.path));
    if (
      !String(entry.path).startsWith("runtime/") ||
      !["file", "symlink"].includes(String(entry.type))
    )
      throw new TypeError("App runtime inventory entry is invalid");
    if (
      entry.type === "file" &&
      (!Number.isSafeInteger(entry.bytes) ||
        (entry.bytes as number) < 0 ||
        (entry.bytes as number) > 1_000_000_000 ||
        !HASH.test(String(entry.sha256)) ||
        typeof entry.executable !== "boolean" ||
        typeof entry.code_signed !== "boolean")
    )
      throw new TypeError("App runtime inventory file is invalid");
    if (entry.type === "file") installedBytes += entry.bytes as number;
    if (
      entry.type === "symlink" &&
      (typeof entry.link_target !== "string" || isAbsolute(entry.link_target))
    )
      throw new TypeError("App runtime inventory link is invalid");
  }
  if (!Number.isSafeInteger(installedBytes) || installedBytes > 4_000_000_000)
    throw new TypeError("App runtime expanded size is invalid");
  for (const path of [
    "runtime/runtime/node/bin/node",
    "runtime/runtime/python/bin/python3",
    "runtime/runtime/bin/ffmpeg",
    "runtime/runtime/bin/ffprobe",
  ])
    if (!runtime.files.some((entry) => record(entry).path === path))
      throw new TypeError("App runtime is incomplete");
  return value as AppRuntimeBootstrap;
}

async function walkBase(
  root: string,
  directory: string,
  leaves: string[],
  directories: Set<string>,
): Promise<void> {
  await safeDirectory(directory, false);
  if (!directories.has(relative(root, directory)))
    throw new TypeError("App runtime contains an undeclared directory");
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isDirectory()) await walkBase(root, path, leaves, directories);
    else {
      if (!info.isFile() && !info.isSymbolicLink())
        throw new TypeError("App runtime has an unsupported leaf");
      leaves.push(relative(root, path));
    }
    if (leaves.length > 50_000)
      throw new TypeError("App runtime inventory is too large");
  }
}

export function appBaseRelease(binding: AppExternalReleaseManifest): string {
  return join(
    binding.base.supportRoot,
    "runtime",
    "releases",
    binding.base.runtimeId,
  );
}

export async function resolveMacAppExecutionLayout(
  layout: MacUserLayout,
  releaseRoot?: string,
): Promise<MacUserLayout> {
  let root = releaseRoot;
  if (!root) {
    let target: string;
    try {
      target = await readlink(layout.currentLink);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const installation = await readBoundedJson(
        layout.installationStatePath,
      ).catch((missing: unknown) => {
        if ((missing as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw missing;
      });
      if (
        !installation ||
        !IDENTIFIER.test(String(installation.releaseVersion))
      )
        return layout;
      target = `releases/${String(installation.releaseVersion)}`;
    }
    if (!/^releases\/[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(target))
      throw new TypeError("Worker current pointer is unsafe");
    root = join(dirname(layout.currentLink), target);
  }
  let binding: AppExternalReleaseManifest | null;
  try {
    binding = await readAppBinding(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return layout;
    throw error;
  }
  if (!binding) return layout;
  const runtime = join(appBaseRelease(binding), "runtime", "runtime");
  return {
    ...layout,
    nodePath: join(runtime, "node", "bin", "node"),
    pythonPath: join(runtime, "python", "bin", "python3"),
    ffmpegPath: join(runtime, "bin", "ffmpeg"),
    ffprobePath: join(runtime, "bin", "ffprobe"),
    engineRoot: join(root, "app", "engine"),
    cliPath: join(root, "app", "dist", "src", "cli", "main.js"),
    modelRoot: join(binding.base.supportRoot, "models"),
  };
}

export async function stageMacAppService(
  layout: MacUserLayout,
  resources: string,
  supportRoot: string,
): Promise<{
  releaseVersion: string;
  releaseRoot: string;
  serviceId: string;
  reused: boolean;
}> {
  const materialized = await materializeAppService(
    join(resources, "worker", "service"),
    layout.temporaryRoot,
  );
  try {
    const source = materialized.root;
    const service = await verifyAppServicePayload(source);
    const serviceBytes = await readBoundedBytes(
      join(source, "service-manifest.json"),
      MANIFEST_LIMIT,
    );
    const bootstrapBytes = await readBoundedBytes(
      join(resources, "runtime-bootstrap.json"),
      MANIFEST_LIMIT,
    );
    const bootstrap = parseBootstrap(
      JSON.parse(bootstrapBytes.toString("utf8")) as unknown,
    );
    if (
      supportRoot !==
      join(layout.homeRoot, "Library", "Application Support", "MusicMuteLocal")
    )
      throw new TypeError("App support root is outside this user");
    const active = await readBoundedJson(
      join(supportRoot, "runtime", "active.json"),
      16 * 1024,
    );
    if (
      active.schema_version !== 1 ||
      active.runtime_id !== bootstrap.runtime.id ||
      active.api_version !== 1 ||
      active.archive_sha256 !== bootstrap.runtime.archive_sha256 ||
      active.release_path !== `releases/${bootstrap.runtime.id}`
    )
      throw new TypeError(
        "App runtime must be prepared before worker installation",
      );
    const serviceId = hash(Buffer.concat([serviceBytes, bootstrapBytes]));
    const releaseVersion = appServiceReleaseVersion(
      service.worker_version,
      serviceId,
    );
    const binding: AppExternalReleaseManifest = {
      schemaVersion: 2,
      platform: "darwin",
      architecture: "arm64",
      distribution: "app-external",
      releaseVersion,
      serviceId,
      serviceManifestSha256: hash(serviceBytes),
      payloadSha256: service.payload_sha256,
      base: {
        supportRoot,
        runtimeId: bootstrap.runtime.id,
        archiveSha256: bootstrap.runtime.archive_sha256,
        bootstrapSha256: hash(bootstrapBytes),
      },
      model: { sha256: APP_MODEL_SHA256, bytes: APP_MODEL_BYTES },
    };
    const destination = join(layout.releasesRoot, releaseVersion);
    await mkdir(layout.releasesRoot, { recursive: true, mode: 0o700 });
    try {
      const existing = await verifyManagedMacRelease(destination);
      if (JSON.stringify(existing) !== JSON.stringify(binding))
        throw new TypeError("App worker release is immutable");
      return {
        releaseVersion,
        releaseRoot: destination,
        serviceId,
        reused: true,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = join(
      layout.releasesRoot,
      `.${releaseVersion}.${randomUUID()}.tmp`,
    );
    try {
      await cp(source, temporary, {
        recursive: true,
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      });
      await chmod(temporary, 0o700);
      await privateWrite(
        join(temporary, "runtime-bootstrap.json"),
        bootstrapBytes,
      );
      await privateWrite(
        join(temporary, "release-manifest.json"),
        Buffer.from(`${JSON.stringify(binding)}\n`),
      );
      await verifyManagedMacRelease(temporary);
      await rename(temporary, destination);
      return {
        releaseVersion,
        releaseRoot: destination,
        serviceId,
        reused: false,
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  } finally {
    await materialized.close();
  }
}

/** Immutable metadata only: checks do not stage code or publish consumer refs. */
export async function macAppServiceCandidateIdentity(
  resources: string,
): Promise<{ releaseVersion: string; serviceId: string }> {
  const serviceBytes = await readBoundedBytes(
    join(resources, "worker", "service", "service-manifest.json"),
    MANIFEST_LIMIT,
  );
  const service = record(JSON.parse(serviceBytes.toString("utf8")) as unknown);
  if (
    service.schema_version !== 1 ||
    service.api_version !== 1 ||
    service.platform !== "darwin" ||
    service.architecture !== "arm64" ||
    !IDENTIFIER.test(String(service.worker_version)) ||
    !Array.isArray(service.entries) ||
    !HASH.test(String(service.payload_sha256)) ||
    hash(Buffer.from(JSON.stringify(service.entries))) !==
      service.payload_sha256
  )
    throw new TypeError("App service update identity is invalid");
  const bootstrapBytes = await readBoundedBytes(
    join(resources, "runtime-bootstrap.json"),
    MANIFEST_LIMIT,
  );
  parseBootstrap(JSON.parse(bootstrapBytes.toString("utf8")) as unknown);
  const serviceId = hash(Buffer.concat([serviceBytes, bootstrapBytes]));
  return {
    releaseVersion: appServiceReleaseVersion(
      String(service.worker_version),
      serviceId,
    ),
    serviceId,
  };
}

function appServiceReleaseVersion(workerVersion: string, serviceId: string) {
  // Delivery policy belongs to the immutable bootstrap. Older schema2 names
  // remain valid; new releases cover the complete binding identity.
  return `${workerVersion}-app.${serviceId.slice(0, 24)}`;
}

async function materializeAppService(
  source: string,
  temporaryRoot: string,
): Promise<{ root: string; close(): Promise<void> }> {
  const expanded = await lstat(join(source, "app")).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (expanded) {
    if (!expanded.isDirectory() || expanded.isSymbolicLink())
      throw new TypeError("App service payload is unsafe");
    return { root: source, close: async () => undefined };
  }
  const descriptor = await readBoundedJson(join(source, "archive.json"), 4096);
  strict(descriptor, ["schema_version", "filename", "bytes", "sha256"]);
  if (
    descriptor.schema_version !== 1 ||
    descriptor.filename !== "service-payload.zip" ||
    !Number.isSafeInteger(descriptor.bytes) ||
    (descriptor.bytes as number) < 1 ||
    (descriptor.bytes as number) > 128 * 1024 * 1024 ||
    !HASH.test(String(descriptor.sha256))
  )
    throw new TypeError("App service archive descriptor is invalid");
  const archive = join(source, "service-payload.zip");
  const info = await lstat(archive);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== descriptor.bytes ||
    (await fileHash(archive)) !== descriptor.sha256
  )
    throw new TypeError("App service archive identity changed");
  const manifest = await readBoundedJson(
    join(source, "service-manifest.json"),
    MANIFEST_LIMIT,
  );
  if (
    !Array.isArray(manifest.entries) ||
    manifest.entries.length < 5 ||
    manifest.entries.length > 50_000
  )
    throw new TypeError("App service archive inventory is invalid");
  const expected = new Map<string, string>();
  let expandedBytes = 0;
  for (const raw of manifest.entries) {
    const entry = record(raw);
    const path = String(entry.path);
    safeRelative(path);
    if (
      (!path.startsWith("app/") && path !== "app") ||
      !["file", "directory", "symlink"].includes(String(entry.kind)) ||
      expected.has(path)
    )
      throw new TypeError("App service archive path is invalid");
    expected.set(path, String(entry.kind));
    if (entry.kind === "file") {
      if (!Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0)
        throw new TypeError("App service archive size is invalid");
      expandedBytes += entry.bytes as number;
    }
  }
  if (!Number.isSafeInteger(expandedBytes) || expandedBytes > 512 * 1024 * 1024)
    throw new TypeError("App service archive is too large");
  for (const path of expected.keys()) {
    let parent = dirname(path);
    while (parent !== ".") {
      if (expected.get(parent) !== "directory")
        throw new TypeError("App service archive traverses a link");
      parent = dirname(parent);
    }
  }
  const listing = await execute("/usr/bin/unzip", ["-Z1", archive], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const paths = listing.stdout
    .trim()
    .split("\n")
    .map((path) => path.replace(/\/$/u, ""));
  if (
    paths.length !== expected.size ||
    new Set(paths).size !== paths.length ||
    paths.some((path) => !expected.has(path))
  )
    throw new TypeError("App service archive contains undeclared paths");
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  await safeDirectory(temporaryRoot, true);
  const root = join(temporaryRoot, `app-service-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  try {
    await execute("/usr/bin/unzip", ["-q", archive, "-d", root], {
      timeout: 60_000,
      maxBuffer: 64 * 1024,
    });
    await cp(
      join(source, "service-manifest.json"),
      join(root, "service-manifest.json"),
      { force: false, errorOnExist: true },
    );
    await verifyAppServicePayload(root);
    return { root, close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** Permanent references protect immutable bases after the short setup lease ends. */
export async function publishMacAppRuntimeReference(
  layout: MacUserLayout,
  releaseRoot: string,
): Promise<void> {
  const binding = await readAppBinding(releaseRoot);
  if (!binding) return;
  const publish = async () => {
    await verifyManagedMacRelease(releaseRoot);
    const root = join(binding.base.supportRoot, "runtime", "consumers");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await safeDirectory(root, true);
    await privateWrite(
      join(root, `${binding.serviceId}.json`),
      Buffer.from(
        `${JSON.stringify({ schema_version: 1, consumer: "macos-worker", runtime_id: binding.base.runtimeId, archive_sha256: binding.base.archiveSha256, worker_root: layout.installRoot, service_id: binding.serviceId })}\n`,
      ),
    );
  };
  if (process.platform === "darwin")
    await withDarwinSharedFileLock(
      join(binding.base.supportRoot, "runtime", "bootstrap.lock"),
      publish,
    );
  else await publish();
}

/** Caller has stopped the fleet and fenced personal admission. Validate all refs before removing any. */
export async function reconcileMacAppRuntimeReferences(
  layout: MacUserLayout,
  purge = false,
): Promise<void> {
  const support = join(
    layout.homeRoot,
    "Library",
    "Application Support",
    "MusicMuteLocal",
  );
  const directory = join(support, "runtime", "consumers");
  const present = await lstat(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!present) return;
  const reconcile = async () => {
    await safeDirectory(layout.installRoot, true);
    await safeDirectory(directory, true);
    const names = await readdir(directory);
    if (names.length > 1000)
      throw new TypeError("Runtime consumer inventory is too large");
    const references: Array<{ path: string; id: string }> = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name))
        throw new TypeError("Runtime consumer reference is invalid");
      const path = join(directory, name);
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0 ||
        info.size < 2 ||
        info.size > 4096
      )
        throw new TypeError("Runtime consumer reference is unsafe");
      const value = await readBoundedJson(path, 4096);
      strict(value, [
        "schema_version",
        "consumer",
        "runtime_id",
        "archive_sha256",
        "worker_root",
        "service_id",
      ]);
      if (
        Object.keys(value).length !== 6 ||
        value.schema_version !== 1 ||
        value.consumer !== "macos-worker" ||
        value.worker_root !== layout.installRoot ||
        typeof value.runtime_id !== "string" ||
        !IDENTIFIER.test(value.runtime_id) ||
        typeof value.archive_sha256 !== "string" ||
        !HASH.test(value.archive_sha256) ||
        value.service_id !== name.slice(0, -5)
      )
        throw new TypeError("Runtime consumer reference is foreign or invalid");
      references.push({ path, id: String(value.service_id) });
    }
    const retained = new Set<string>();
    if (!purge)
      for (const entry of await readdir(layout.releasesRoot, {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory() || !IDENTIFIER.test(entry.name)) continue;
        const binding = await readAppBinding(
          join(layout.releasesRoot, entry.name),
        );
        if (binding) retained.add(binding.serviceId);
      }
    await assertMacPreparedRuntimeUnused(layout);
    for (const reference of references)
      if (purge || !retained.has(reference.id)) await rm(reference.path);
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  if (process.platform === "darwin")
    await withDarwinSharedFileLock(
      join(support, "runtime", "bootstrap.lock"),
      reconcile,
    );
  else await reconcile();
}

/** No argv or credentials are read. Historical unregistered personal engines fail closed. */
export async function assertMacPreparedRuntimeUnused(
  layout: MacUserLayout,
): Promise<void> {
  const releases = join(
    layout.homeRoot,
    "Library",
    "Application Support",
    "MusicMuteLocal",
    "runtime",
    "releases",
  );
  const exists = await lstat(releases).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!exists) return;
  await safeDirectory(releases, true);
  const names = await readdir(releases);
  if (names.length > 1000)
    throw new TypeError("Prepared runtime inventory is too large");
  const pythons = new Set<string>();
  for (const name of names) {
    if (!IDENTIFIER.test(name)) continue;
    const root = join(releases, name);
    await safeDirectory(root, true);
    const python = join(root, "runtime", "runtime", "python", "bin", "python3");
    pythons.add(python);
    const actual = await realpath(python).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (actual !== null) {
      if (!actual.startsWith(`${root}/`))
        throw new TypeError("Prepared runtime interpreter escapes its release");
      pythons.add(actual);
    }
  }
  if (process.platform !== "darwin" || pythons.size === 0) return;
  const snapshot = await execute("/bin/ps", ["-axo", "uid=,pid=,comm="], {
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  for (const line of snapshot.stdout.split("\n")) {
    const parsed = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (
      parsed &&
      Number(parsed[1]) === process.getuid?.() &&
      pythons.has(parsed[3]!)
    )
      throw new AppControlError("WORKER_PERSONAL_BUSY");
  }
}

export async function verifyMacAppServiceConfiguration(
  layout: MacUserLayout,
  config: {
    engineRoot: string;
    pythonPath: string;
    ffmpegPath: string;
    ffprobePath: string;
    modelCacheRoot: string;
  },
): Promise<void> {
  const resolved = await resolveMacAppExecutionLayout(layout);
  const releaseRoot = dirname(dirname(resolved.engineRoot));
  const binding = await readAppBinding(releaseRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!binding) return;
  if (
    config.engineRoot !== resolved.engineRoot ||
    config.pythonPath !== resolved.pythonPath ||
    config.ffmpegPath !== resolved.ffmpegPath ||
    config.ffprobePath !== resolved.ffprobePath ||
    config.modelCacheRoot !== resolved.modelRoot
  )
    throw new TypeError(
      "App worker configuration does not match its immutable binding",
    );
  await publishMacAppRuntimeReference(layout, releaseRoot);
}

export async function privateWrite(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}
export async function readBoundedJson(
  path: string,
  limit = 64 * 1024,
): Promise<Record<string, unknown>> {
  return record(
    JSON.parse(
      (await readBoundedBytes(path, limit)).toString("utf8"),
    ) as unknown,
  );
}
async function readBoundedBytes(path: string, limit: number): Promise<Buffer> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > limit ||
    (info.mode & 0o022) !== 0
  )
    throw new TypeError("App worker metadata is unsafe");
  return await readFile(path);
}
async function safeDirectory(
  path: string,
  privateDirectory: boolean,
): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & (privateDirectory ? 0o077 : 0o022)) !== 0 ||
    (await realpath(path)) !== resolve(path) ||
    (privateDirectory && info.uid !== process.getuid?.())
  )
    throw new TypeError("App worker directory is unsafe");
}
function safeRelative(path: string): void {
  if (
    !path ||
    path.length > 4096 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new TypeError("App worker inventory path is unsafe");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("App worker metadata must be an object");
  return value as Record<string, unknown>;
}
function strict(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new TypeError("App worker metadata has unknown fields");
}
function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
async function fileHash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
async function verifyNativeSignature(
  path: string,
  signing: AppRuntimeBootstrap["runtime"]["signing"],
): Promise<void> {
  const args = ["--verify", "--strict", "--all-architectures"];
  if (signing.mode === "developer_id")
    args.push(
      "--test-requirement",
      `=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${signing.team_id}"`,
    );
  args.push(path);
  try {
    await execute("/usr/bin/codesign", args, {
      timeout: 60_000,
      maxBuffer: 128 * 1024,
    });
    const detail = await execute(
      "/usr/bin/codesign",
      ["-d", "--verbose=4", path],
      { timeout: 30_000, maxBuffer: 128 * 1024 },
    );
    const text = detail.stdout + detail.stderr;
    if (
      !/flags=.*\bruntime\b/u.test(text) ||
      (signing.mode === "developer_id" &&
        (!text.includes(`TeamIdentifier=${signing.team_id}`) ||
          !text.includes("Authority=Developer ID Application:"))) ||
      (signing.mode === "ad_hoc" && !text.includes("Signature=adhoc"))
    )
      throw new Error();
  } catch {
    throw new TypeError("App runtime native signature is invalid");
  }
}

import {
  DarwinFileLockBusyError,
  withDarwinFileLock,
} from "../../../worker/src/runtime/darwin-file-lock.js";
import {
  RuntimeResourceGate,
  RuntimeResourceLimitError,
  type RuntimeResourceProbe,
} from "../../../worker/src/runtime/resource-limits.js";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  inspectLocalReadiness,
  inspectYouTubeReadiness,
  LocalSetupError,
  type LocalConfig,
  type ReadinessProbeEvent,
} from "./config.js";
import {
  MVP_MAX_DURATION_SECONDS,
  NATIVE_HOST,
  VERSION,
} from "../shared/protocol.js";
import { LocalProcessingError } from "./local-provider.js";
import {
  DOWNLOADER_BOOTSTRAP,
  DOWNLOADER_WHEELS,
} from "./downloader-bundle.js";

export const MODEL = Object.freeze({
  filename: "Kim_Vocal_2.onnx",
  bytes: 66_759_214,
  sha256: "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b",
  url: "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx",
});
export interface AppProgress {
  phase: string;
  percent: number;
  label: string;
}
export interface AppStatus {
  ready: boolean;
  platform: "darwin";
  arch: "arm64";
  version: string;
  runtime_ready: boolean;
  model_ready: boolean;
  extension_registered: boolean;
  extension_path: string;
  model_bytes: number;
  cache_bytes: number;
  diagnostic_mode: "LOCAL_ONLY";
  max_duration_seconds: number;
  downloader_ready?: boolean;
  javascript_ready?: boolean;
  token_provider_ready?: boolean;
  youtube_ready?: boolean;
  local_processing_ready?: boolean;
  components?: {
    component:
      | "engine"
      | "model"
      | "downloader"
      | "javascript"
      | "token_provider"
      | "chrome";
    state: "ready" | "missing" | "invalid";
    error_code?: string;
  }[];
}
export function modelPath(config: LocalConfig): string {
  return join(config.models_root, MODEL.sha256, MODEL.filename);
}
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    info.uid !== process.getuid?.()
  )
    throw new LocalSetupError("LOCAL_DIRECTORY_NOT_PRIVATE");
}
async function safeFile(
  path: string,
  maxBytes: number,
  bundled = false,
): Promise<Buffer> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > maxBytes ||
    (bundled ? Boolean(info.mode & 0o022) : info.uid !== process.getuid?.())
  )
    throw new LocalSetupError("UNSAFE_SETUP_FILE");
  return readFile(path);
}
export async function verifyModel(config: LocalConfig): Promise<boolean> {
  try {
    const path = modelPath(config);
    const information = await lstat(path);
    if (
      !information.isFile() ||
      information.isSymbolicLink() ||
      information.nlink !== 1 ||
      information.size !== MODEL.bytes ||
      information.mode & 0o077
    )
      return false;
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    return digest.digest("hex") === MODEL.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export async function extensionOrigin(resources: string): Promise<string> {
  const bytes = await safeFile(
    join(resources, "extension/manifest.json"),
    32 * 1024,
    true,
  );
  const manifest = JSON.parse(bytes.toString("utf8")) as Record<
    string,
    unknown
  >;
  if (
    typeof manifest.key !== "string" ||
    !/^[A-Za-z0-9+/=]+$/.test(manifest.key)
  )
    throw new LocalSetupError("EXTENSION_MANIFEST_KEY_INVALID");
  const key = Buffer.from(manifest.key, "base64");
  if (key.length < 128 || key.length > 4096)
    throw new LocalSetupError("EXTENSION_MANIFEST_KEY_INVALID");
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  const id = [...hash]
    .map((hex) => String.fromCharCode(97 + Number.parseInt(hex, 16)))
    .join("");
  return `chrome-extension://${id}/`;
}
export function registrationPaths(
  config: LocalConfig,
  userHome = homedir(),
): { launcher: string; manifest: string } {
  return {
    launcher: join(config.root, "native-launcher.sh"),
    manifest: join(
      userHome,
      `Library/Application Support/Google/Chrome/NativeMessagingHosts/${NATIVE_HOST}.json`,
    ),
  };
}
const LAUNCHER_MARKER = "# MusicMute Local companion launcher v1";
export function launcherContents(
  config: LocalConfig,
  userHome = homedir(),
): string {
  if (!config.app_resources)
    throw new LocalSetupError("APP_RESOURCES_REQUIRED");
  const quote = (value: string): string =>
    `'${value.replaceAll("'", "'\\''")}'`;
  const executable = join(
    dirname(config.app_resources),
    "MacOS",
    "MusicMuteLocal",
  );
  return [
    "#!/bin/sh",
    LAUNCHER_MARKER,
    `exec /usr/bin/env -i HOME=${quote(userHome)} PATH='/usr/bin:/bin' LANG='en_US.UTF-8' ${quote(executable)} --native-host "$@"`,
    "",
  ].join("\n");
}
async function atomicOwnedWrite(
  path: string,
  contents: string,
  mode: number,
  signal?: AbortSignal,
): Promise<void> {
  const temporary = join(dirname(path), `.musicmute-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    signal?.throwIfAborted();
    await rename(temporary, path);
    await chmod(path, mode);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export async function registerNativeHost(
  config: LocalConfig,
  userHome = homedir(),
): Promise<void> {
  const resources = config.app_resources;
  if (!resources) throw new LocalSetupError("APP_RESOURCES_REQUIRED");
  await privateDirectory(config.root);
  const paths = registrationPaths(config, userHome);
  await mkdir(dirname(paths.manifest), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(paths.manifest));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o022)
    throw new LocalSetupError("UNSAFE_NATIVE_REGISTRATION_DIRECTORY");
  const origin = await extensionOrigin(resources);
  let previous: Record<string, unknown> | undefined;
  try {
    previous = JSON.parse(
      (await safeFile(paths.manifest, 16 * 1024)).toString("utf8"),
    ) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new LocalSetupError("FOREIGN_NATIVE_REGISTRATION_EXISTS");
  }
  if (previous) {
    const origins = previous.allowed_origins;
    const ownDevelopment = join(
      userHome,
      "Library/Application Support/MusicMuteLocalMvp/native-launcher.sh",
    );
    if (
      previous.name !== NATIVE_HOST ||
      previous.type !== "stdio" ||
      !Array.isArray(origins) ||
      origins.length !== 1 ||
      origins[0] !== origin ||
      (previous.path !== paths.launcher && previous.path !== ownDevelopment)
    )
      throw new LocalSetupError("FOREIGN_NATIVE_REGISTRATION_EXISTS");
    try {
      const priorLauncher = (
        await safeFile(String(previous.path), 16 * 1024)
      ).toString("utf8");
      const expectedMarker =
        previous.path === ownDevelopment
          ? "# MusicMute Local MVP development launcher"
          : LAUNCHER_MARKER;
      if (!priorLauncher.includes(expectedMarker))
        throw new LocalSetupError("FOREIGN_NATIVE_LAUNCHER_EXISTS");
    } catch (error) {
      // Removing the app/helper can leave Chrome's exact owned manifest behind.
      // Recreate an absent launcher; existing unsafe or foreign files still fail.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    const existing = (await safeFile(paths.launcher, 16 * 1024)).toString(
      "utf8",
    );
    if (!existing.includes(LAUNCHER_MARKER))
      throw new LocalSetupError("FOREIGN_NATIVE_LAUNCHER_EXISTS");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicOwnedWrite(
    paths.launcher,
    launcherContents(config, userHome),
    0o700,
  );
  await atomicOwnedWrite(
    paths.manifest,
    `${JSON.stringify({ name: NATIVE_HOST, description: "MusicMute local Apple Silicon companion", path: paths.launcher, type: "stdio", allowed_origins: [origin] }, null, 2)}\n`,
    0o600,
  );
}

function within(root: string, path: string): boolean {
  return resolve(path).startsWith(`${resolve(root)}${sep}`);
}

/** Only inspect the installed entry's metadata; Prepare/Check own byte audits. */
async function installedEntryReady(
  config: LocalConfig,
  path: string,
  root: string,
  options: { directory?: boolean; executable?: boolean; bytes?: number } = {},
): Promise<boolean> {
  try {
    if (!isAbsolute(path) || !isAbsolute(root) || !within(root, path))
      return false;
    const named = await lstat(path);
    if (named.isSymbolicLink() && !options.executable) return false;
    const resolvedRoot = await realpath(root);
    const resolved = await realpath(path);
    if (!within(resolvedRoot, resolved)) return false;
    const info = await lstat(resolved);
    if (
      (options.directory ? !info.isDirectory() : !info.isFile()) ||
      info.mode & 0o022 ||
      (within(config.root, resolved) && info.uid !== process.getuid?.()) ||
      (!options.directory &&
        (info.nlink !== 1 ||
          info.size <= 0 ||
          (options.bytes !== undefined && info.size !== options.bytes))) ||
      (options.executable && !(info.mode & 0o111)) ||
      !(info.mode & 0o444)
    )
      return false;
    await access(
      resolved,
      constants.R_OK |
        (options.directory || options.executable ? constants.X_OK : 0),
    );
    return true;
  } catch {
    return false;
  }
}

async function installedModelReady(config: LocalConfig): Promise<boolean> {
  try {
    const path = modelPath(config);
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      !(info.mode & 0o400) ||
      info.size !== MODEL.bytes ||
      !within(await realpath(config.models_root), await realpath(path))
    )
      return false;
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const SETUP_COMPONENTS = [
  "engine",
  "model",
  "downloader",
  "javascript",
  "token_provider",
] as const;
type SetupComponent = (typeof SETUP_COMPONENTS)[number];
export type SetupReadiness = Partial<Record<SetupComponent, boolean>> & {
  errors: Partial<Record<SetupComponent, string>>;
};

export async function setupReadinessIdentity(
  config: LocalConfig,
): Promise<string> {
  const app = await lstat(config.app_resources!);
  // App replacement changes this cheap stamp even when it reuses the runtime.
  return JSON.stringify([
    config.app_resources,
    app.dev,
    app.ino,
    app.mtimeMs,
    app.ctimeMs,
    config.runtime_id ?? null,
    config.runtime_root ?? null,
    VERSION,
  ]);
}

async function savedSetupReadiness(
  config: LocalConfig,
): Promise<SetupReadiness | undefined> {
  try {
    const path = join(config.root, "setup-readiness-v1.json");
    if ((await lstat(path)).mode & 0o077) return;
    const parsed: unknown = JSON.parse(
      (await safeFile(path, 16 * 1024)).toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const raw = parsed as Record<string, unknown>;
    if (
      raw.schema_version !== 1 ||
      raw.identity !== (await setupReadinessIdentity(config)) ||
      !raw.errors ||
      typeof raw.errors !== "object" ||
      Array.isArray(raw.errors)
    )
      return;
    const readiness: SetupReadiness = { errors: {} };
    for (const component of SETUP_COMPONENTS) {
      const ready = raw[component];
      if (ready !== undefined) {
        if (typeof ready !== "boolean") return;
        readiness[component] = ready;
      }
      const code = (raw.errors as Record<string, unknown>)[component];
      if (code !== undefined) {
        if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{1,79}$/.test(code))
          return;
        readiness.errors[component] = code;
      }
    }
    return readiness;
  } catch {
    // Missing or stale setup evidence never starts probes during ordinary status.
    return;
  }
}

async function saveSetupReadiness(
  config: LocalConfig,
  readiness: SetupReadiness,
  identity?: string,
  signal?: AbortSignal,
): Promise<void> {
  const path = join(config.root, "setup-readiness-v1.json");
  try {
    await safeFile(path, 16 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicOwnedWrite(
    path,
    `${JSON.stringify({ schema_version: 1, identity: identity ?? (await setupReadinessIdentity(config)), ...readiness })}\n`,
    0o600,
    signal,
  );
}

/** A completed manual check changes only components it actually diagnosed. */
export async function updateSetupReadiness(
  config: LocalConfig,
  identity: string,
  update: SetupReadiness,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || (await setupReadinessIdentity(config)) !== identity)
    return;
  const previous = await savedSetupReadiness(config);
  const next: SetupReadiness = {
    ...previous,
    ...update,
    errors: { ...previous?.errors },
  };
  for (const component of SETUP_COMPONENTS) {
    if (update[component] !== undefined) {
      delete next.errors[component];
      if (update.errors[component])
        next.errors[component] = update.errors[component];
    }
  }
  if (signal.aborted) return;
  await saveSetupReadiness(config, next, identity, signal);
}

export async function inspectAppStatus(
  config: LocalConfig,
  userHome = homedir(),
): Promise<AppStatus> {
  if (!config.app_resources)
    throw new LocalSetupError("APP_RESOURCES_REQUIRED");
  // This is connection/installed-metadata readiness, not a new integrity audit.
  const resources = config.app_resources;
  const runtime = config.runtime_root ?? join(resources, "runtime");
  const executableReady = (path: string): Promise<boolean> =>
    installedEntryReady(config, path, runtime, { executable: true });
  const runtimeEntries = await Promise.all([
    ...[
      config.python_path,
      config.node_path,
      config.ffmpeg_path,
      config.ffprobe_path,
    ].map(executableReady),
    installedEntryReady(config, config.runner_path, resources),
    installedEntryReady(
      config,
      config.engine_root,
      within(resources, config.engine_root) ? resources : runtime,
      { directory: true },
    ),
  ]);
  const saved = await savedSetupReadiness(config);
  const runtimeReady = runtimeEntries.every(Boolean) && (saved?.engine ?? true);
  let downloaderReady = await executableReady(config.yt_dlp_path);
  if (config.downloader_bundle_root) {
    const bundle = config.downloader_bundle_root;
    const bootstrap =
      config.downloader_bootstrap_path ?? join(bundle, DOWNLOADER_BOOTSTRAP);
    const entries = await Promise.all([
      installedEntryReady(config, bundle, runtime, { directory: true }),
      installedEntryReady(config, join(bundle, "identity.json"), bundle),
      installedEntryReady(
        config,
        bootstrap,
        config.downloader_bootstrap_path ? resources : bundle,
      ),
      ...DOWNLOADER_WHEELS.map((wheel) =>
        installedEntryReady(config, join(bundle, wheel.file), bundle, {
          bytes: wheel.bytes,
        }),
      ),
    ]);
    downloaderReady &&= entries.every(Boolean);
  }
  let javascriptReady = false,
    tokenProviderReady = false;
  if (config.youtube_runtime_root) {
    const youtube = config.youtube_runtime_root;
    javascriptReady = await installedEntryReady(
      config,
      config.js_runtime_path,
      youtube,
      { executable: true },
    );
    const entries = await Promise.all([
      installedEntryReady(config, youtube, runtime, { directory: true }),
      ...[
        "identity.json",
        "provider/src/generate_once.ts",
        "provider/src/session_manager.ts",
        "provider/deno.json",
        "provider/deno.lock",
      ].map((path) =>
        installedEntryReady(config, join(youtube, path), youtube),
      ),
      installedEntryReady(
        config,
        join(youtube, "provider/node_modules"),
        youtube,
        {
          directory: true,
        },
      ),
    ]);
    tokenProviderReady = entries.every(Boolean);
  }
  downloaderReady &&= saved?.downloader ?? true;
  javascriptReady &&= saved?.javascript ?? true;
  tokenProviderReady &&= saved?.token_provider ?? true;
  const componentErrors = new Map<string, string>(
    Object.entries(saved?.errors ?? {}),
  );
  const modelReady =
    (await installedModelReady(config)) && (saved?.model ?? true);
  let registered = false;
  try {
    const paths = registrationPaths(config, userHome);
    const manifest = JSON.parse(
      (await safeFile(paths.manifest, 16 * 1024)).toString("utf8"),
    ) as Record<string, unknown>;
    const launcher = (await safeFile(paths.launcher, 16 * 1024)).toString(
      "utf8",
    );
    registered =
      manifest.name === NATIVE_HOST &&
      manifest.path === paths.launcher &&
      manifest.type === "stdio" &&
      JSON.stringify(manifest.allowed_origins) ===
        JSON.stringify([await extensionOrigin(config.app_resources)]) &&
      launcher === launcherContents(config, userHome);
  } catch {
    /* Setup gives a specific error; quick status remains actionable. */
  }
  let cacheBytes = 0;
  try {
    for (const name of (await readdir(join(config.cache_root, "vocals"))).slice(
      0,
      1000,
    )) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const directory = join(config.cache_root, "vocals", name);
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      for (const filename of ["vocals.mp3", "result.json"]) {
        try {
          const item = await lstat(join(directory, filename));
          if (item.isFile() && !item.isSymbolicLink()) cacheBytes += item.size;
        } catch {
          /* In-progress eviction. */
        }
      }
    }
  } catch {
    /* No cache is normal before first use. */
  }
  return {
    ready: runtimeReady && modelReady && registered,
    platform: "darwin",
    arch: "arm64",
    version: VERSION,
    runtime_ready: runtimeReady,
    local_processing_ready: runtimeReady && modelReady,
    downloader_ready: downloaderReady,
    javascript_ready: javascriptReady,
    token_provider_ready: tokenProviderReady,
    youtube_ready:
      downloaderReady &&
      javascriptReady &&
      tokenProviderReady &&
      runtimeReady &&
      modelReady &&
      registered,
    components: (
      [
        ["engine", runtimeReady, "DEV_RUNTIME_INCOMPLETE"],
        ["model", modelReady, "MODEL_CACHE_INVALID"],
        ["downloader", downloaderReady, "YT_DLP_IDENTITY_INVALID"],
        ["javascript", javascriptReady, "DENO_MISSING"],
        ["token_provider", tokenProviderReady, "PO_TOKEN_PROVIDER_INVALID"],
        ["chrome", registered, "NATIVE_REGISTRATION_MISSING"],
      ] as const
    ).map(([component, ready, error_code]) => ({
      component,
      state: ready ? "ready" : "invalid",
      ...(ready
        ? {}
        : { error_code: componentErrors.get(component) ?? error_code }),
    })),
    model_ready: modelReady,
    extension_registered: registered,
    extension_path: join(config.app_resources, "extension"),
    model_bytes: modelReady ? MODEL.bytes : 0,
    cache_bytes: cacheBytes,
    diagnostic_mode: "LOCAL_ONLY",
    max_duration_seconds: MVP_MAX_DURATION_SECONDS,
  };
}
export async function downloadModel(
  config: LocalConfig,
  signal: AbortSignal,
  progress: (event: AppProgress) => void,
  resourceProbe?: RuntimeResourceProbe,
): Promise<void> {
  if (await verifyModel(config)) return;
  await privateDirectory(config.models_root);
  const directory = join(config.models_root, MODEL.sha256);
  await privateDirectory(directory);
  const destination = modelPath(config);
  try {
    await lstat(destination);
    throw new LocalSetupError("MODEL_CACHE_INVALID");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (signal.aborted) throw new LocalSetupError("CANCELLED");
  try {
    await new RuntimeResourceGate(directory, resourceProbe).assertAvailable(
      MODEL.bytes,
    );
  } catch (error) {
    throw new LocalSetupError(
      error instanceof RuntimeResourceLimitError && error.resource === "disk"
        ? "DISK_SPACE_LOW"
        : "MEMORY_LOW",
    );
  }
  const path = join(directory, `.download-${randomUUID()}`);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const deadline = setTimeout(abort, 300_000);
  let inactivity = setTimeout(abort, 30_000);
  let handle: FileHandle | undefined;
  try {
    let url: string = MODEL.url;
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 2; redirects++) {
      const parsed = new URL(url);
      if (
        parsed.protocol !== "https:" ||
        !["github.com", "release-assets.githubusercontent.com"].includes(
          parsed.hostname,
        ) ||
        parsed.username ||
        parsed.password
      )
        throw new LocalSetupError("MODEL_SOURCE_INVALID");
      response = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "MusicMuteLocal/0.1" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects === 2)
          throw new LocalSetupError("MODEL_REDIRECT_INVALID");
        url = new URL(location, url).href;
        continue;
      }
      break;
    }
    if (!response?.ok || !response.body)
      throw new LocalSetupError("MODEL_DOWNLOAD_FAILED");
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) !== MODEL.bytes) {
      await response.body.cancel();
      throw new LocalSetupError("MODEL_SIZE_INVALID");
    }
    handle = await open(path, "wx", 0o600);
    const hash = createHash("sha256");
    const reader = response.body.getReader();
    let bytes = 0;
    let lastPercent = -1;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(inactivity);
      inactivity = setTimeout(abort, 30_000);
      bytes += value.byteLength;
      if (bytes > MODEL.bytes) {
        controller.abort();
        throw new LocalSetupError("MODEL_SIZE_INVALID");
      }
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength)
        offset += (await handle.write(value, offset, value.byteLength - offset))
          .bytesWritten;
      const percent = Math.floor((bytes / MODEL.bytes) * 55);
      if (percent !== lastPercent) {
        progress({
          phase: "model_download",
          percent,
          label: "Downloading the voice model",
        });
        lastPercent = percent;
      }
    }
    if (bytes !== MODEL.bytes || hash.digest("hex") !== MODEL.sha256)
      throw new LocalSetupError("MODEL_CHECKSUM_INVALID");
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Exclusive publication cannot replace an existing model or unrelated file.
    controller.signal.throwIfAborted();
    await link(path, destination);
    await unlink(path);
  } catch (error) {
    if (signal.aborted) throw new LocalSetupError("CANCELLED");
    if (error instanceof LocalSetupError) throw error;
    if (controller.signal.aborted)
      throw new LocalSetupError("MODEL_DOWNLOAD_TIMEOUT");
    throw new LocalSetupError("MODEL_DOWNLOAD_FAILED");
  } finally {
    clearTimeout(deadline);
    clearTimeout(inactivity);
    signal.removeEventListener("abort", abort);
    await handle?.close();
    await unlink(path).catch(() => {});
  }
}
export async function withSetupLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  await privateDirectory(root);
  try {
    return await withDarwinFileLock(join(root, "setup.lock"), operation);
  } catch (error) {
    if (error instanceof DarwinFileLockBusyError)
      throw new LocalSetupError("SETUP_BUSY");
    throw error;
  }
}
export async function setupApp(
  config: LocalConfig,
  signal: AbortSignal,
  progress: (event: AppProgress) => void,
  observeReadiness?: (event: ReadinessProbeEvent) => void,
): Promise<AppStatus> {
  return withSetupLock(config.root, async () => {
    for (const directory of [config.cache_root, config.logs_root])
      await privateDirectory(directory);
    progress({
      phase: "model_download",
      percent: 0,
      label: "Checking the voice model",
    });
    await downloadModel(config, signal, progress);
    signal.throwIfAborted();
    progress({
      phase: "validation",
      percent: 60,
      label: "Checking Apple GPU and bundled tools",
    });
    await inspectLocalReadiness(config, signal, (event) => {
      if (event.state === "started") {
        const step = {
          "engine-doctor": [60, "Checking Apple GPU and voice model"],
          "downloader-version": [70, "Starting the audio downloader"],
          "downloader-help": [80, "Checking audio downloader capabilities"],
          "downloader-ejs": [80, "Checking YouTube challenge scripts"],
          "javascript-runtime": [85, "Checking the bundled Deno runtime"],
          "token-provider": [90, "Checking YouTube playback token support"],
        } as const;
        const [percent, label] = step[event.probe];
        progress({ phase: "validation", percent, label });
      }
      observeReadiness?.(event);
    });
    const readiness: SetupReadiness = {
      engine: true,
      model: true,
      downloader: false,
      javascript: false,
      token_provider: false,
      errors: {},
    };
    let probe = "downloader-version";
    await inspectYouTubeReadiness(config, signal, (event) => {
      if (event.state === "started") {
        probe = event.probe;
        progress({
          phase: "validation",
          percent: event.probe === "token-provider" ? 90 : 80,
          label:
            event.probe === "token-provider"
              ? "Checking playback token support"
              : "Checking YouTube tools",
        });
      }
      if (event.state === "completed") {
        if (event.probe === "downloader-ejs") readiness.downloader = true;
        if (event.probe === "javascript-runtime") readiness.javascript = true;
        if (event.probe === "token-provider") readiness.token_provider = true;
      }
      observeReadiness?.(event);
    }).catch((error: unknown) => {
      if (signal.aborted) throw new LocalSetupError("CANCELLED");
      // Registration and local-file readiness remain useful if acquisition needs repair.
      if (
        error instanceof LocalSetupError ||
        error instanceof LocalProcessingError
      ) {
        const component =
          error.code.startsWith("PO_TOKEN_") || probe === "token-provider"
            ? "token_provider"
            : error.code.startsWith("DENO_") || probe === "javascript-runtime"
              ? "javascript"
              : "downloader";
        readiness.errors[component] = error.code;
        return;
      }
      throw error;
    });
    signal.throwIfAborted();
    progress({
      phase: "registration",
      percent: 95,
      label: "Connecting MusicMute to Chrome",
    });
    await registerNativeHost(config);
    await saveSetupReadiness(config, readiness, undefined, signal);
    progress({ phase: "ready", percent: 100, label: "Mac setup checked" });
    return inspectAppStatus(config);
  });
}

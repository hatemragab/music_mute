import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  open,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { LocalProcessingError, runBounded } from "./local-provider.js";
import {
  DOWNLOADER_VERSION,
  downloaderToolArguments,
  verifyDownloaderBundle,
} from "./downloader-bundle.js";

import {
  DENO_VERSION,
  tokenProviderCheckArguments,
  verifyYoutubeRuntime,
} from "./youtube-runtime.js";

export interface LocalConfig {
  app_resources?: string;
  runtime_id?: string;
  runtime_root?: string;
  root: string;
  cache_root: string;
  logs_root: string;
  models_root: string;
  python_path: string;
  node_path: string;
  ffmpeg_path: string;
  ffprobe_path: string;
  yt_dlp_path: string;
  downloader_bundle_root?: string;
  downloader_bootstrap_path?: string;
  js_runtime_path: string;
  youtube_runtime_root?: string;
  update_lease_python_path?: string;
  js_runtime_kind?: "node" | "deno";
  engine_root: string;
  runner_path: string;
}

export const PACKAGED_RUNTIME_API_VERSION = 1;
export const PACKAGED_RUNTIME_BOOTSTRAP = "runtime-bootstrap.json";
export const PACKAGED_RUNTIME_ACTIVE_DESCRIPTOR = "runtime/active.json";

interface PackagedRuntimeIdentity {
  id: string;
  api_version: number;
  archive_sha256: string;
}

export interface ResolvedPackagedRuntime extends PackagedRuntimeIdentity {
  release_root: string;
  runtime_root: string;
}

export class LocalSetupError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LocalSetupError";
  }
}

export type ReadinessProbe =
  | "engine-doctor"
  | "downloader-version"
  | "downloader-help"
  | "downloader-ejs"
  | "javascript-runtime"
  | "token-provider";
const READINESS_ERROR_CODES = [
  "CANCELLED",
  "TOOL_TIMEOUT",
  "TOOL_OUTPUT_LIMIT",
  "TOOL_UNAVAILABLE",
  "TOOL_FAILED",
  "ENGINE_PROTOCOL_INVALID",
  "ENGINE_DOCTOR_INVALID",
  "ENGINE_NOT_READY",
  "YT_DLP_VERSION_INVALID",
  "CLI_OPTION_UNSUPPORTED",
  "YT_DLP_EJS_MISSING",
  "DENO_MISSING",
  "DENO_VERSION_INVALID",
  "PO_TOKEN_PROVIDER_INVALID",
  "PO_TOKEN_PROVIDER_UNAVAILABLE",
  "READINESS_PROBE_FAILED",
] as const;
export type ReadinessProbeErrorCode = (typeof READINESS_ERROR_CODES)[number];
export type ReadinessProbeEvent = {
  probe: ReadinessProbe;
  duration_ms: number;
} & (
  | { state: "started" | "completed"; error_code?: never }
  | { state: "failed"; error_code: ReadinessProbeErrorCode }
);
export type ReadinessObserver = (event: ReadinessProbeEvent) => void;

function observeReadiness(
  observer: ReadinessObserver | undefined,
  event: ReadinessProbeEvent,
): void {
  try {
    // Ignore rejected async callbacks as well as synchronous observer errors.
    void Promise.resolve(observer?.(event)).catch(() => {});
  } catch {
    /* Diagnostics must never change readiness or its owned cleanup. */
  }
}

async function readinessProbe(
  probe: ReadinessProbe,
  observer: ReadinessObserver | undefined,
  operation: () => Promise<void>,
): Promise<void> {
  const started = performance.now();
  observeReadiness(observer, { probe, state: "started", duration_ms: 0 });
  try {
    await operation();
    observeReadiness(observer, {
      probe,
      state: "completed",
      duration_ms: Math.max(0, performance.now() - started),
    });
  } catch (error) {
    const code =
      error instanceof LocalSetupError || error instanceof LocalProcessingError
        ? error.code
        : undefined;
    const error_code =
      READINESS_ERROR_CODES.find((known) => known === code) ??
      "READINESS_PROBE_FAILED";
    observeReadiness(observer, {
      probe,
      state: "failed",
      duration_ms: Math.max(0, performance.now() - started),
      error_code,
    });
    throw error;
  }
}

function absoluteSetting(value: string | undefined, fallback: string): string {
  if (value !== undefined && (!value || !isAbsolute(value))) {
    throw new LocalSetupError("INVALID_LOCAL_CONFIG");
  }
  return value ?? fallback;
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function packagedRuntimeBootstrap(
  appResources: string,
): Promise<PackagedRuntimeIdentity> {
  const path = join(appResources, PACKAGED_RUNTIME_BOOTSTRAP);
  try {
    const information = await lstat(path);
    // The native installer performs the complete leaf inventory and code-signing
    // verification before it publishes the private active descriptor. The
    // companion revalidates the immutable compatibility identity before launch.
    if (
      !information.isFile() ||
      information.isSymbolicLink() ||
      information.nlink !== 1 ||
      information.size < 2 ||
      information.size > 16 * 1024 * 1024 ||
      information.mode & 0o022
    )
      throw new Error();
    const manifest = jsonRecord(JSON.parse(await readFile(path, "utf8")));
    const runtime = jsonRecord(manifest?.runtime);
    const signing = jsonRecord(runtime?.signing);
    const source = new URL(String(runtime?.url ?? ""));
    const downloadHosts = Array.isArray(runtime?.download_hosts)
      ? runtime.download_hosts
      : [];
    const normalizedDownloadHosts = downloadHosts.map((host) =>
      typeof host === "string" ? host.toLowerCase() : "",
    );
    const validSigning =
      (signing?.mode === "developer_id" &&
        typeof signing.team_id === "string" &&
        /^[A-Z0-9]{10}$/.test(signing.team_id)) ||
      (signing?.mode === "ad_hoc" && signing.team_id == null);
    if (
      manifest?.schema_version !== 1 ||
      typeof runtime?.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runtime.id) ||
      runtime.api_version !== PACKAGED_RUNTIME_API_VERSION ||
      runtime.platform !== "darwin" ||
      runtime.arch !== "arm64" ||
      runtime.archive_format !== "zip" ||
      typeof runtime.archive_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(runtime.archive_sha256) ||
      !positiveSafeInteger(runtime.archive_bytes) ||
      runtime.archive_bytes > 2_000_000_000 ||
      !positiveSafeInteger(runtime.installed_bytes) ||
      runtime.installed_bytes > 4_000_000_000 ||
      source.protocol !== "https:" ||
      source.username ||
      source.password ||
      (source.port && source.port !== "443") ||
      source.search ||
      source.hash ||
      downloadHosts.length === 0 ||
      downloadHosts.length > 8 ||
      downloadHosts.some(
        (host) =>
          typeof host !== "string" ||
          !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/.test(
            host,
          ),
      ) ||
      new Set(normalizedDownloadHosts).size !== downloadHosts.length ||
      !normalizedDownloadHosts.includes(source.hostname) ||
      !Array.isArray(runtime.files) ||
      runtime.files.length < 5 ||
      runtime.files.length > 50_000 ||
      !validSigning
    )
      throw new Error();
    return {
      id: runtime.id,
      api_version: runtime.api_version,
      archive_sha256: runtime.archive_sha256,
    };
  } catch (error) {
    if (error instanceof LocalSetupError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new LocalSetupError("APP_RUNTIME_BOOTSTRAP_MISSING");
    throw new LocalSetupError("APP_RUNTIME_BOOTSTRAP_INVALID");
  }
}

async function ownedRuntimeDirectory(
  path: string,
  privateDirectory: boolean,
): Promise<void> {
  const information = await lstat(path);
  if (
    !information.isDirectory() ||
    information.isSymbolicLink() ||
    information.uid !== process.getuid?.() ||
    information.mode & (privateDirectory ? 0o077 : 0o022)
  )
    throw new LocalSetupError("APP_RUNTIME_DESCRIPTOR_INVALID");
}

/** Resolve only the runtime release selected and verified by the native installer. */
export async function resolvePackagedRuntime(
  appResources: string,
  stateRoot: string,
): Promise<ResolvedPackagedRuntime> {
  if (!isAbsolute(appResources) || !isAbsolute(stateRoot))
    throw new LocalSetupError("APP_RUNTIME_DESCRIPTOR_INVALID");
  const expected = await packagedRuntimeBootstrap(appResources);
  const runtimeDirectory = join(stateRoot, "runtime");
  const releasesDirectory = join(runtimeDirectory, "releases");
  const activePath = join(stateRoot, PACKAGED_RUNTIME_ACTIVE_DESCRIPTOR);
  let descriptor: Record<string, unknown>;
  try {
    await ownedRuntimeDirectory(stateRoot, true);
    await ownedRuntimeDirectory(runtimeDirectory, true);
    await ownedRuntimeDirectory(releasesDirectory, true);
    const information = await lstat(activePath);
    if (
      !information.isFile() ||
      information.isSymbolicLink() ||
      information.nlink !== 1 ||
      information.uid !== process.getuid?.() ||
      information.mode & 0o077 ||
      information.size < 2 ||
      information.size > 16 * 1024
    )
      throw new LocalSetupError("APP_RUNTIME_DESCRIPTOR_INVALID");
    const parsed = jsonRecord(JSON.parse(await readFile(activePath, "utf8")));
    if (!parsed) throw new LocalSetupError("APP_RUNTIME_DESCRIPTOR_INVALID");
    descriptor = parsed;
  } catch (error) {
    if (error instanceof LocalSetupError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new LocalSetupError("APP_RUNTIME_NOT_PREPARED");
    throw new LocalSetupError("APP_RUNTIME_DESCRIPTOR_INVALID");
  }
  if (
    descriptor.schema_version !== 1 ||
    typeof descriptor.runtime_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(descriptor.runtime_id) ||
    descriptor.api_version !== PACKAGED_RUNTIME_API_VERSION ||
    typeof descriptor.archive_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(descriptor.archive_sha256) ||
    descriptor.release_path !== `releases/${descriptor.runtime_id}`
  )
    throw new LocalSetupError("APP_RUNTIME_DESCRIPTOR_INVALID");
  if (
    descriptor.runtime_id !== expected.id ||
    descriptor.api_version !== expected.api_version ||
    descriptor.archive_sha256 !== expected.archive_sha256
  )
    throw new LocalSetupError("APP_RUNTIME_INCOMPATIBLE");
  const expectedRelativePath = `releases/${expected.id}`;
  const releaseRoot = join(runtimeDirectory, expectedRelativePath);
  const runtimeRoot = join(releaseRoot, "runtime");
  try {
    await ownedRuntimeDirectory(releaseRoot, true);
    await ownedRuntimeDirectory(runtimeRoot, false);
    if (
      (await realpath(releaseRoot)) !==
      join(await realpath(releasesDirectory), expected.id)
    )
      throw new LocalSetupError("APP_RUNTIME_DESCRIPTOR_INVALID");
  } catch (error) {
    if (error instanceof LocalSetupError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new LocalSetupError("APP_RUNTIME_NOT_PREPARED");
    throw new LocalSetupError("APP_RUNTIME_DESCRIPTOR_INVALID");
  }
  return {
    ...expected,
    release_root: releaseRoot,
    runtime_root: runtimeRoot,
  };
}

/** Packaged apps own their runtime/model; developer reuse never reads fleet config. */
export async function loadLocalConfig(): Promise<LocalConfig> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new LocalSetupError("UNSUPPORTED_PLATFORM");
  }
  const appSetting = process.env.MUSICMUTE_LOCAL_APP_RESOURCES;
  const appResources =
    appSetting !== undefined
      ? await realpath(absoluteSetting(appSetting, "")).catch(() => {
          throw new LocalSetupError("APP_RESOURCES_MISSING");
        })
      : undefined;
  const workerRoot = join(
    homedir(),
    "Library/Application Support/MusicMuteWorker",
  );
  const root = absoluteSetting(
    process.env.MUSICMUTE_LOCAL_ROOT,
    join(
      homedir(),
      `Library/Application Support/${appResources ? "MusicMuteLocal" : "MusicMuteLocalMvp"}`,
    ),
  );
  let runtime: string;
  let runtimeId: string | undefined;
  try {
    if (appResources) {
      try {
        const installed = await resolvePackagedRuntime(appResources, root);
        runtime = installed.runtime_root;
        runtimeId = installed.id;
      } catch (error) {
        if (
          !(error instanceof LocalSetupError) ||
          error.code !== "APP_RUNTIME_BOOTSTRAP_MISSING"
        )
          throw error;
        // Existing development and installed app fixtures predate thin runtime
        // manifests. New packages include a bootstrap and cannot use this path.
        runtime = await realpath(join(appResources, "runtime"));
      }
    } else {
      runtime = await realpath(
        absoluteSetting(
          process.env.MUSICMUTE_LOCAL_RUNTIME,
          join(workerRoot, "runtime/current"),
        ),
      );
    }
  } catch (error) {
    if (error instanceof LocalSetupError) throw error;
    throw new LocalSetupError(
      appResources ? "APP_RUNTIME_MISSING" : "DEV_RUNTIME_MISSING",
    );
  }
  const node = join(runtime, "runtime/node/bin/node");
  const python = join(runtime, "runtime/python/bin/python3");
  const wheelBundle = join(appResources ? runtime : root, "tools/downloader");
  // A damaged packaged bundle must remain a repairable setup error, never fall
  // back to a standalone downloader without the bundled challenge/token support.
  let downloaderBundle: string | undefined = appResources
    ? wheelBundle
    : undefined;
  if (!appResources && process.env.MUSICMUTE_LOCAL_YT_DLP === undefined) {
    try {
      await lstat(join(wheelBundle, "identity.json"));
      downloaderBundle = wheelBundle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new LocalSetupError("YT_DLP_IDENTITY_INVALID");
    }
  }
  const privateDownloader = join(root, "tools/yt-dlp");
  let defaultDownloader = appResources
    ? join(runtime, "tools/yt-dlp")
    : "/opt/homebrew/bin/yt-dlp";
  try {
    await access(privateDownloader, constants.X_OK);
    defaultDownloader = privateDownloader;
  } catch {
    /* Explicit dev prerequisite fallback. */
  }
  // Bundled host code is dist/companion/*.js. Sources use the same repository root.
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const youtubeRuntime = appResources
    ? join(runtime, "tools/youtube")
    : process.env.MUSICMUTE_YOUTUBE_RUNTIME_TARGET;
  return {
    ...(appResources ? { app_resources: appResources } : {}),
    ...(runtimeId ? { runtime_id: runtimeId } : {}),
    runtime_root: runtime,
    root,
    cache_root: join(root, "cache"),
    logs_root: join(root, "logs"),
    models_root: absoluteSetting(
      appResources ? undefined : process.env.MUSICMUTE_LOCAL_MODELS,
      appResources ? join(root, "models") : join(workerRoot, "models"),
    ),
    python_path: python,
    ...(appResources ? { update_lease_python_path: python } : {}),
    node_path: node,
    ffmpeg_path: join(runtime, "runtime/bin/ffmpeg"),
    ffprobe_path: join(runtime, "runtime/bin/ffprobe"),
    yt_dlp_path: downloaderBundle
      ? python
      : absoluteSetting(
          appResources ? undefined : process.env.MUSICMUTE_LOCAL_YT_DLP,
          defaultDownloader,
        ),
    ...(downloaderBundle ? { downloader_bundle_root: downloaderBundle } : {}),
    ...(appResources
      ? {
          downloader_bootstrap_path: join(
            appResources,
            "engine/downloader_bootstrap.py",
          ),
        }
      : {}),
    js_runtime_path: youtubeRuntime ? join(youtubeRuntime, "bin/deno") : node,
    js_runtime_kind: youtubeRuntime ? "deno" : "node",
    ...(youtubeRuntime ? { youtube_runtime_root: youtubeRuntime } : {}),
    engine_root: appResources
      ? join(appResources, "engine-core")
      : join(workerRoot, "engine"),
    runner_path: absoluteSetting(
      appResources ? undefined : process.env.MUSICMUTE_LOCAL_RUNNER,
      join(appResources ?? packageRoot, "engine/local_pipeline.py"),
    ),
  };
}

export function localToolEnvironment(
  config: LocalConfig,
  temporaryRoot = config.root,
): NodeJS.ProcessEnv {
  return {
    HOME: homedir(),
    ...(config.app_resources && config.update_lease_python_path
      ? {
          MUSICMUTE_LOCAL_APP_RESOURCES: config.app_resources,
          MUSICMUTE_LOCAL_ROOT: config.root,
          MUSICMUTE_LOCAL_UPDATE_PYTHON: config.update_lease_python_path,
        }
      : {}),
    PATH: [
      dirname(config.ffmpeg_path),
      dirname(config.node_path),
      "/usr/bin",
      "/bin",
    ].join(":"),
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TMPDIR: temporaryRoot,
    PYTHONPATH: config.engine_root,
    PYTHONNOUSERSITE: "1",
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTORCH_ENABLE_MPS_FALLBACK: "0",
    MUSICMUTE_LOCAL_PARENT_PID: String(process.pid),
    ...(config.youtube_runtime_root
      ? {
          DENO_DIR: join(temporaryRoot, "deno-cache"),
          DENO_NO_PROMPT: "1",
          DENO_NO_UPDATE_CHECK: "1",
        }
      : {}),
  };
}

export async function inspectLocalReadiness(
  config: LocalConfig,
  signal = new AbortController().signal,
  observer?: ReadinessObserver,
): Promise<void> {
  for (const path of [
    config.python_path,
    config.node_path,
    config.ffmpeg_path,
    config.ffprobe_path,
  ]) {
    try {
      await access(path, constants.X_OK);
    } catch {
      throw new LocalSetupError("DEV_RUNTIME_INCOMPLETE");
    }
  }
  try {
    if (
      !(await stat(config.runner_path)).isFile() ||
      !(await stat(config.engine_root)).isDirectory()
    )
      throw new Error();
  } catch {
    throw new LocalSetupError("ENGINE_MISSING");
  }
  for (const directory of [config.root, config.cache_root, config.logs_root]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await stat(directory)).mode & 0o077)
      throw new LocalSetupError("LOCAL_DIRECTORY_NOT_PRIVATE");
  }
  await readinessProbe("engine-doctor", observer, async () => {
    const doctor = await runBounded(
      config.python_path,
      [config.runner_path, "--doctor", "--model-cache", config.models_root],
      {
        signal,
        timeout_ms: 60_000,
        max_output_bytes: 128 * 1024,
        env: localToolEnvironment(config),
      },
    );
    let ready: unknown;
    try {
      ready = JSON.parse(doctor.stdout.trim());
    } catch {
      throw new LocalSetupError("ENGINE_DOCTOR_INVALID");
    }
    if (
      typeof ready !== "object" ||
      ready === null ||
      !("ready" in ready) ||
      ready.ready !== true
    ) {
      const code =
        typeof ready === "object" &&
        ready !== null &&
        "code" in ready &&
        typeof ready.code === "string" &&
        /^[A-Z_]{1,60}$/.test(ready.code)
          ? ready.code
          : "ENGINE_NOT_READY";
      throw new LocalSetupError(code);
    }
  });
}

/** Offline validation only. It does not claim YouTube accepts guest requests. */
export async function inspectYouTubeReadiness(
  config: LocalConfig,
  signal = new AbortController().signal,
  observer?: ReadinessObserver,
): Promise<void> {
  try {
    await access(config.yt_dlp_path, constants.X_OK);
  } catch {
    throw new LocalSetupError("YT_DLP_MISSING");
  }
  if (config.downloader_bundle_root) {
    try {
      await verifyDownloaderBundle(
        config.downloader_bundle_root,
        Boolean(config.app_resources),
        config.downloader_bootstrap_path,
      );
    } catch {
      throw new LocalSetupError("YT_DLP_IDENTITY_INVALID");
    }
  }
  if (config.youtube_runtime_root) {
    try {
      // Validate immutable Deno/provider bytes before the EJS check executes Deno.
      await verifyYoutubeRuntime(
        config.youtube_runtime_root,
        Boolean(config.app_resources),
      );
    } catch {
      throw new LocalSetupError("PO_TOKEN_PROVIDER_INVALID");
    }
  }
  const packagedDownloader = config.app_resources
    ? join(
        config.runtime_root ?? join(config.app_resources, "runtime"),
        "tools/yt-dlp",
      )
    : undefined;
  if (
    config.yt_dlp_path === join(config.root, "tools/yt-dlp") ||
    config.yt_dlp_path === packagedDownloader
  ) {
    try {
      const binary = await lstat(config.yt_dlp_path);
      const identityPath = join(
        dirname(config.yt_dlp_path),
        "yt-dlp.identity.json",
      );
      const record = await lstat(identityPath);
      if (
        !binary.isFile() ||
        binary.isSymbolicLink() ||
        binary.mode &
          (config.yt_dlp_path === packagedDownloader ? 0o022 : 0o077) ||
        !record.isFile() ||
        record.isSymbolicLink() ||
        record.size > 4096 ||
        record.mode &
          (config.yt_dlp_path === packagedDownloader ? 0o022 : 0o077)
      )
        throw new Error();
      const identity = JSON.parse(
        await readFile(identityPath, "utf8"),
      ) as Record<string, unknown>;
      if (
        identity.source !== "yt-dlp/yt-dlp" ||
        identity.asset !== "yt-dlp_macos" ||
        identity.bytes !== binary.size ||
        typeof identity.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(identity.sha256)
      )
        throw new Error();
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(config.yt_dlp_path))
        hash.update(chunk);
      if (hash.digest("hex") !== identity.sha256) throw new Error();
    } catch {
      throw new LocalSetupError("YT_DLP_IDENTITY_INVALID");
    }
  }
  await readinessProbe("downloader-version", observer, async () => {
    const version = await runBounded(
      config.python_path,
      downloaderToolArguments(config, [
        "--ignore-config",
        "--no-plugin-dirs",
        "--version",
      ]),
      {
        signal,
        // Measured packaged cold startup exceeded the previous 15s cap.
        timeout_ms: 30_000,
        max_output_bytes: 32 * 1024,
        env: localToolEnvironment(config),
      },
    );
    if (!/^20\d\d\.\d\d\.\d\d/.test(version.stdout.trim()))
      throw new LocalSetupError("YT_DLP_VERSION_INVALID");
    if (
      config.downloader_bundle_root &&
      version.stdout.trim() !== DOWNLOADER_VERSION
    )
      throw new LocalSetupError("YT_DLP_VERSION_INVALID");
  });
  // --version can short-circuit parsing. Check documented capabilities before
  // an invalid isolation flag could turn into a generic acquisition failure.
  await readinessProbe("downloader-help", observer, async () => {
    const help = await runBounded(
      config.python_path,
      downloaderToolArguments(config, [
        "--ignore-config",
        "--no-plugin-dirs",
        "--help",
      ]),
      {
        signal,
        timeout_ms: 30_000,
        max_output_bytes: 128 * 1024,
        env: localToolEnvironment(config),
      },
    );
    for (const flag of [
      "--no-plugin-dirs",
      "--no-cache-dir",
      "--no-remote-components",
      "--no-js-runtimes",
      "--js-runtimes",
      "--dump-single-json",
    ]) {
      if (!help.stdout.includes(flag))
        throw new LocalSetupError("CLI_OPTION_UNSUPPORTED");
    }
  });
  if (config.downloader_bundle_root) {
    await readinessProbe("downloader-ejs", observer, async () => {
      const ejs = await runBounded(
        config.python_path,
        downloaderToolArguments(config, ["--musicmute-check-ejs"]),
        {
          signal,
          timeout_ms: 15_000,
          max_output_bytes: 32 * 1024,
          env: localToolEnvironment(config),
        },
      ).catch((error: unknown) => {
        if (
          error instanceof LocalProcessingError &&
          error.code === "TOOL_FAILED"
        )
          throw new LocalSetupError("YT_DLP_EJS_MISSING");
        throw error;
      });
      if (ejs.stdout.trim() !== "ready")
        throw new LocalSetupError("YT_DLP_EJS_MISSING");
    });
    await inspectTokenProviderReadiness(config, signal, observer);
    return;
  }
  // Python/pip launchers may lack EJS despite yt-dlp --version succeeding.
  // Official self-contained binaries ship EJS and do not have this shebang.
  const descriptor = await open(config.yt_dlp_path, "r");
  const header = Buffer.alloc(512);
  try {
    await descriptor.read(header, 0, header.length, 0);
  } finally {
    await descriptor.close();
  }
  const interpreter = /^#!(\/[^\r\n ]*python[^\r\n ]*)\r?\n/.exec(
    header.toString("utf8"),
  )?.[1];
  if (interpreter) {
    const check =
      "from yt_dlp.dependencies import yt_dlp_ejs; from yt_dlp.extractor.youtube.jsc._builtin.vendor import load_script; print('ready' if yt_dlp_ejs or (load_script('yt.solver.core.js') and load_script('yt.solver.lib.js')) else 'missing')";
    await readinessProbe("downloader-ejs", observer, async () => {
      const ejs = await runBounded(
        config.python_path,
        [config.runner_path, "--tool", interpreter, "--", "-c", check],
        {
          signal,
          timeout_ms: 15_000,
          max_output_bytes: 32 * 1024,
          env: localToolEnvironment(config),
        },
      ).catch((error: unknown) => {
        if (
          error instanceof LocalProcessingError &&
          error.code === "TOOL_FAILED"
        )
          throw new LocalSetupError("YT_DLP_EJS_MISSING");
        throw error;
      });
      if (ejs.stdout.trim() !== "ready")
        throw new LocalSetupError("YT_DLP_EJS_MISSING");
    });
  }
}

export async function inspectTokenProviderReadiness(
  config: LocalConfig,
  signal = new AbortController().signal,
  observer?: ReadinessObserver,
): Promise<void> {
  // Explicit developer standalone tools retain their prior prerequisite behavior.
  if (!config.youtube_runtime_root) {
    if (config.app_resources)
      throw new LocalSetupError("PO_TOKEN_PROVIDER_MISSING");
    return;
  }
  const root = config.youtube_runtime_root;
  await readinessProbe("javascript-runtime", observer, async () => {
    try {
      await verifyYoutubeRuntime(root, Boolean(config.app_resources));
    } catch {
      throw new LocalSetupError("PO_TOKEN_PROVIDER_INVALID");
    }
    try {
      await access(config.js_runtime_path, constants.X_OK);
    } catch {
      throw new LocalSetupError("DENO_MISSING");
    }
    const version = await runBounded(
      config.python_path,
      [config.runner_path, "--tool", config.js_runtime_path, "--", "--version"],
      {
        signal,
        timeout_ms: 10000,
        max_output_bytes: 32768,
        env: localToolEnvironment(config),
      },
    ).catch((error: unknown) => {
      if (error instanceof LocalProcessingError && error.code === "TOOL_FAILED")
        throw new LocalSetupError("DENO_VERSION_INVALID");
      throw error;
    });
    if (
      version.stdout.split("\n")[0]?.split(" ").slice(0, 2).join(" ") !==
      `deno ${DENO_VERSION}`
    )
      throw new LocalSetupError("DENO_VERSION_INVALID");
  });
  await readinessProbe("token-provider", observer, async () => {
    await mkdir(config.root, { recursive: true, mode: 0o700 });
    const cache = await mkdtemp(join(config.root, "token-check-"));
    try {
      const result = await runBounded(
        config.python_path,
        [
          config.runner_path,
          "--tool",
          config.js_runtime_path,
          "--",
          ...tokenProviderCheckArguments(root, cache),
        ],
        {
          signal,
          timeout_ms: 20000,
          max_output_bytes: 32768,
          cwd: join(root, "provider"),
          env: {
            ...localToolEnvironment(config, cache),
            HOME: cache,
            XDG_CACHE_HOME: cache,
          },
        },
      ).catch((error: unknown) => {
        if (
          error instanceof LocalProcessingError &&
          error.code === "TOOL_FAILED"
        )
          throw new LocalSetupError("PO_TOKEN_PROVIDER_UNAVAILABLE");
        throw error;
      });
      if (result.stdout.trim() !== "ready")
        throw new LocalSetupError("PO_TOKEN_PROVIDER_UNAVAILABLE");
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });
}

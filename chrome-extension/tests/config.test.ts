import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectLocalReadiness as inspectEngineReadiness,
  inspectYouTubeReadiness,
  loadLocalConfig,
  localToolEnvironment,
  PACKAGED_RUNTIME_ACTIVE_DESCRIPTOR,
  PACKAGED_RUNTIME_BOOTSTRAP,
  PACKAGED_RUNTIME_API_VERSION,
  resolvePackagedRuntime,
  type LocalConfig,
  type ReadinessProbeEvent,
} from "../src/companion/config.js";
import * as tools from "../src/companion/local-provider.js";
import * as downloader from "../src/companion/downloader-bundle.js";

async function inspectLocalReadiness(
  config: LocalConfig,
  signal?: AbortSignal,
  observer?: (event: ReadinessProbeEvent) => void,
): Promise<void> {
  await inspectEngineReadiness(config, signal, observer);
  await inspectYouTubeReadiness(config, signal, observer);
}

const temporaryRoots: string[] = [];
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", originalPlatform);
  Object.defineProperty(process, "arch", originalArch);
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-config-test-"));
  temporaryRoots.push(root);
  return root;
}

const PACKAGED_RUNTIME_ID = "macos-arm64-test-v1";
const PACKAGED_RUNTIME_SHA256 = "a".repeat(64);
async function packagedRuntimeFixture(
  resources: string,
  root: string,
): Promise<string> {
  await writeFile(
    join(resources, PACKAGED_RUNTIME_BOOTSTRAP),
    JSON.stringify({
      schema_version: 1,
      runtime: {
        id: PACKAGED_RUNTIME_ID,
        api_version: PACKAGED_RUNTIME_API_VERSION,
        platform: "darwin",
        arch: "arm64",
        url: "https://downloads.example.test/musicmute-runtime.zip",
        download_hosts: ["downloads.example.test"],
        archive_format: "zip",
        archive_sha256: PACKAGED_RUNTIME_SHA256,
        archive_bytes: 500_000_000,
        installed_bytes: 1_000_000_000,
        signing: { mode: "ad_hoc" },
        files: [
          "runtime/runtime/node/bin/node",
          "runtime/runtime/python/bin/python3",
          "runtime/runtime/bin/ffmpeg",
          "runtime/runtime/bin/ffprobe",
          "runtime/tools/youtube/bin/deno",
        ].map((path) => ({
          path,
          type: "file",
          bytes: 1,
          sha256: "b".repeat(64),
          executable: true,
          code_signed: true,
        })),
      },
    }),
    { mode: 0o600 },
  );
  const release = join(root, "runtime/releases", PACKAGED_RUNTIME_ID);
  const payload = join(release, "runtime");
  await mkdir(payload, { recursive: true, mode: 0o700 });
  for (const directory of [
    join(root, "runtime"),
    join(root, "runtime/releases"),
  ])
    await stat(directory).then(() => undefined);
  await writeFile(
    join(root, PACKAGED_RUNTIME_ACTIVE_DESCRIPTOR),
    JSON.stringify({
      schema_version: 1,
      runtime_id: PACKAGED_RUNTIME_ID,
      api_version: PACKAGED_RUNTIME_API_VERSION,
      release_path: `releases/${PACKAGED_RUNTIME_ID}`,
      archive_sha256: PACKAGED_RUNTIME_SHA256,
    }),
    { mode: 0o600 },
  );
  return payload;
}
function platform(): void {
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true,
  });
  Object.defineProperty(process, "arch", {
    value: "arm64",
    configurable: true,
  });
}

async function readinessFixture(
  behavior: {
    failure_probe?: string;
    doctor_output?: string;
    help_output?: string;
    ejs_output?: string;
    python_downloader?: boolean;
  } = {},
): Promise<LocalConfig> {
  const root = await temporaryRoot();
  const runner = join(root, "fixture-runner.cjs");
  await writeFile(
    runner,
    `const behavior = ${JSON.stringify(behavior)};
const args = process.argv.slice(2);
const probe = args.includes('--doctor') ? 'engine-doctor' : args.includes('--version') ? 'downloader-version' : args.includes('--help') ? 'downloader-help' : 'downloader-ejs';
if (probe === behavior.failure_probe) {
  process.stderr.write('fixture private path/token must not reach diagnostics');
  process.exit(2);
}
const output = probe === 'engine-doctor' ? (behavior.doctor_output ?? '{"ready":true}')
  : probe === 'downloader-version' ? '2026.08.19'
  : probe === 'downloader-help' ? (behavior.help_output ?? '--no-plugin-dirs --no-cache-dir --no-remote-components --no-js-runtimes --js-runtimes --dump-single-json')
  : (behavior.ejs_output ?? 'ready');
process.stdout.write(output);
`,
  );
  const downloader = join(root, "fixture-downloader");
  await writeFile(
    downloader,
    behavior.python_downloader ? "#!/fixture/python\n" : "standalone fixture",
    { mode: 0o700 },
  );
  return {
    root,
    cache_root: join(root, "cache"),
    logs_root: join(root, "logs"),
    models_root: join(root, "models"),
    python_path: process.execPath,
    node_path: process.execPath,
    ffmpeg_path: process.execPath,
    ffprobe_path: process.execPath,
    yt_dlp_path: downloader,
    js_runtime_path: process.execPath,
    engine_root: root,
    runner_path: runner,
  };
}

describe("isolated local configuration", () => {
  it("packaged app uses the compatible active external runtime and persistent model root", async () => {
    platform();
    const resources = await temporaryRoot();
    const root = await temporaryRoot();
    const runtime = await packagedRuntimeFixture(resources, root);
    await mkdir(join(resources, "runtime"));
    vi.stubEnv("MUSICMUTE_LOCAL_APP_RESOURCES", resources);
    vi.stubEnv("MUSICMUTE_LOCAL_ROOT", root);
    vi.stubEnv("MUSICMUTE_LOCAL_RUNTIME", "/foreign/worker/runtime");
    vi.stubEnv("MUSICMUTE_LOCAL_MODELS", "/foreign/models");
    vi.stubEnv("MUSICMUTE_LOCAL_YT_DLP", "/foreign/downloader");
    const config = await loadLocalConfig();
    expect(config.app_resources).toBe(await realpath(resources));
    expect(config.runtime_id).toBe(PACKAGED_RUNTIME_ID);
    expect(config.engine_root).toBe(
      join(await realpath(resources), "engine-core"),
    );
    expect(config.downloader_bootstrap_path).toBe(
      join(await realpath(resources), "engine/downloader_bootstrap.py"),
    );
    expect(config.runtime_root).toBe(runtime);
    expect(config.node_path).toBe(join(runtime, "runtime/node/bin/node"));
    expect(config.models_root).toBe(join(config.root, "models"));
    expect(config.root).toBe(root);
    expect(config.yt_dlp_path).toBe(config.python_path);
    expect(config.downloader_bundle_root).toBe(
      join(runtime, "tools/downloader"),
    );
    expect(config.runner_path).toBe(
      join(await realpath(resources), "engine/local_pipeline.py"),
    );
  });
  it("rejects unsupported architectures rather than silently falling back", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    await expect(loadLocalConfig()).rejects.toMatchObject({
      code: "UNSUPPORTED_PLATFORM",
    });
    platform();
    Object.defineProperty(process, "arch", {
      value: "x64",
      configurable: true,
    });
    await expect(loadLocalConfig()).rejects.toMatchObject({
      code: "UNSUPPORTED_PLATFORM",
    });
  });
  it("selects the app-owned wheel bundle ahead of inherited or private standalone tools", async () => {
    platform();
    const resources = await temporaryRoot();
    const root = await temporaryRoot();
    const runtime = await packagedRuntimeFixture(resources, root);
    await mkdir(join(runtime, "tools/downloader"), {
      recursive: true,
    });
    await writeFile(join(runtime, "tools/downloader/identity.json"), "{}");
    await mkdir(join(root, "tools"), { mode: 0o700 });
    await writeFile(join(root, "tools/yt-dlp"), "foreign", { mode: 0o700 });
    vi.stubEnv("MUSICMUTE_LOCAL_APP_RESOURCES", resources);
    vi.stubEnv("MUSICMUTE_LOCAL_ROOT", root);
    vi.stubEnv("MUSICMUTE_LOCAL_YT_DLP", "/foreign/downloader");
    const config = await loadLocalConfig();
    expect(config.yt_dlp_path).toBe(config.python_path);
    expect(config.downloader_bundle_root).toBe(
      join(runtime, "tools/downloader"),
    );
    // Presence selects the packaged mode; invalid contents cannot fall back.
    const run = vi.spyOn(tools, "runBounded");
    await expect(
      inspectYouTubeReadiness({
        ...config,
        python_path: process.execPath,
        node_path: process.execPath,
        ffmpeg_path: process.execPath,
        ffprobe_path: process.execPath,
        yt_dlp_path: process.execPath,
      }),
    ).rejects.toMatchObject({ code: "YT_DLP_IDENTITY_INVALID" });
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects an active release that is not compatible with the app bootstrap", async () => {
    platform();
    const resources = await temporaryRoot();
    const root = await temporaryRoot();
    await packagedRuntimeFixture(resources, root);
    const active = join(root, PACKAGED_RUNTIME_ACTIVE_DESCRIPTOR);
    const descriptor = JSON.parse(await readFile(active, "utf8"));
    descriptor.runtime_id = "macos-arm64-other-v2";
    descriptor.release_path = "releases/macos-arm64-other-v2";
    await writeFile(active, JSON.stringify(descriptor), { mode: 0o600 });
    await expect(resolvePackagedRuntime(resources, root)).rejects.toMatchObject(
      {
        code: "APP_RUNTIME_INCOMPATIBLE",
      },
    );
  });
  it("reuses the same external runtime, model, and cache paths after an app-only update", async () => {
    platform();
    const firstResources = await temporaryRoot();
    const nextResources = await temporaryRoot();
    const root = await temporaryRoot();
    const runtime = await packagedRuntimeFixture(firstResources, root);
    await writeFile(
      join(nextResources, PACKAGED_RUNTIME_BOOTSTRAP),
      await readFile(join(firstResources, PACKAGED_RUNTIME_BOOTSTRAP)),
      { mode: 0o600 },
    );
    vi.stubEnv("MUSICMUTE_LOCAL_ROOT", root);
    vi.stubEnv("MUSICMUTE_LOCAL_APP_RESOURCES", firstResources);
    const before = await loadLocalConfig();
    vi.stubEnv("MUSICMUTE_LOCAL_APP_RESOURCES", nextResources);
    const after = await loadLocalConfig();
    expect(before.runtime_root).toBe(runtime);
    expect(after.runtime_root).toBe(runtime);
    expect(after.models_root).toBe(before.models_root);
    expect(after.cache_root).toBe(before.cache_root);
  });
  it("does not fall back to a legacy bundle when a thin-app runtime is not prepared", async () => {
    platform();
    const resources = await temporaryRoot();
    const root = await temporaryRoot();
    await packagedRuntimeFixture(resources, root);
    await unlink(join(root, PACKAGED_RUNTIME_ACTIVE_DESCRIPTOR));
    await mkdir(join(resources, "runtime"));
    vi.stubEnv("MUSICMUTE_LOCAL_ROOT", root);
    vi.stubEnv("MUSICMUTE_LOCAL_APP_RESOURCES", resources);
    await expect(loadLocalConfig()).rejects.toMatchObject({
      code: "APP_RUNTIME_NOT_PREPARED",
    });
  });
  it("keeps compatibility with an existing app that predates runtime bootstraps", async () => {
    platform();
    const resources = await temporaryRoot();
    const root = await temporaryRoot();
    const legacyRuntime = join(resources, "runtime");
    await mkdir(legacyRuntime);
    vi.stubEnv("MUSICMUTE_LOCAL_ROOT", root);
    vi.stubEnv("MUSICMUTE_LOCAL_APP_RESOURCES", resources);
    const config = await loadLocalConfig();
    expect(config.runtime_id).toBeUndefined();
    expect(config.runtime_root).toBe(await realpath(legacyRuntime));
    expect(config.node_path).toBe(
      join(await realpath(legacyRuntime), "runtime/node/bin/node"),
    );
    expect(config.models_root).toBe(join(root, "models"));
  });
  it("rejects a linked active descriptor before resolving executable paths", async () => {
    platform();
    const resources = await temporaryRoot();
    const root = await temporaryRoot();
    await packagedRuntimeFixture(resources, root);
    const active = join(root, PACKAGED_RUNTIME_ACTIVE_DESCRIPTOR);
    const foreign = join(root, "foreign-active.json");
    await writeFile(foreign, await readFile(active), { mode: 0o600 });
    await unlink(active);
    await symlink(foreign, active);
    await expect(resolvePackagedRuntime(resources, root)).rejects.toMatchObject(
      {
        code: "APP_RUNTIME_DESCRIPTOR_INVALID",
      },
    );
  });
  it("resolves runtime read-only and keeps local state separate from fleet state", async () => {
    platform();
    const runtime = await temporaryRoot();
    const root = join(runtime, "new-local-root");
    vi.stubEnv("MUSICMUTE_LOCAL_RUNTIME", runtime);
    vi.stubEnv("MUSICMUTE_LOCAL_ROOT", root);
    const config = await loadLocalConfig();
    expect(config.node_path).toBe(
      join(await realpath(runtime), "runtime/node/bin/node"),
    );
    expect(config.models_root).toBe(
      join(homedir(), "Library/Application Support/MusicMuteWorker/models"),
    );
    expect(config.root).toBe(root);
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    vi.stubEnv("MUSICMUTE_LOCAL_ROOT", "relative/path");
    await expect(loadLocalConfig()).rejects.toMatchObject({
      code: "INVALID_LOCAL_CONFIG",
    });
  });
  it("does not inherit credentials, proxy, Python user packages or remote telemetry", () => {
    vi.stubEnv("MUSICMUTE_SENTRY_DSN", "secret");
    vi.stubEnv("HTTPS_PROXY", "private-proxy");
    const config = {
      root: "/private/local",
      ffmpeg_path: "/runtime/bin/ffmpeg",
      node_path: "/runtime/node/bin/node",
      youtube_runtime_root: "/runtime/tools/youtube",
      engine_root: "/runtime/app/engine",
    } as LocalConfig;
    const environment = localToolEnvironment(config);
    expect(environment.MUSICMUTE_SENTRY_DSN).toBeUndefined();
    expect(environment.HTTPS_PROXY).toBeUndefined();
    expect(environment.PYTHONNOUSERSITE).toBe("1");
    expect(environment.PYTHONDONTWRITEBYTECODE).toBe("1");
    expect(environment.PYTORCH_ENABLE_MPS_FALLBACK).toBe("0");
    expect(environment.DENO_DIR).toBe("/private/local/deno-cache");
    expect(environment.PATH).toBe(
      "/runtime/bin:/runtime/node/bin:/usr/bin:/bin",
    );
  });
  it("fails readiness when runtime dependencies are missing", async () => {
    await expect(
      inspectLocalReadiness({
        python_path: "/missing/musicmute-python",
      } as LocalConfig),
    ).rejects.toMatchObject({ code: "DEV_RUNTIME_INCOMPLETE" });
  });
  it("prefers the installed private downloader and rejects a corrupted identity", async () => {
    platform();
    const runtime = await temporaryRoot();
    vi.stubEnv("MUSICMUTE_LOCAL_RUNTIME", runtime);
    vi.stubEnv("MUSICMUTE_LOCAL_ROOT", runtime);
    await mkdir(join(runtime, "tools"), { mode: 0o700 });
    const downloader = join(runtime, "tools/yt-dlp");
    await writeFile(downloader, "fixture", { mode: 0o700 });
    const config = await loadLocalConfig();
    expect(config.yt_dlp_path).toBe(downloader);
    const binaryConfig = {
      ...config,
      python_path: process.execPath,
      node_path: process.execPath,
      ffmpeg_path: process.execPath,
      ffprobe_path: process.execPath,
    };
    await writeFile(
      join(runtime, "tools/yt-dlp.identity.json"),
      JSON.stringify({
        source: "yt-dlp/yt-dlp",
        asset: "yt-dlp_macos",
        bytes: 7,
        sha256: "a".repeat(64),
      }),
      { mode: 0o600 },
    );
    await expect(inspectYouTubeReadiness(binaryConfig)).rejects.toMatchObject({
      code: "YT_DLP_IDENTITY_INVALID",
    });
  });
  it("refuses public state directories before running tools", async () => {
    const root = await temporaryRoot();
    const publicRoot = join(root, "public");
    await mkdir(publicRoot, { mode: 0o755 });
    const runner = join(root, "runner.py");
    await writeFile(runner, "");
    const config: LocalConfig = {
      root: publicRoot,
      cache_root: join(publicRoot, "cache"),
      logs_root: join(publicRoot, "logs"),
      models_root: root,
      python_path: process.execPath,
      node_path: process.execPath,
      ffmpeg_path: process.execPath,
      ffprobe_path: process.execPath,
      yt_dlp_path: process.execPath,
      js_runtime_path: process.execPath,
      engine_root: root,
      runner_path: runner,
    };
    await expect(inspectLocalReadiness(config)).rejects.toMatchObject({
      code: "LOCAL_DIRECTORY_NOT_PRIVATE",
    });
  });
});

describe("readiness probe observations", () => {
  it("keeps local file processing ready when YouTube tools need repair", async () => {
    const config = await readinessFixture();
    config.yt_dlp_path = "/missing/downloader";
    config.youtube_runtime_root = "/missing/youtube-runtime";
    config.js_runtime_path = "/missing/deno";
    await expect(inspectEngineReadiness(config)).resolves.toBeUndefined();
    await expect(inspectYouTubeReadiness(config)).rejects.toMatchObject({
      code: "YT_DLP_MISSING",
    });
  });
  it("checks the isolated wheel version, capabilities and both EJS resources", async () => {
    const config = {
      ...(await readinessFixture()),
      downloader_bundle_root: "/fixture/downloader",
    };
    const verified = vi
      .spyOn(downloader, "verifyDownloaderBundle")
      .mockResolvedValue();
    const run = vi.spyOn(tools, "runBounded");
    const events: ReadinessProbeEvent[] = [];
    await inspectLocalReadiness(config, undefined, (event) =>
      events.push(event),
    );
    expect(verified).toHaveBeenCalledOnce();
    const commands = run.mock.calls.filter(([, args]) =>
      args.includes("--tool"),
    );
    expect(commands).toHaveLength(3);
    for (const [, args] of commands)
      expect(args.slice(4, 8)).toEqual([
        "-I",
        "-B",
        "-S",
        "/fixture/downloader/downloader_bootstrap.py",
      ]);
    expect(commands.at(-1)?.[1].at(-1)).toBe("--musicmute-check-ejs");
    expect(events.at(-1)).toMatchObject({
      probe: "downloader-ejs",
      state: "completed",
    });
  });

  it("refuses a wheel bundle whose EJS resource check fails", async () => {
    const config = {
      ...(await readinessFixture({ ejs_output: "missing" })),
      downloader_bundle_root: "/fixture/downloader",
    };
    vi.spyOn(downloader, "verifyDownloaderBundle").mockResolvedValue();
    await expect(inspectLocalReadiness(config)).rejects.toMatchObject({
      code: "YT_DLP_EJS_MISSING",
    });
  });

  it("uses a 30s downloader version deadline and reports sequential validated probes", async () => {
    const config = await readinessFixture();
    const run = vi.spyOn(tools, "runBounded");
    const events: ReadinessProbeEvent[] = [];
    await inspectLocalReadiness(config, undefined, (event) =>
      events.push(event),
    );
    const version = run.mock.calls.find(([, args]) =>
      args.includes("--version"),
    );
    expect(version?.[2].timeout_ms).toBe(30_000);
    expect(events.map(({ probe, state }) => ({ probe, state }))).toEqual([
      { probe: "engine-doctor", state: "started" },
      { probe: "engine-doctor", state: "completed" },
      { probe: "downloader-version", state: "started" },
      { probe: "downloader-version", state: "completed" },
      { probe: "downloader-help", state: "started" },
      { probe: "downloader-help", state: "completed" },
    ]);
    for (const event of events) {
      expect(Number.isFinite(event.duration_ms)).toBe(true);
      expect(event.duration_ms).toBeGreaterThanOrEqual(0);
      expect(event.error_code).toBeUndefined();
    }
  });

  it("preserves a real subprocess failure while dropping stderr and private paths", async () => {
    const config = await readinessFixture({
      failure_probe: "downloader-version",
    });
    const events: ReadinessProbeEvent[] = [];
    await expect(
      inspectLocalReadiness(config, undefined, (event) => events.push(event)),
    ).rejects.toMatchObject({ code: "TOOL_FAILED" });
    expect(events.at(-1)).toMatchObject({
      probe: "downloader-version",
      state: "failed",
      error_code: "TOOL_FAILED",
    });
    expect(events.some((event) => event.probe === "downloader-help")).toBe(
      false,
    );
    expect(JSON.stringify(events)).not.toContain(config.root);
    expect(JSON.stringify(events)).not.toContain("private path/token");
  });

  it.each([
    [
      "not JSON private-path/token",
      "ENGINE_DOCTOR_INVALID",
      "ENGINE_DOCTOR_INVALID",
    ],
    [
      '{"ready":false,"code":"SECRET_TEST_TOKEN_VALUE"}',
      "SECRET_TEST_TOKEN_VALUE",
      "READINESS_PROBE_FAILED",
    ],
  ])(
    "reports safe output validation failure without changing the original error",
    async (doctor_output, original, projected) => {
      const config = await readinessFixture({ doctor_output });
      const events: ReadinessProbeEvent[] = [];
      await expect(
        inspectLocalReadiness(config, undefined, (event) => events.push(event)),
      ).rejects.toMatchObject({ code: original });
      expect(events.at(-1)).toMatchObject({
        probe: "engine-doctor",
        state: "failed",
        error_code: projected,
      });
      expect(JSON.stringify(events)).not.toContain("SECRET_TEST_TOKEN_VALUE");
      expect(JSON.stringify(events)).not.toContain("private-path/token");
    },
  );

  it("includes the optional EJS probe and treats missing capability as a failure", async () => {
    const config = await readinessFixture({
      python_downloader: true,
      ejs_output: "missing",
    });
    const events: ReadinessProbeEvent[] = [];
    await expect(
      inspectLocalReadiness(config, undefined, (event) => events.push(event)),
    ).rejects.toMatchObject({ code: "YT_DLP_EJS_MISSING" });
    expect(
      events.slice(-2).map(({ probe, state }) => ({ probe, state })),
    ).toEqual([
      { probe: "downloader-ejs", state: "started" },
      { probe: "downloader-ejs", state: "failed" },
    ]);
    expect(events.at(-1)?.error_code).toBe("YT_DLP_EJS_MISSING");
  });

  it("keeps cancellation authoritative even when the observer throws", async () => {
    const config = await readinessFixture();
    const controller = new AbortController();
    controller.abort();
    const observer = vi.fn((_event: ReadinessProbeEvent) => {
      throw new Error("fixture observer error");
    });
    await expect(
      inspectLocalReadiness(config, controller.signal, observer),
    ).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(observer.mock.calls.at(-1)?.[0]).toMatchObject({
      probe: "engine-doctor",
      state: "failed",
      error_code: "CANCELLED",
    });
  });

  it.each([false, true])(
    "ignores synchronous or asynchronous observer errors on successful probes",
    async (asynchronous) => {
      const config = await readinessFixture();
      const observer = vi.fn((_event: ReadinessProbeEvent) => {
        if (asynchronous)
          return Promise.reject(new Error("fixture observer error"));
        throw new Error("fixture observer error");
      });
      await expect(
        inspectLocalReadiness(config, undefined, observer),
      ).resolves.toBeUndefined();
      expect(observer).toHaveBeenCalledTimes(6);
    },
  );
});

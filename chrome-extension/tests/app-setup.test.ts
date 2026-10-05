import {
  chmod,
  mkdtemp,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeResourceProbe } from "../../worker/src/runtime/resource-limits.js";
import {
  withSetupLock,
  downloadModel,
  extensionOrigin,
  inspectAppStatus,
  launcherContents,
  MODEL,
  modelPath,
  privateDirectory,
  registerNativeHost,
  registrationPaths,
  setupApp,
  verifyModel,
} from "../src/companion/app-setup.js";
import * as downloaderModule from "../src/companion/downloader-bundle.js";
import * as configModule from "../src/companion/config.js";
import * as youtubeRuntime from "../src/companion/youtube-runtime.js";
import * as tools from "../src/companion/local-provider.js";
import * as diagnosticIdentity from "../src/companion/diagnostic-identity.js";
import { checkInstallation } from "../src/companion/installation-check.js";
import { type LocalConfig } from "../src/companion/config.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

const roots: string[] = [];
const adequateResources: RuntimeResourceProbe = {
  availableDiskBytes: async () => 100_000_000_000n,
  availableMemoryBytes: async () => 100_000_000_000n,
};
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.createReadStream).mockClear();
  const crypto =
    await vi.importActual<typeof import("node:crypto")>("node:crypto");
  vi.mocked(createHash).mockReset().mockImplementation(crypto.createHash);
  const os = await vi.importActual<typeof import("node:os")>("node:os");
  vi.mocked(homedir).mockReset().mockImplementation(os.homedir);
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(): Promise<{ config: LocalConfig; userHome: string }> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-app-test-"));
  roots.push(root);
  const resources = join(root, "Test App's.app", "Contents", "Resources");
  const state = join(root, "state");
  const runtime = join(state, "runtime/releases/macos-arm64-test-v1/runtime");
  await mkdir(join(resources, "extension"), { recursive: true });
  const source = JSON.parse(
    await readFile(
      join(import.meta.dirname, "../src/extension/static/manifest.json"),
      "utf8",
    ),
  ) as object;
  await writeFile(
    join(resources, "extension/manifest.json"),
    JSON.stringify(source),
  );
  const config: LocalConfig = {
    app_resources: resources,
    root: state,
    cache_root: join(state, "cache"),
    logs_root: join(state, "logs"),
    models_root: join(state, "models"),
    runtime_id: "macos-arm64-test-v1",
    runtime_root: runtime,
    python_path: join(runtime, "runtime/python/bin/python3"),
    node_path: join(runtime, "runtime/node/bin/node"),
    ffmpeg_path: join(runtime, "runtime/bin/ffmpeg"),
    ffprobe_path: join(runtime, "runtime/bin/ffprobe"),
    yt_dlp_path: join(runtime, "tools/yt-dlp"),
    js_runtime_path: join(runtime, "runtime/node/bin/node"),
    engine_root: join(runtime, "app/engine"),
    runner_path: join(resources, "engine/local_pipeline.py"),
  };
  return { config, userHome: join(root, "user's home") };
}

async function metadataReadyFixture(): Promise<{
  config: LocalConfig;
  userHome: string;
}> {
  const result = await fixture();
  const { config, userHome } = result;
  config.downloader_bundle_root = join(
    config.runtime_root!,
    "tools/downloader",
  );
  config.downloader_bootstrap_path = join(
    config.app_resources!,
    "engine/downloader_bootstrap.py",
  );
  config.youtube_runtime_root = join(config.runtime_root!, "tools/youtube");
  config.js_runtime_path = join(config.youtube_runtime_root, "bin/deno");
  await mkdir(config.engine_root, { recursive: true, mode: 0o700 });
  await mkdir(join(config.youtube_runtime_root, "provider/node_modules"), {
    recursive: true,
    mode: 0o700,
  });
  for (const path of [
    config.python_path,
    config.node_path,
    config.ffmpeg_path,
    config.ffprobe_path,
    config.yt_dlp_path,
    config.js_runtime_path,
  ]) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, "installed fixture", { mode: 0o700 });
  }
  for (const path of [
    config.runner_path,
    config.downloader_bootstrap_path,
    join(config.downloader_bundle_root, "identity.json"),
    ...[
      "identity.json",
      "provider/src/generate_once.ts",
      "provider/src/session_manager.ts",
      "provider/deno.json",
      "provider/deno.lock",
    ].map((path) => join(config.youtube_runtime_root!, path)),
  ]) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, "installed fixture", { mode: 0o600 });
  }
  for (const entry of [
    { path: modelPath(config), bytes: MODEL.bytes },
    ...downloaderModule.DOWNLOADER_WHEELS.map((wheel) => ({
      path: join(config.downloader_bundle_root!, wheel.file),
      bytes: wheel.bytes,
    })),
  ]) {
    await mkdir(dirname(entry.path), { recursive: true, mode: 0o700 });
    const file = await open(entry.path, "wx", 0o600);
    await file.truncate(entry.bytes);
    await file.close();
  }
  await registerNativeHost(config, userHome);
  return result;
}

async function setupReadinessRecord(
  config: LocalConfig,
  fields: Record<string, unknown> = {},
): Promise<void> {
  const app = await stat(config.app_resources!);
  await writeFile(
    join(config.root, "setup-readiness-v1.json"),
    JSON.stringify({
      schema_version: 1,
      identity: JSON.stringify([
        config.app_resources,
        app.dev,
        app.ino,
        app.mtimeMs,
        app.ctimeMs,
        config.runtime_id ?? null,
        config.runtime_root ?? null,
        "0.1.0",
      ]),
      downloader: true,
      javascript: true,
      token_provider: true,
      errors: {},
      ...fields,
    }),
    { mode: 0o600 },
  );
}
describe("standalone app setup", () => {
  it("reads a protected bundled manifest installed by another Mac account", async () => {
    const { config } = await fixture();
    vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    expect(await extensionOrigin(config.app_resources!)).toBe(
      "chrome-extension://dclpfemnpknfdlpcbfcjkmdbnociippd/",
    );
    await expect(privateDirectory(config.root)).rejects.toMatchObject({
      code: "LOCAL_DIRECTORY_NOT_PRIVATE",
    });
    await chmod(join(config.app_resources!, "extension/manifest.json"), 0o666);
    await expect(extensionOrigin(config.app_resources!)).rejects.toMatchObject({
      code: "UNSAFE_SETUP_FILE",
    });
  });

  it("registers the exact origin and invokes only the quoted native app entrypoint", async () => {
    const { config, userHome } = await fixture();
    expect(await extensionOrigin(config.app_resources!)).toBe(
      "chrome-extension://dclpfemnpknfdlpcbfcjkmdbnociippd/",
    );
    await registerNativeHost(config, userHome);
    const paths = registrationPaths(config, userHome);
    const manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
    expect(manifest.path).toBe(paths.launcher);
    expect(manifest.allowed_origins).toEqual([
      await extensionOrigin(config.app_resources!),
    ]);
    const script = await readFile(paths.launcher, "utf8");
    const appExecutable = join(
      config.app_resources!,
      "..",
      "MacOS",
      "MusicMuteLocal",
    );
    expect(script).toBe(launcherContents(config, userHome));
    expect(script).toBe(
      [
        "#!/bin/sh",
        "# MusicMute Local companion launcher v1",
        `exec /usr/bin/env -i HOME='${userHome.replaceAll("'", "'\\''")}' PATH='/usr/bin:/bin' LANG='en_US.UTF-8' '${appExecutable.replaceAll("'", "'\\''")}' --native-host "$@"`,
        "",
      ].join("\n"),
    );
    expect(script).toContain("'\\''");
    expect(script).toContain(`'${appExecutable.replaceAll("'", "'\\''")}'`);
    expect(script).toContain(' --native-host "$@"');
    expect(script).not.toContain(config.root);
    expect(script).not.toContain(config.app_resources!);
    expect(script).not.toContain(config.runtime_root!);
    expect(script).not.toContain(config.python_path);
    expect(script).not.toContain(config.node_path);
    expect(script).not.toContain("python");
    expect(script).not.toContain("node");
    expect(script).not.toContain("MUSICMUTE_");
    expect(script).not.toContain("native-lock.py");
    expect(script).not.toContain("host.js");
    expect(script).not.toContain("MusicMuteWorker");
    expect((await stat(paths.launcher)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.manifest)).mode & 0o777).toBe(0o600);
    await registerNativeHost(config, userHome);
    const status = await inspectAppStatus(config, userHome);
    expect(status.extension_registered).toBe(true);
    expect(status.ready).toBe(false);
    expect(status.model_ready).toBe(false);
  });
  it("reads installed metadata without hashing content or executing readiness probes", async () => {
    const { config, userHome } = await metadataReadyFixture();
    const downloader = vi.spyOn(downloaderModule, "verifyDownloaderBundle");
    const youtube = vi.spyOn(youtubeRuntime, "verifyYoutubeRuntime");
    const localCheck = vi.spyOn(configModule, "inspectLocalReadiness");
    const youtubeCheck = vi.spyOn(configModule, "inspectYouTubeReadiness");
    const run = vi.spyOn(tools, "runBounded");
    vi.mocked(fs.createReadStream).mockClear();

    const status = await inspectAppStatus(config, userHome);

    expect(status).toMatchObject({
      ready: true,
      runtime_ready: true,
      model_ready: true,
      youtube_ready: true,
    });
    expect(downloader).not.toHaveBeenCalled();
    expect(youtube).not.toHaveBeenCalled();
    expect(localCheck).not.toHaveBeenCalled();
    expect(youtubeCheck).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(fs.createReadStream).not.toHaveBeenCalled();
    // These sparse fixture bytes deliberately fail an actual content check.
    expect(await verifyModel(config)).toBe(false);
    expect(fs.createReadStream).toHaveBeenCalledWith(modelPath(config));
  });

  it("requires the app-owned bootstrap's metadata when reusing an installed runtime", async () => {
    const { config, userHome } = await metadataReadyFixture();
    await unlink(config.downloader_bootstrap_path!);

    const status = await inspectAppStatus(config, userHome);

    expect(status.local_processing_ready).toBe(true);
    expect(status.downloader_ready).toBe(false);
    expect(status.youtube_ready).toBe(false);
  });

  it.each(["missing", "truncated", "unreadable", "symlink", "foreign"])(
    "reports a %s model safely without reading or hashing it",
    async (caseName) => {
      const { config, userHome } = await metadataReadyFixture();
      const path = modelPath(config);
      if (caseName === "missing") await unlink(path);
      if (caseName === "truncated") {
        const file = await open(path, "r+");
        await file.truncate(1);
        await file.close();
      }
      if (caseName === "unreadable") await chmod(path, 0o000);
      if (caseName === "symlink") {
        await rename(path, `${path}.retained`);
        await symlink(`${path}.retained`, path);
      }
      if (caseName === "foreign")
        vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
      vi.mocked(fs.createReadStream).mockClear();

      const status = await inspectAppStatus(config, userHome);

      expect(status.model_ready).toBe(false);
      expect(status.ready).toBe(false);
      expect(fs.createReadStream).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "unreadable", "directory", "escaped_link"])(
    "reports a %s runtime executable safely without launching it",
    async (caseName) => {
      const { config, userHome } = await metadataReadyFixture();
      const path = config.python_path;
      if (caseName === "missing") await unlink(path);
      if (caseName === "unreadable") await chmod(path, 0o000);
      if (caseName === "directory") {
        await unlink(path);
        await mkdir(path, { mode: 0o700 });
      }
      if (caseName === "escaped_link") {
        await unlink(path);
        await symlink(process.execPath, path);
      }
      const run = vi.spyOn(tools, "runBounded");

      const status = await inspectAppStatus(config, userHome);

      expect(status.runtime_ready).toBe(false);
      expect(status.ready).toBe(false);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("accepts the installed Python symlink only within the selected runtime", async () => {
    const { config, userHome } = await metadataReadyFixture();
    await rename(config.python_path, `${config.python_path}.real`);
    await symlink("python3.real", config.python_path);

    expect((await inspectAppStatus(config, userHome)).runtime_ready).toBe(true);
  });

  it("still hashes an existing model during explicit Prepare", async () => {
    const { config } = await metadataReadyFixture();
    const check = vi.spyOn(configModule, "inspectLocalReadiness");
    vi.mocked(fs.createReadStream).mockClear();

    await expect(
      setupApp(config, new AbortController().signal, () => {}),
    ).rejects.toMatchObject({ code: "MODEL_CACHE_INVALID" });

    expect(fs.createReadStream).toHaveBeenCalledWith(modelPath(config));
    expect(check).not.toHaveBeenCalled();
  });

  it("runs full readiness during Prepare once and reuses its recorded result for status", async () => {
    const { config, userHome } = await metadataReadyFixture();
    vi.mocked(homedir).mockReturnValue(userHome);
    // The sparse model represents a previously verified installation for this
    // routing test. The preceding test exercises real checksum rejection.
    const hash = createHash("sha256");
    vi.spyOn(hash, "digest").mockReturnValue(MODEL.sha256);
    vi.mocked(createHash).mockReturnValueOnce(hash);
    const localCheck = vi
      .spyOn(configModule, "inspectLocalReadiness")
      .mockResolvedValue();
    const youtubeCheck = vi
      .spyOn(configModule, "inspectYouTubeReadiness")
      .mockImplementation(async (_config, _signal, observer) => {
        observer?.({
          probe: "downloader-ejs",
          state: "completed",
          duration_ms: 1,
        });
        observer?.({
          probe: "javascript-runtime",
          state: "completed",
          duration_ms: 1,
        });
        observer?.({
          probe: "token-provider",
          state: "completed",
          duration_ms: 1,
        });
      });
    vi.mocked(fs.createReadStream).mockClear();

    const prepared = await setupApp(
      config,
      new AbortController().signal,
      () => {},
    );
    const subsequent = await inspectAppStatus(config, userHome);

    expect(prepared.youtube_ready).toBe(true);
    expect(subsequent.youtube_ready).toBe(true);
    expect(localCheck).toHaveBeenCalledTimes(1);
    expect(youtubeCheck).toHaveBeenCalledTimes(1);
    expect(fs.createReadStream).toHaveBeenCalledTimes(1);
    expect(fs.createReadStream).toHaveBeenCalledWith(modelPath(config));
    const record = join(config.root, "setup-readiness-v1.json");
    expect((await stat(record)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(record, "utf8"))).toMatchObject({
      schema_version: 1,
      downloader: true,
      javascript: true,
      token_provider: true,
      errors: {},
    });
  });

  it("keeps the GUI status command free of optional inventory fingerprinting", async () => {
    const { config } = await metadataReadyFixture();
    vi.spyOn(configModule, "loadLocalConfig").mockResolvedValue(config);
    const identity = vi
      .spyOn(diagnosticIdentity, "resolveDiagnosticIdentity")
      .mockImplementation(() => {
        throw new Error("GUI status must not read the package inventory");
      });
    const lines: string[] = [];
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((line) => {
        lines.push(String(line));
        return true;
      });
    const argv = process.argv;
    const exitCode = process.exitCode;
    const mask = process.umask();
    const before = {
      SIGTERM: process.listeners("SIGTERM"),
      SIGINT: process.listeners("SIGINT"),
    };
    try {
      process.argv = [process.execPath, "fixture-app-control", "status"];
      await import("../src/companion/app-control.js");
    } finally {
      output.mockRestore();
      process.argv = argv;
      process.exitCode = exitCode;
      process.umask(mask);
      for (const signal of ["SIGTERM", "SIGINT"] as const)
        for (const listener of process.listeners(signal))
          if (!before[signal].includes(listener))
            process.removeListener(signal, listener);
    }

    expect(identity).not.toHaveBeenCalled();
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        protocol_version: 1,
        type: "result",
        status: expect.objectContaining({
          runtime_ready: true,
          model_ready: true,
        }),
      }),
    );
  });
  it("upgrades an owned legacy managed-runtime launcher in place", async () => {
    const { config, userHome } = await fixture();
    await registerNativeHost(config, userHome);
    const paths = registrationPaths(config, userHome);
    await writeFile(
      paths.launcher,
      [
        "#!/bin/sh",
        "# MusicMute Local companion launcher v1",
        `exec '${config.python_path}' -B '${join(config.app_resources!, "scripts/native-lock.py")}' '${config.node_path}' '${join(config.app_resources!, "companion/host.js")}' "$@"`,
        "",
      ].join("\n"),
    );
    expect(
      (await inspectAppStatus(config, userHome)).extension_registered,
    ).toBe(false);

    await registerNativeHost(config, userHome);

    const repaired = await readFile(paths.launcher, "utf8");
    expect(repaired).toBe(launcherContents(config, userHome));
    expect(repaired).not.toContain(config.python_path);
    expect(repaired).not.toContain(config.node_path);
    expect(
      (await inspectAppStatus(config, userHome)).extension_registered,
    ).toBe(true);
  });
  it("repairs app relocation but preserves a foreign native registration", async () => {
    const { config, userHome } = await fixture();
    await registerNativeHost(config, userHome);
    const oldResources = config.app_resources!;
    const oldApp = join(oldResources, "..", "..");
    const movedApp = join(oldApp, "..", "Moved App's.app");
    const movedResources = join(movedApp, "Contents", "Resources");
    await rename(oldApp, movedApp);
    const moved = {
      ...config,
      app_resources: movedResources,
      runner_path: join(movedResources, "engine/local_pipeline.py"),
    };
    expect(moved.runtime_root).toBe(config.runtime_root);
    expect((await inspectAppStatus(moved, userHome)).extension_registered).toBe(
      false,
    );
    await registerNativeHost(moved, userHome);
    expect((await inspectAppStatus(moved, userHome)).extension_registered).toBe(
      true,
    );
    const paths = registrationPaths(config, userHome);
    const repaired = await readFile(paths.launcher, "utf8");
    expect(repaired).toBe(launcherContents(moved, userHome));
    expect(repaired).not.toBe(launcherContents(config, userHome));
    expect((await inspectAppStatus(moved, userHome)).extension_path).toBe(
      join(movedResources, "extension"),
    );
    const foreign = JSON.stringify({
      name: "com.musicmute.local",
      path: "/foreign/helper",
      allowed_origins: [await extensionOrigin(moved.app_resources!)],
    });
    await writeFile(paths.manifest, foreign);
    await expect(registerNativeHost(moved, userHome)).rejects.toMatchObject({
      code: "FOREIGN_NATIVE_REGISTRATION_EXISTS",
    });
    expect(await readFile(paths.manifest, "utf8")).toBe(foreign);
  });
  it("repairs a reinstall when Chrome retains the manifest but the launcher is missing", async () => {
    const { config, userHome } = await fixture();
    await registerNativeHost(config, userHome);
    const paths = registrationPaths(config, userHome);
    const manifest = await readFile(paths.manifest, "utf8");
    await unlink(paths.launcher);
    expect(
      (await inspectAppStatus(config, userHome)).extension_registered,
    ).toBe(false);

    await registerNativeHost(config, userHome);

    expect(await readFile(paths.manifest, "utf8")).toBe(manifest);
    expect(await readFile(paths.launcher, "utf8")).toBe(
      launcherContents(config, userHome),
    );
    expect((await stat(paths.launcher)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.manifest)).mode & 0o777).toBe(0o600);
    expect(
      (await inspectAppStatus(config, userHome)).extension_registered,
    ).toBe(true);
  });
  it.each(["path", "name", "type", "allowed_origins"])(
    "preserves a foreign %s when its registered launcher is missing",
    async (field) => {
      const { config, userHome } = await fixture();
      await registerNativeHost(config, userHome);
      const paths = registrationPaths(config, userHome);
      const manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
      manifest[field] =
        field === "allowed_origins"
          ? ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"]
          : "foreign";
      const foreign = JSON.stringify(manifest);
      await writeFile(paths.manifest, foreign);
      await unlink(paths.launcher);

      await expect(registerNativeHost(config, userHome)).rejects.toMatchObject({
        code: "FOREIGN_NATIVE_REGISTRATION_EXISTS",
      });
      expect(await readFile(paths.manifest, "utf8")).toBe(foreign);
      await expect(stat(paths.launcher)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
  it("preserves an existing foreign launcher behind an otherwise matching registration", async () => {
    const { config, userHome } = await fixture();
    await registerNativeHost(config, userHome);
    const paths = registrationPaths(config, userHome);
    const manifest = await readFile(paths.manifest, "utf8");
    const foreign = "#!/bin/sh\n# another application's launcher\n";
    await writeFile(paths.launcher, foreign);

    await expect(registerNativeHost(config, userHome)).rejects.toMatchObject({
      code: "FOREIGN_NATIVE_LAUNCHER_EXISTS",
    });
    expect(await readFile(paths.launcher, "utf8")).toBe(foreign);
    expect(await readFile(paths.manifest, "utf8")).toBe(manifest);
  });
  it("preserves a dangling launcher symlink instead of treating it as missing", async () => {
    const { config, userHome } = await fixture();
    await registerNativeHost(config, userHome);
    const paths = registrationPaths(config, userHome);
    const manifest = await readFile(paths.manifest, "utf8");
    await unlink(paths.launcher);
    await symlink(join(config.root, "missing-target"), paths.launcher);

    await expect(registerNativeHost(config, userHome)).rejects.toMatchObject({
      code: "UNSAFE_SETUP_FILE",
    });
    expect(await readFile(paths.manifest, "utf8")).toBe(manifest);
  });
  it("refuses symlink data roots and foreign launchers", async () => {
    const { config, userHome } = await fixture();
    await symlink(config.app_resources!, config.root);
    await expect(privateDirectory(config.root)).rejects.toMatchObject({
      code: "LOCAL_DIRECTORY_NOT_PRIVATE",
    });
    await rm(config.root);
    await privateDirectory(config.root);
    await writeFile(
      registrationPaths(config, userHome).launcher,
      "foreign executable",
    );
    await expect(registerNativeHost(config, userHome)).rejects.toMatchObject({
      code: "FOREIGN_NATIVE_LAUNCHER_EXISTS",
    });
  });
  it("uses a kernel setup lock and preserves its inode across successive operations", async () => {
    const { config } = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const active = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = withSetupLock(config.root, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await active;
    const inode = (await stat(join(config.root, "setup.lock"))).ino;
    await expect(
      withSetupLock(config.root, async () => {}),
    ).rejects.toMatchObject({ code: "SETUP_BUSY" });
    release();
    await first;
    await withSetupLock(config.root, async () => {});
    expect((await stat(join(config.root, "setup.lock"))).ino).toBe(inode);
  });
  it("rejects unapproved model redirects without fetching the destination", async () => {
    const { config } = await fixture();
    await privateDirectory(config.root);
    const fetcher = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://unapproved.example/model" },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      downloadModel(
        config,
        new AbortController().signal,
        () => {},
        adequateResources,
      ),
    ).rejects.toMatchObject({ code: "MODEL_SOURCE_INVALID" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(MODEL.url);
    await expect(stat(modelPath(config))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("rejects wrong bytes and preserves an existing invalid model for review", async () => {
    const { config } = await fixture();
    await privateDirectory(config.root);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("corrupt")));
    await expect(
      downloadModel(
        config,
        new AbortController().signal,
        () => {},
        adequateResources,
      ),
    ).rejects.toMatchObject({ code: "MODEL_CHECKSUM_INVALID" });
    await expect(stat(modelPath(config))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeFile(modelPath(config), "foreign bytes", { mode: 0o600 });
    await expect(
      downloadModel(
        config,
        new AbortController().signal,
        () => {},
        adequateResources,
      ),
    ).rejects.toMatchObject({ code: "MODEL_CACHE_INVALID" });
    expect(await readFile(modelPath(config), "utf8")).toBe("foreign bytes");
  });
  it("honors cancelled setup without publishing a model", async () => {
    const { config } = await fixture();
    await privateDirectory(config.root);
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn(
      async (_url: string, options: { signal: AbortSignal }) => {
        options.signal.throwIfAborted();
        return new Response();
      },
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      downloadModel(config, controller.signal, () => {}, adequateResources),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(stat(modelPath(config))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it.each(["disk", "memory"] as const)(
    "rejects low %s before any model network request or publication",
    async (resource) => {
      const { config } = await fixture();
      await privateDirectory(config.root);
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const probe = {
        availableDiskBytes: async () =>
          resource === "disk" ? 0n : 100_000_000_000n,
        availableMemoryBytes: async () =>
          resource === "memory" ? 0n : 100_000_000_000n,
      };
      await expect(
        downloadModel(config, new AbortController().signal, () => {}, probe),
      ).rejects.toMatchObject({
        code: resource === "disk" ? "DISK_SPACE_LOW" : "MEMORY_LOW",
      });
      expect(fetcher).not.toHaveBeenCalled();
      await expect(stat(modelPath(config))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
  it("preserves an explicit Prepare failure without rerunning its tool probe", async () => {
    const { config, userHome } = await metadataReadyFixture();
    await setupReadinessRecord(config, {
      javascript: false,
      token_provider: false,
      errors: { javascript: "DENO_VERSION_INVALID" },
    });
    const check = vi.spyOn(configModule, "inspectYouTubeReadiness");

    const status = await inspectAppStatus(config, userHome);

    expect(status.local_processing_ready).toBe(true);
    expect(status.youtube_ready).toBe(false);
    expect(status.javascript_ready).toBe(false);
    expect(status.components).toContainEqual({
      component: "javascript",
      state: "invalid",
      error_code: "DENO_VERSION_INVALID",
    });
    expect(check).not.toHaveBeenCalled();
  });

  it("clears saved Prepare failures only after the explicit installation check succeeds", async () => {
    const { config, userHome } = await metadataReadyFixture();
    await setupReadinessRecord(config, {
      engine: false,
      model: false,
      javascript: false,
      token_provider: false,
      errors: {
        engine: "ENGINE_NOT_READY",
        model: "MODEL_CHECKSUM_INVALID",
        javascript: "DENO_VERSION_INVALID",
        token_provider: "PO_TOKEN_PROVIDER_INVALID",
      },
    });
    const inspect = {
      runtime: vi.fn(async () => {}),
      model: vi.fn(async () => {}),
      youtube_tools: vi.fn(async () => {}),
    };
    expect((await inspectAppStatus(config, userHome)).youtube_ready).toBe(
      false,
    );

    const result = await checkInstallation(
      config,
      "a".repeat(64),
      new AbortController().signal,
      () => {},
      inspect,
    );

    expect(result.state).toBe("passed");
    expect((await inspectAppStatus(config, userHome)).youtube_ready).toBe(true);
    expect(inspect.model).toHaveBeenCalledTimes(1);
    expect(inspect.youtube_tools).toHaveBeenCalledTimes(1);
    const record = join(config.root, "setup-readiness-v1.json");
    expect(JSON.parse(await readFile(record, "utf8"))).toMatchObject({
      engine: true,
      model: true,
      downloader: true,
      javascript: true,
      token_provider: true,
      errors: {},
    });
  });

  it("preserves pending component failures when runtime integrity prevents their checks", async () => {
    const { config, userHome } = await metadataReadyFixture();
    await setupReadinessRecord(config, {
      model: false,
      javascript: false,
      token_provider: false,
      errors: {
        model: "MODEL_CHECKSUM_INVALID",
        javascript: "DENO_VERSION_INVALID",
        token_provider: "PO_TOKEN_PROVIDER_INVALID",
      },
    });
    const inspect = {
      runtime: vi.fn(async () => {
        throw new Error("APP_SIGNATURE_INVALID");
      }),
      model: vi.fn(async () => {}),
      youtube_tools: vi.fn(async () => {}),
    };

    await checkInstallation(
      config,
      "a".repeat(64),
      new AbortController().signal,
      () => {},
      inspect,
    );

    const status = await inspectAppStatus(config, userHome);
    expect(status.runtime_ready).toBe(false);
    expect(status.components).toEqual(
      expect.arrayContaining([
        {
          component: "engine",
          state: "invalid",
          error_code: "APP_SIGNATURE_INVALID",
        },
        {
          component: "model",
          state: "invalid",
          error_code: "MODEL_CHECKSUM_INVALID",
        },
        {
          component: "javascript",
          state: "invalid",
          error_code: "DENO_VERSION_INVALID",
        },
        {
          component: "token_provider",
          state: "invalid",
          error_code: "PO_TOKEN_PROVIDER_INVALID",
        },
      ]),
    );
    expect(inspect.model).not.toHaveBeenCalled();
    expect(inspect.youtube_tools).not.toHaveBeenCalled();
  });

  it.each(["MODEL_CHECKSUM_INVALID", "ENGINE_NOT_READY"])(
    "retains a diagnosed %s failure after the manual check completes",
    async (code) => {
      const { config, userHome } = await metadataReadyFixture();
      await setupReadinessRecord(config, { engine: true, model: true });
      await checkInstallation(
        config,
        "a".repeat(64),
        new AbortController().signal,
        () => {},
        {
          runtime: async () => {},
          model: async () => {
            throw new Error(code);
          },
          youtube_tools: async () => {},
        },
      );

      const status = await inspectAppStatus(config, userHome);
      expect(status.components).toContainEqual({
        component: code.startsWith("MODEL_") ? "model" : "engine",
        state: "invalid",
        error_code: code,
      });
      expect(status.local_processing_ready).toBe(false);
    },
  );

  it("records completed YouTube subprobes while retaining the diagnosed failing and pending tools", async () => {
    const { config, userHome } = await metadataReadyFixture();
    await setupReadinessRecord(config, {
      downloader: false,
      javascript: false,
      token_provider: false,
      errors: {
        downloader: "YT_DLP_EJS_MISSING",
        javascript: "DENO_MISSING",
        token_provider: "PO_TOKEN_PROVIDER_INVALID",
      },
    });
    vi.spyOn(tools, "runBounded").mockResolvedValue({
      stdout: '{"ready":true}',
    });
    vi.spyOn(configModule, "inspectLocalReadiness").mockResolvedValue();
    const youtubeCheck = vi
      .spyOn(configModule, "inspectYouTubeReadiness")
      .mockImplementation(async (_config, _signal, observer) => {
        observer?.({
          probe: "downloader-ejs",
          state: "completed",
          duration_ms: 1,
        });
        observer?.({
          probe: "javascript-runtime",
          state: "started",
          duration_ms: 0,
        });
        throw new configModule.LocalSetupError("DENO_VERSION_INVALID");
      });

    await checkInstallation(
      config,
      "a".repeat(64),
      new AbortController().signal,
      () => {},
    );

    const status = await inspectAppStatus(config, userHome);
    expect(status.downloader_ready).toBe(true);
    expect(status.javascript_ready).toBe(false);
    expect(status.token_provider_ready).toBe(false);
    expect(status.components).toContainEqual({
      component: "javascript",
      state: "invalid",
      error_code: "DENO_VERSION_INVALID",
    });
    expect(status.components).toContainEqual({
      component: "token_provider",
      state: "invalid",
      error_code: "PO_TOKEN_PROVIDER_INVALID",
    });
    expect(youtubeCheck).toHaveBeenCalledTimes(1);
  });

  it.each(["cancelled", "disconnected", "replaced_app"])(
    "preserves previous readiness when the manual check is %s",
    async (caseName) => {
      const { config } = await metadataReadyFixture();
      await setupReadinessRecord(config, {
        javascript: false,
        errors: { javascript: "DENO_VERSION_INVALID" },
      });
      const record = join(config.root, "setup-readiness-v1.json");
      const before = await readFile(record, "utf8");
      const controller = new AbortController();
      const check = checkInstallation(
        config,
        "a".repeat(64),
        controller.signal,
        (status) => {
          if (
            caseName === "disconnected" &&
            status.checks[0]?.state === "passed"
          )
            throw new Error("NATIVE_DISCONNECTED");
        },
        {
          runtime: async () => {},
          model: async () => {},
          youtube_tools: async () => {
            if (caseName === "cancelled") controller.abort();
            if (caseName === "replaced_app")
              await writeFile(
                join(config.app_resources!, "new-build"),
                "fixture",
              );
          },
        },
      );
      if (caseName === "disconnected")
        await expect(check).rejects.toThrow("NATIVE_DISCONNECTED");
      else await check;

      expect(await readFile(record, "utf8")).toBe(before);
    },
  );

  it.each(["different_runtime", "malformed", "public", "replacement_app"])(
    "ignores %s saved readiness without probing tools or blocking installed metadata",
    async (caseName) => {
      const { config, userHome } = await metadataReadyFixture();
      await setupReadinessRecord(config, {
        javascript: false,
        errors: { javascript: "DENO_VERSION_INVALID" },
      });
      const record = join(config.root, "setup-readiness-v1.json");
      if (caseName === "different_runtime") config.runtime_id = "next-runtime";
      if (caseName === "malformed") await writeFile(record, "{");
      if (caseName === "public") await chmod(record, 0o644);
      if (caseName === "replacement_app")
        await writeFile(join(config.app_resources!, "new-build"), "fixture");
      const check = vi.spyOn(configModule, "inspectYouTubeReadiness");

      expect((await inspectAppStatus(config, userHome)).youtube_ready).toBe(
        true,
      );
      expect(check).not.toHaveBeenCalled();
    },
  );
  it("does not depend on the developer user's model or runtime directories", async () => {
    const { config, userHome } = await fixture();
    const status = await inspectAppStatus(config, userHome);
    expect(status.extension_path).toBe(
      join(config.app_resources!, "extension"),
    );
    expect(config.models_root).not.toContain(
      join(homedir(), "Library/Application Support/MusicMuteWorker"),
    );
  });
});

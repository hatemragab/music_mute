import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  DOWNLOADER_BOOTSTRAP,
  DOWNLOADER_WHEELS,
  verifyDownloaderBundle,
} from "../dist/companion/downloader-bundle.js";
import { MODEL } from "../dist/companion/app-setup.js";
import {
  assertNotarizationLoadCommands,
  parsePackageMode,
  resolveSigningConfiguration,
  signingArguments,
  verifyDeveloperIdSignature,
} from "./macos-signing.mjs";
import {
  packageFailureReport,
  writePackageFailure,
} from "./macos-package-failure.mjs";
import {
  stageSparkle,
  packagingUpdaterConfiguration,
} from "./sparkle-artifacts.mjs";
import {
  createMacRuntimeArtifact,
  macosSetupMetadata,
  macosSteadyStateBytes,
  reuseMacRuntimeArtifact,
  runtimeDownloadConfiguration,
  verifyRuntimeCodeSignature,
} from "./macos-runtime-artifact.mjs";
import { verifyYoutubeRuntime } from "../dist/companion/youtube-runtime.js";
import { refreshYoutubeRuntimeIdentity } from "./youtube-runtime-artifacts.mjs";

const executeTool = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const failureContext = {
  phase: "OPTIONS",
  release: false,
  build_id: null,
  build_root: null,
  bundle_path: null,
  timeout_ms: null,
  tool_failure: null,
};
const exec = async (file, args, options = {}) => {
  failureContext.timeout_ms = options.timeout ?? null;
  failureContext.tool_failure = null;
  try {
    return await executeTool(file, args, options);
  } catch (error) {
    // Safe metadata survives helpers that deliberately replace a tool's raw error.
    failureContext.tool_failure = {
      code: error?.code,
      signal: error?.signal,
      killed: error?.killed === true,
    };
    throw error;
  }
};
const stage = (phase, bundlePath = null, timeout = null) => {
  failureContext.phase = phase;
  failureContext.bundle_path = bundlePath;
  failureContext.timeout_ms = timeout;
  failureContext.tool_failure = null;
};
async function packageMacos() {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("UNSUPPORTED_PLATFORM");
  const { release } = parsePackageMode(process.argv.slice(2));
  failureContext.release = release;
  stage("IDENTITY");
  // Resolve the public identity before copying the runtime or compiling the app.
  const signing = await resolveSigningConfiguration({
    release,
    identity: process.env.MUSICMUTE_MAC_SIGN_IDENTITY,
    exec,
  });
  stage("RUNTIME_SOURCE");
  const sourceRuntime = await realpath(
    process.env.MUSICMUTE_LOCAL_RUNTIME ??
      join(
        homedir(),
        "Library/Application Support/MusicMuteWorker/runtime/current",
      ),
  );
  const runtimePackagePath = join(sourceRuntime, "app/package.json");
  let runtimeSourceVersion;
  try {
    const runtimePackageInfo = await lstat(runtimePackagePath);
    const runtimePackage = JSON.parse(
      await readFile(runtimePackagePath, "utf8"),
    );
    if (
      !runtimePackageInfo.isFile() ||
      runtimePackageInfo.isSymbolicLink() ||
      runtimePackageInfo.nlink !== 1 ||
      runtimePackageInfo.mode & 0o022 ||
      runtimePackageInfo.size < 2 ||
      runtimePackageInfo.size > 1024 * 1024 ||
      runtimePackage?.name !== "@music-mute/worker" ||
      typeof runtimePackage.version !== "string" ||
      !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(
        runtimePackage.version,
      )
    )
      throw new Error();
    runtimeSourceVersion = runtimePackage.version;
  } catch {
    throw new Error("RUNTIME_SOURCE_MANIFEST_INVALID");
  }
  const sourceDownloader =
    process.env.MUSICMUTE_LOCAL_DOWNLOADER_TARGET ??
    join(
      homedir(),
      "Library/Application Support/MusicMuteLocalMvp/tools/downloader",
    );
  const runtimeReusePackageResult =
    process.env.MUSICMUTE_RUNTIME_REUSE_PACKAGE_RESULT;
  const identity = signing.identity;
  const runtimeDownload = runtimeReusePackageResult
    ? process.env.MUSICMUTE_RUNTIME_DOWNLOAD_BASE_URL == null &&
      process.env.MUSICMUTE_RUNTIME_REDIRECT_HOSTS == null
      ? undefined
      : {
          ...(process.env.MUSICMUTE_RUNTIME_DOWNLOAD_BASE_URL == null
            ? {}
            : {
                baseURL: runtimeDownloadConfiguration({
                  baseURL: process.env.MUSICMUTE_RUNTIME_DOWNLOAD_BASE_URL,
                }).baseURL,
              }),
          ...(process.env.MUSICMUTE_RUNTIME_REDIRECT_HOSTS == null
            ? {}
            : {
                redirectHosts: process.env.MUSICMUTE_RUNTIME_REDIRECT_HOSTS,
              }),
        }
    : runtimeDownloadConfiguration({
        baseURL: process.env.MUSICMUTE_RUNTIME_DOWNLOAD_BASE_URL,
        redirectHosts: process.env.MUSICMUTE_RUNTIME_REDIRECT_HOSTS,
      });
  const packageManifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const updateConfiguration = await packagingUpdaterConfiguration({
    version: process.env.MUSICMUTE_MAC_VERSION ?? packageManifest.version,
    build:
      process.env.MUSICMUTE_MAC_BUILD ?? String(Math.floor(Date.now() / 1000)),
    feedURL: process.env.MUSICMUTE_UPDATE_FEED_URL,
    publicKey: process.env.MUSICMUTE_UPDATE_PUBLIC_ED_KEY,
    configFile: process.env.MUSICMUTE_UPDATE_CONFIG_FILE,
  });
  const buildId = randomUUID();
  const buildRoot = join(root, "output/macos", `build-${buildId}.noindex`);
  failureContext.build_id = buildId;
  failureContext.build_root = buildRoot;
  stage("COPY_RUNTIME");
  const app = join(buildRoot, "MusicMute Local.app");
  const resources = join(app, "Contents/Resources");
  const runtime = join(resources, "runtime");
  await mkdir(join(app, "Contents/MacOS"), { recursive: true });
  await mkdir(resources, { recursive: true });
  const frameworks = join(app, "Contents/Frameworks");
  stage("COPY_UPDATER");
  await stageSparkle(resources, frameworks);
  stage("COPY_APP_RESOURCES");
  await cp(join(root, "macos/Resources"), resources, { recursive: true });
  // Public Firebase client settings only. OAuth registration and all server credentials stay outside this bundle.
  if (process.env.MUSICMUTE_DESKTOP_PUBLIC_CONFIG) {
    stage("PUBLIC_CONFIG");
    let bytes;
    try {
      bytes = await readFile(process.env.MUSICMUTE_DESKTOP_PUBLIC_CONFIG);
    } catch (error) {
      throw new Error(
        error.code === "ENOENT"
          ? "DESKTOP_PUBLIC_CONFIG_MISSING"
          : "DESKTOP_PUBLIC_CONFIG_UNREADABLE",
      );
    }
    if (bytes.length > 16_384)
      throw new Error("DESKTOP_PUBLIC_CONFIG_TOO_LARGE");
    const config = JSON.parse(bytes.toString("utf8"));
    const allowed = new Set([
      "backend_base_url",
      "firebase_api_key",
      "firebase_project_id",
      "google_desktop_client_id",
    ]);
    if (
      !config ||
      Array.isArray(config) ||
      typeof config !== "object" ||
      Object.keys(config).some((key) => !allowed.has(key))
    )
      throw new Error("DESKTOP_PUBLIC_CONFIG_UNAPPROVED_FIELDS");
    const origin = new URL(config.backend_base_url);
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      !["", "/"].includes(origin.pathname) ||
      typeof config.firebase_api_key !== "string" ||
      !/^[A-Za-z0-9_-]{20,200}$/.test(config.firebase_api_key) ||
      typeof config.firebase_project_id !== "string" ||
      !/^[a-z][a-z0-9-]{4,62}$/.test(config.firebase_project_id) ||
      (config.google_desktop_client_id != null &&
        (typeof config.google_desktop_client_id !== "string" ||
          !/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(
            config.google_desktop_client_id,
          )))
    )
      throw new Error("DESKTOP_PUBLIC_CONFIG_INVALID");
    await writeFile(
      join(resources, "desktop-public-config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      { mode: 0o644 },
    );
  }
  const digest = async (path) => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  };
  if (!runtimeReusePackageResult) {
    stage("COPY_DOWNLOADER");
    await verifyDownloaderBundle(sourceDownloader, false);
  }
  stage("COPY_RUNTIME");
  const runtimeAllowlist = [
    "runtime/python",
    "runtime/node/bin/node",
    "runtime/node/LICENSE",
    "runtime/bin/ffmpeg",
    "runtime/bin/ffprobe",
    "runtime/licenses",
    "runtime/media-source-manifest.json",
  ];
  const engineAllowlist = [
    "__init__.py",
    "artifacts.py",
    "limits.py",
    "media.py",
    "pipeline.py",
    "provider_adapter.py",
    "recipes.py",
    "separator.py",
    "trimmer.py",
  ];
  // App-owned Python adapters evolve with the app while the large installed
  // interpreter/library runtime remains reusable across compatible updates.
  for (const name of engineAllowlist) {
    const destination = join(resources, "engine-core/musicmute_engine", name);
    await mkdir(dirname(destination), { recursive: true });
    await cp(
      join(root, "../worker/engine/musicmute_engine", name),
      destination,
    );
  }
  if (!runtimeReusePackageResult) {
    console.log("Copying allowlisted runtime and minimal local engine.");
    for (const path of runtimeAllowlist) {
      const from = join(sourceRuntime, path),
        to = join(runtime, path);
      await mkdir(dirname(to), { recursive: true });
      await cp(from, to, {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
        filter: (path) =>
          !/(?:^|\/)(?:__pycache__|samplerate|samplerate-[^/]+\.dist-info)(?:\/|$)/.test(
            path,
          ) && !path.endsWith(".pyc"),
      });
    }
    for (const name of engineAllowlist) {
      const destination = join(runtime, "app/engine/musicmute_engine", name);
      await mkdir(dirname(destination), { recursive: true });
      await cp(
        join(sourceRuntime, "app/engine/musicmute_engine", name),
        destination,
      );
    }
  }
  await cp(join(root, "dist/companion"), join(resources, "companion"), {
    recursive: true,
    filter: (path) =>
      !path.endsWith(".map") &&
      !path.endsWith("/MusicMuteGuestCredentials") &&
      !path.endsWith("/MusicMuteBrowserProcessingBridge"),
  });
  await cp(join(root, "dist/extension"), join(resources, "extension"), {
    recursive: true,
    filter: (path) => !path.endsWith(".map"),
  });
  const manifest = JSON.parse(
    await readFile(join(resources, "extension/manifest.json"), "utf8"),
  );
  if (
    manifest.content_scripts.some((script) =>
      script.matches.some(
        (match) =>
          !["https://www.youtube.com/*", "https://youtube.com/*"].includes(
            match,
          ),
      ),
    )
  )
    throw new Error("FIXTURE_EXTENSION_CANNOT_BE_PACKAGED");
  for (const name of [
    "engine/local_pipeline.py",
    "engine/local_engine_service.py",
    "engine/process_lease.py",
    "engine/downloader_bootstrap.py",
    "scripts/native-lock.py",
    "scripts/update-lock.py",
  ]) {
    const destination = join(resources, name);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, name), destination);
  }
  let youtubeRuntime;
  if (!runtimeReusePackageResult) {
    await mkdir(join(runtime, "tools/downloader"), { recursive: true });
    stage("COPY_DOWNLOADER");
    for (const name of [
      DOWNLOADER_BOOTSTRAP,
      "identity.json",
      ...DOWNLOADER_WHEELS.map((wheel) => wheel.file),
    ]) {
      const destination = join(runtime, "tools/downloader", name);
      await cp(join(sourceDownloader, name), destination);
      await chmod(destination, 0o644);
    }
    await verifyDownloaderBundle(join(runtime, "tools/downloader"), true);
    const youtubeSource =
      process.env.MUSICMUTE_YOUTUBE_RUNTIME_TARGET ??
      join(root, "output/youtube-runtime.noindex");
    stage("COPY_YOUTUBE_RUNTIME");
    await verifyYoutubeRuntime(youtubeSource, false);
    youtubeRuntime = join(runtime, "tools/youtube");
    await cp(youtubeSource, youtubeRuntime, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    await verifyYoutubeRuntime(youtubeRuntime, false);
  }
  await cp(join(root, "macos/Info.plist"), join(app, "Contents/Info.plist"));
  const plistPath = join(app, "Contents/Info.plist");
  for (const [key, value] of [
    ["CFBundleShortVersionString", updateConfiguration.version],
    ["CFBundleVersion", updateConfiguration.build],
    ...(updateConfiguration.configured
      ? [
          ["SUFeedURL", updateConfiguration.feedURL],
          ["SUPublicEDKey", updateConfiguration.publicKey],
        ]
      : []),
  ])
    await exec(
      "/usr/bin/plutil",
      ["-replace", key, "-string", value, plistPath],
      { timeout: 30_000, maxBuffer: 128 * 1024 },
    );
  const executable = join(app, "Contents/MacOS/MusicMuteLocal");
  const iconset = join(buildRoot, "AppIcon.iconset");
  await exec(
    "/usr/bin/xcrun",
    ["swift", join(root, "scripts/macos-icon.swift"), iconset],
    { timeout: 60_000, maxBuffer: 128 * 1024 },
  );
  await exec(
    "/usr/bin/iconutil",
    ["-c", "icns", iconset, "-o", join(resources, "AppIcon.icns")],
    { timeout: 30_000 },
  );
  console.log("Compiling the native SwiftUI app.");
  stage("COMPILE_NATIVE", "Contents/MacOS/MusicMuteLocal", 120_000);
  await exec(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-swift-version",
      "6",
      "-warnings-as-errors",
      "-O",
      "-target",
      "arm64-apple-macos14.0",
      "-parse-as-library",
      "-framework",
      "SwiftUI",
      "-framework",
      "AppKit",
      "-F",
      frameworks,
      "-framework",
      "Sparkle",
      "-Xlinker",
      "-rpath",
      "-Xlinker",
      "@executable_path/../Frameworks",
      ...[
        "Models.swift",
        "DesktopCloudHandoff.swift",
        "ProcessBridge.swift",
        "UIJournal.swift",
        "DesktopAuth.swift",
        "DesktopAccountState.swift",
        "BrowserProcessingBridge.swift",
        "DesktopOutboxWatcher.swift",
        "DesktopListening.swift",
        "DesktopWorkspace.swift",
        "DesktopAccountView.swift",
        "DesktopMediaViews.swift",
        "DesktopPreferences.swift",
        "DesktopUpdater.swift",
        "MusicMuteLocal.swift",
      ].map((name) => join(root, "macos", name)),
      "-o",
      executable,
    ],
    { timeout: 120_000, maxBuffer: 128 * 1024 },
  );

  stage("COMPILE_NATIVE", "Contents/MacOS/MusicMuteGuestCredentials", 60_000);
  await exec(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-swift-version",
      "6",
      "-warnings-as-errors",
      "-O",
      "-target",
      "arm64-apple-macos14.0",
      "-parse-as-library",
      "-framework",
      "Security",
      join(root, "macos/GuestCredentials.swift"),
      "-o",
      join(app, "Contents/MacOS/MusicMuteGuestCredentials"),
    ],
    { timeout: 60_000, maxBuffer: 32 * 1024 },
  );
  stage("COMPILE_NATIVE", "Contents/MacOS/MusicMuteInstallHelper", 60_000);
  await exec(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-swift-version",
      "6",
      "-warnings-as-errors",
      "-O",
      "-target",
      "arm64-apple-macos14.0",
      "-parse-as-library",
      join(root, "macos/InstallHelper.swift"),
      "-o",
      join(app, "Contents/MacOS/MusicMuteInstallHelper"),
    ],
    { timeout: 60_000, maxBuffer: 32 * 1024 },
  );
  const inventory = [];
  const native = [];
  // The bundle contains only allowlisted immutable public/runtime artifacts.
  // Private account/model/user state stays outside it. A different Mac user
  // must be able to read these files after a normal Finder installation.
  async function normalizeBundlePermissions(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      await chmod(path, 0o755);
      for (const name of await readdir(path))
        await normalizeBundlePermissions(join(path, name));
    } else if (info.isFile()) {
      await chmod(path, info.mode & 0o111 ? 0o755 : 0o644);
    } else throw new Error("UNSUPPORTED_BUNDLE_ENTRY");
  }
  async function walk(directory, withHashes = false) {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await readlink(path);
        const resolved = resolve(dirname(path), target);
        if (
          isAbsolute(target) ||
          relative(app, resolved).startsWith("..") ||
          !resolved.startsWith(`${app}/`)
        )
          throw new Error("BUNDLE_SYMLINK_ESCAPE");
        await access(resolved);
        inventory.push({ path: relative(app, path), type: "symlink", target });
      } else if (info.isDirectory()) await walk(path, withHashes);
      else if (info.isFile()) {
        const descriptor = await open(path, "r");
        const header = Buffer.alloc(4);
        try {
          await descriptor.read(header, 0, 4, 0);
        } finally {
          await descriptor.close();
        }
        if (
          [
            "cffaedfe",
            "cefaedfe",
            "feedfacf",
            "feedface",
            "cafebabe",
            "bebafeca",
            "cafebabf",
            "bfbafeca",
          ].includes(header.toString("hex"))
        )
          native.push(path);
        inventory.push({
          path: relative(app, path),
          type: "file",
          bytes: info.size,
          ...(withHashes ? { sha256: await digest(path) } : {}),
        });
      } else throw new Error("UNSUPPORTED_BUNDLE_ENTRY");
    }
  }
  stage("AUDIT_BUNDLE");
  await normalizeBundlePermissions(app);
  await walk(app);
  const jitEntitlements = join(buildRoot, "jit.entitlements");
  const denoEntitlements = join(buildRoot, "deno.entitlements");
  const dynamicEntitlements = join(buildRoot, "dynamic.entitlements");
  const localAppEntitlements = async () => {
    const path = join(buildRoot, "local-app.entitlements");
    await writeFile(
      path,
      '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>',
    );
    return path;
  };
  await writeFile(
    jitEntitlements,
    '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/>' +
      (release
        ? ""
        : "<key>com.apple.security.cs.disable-library-validation</key><true/>") +
      "</dict></plist>",
  );
  await writeFile(
    denoEntitlements,
    '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>' +
      (release
        ? ""
        : "<key>com.apple.security.cs.disable-library-validation</key><true/>") +
      "</dict></plist>",
  );
  await writeFile(
    dynamicEntitlements,
    '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>' +
      (release
        ? ""
        : "<key>com.apple.security.cs.disable-library-validation</key><true/>") +
      "</dict></plist>",
  );
  stage("ENTITLEMENTS");
  for (const entitlements of [
    jitEntitlements,
    denoEntitlements,
    dynamicEntitlements,
    join(root, "macos/MusicMuteLocal.entitlements"),
  ]) {
    await exec("/usr/bin/plutil", ["-lint", entitlements], {
      timeout: 30_000,
      maxBuffer: 128 * 1024,
    });
    if (release) {
      const { stdout } = await exec(
        "/usr/bin/plutil",
        ["-convert", "json", "-o", "-", entitlements],
        { timeout: 30_000, maxBuffer: 128 * 1024 },
      );
      const values = JSON.parse(stdout);
      if (
        values["com.apple.security.get-task-allow"] != null &&
        values["com.apple.security.get-task-allow"] !== false
      )
        throw new Error("RELEASE_DEBUG_ENTITLEMENT_FORBIDDEN");
    }
  }
  let cleanedRpaths = 0;
  console.log(
    `Auditing and signing ${native.length} native binaries (${release ? "Developer ID distribution" : identity === "-" ? "ad hoc local build" : "custom-identity local build"}).`,
  );
  const nativeSignatures = [];
  for (const path of native.sort((a, b) => b.length - a.length)) {
    stage("AUDIT_NATIVE", relative(app, path), 30_000);
    await exec("/usr/bin/lipo", [path, "-verify_arch", "arm64"], {
      timeout: 30_000,
    });
    const { stdout } = await exec("/usr/bin/otool", ["-l", path], {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (release) assertNotarizationLoadCommands(stdout);
    const rpaths = [
      ...stdout.matchAll(
        /cmd LC_RPATH\s+cmdsize \d+\s+path ([^\n]+) \(offset \d+\)/g,
      ),
    ].map((match) => match[1]);
    for (const rpath of rpaths) {
      if (
        rpath.startsWith("/") &&
        !rpath.startsWith("/System/") &&
        !rpath.startsWith("/usr/lib/")
      ) {
        await exec(
          "/usr/bin/install_name_tool",
          ["-delete_rpath", rpath, path],
          {
            timeout: 30_000,
          },
        );
        cleanedRpaths++;
      }
    }
    const entitlements = path.endsWith("/deno")
      ? denoEntitlements
      : path.endsWith("/node")
        ? jitEntitlements
        : path.endsWith("/python3.13")
          ? dynamicEntitlements
          : undefined;
    const args = signingArguments(signing, { entitlements });
    stage("SIGN_NATIVE", relative(app, path), 60_000);
    await exec("/usr/bin/codesign", [...args, path], {
      timeout: 60_000,
      maxBuffer: 128 * 1024,
    });
    stage("VERIFY_NATIVE", relative(app, path), 30_000);
    await exec("/usr/bin/codesign", ["--verify", "--strict", path], {
      timeout: 30_000,
      maxBuffer: 128 * 1024,
    });
    if (release)
      nativeSignatures.push({
        path: relative(app, path),
        ...(await verifyDeveloperIdSignature(path, signing, { exec })),
      });
  }
  // Seal nested Sparkle containers from the inside out after their native code.
  // Signing only Mach-O executables leaves stale XPC/app/framework resource seals.
  for (const bundle of [
    "Sparkle.framework/Versions/B/XPCServices/Downloader.xpc",
    "Sparkle.framework/Versions/B/XPCServices/Installer.xpc",
    "Sparkle.framework/Versions/B/Updater.app",
    "Sparkle.framework",
  ]) {
    const path = join(frameworks, bundle);
    stage("SIGN_NATIVE", relative(app, path), 60_000);
    await exec(
      "/usr/bin/codesign",
      [...signingArguments(signing, { kind: "app" }), path],
      { timeout: 60_000, maxBuffer: 128 * 1024 },
    );
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", path], {
      timeout: 30_000,
      maxBuffer: 128 * 1024,
    });
    if (release)
      await verifyDeveloperIdSignature(path, signing, { exec, kind: "app" });
  }
  // Code signatures change vendored canvas/Deno bytes. Record the sealed closure.
  if (youtubeRuntime) {
    await refreshYoutubeRuntimeIdentity(youtubeRuntime);
    await verifyYoutubeRuntime(youtubeRuntime, true);
  }
  const freshlySignedRuntimeBinaries = native.filter((path) =>
    path.startsWith(`${runtime}/`),
  ).length;
  const freshlySignedRuntimeSignatures = nativeSignatures.filter((entry) =>
    entry.path.startsWith("Contents/Resources/runtime/"),
  );
  const appNativeSignatures = nativeSignatures.filter(
    (entry) => !entry.path.startsWith("Contents/Resources/runtime/"),
  );
  stage("PACKAGE_RUNTIME");
  let runtimeArtifact;
  if (runtimeReusePackageResult) {
    stage("REUSE_RUNTIME");
    runtimeArtifact = await reuseMacRuntimeArtifact({
      packageResultPath: runtimeReusePackageResult,
      outputDirectory: join(buildRoot, "runtime-release.noindex"),
      sourceVersion: runtimeSourceVersion,
      signing,
      downloadConfiguration: runtimeDownload,
      exec,
      signatureVerifier: (path, manifest) =>
        verifyRuntimeCodeSignature(path, manifest, { exec }),
    });
  } else {
    const runtimeReleaseRoot = join(
      buildRoot,
      `.runtime-release-${randomUUID()}.noindex`,
    );
    await mkdir(runtimeReleaseRoot, { mode: 0o700 });
    await rename(runtime, join(runtimeReleaseRoot, "runtime"));
    if (
      await access(runtime).then(
        () => true,
        () => false,
      )
    )
      throw new Error("BUNDLED_RUNTIME_NOT_REMOVED");
    runtimeArtifact = await createMacRuntimeArtifact({
      releaseRoot: runtimeReleaseRoot,
      outputDirectory: join(buildRoot, "runtime-release.noindex"),
      downloadBaseURL: runtimeDownload.baseURL.href,
      redirectHosts: runtimeDownload.downloadHosts.slice(1).join(","),
      sourceVersion: runtimeSourceVersion,
      signing,
      exec,
      signatureVerifier: (path, manifest) =>
        verifyRuntimeCodeSignature(path, manifest, { exec }),
    });
    if (
      runtimeArtifact.native_binaries !== freshlySignedRuntimeBinaries ||
      (release &&
        freshlySignedRuntimeSignatures.length !==
          runtimeArtifact.native_binaries)
    )
      throw new Error("RUNTIME_NATIVE_INVENTORY_MISMATCH");
    await rm(runtimeReleaseRoot, { recursive: true, force: true });
  }
  await cp(runtimeArtifact.manifest, join(resources, "runtime-bootstrap.json"));
  await chmod(join(resources, "runtime-bootstrap.json"), 0o644);
  await writeFile(
    join(resources, "setup-metadata.json"),
    `${JSON.stringify(macosSetupMetadata(MODEL), null, 2)}\n`,
    { mode: 0o644, flag: "wx" },
  );
  stage("BUNDLE_NOTICES");
  await mkdir(join(resources, "Notices"), { recursive: true });
  await cp(
    join(root, "../worker/LICENSE"),
    join(resources, "Notices/MusicMute-Apache-2.0.txt"),
  );
  await cp(
    join(root, "docs/THIRD-PARTY.md"),
    join(resources, "Notices/THIRD-PARTY.md"),
  );
  await cp(
    join(root, "../worker/scripts/build-macos-media-runtime.sh"),
    join(resources, "Notices/build-macos-media-runtime.sh"),
  );
  // Build record names only allowlisted artifacts. Never copy fleet release manifests/config.
  inventory.length = 0;
  native.length = 0;
  stage("BUNDLE_AUDIT");
  await walk(app, true);
  // The outer seal changes both the main executable and CodeResources. Their final
  // measurements belong in the external post-seal inventory, never in a
  // self-referential signed resource.
  const sealMutatedPaths = [
    relative(app, executable),
    "Contents/_CodeSignature/CodeResources",
  ];
  for (const path of sealMutatedPaths) {
    const entry = inventory.find((file) => file.path === path);
    if (!entry) throw new Error("PRE_SEAL_MUTABLE_PATH_NOT_IN_INVENTORY");
    delete entry.bytes;
    delete entry.sha256;
    entry.measurement_scope = "FINAL_POST_SEAL_INVENTORY";
  }
  await writeFile(
    join(resources, "bundle-audit.json"),
    `${JSON.stringify({ schema_version: 1, scope: "PRE_OUTER_SEAL", final_inventory: "EXTERNAL_PACKAGE_INVENTORY", inventory_excludes: ["Contents/Resources/bundle-audit.json"], seal_mutated_paths: sealMutatedPaths, architecture: "arm64", minimum_macos: "14.0", runtime_source_version: runtimeSourceVersion, runtime_delivery: "EXTERNAL_PREPARE", runtime_bootstrap: "runtime-bootstrap.json", runtime_id: runtimeArtifact.id, runtime_archive_sha256: runtimeArtifact.archive_sha256, runtime_artifact_reused: runtimeArtifact.reused, ...(runtimeArtifact.reuse_source ? { runtime_reuse_source_build_id: runtimeArtifact.reuse_source.build_id } : {}), runtime_allowlist: runtimeAllowlist, engine_allowlist: engineAllowlist, excluded_optional_intel_package: "samplerate", native_binaries: native.length, removed_absolute_rpaths: cleanedRpaths, signing: signing.signing, release_mode: release, ...(release ? { signing_identity_sha1: identity, team_identifier: signing.teamIdentifier, secure_timestamp: true, hardened_runtime: true, native_signatures: appNativeSignatures } : {}), includes_model_weights: false, includes_worker_state: false, files: inventory }, null, 2)}\n`,
  );
  stage("SIGN_APP", "Contents/MacOS/MusicMuteLocal", 120_000);
  await exec(
    "/usr/bin/codesign",
    [
      ...signingArguments(signing, {
        kind: "app",
        entitlements: release
          ? join(root, "macos/MusicMuteLocal.entitlements")
          : await localAppEntitlements(),
      }),
      app,
    ],
    { timeout: 120_000, maxBuffer: 256 * 1024 },
  );
  stage("VERIFY_APP", "Contents/MacOS/MusicMuteLocal", 120_000);
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
    timeout: 120_000,
    maxBuffer: 256 * 1024,
  });
  const appSignature = release
    ? await verifyDeveloperIdSignature(app, signing, { exec, kind: "app" })
    : undefined;
  const finalInventory = join(buildRoot, "package-inventory.json");
  stage("FINAL_INVENTORY");
  inventory.length = 0;
  native.length = 0;
  await walk(app, true);
  await writeFile(
    finalInventory,
    `${JSON.stringify({ schema_version: 1, scope: "FINAL_SIGNED_APP", files: inventory }, null, 2)}\n`,
  );
  const appBytes = inventory.reduce((sum, file) => sum + (file.bytes ?? 0), 0);
  const steadyStateBytes = macosSteadyStateBytes({
    appBytes,
    runtimeInstalledBytes: runtimeArtifact.installed_bytes,
  });
  const result = {
    schema_version: 1,
    build_id: buildId,
    app,
    build_root: buildRoot,
    native_binaries: native.length,
    removed_absolute_rpaths: cleanedRpaths,
    signing: signing.signing,
    architecture: "arm64",
    release_mode: release,
    version: updateConfiguration.version,
    build: updateConfiguration.build,
    updater: {
      framework: "Sparkle",
      version: "2.10.0",
      configured: updateConfiguration.configured,
    },
    final_inventory: finalInventory,
    final_inventory_sha256: await digest(finalInventory),
    runtime: {
      delivery: "EXTERNAL_PREPARE",
      id: runtimeArtifact.id,
      api_version: runtimeArtifact.api_version,
      source_version: runtimeArtifact.source_version,
      reused: runtimeArtifact.reused,
      ...(runtimeArtifact.reuse_source
        ? { reuse_source: runtimeArtifact.reuse_source }
        : {}),
      archive: runtimeArtifact.archive,
      archive_bytes: runtimeArtifact.archive_bytes,
      archive_sha256: runtimeArtifact.archive_sha256,
      installed_bytes: runtimeArtifact.installed_bytes,
      manifest: runtimeArtifact.manifest,
      manifest_sha256: runtimeArtifact.manifest_sha256,
      url: runtimeArtifact.url,
      files: runtimeArtifact.files,
      native_binaries: runtimeArtifact.native_binaries,
      ...(release
        ? { native_binaries_verified: runtimeArtifact.native_binaries }
        : {}),
      signing: runtimeArtifact.signing,
      notarized: false,
      public_ready: false,
    },
    ...(release
      ? {
          signing_identity_sha1: identity,
          ...appSignature,
          signing_attestation: {
            schema_version: 1,
            mode: "DEVELOPER_ID_DISTRIBUTION",
            identity_sha1: identity,
            ...appSignature,
            native_binaries_verified: appNativeSignatures.length,
            app_verified: true,
            notarized: false,
          },
        }
      : {}),
    bytes: appBytes,
    steady_state_bytes: steadyStateBytes,
    notarized: false,
    public_ready: false,
    relocated_runtime_tested: false,
  };
  stage("PACKAGE_RECORD");
  await writeFile(
    join(buildRoot, "package-result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  await writeFile(
    join(root, "output/macos", release ? "latest-release.json" : "latest.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
}

try {
  await packageMacos();
} catch (error) {
  const report = packageFailureReport(error, failureContext);
  let recorded = false;
  if (failureContext.build_root) {
    try {
      await writePackageFailure(failureContext.build_root, report);
      recorded = true;
    } catch {
      // Preserve the fixed failure and build identity even if the disk cannot store a report.
    }
  }
  console.error(
    JSON.stringify({ ...report, failure_record_written: recorded }),
  );
  process.exitCode = 1;
}

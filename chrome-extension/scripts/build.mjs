import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const root = resolve(import.meta.dirname, "..");
const execute = promisify(execFile);
await mkdir(resolve(root, "dist/extension"), { recursive: true });
await build({
  entryPoints: [
    "src/companion/host.ts",
    "src/companion/cli.ts",
    "src/companion/benchmark.ts",
    "src/companion/app-setup.ts",
    "src/companion/app-control.ts",
    "src/companion/desktop-control.ts",
    "src/companion/downloader-bundle.ts",
    "src/companion/youtube-runtime.ts",
    "src/companion/worker-preflight.ts",
  ],
  outdir: "dist/companion",
  platform: "node",
  target: "node24",
  format: "esm",
  bundle: true,
  sourcemap: true,
  absWorkingDir: root,
});
if (process.platform === "darwin") {
  await promisify(execFile)(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-swift-version",
      "6",
      "-warnings-as-errors",
      "-O",
      "-parse-as-library",
      "-framework",
      "Security",
      resolve(root, "macos/GuestCredentials.swift"),
      "-o",
      resolve(root, "dist/companion/MusicMuteGuestCredentials"),
    ],
    { timeout: 60_000, maxBuffer: 32 * 1024 },
  );
  await promisify(execFile)(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-swift-version",
      "6",
      "-warnings-as-errors",
      "-O",
      "-parse-as-library",
      "-D",
      "MUSICMUTE_NATIVE_TESTS",
      "-D",
      "MUSICMUTE_BROWSER_BRIDGE",
      "-framework",
      "SwiftUI",
      "-framework",
      "AppKit",
      ...[
        "Models.swift",
        "DesktopWorker.swift",
        "DesktopWorkerView.swift",
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
      ].map((name) => resolve(root, "macos", name)),
      "-o",
      resolve(root, "dist/companion/MusicMuteBrowserProcessingBridge"),
    ],
    { timeout: 120_000, maxBuffer: 128 * 1024 },
  );
}
// The controller is bundled independently; worker dependencies stay out of the
// browser and personal-processing companion. The service payload is staged by
// packaging as an immutable, independently managed worker release.
await build({
  entryPoints: { controller: "../worker/src/cli/app-control.ts" },
  outdir: "dist/worker",
  platform: "node",
  target: "node24",
  format: "esm",
  bundle: true,
  banner: {
    js: 'import { createRequire as workerCreateRequire } from "node:module"; const require = workerCreateRequire(import.meta.url);',
  },
  absWorkingDir: root,
});
await execute(
  process.execPath,
  [resolve(root, "scripts/worker-service-artifact.mjs")],
  {
    cwd: root,
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
  },
);
await build({
  entryPoints: [
    "src/extension/background.ts",
    "src/extension/content.ts",
    "src/extension/offscreen.ts",
    "src/extension/popup.ts",
    "src/extension/privacy.ts",
  ],
  outdir: "dist/extension",
  platform: "browser",
  target: "chrome116",
  format: "iife",
  bundle: true,
  sourcemap: true,
  absWorkingDir: root,
});
await cp(
  resolve(root, "src/extension/static"),
  resolve(root, "dist/extension"),
  { recursive: true },
);
if (process.argv.includes("--fixture")) {
  const path = resolve(root, "dist/extension/manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.content_scripts[0].matches.push("http://127.0.0.1/*");
  await writeFile(path, JSON.stringify(manifest, null, 2));
}

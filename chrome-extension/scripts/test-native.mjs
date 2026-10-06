// Isolated native checks: no Keychain writes, cloud requests, app installation or device changes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
assert.equal(process.platform, "darwin", "UNSUPPORTED_PLATFORM");
assert.equal(process.arch, "arm64", "UNSUPPORTED_PLATFORM");
const root = resolve(import.meta.dirname, "..");
const output = join(
  root,
  "output/native-tests",
  `build-${randomUUID()}.noindex`,
);
await mkdir(output, { recursive: true, mode: 0o700 });
const sources = [
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
].map((name) => join(root, "macos", name));
const installHelper = join(output, "MusicMuteInstallHelper");
await exec(
  "/usr/bin/xcrun",
  [
    "swiftc",
    "-swift-version",
    "6",
    "-warnings-as-errors",
    "-target",
    "arm64-apple-macos14.0",
    "-parse-as-library",
    join(root, "macos/InstallHelper.swift"),
    "-o",
    installHelper,
  ],
  { timeout: 60_000, maxBuffer: 128 * 1024 },
);
for (const name of [
  "NativeTests",
  "DesktopTests",
  "UpdaterTests",
  "BrowserProcessingBridgeTests",
  "WorkerTests",
  "SettingsTests",
]) {
  const binary = join(output, name);
  await exec(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-swift-version",
      "6",
      "-warnings-as-errors",
      "-target",
      "arm64-apple-macos14.0",
      "-parse-as-library",
      "-D",
      "MUSICMUTE_NATIVE_TESTS",
      "-framework",
      "SwiftUI",
      "-framework",
      "AppKit",
      ...sources,
      join(root, "macos/Tests", `${name}.swift`),
      "-o",
      binary,
    ],
    { timeout: 120_000, maxBuffer: 512 * 1024 },
  );
  const { stdout } = await exec(binary, [], {
    timeout: 30_000,
    maxBuffer: 128 * 1024,
    env: {
      ...process.env,
      MUSICMUTE_INSTALL_HELPER_TEST_PATH: installHelper,
    },
  });
  process.stdout.write(stdout);
}

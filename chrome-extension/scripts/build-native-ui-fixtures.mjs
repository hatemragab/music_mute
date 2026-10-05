// Builds isolated native UI previews. It never launches an app or runs setup.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
assert.equal(process.platform, "darwin", "UNSUPPORTED_PLATFORM");
assert.equal(process.arch, "arm64", "UNSUPPORTED_PLATFORM");
assert.equal(process.argv.length, 2, "INVALID_PREVIEW_ARGUMENTS");
const id = randomUUID();
const output = join(root, "output/native-ui-proof.noindex", id);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = await readFile(join(root, "macos/MusicMuteLocal.swift"), "utf8");
const anchor = "    let arguments = ProcessInfo.processInfo.arguments";
assert.equal(
  source.split(anchor).length,
  2,
  "PREVIEW_PROJECTION_ANCHOR_CHANGED",
);
for (const safetyGuard of [
  "    journal = fixture ? nil : UIJournal()",
  "    guard !fixture else {",
  "if !model.fixture && model.status == nil && !model.busy",
])
  assert.ok(source.includes(safetyGuard), "PREVIEW_SAFETY_GUARD_CHANGED");
const shared = [
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
];
const sources = Object.fromEntries(
  await Promise.all(
    shared.map(async (name) => [
      name,
      digest(await readFile(join(root, "macos", name))),
    ]),
  ),
);
await mkdir(output, { recursive: true, mode: 0o700 });
const report = {
  scope: "NATIVE_UI_PREVIEW_BUILD_ONLY",
  source_main_sha256: digest(source),
  unchanged_shared_source_sha256: sources,
  projection: "EXACT_SINGLE_FIXTURE_ARGUMENT_DEFAULT",
  application_launched: false,
  native_processing: false,
  browser_playback: false,
  consumer_or_fleet_state_modified: false,
  previews: [],
};
for (const [fixture, name] of [
  ["home", "MusicMute Preview Home"],
  ["progress-overview", "MusicMute Preview Overview"],
  ["progress-diagnostics", "MusicMute Preview Busy Diagnostics"],
  ["diagnostics-alerts", "MusicMute Preview Alerts"],
]) {
  const directory = join(output, fixture);
  const app = join(directory, `${name}.app`);
  const projected = source.replace(
    anchor,
    `    let arguments = ["MusicMuteLocal", "--ui-fixture", "${fixture}"]`,
  );
  assert.equal(projected.split(anchor).length, 1);
  const projectedPath = join(directory, "MusicMuteLocal.swift");
  await mkdir(join(app, "Contents/MacOS"), { recursive: true, mode: 0o700 });
  await mkdir(join(app, "Contents/Resources"), { mode: 0o700 });
  await writeFile(projectedPath, projected, { mode: 0o600, flag: "wx" });
  const bundleId = `com.hatem.musicmute.preview.${fixture}.${id}`;
  await writeFile(
    join(app, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>MusicMuteLocal</string>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>${name}</string>
<key>CFBundleDisplayName</key><string>${name}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
`,
    { mode: 0o600, flag: "wx" },
  );
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
      "-framework",
      "SwiftUI",
      "-framework",
      "AppKit",
      ...shared.map((file) => join(root, "macos", file)),
      projectedPath,
      "-o",
      join(app, "Contents/MacOS/MusicMuteLocal"),
    ],
    { timeout: 60_000, maxBuffer: 64 * 1024 },
  );
  await exec("/usr/bin/plutil", ["-lint", join(app, "Contents/Info.plist")]);
  await exec("/usr/bin/codesign", ["--force", "--sign", "-", app], {
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  assert.equal(
    digest(await readFile(join(root, "macos/MusicMuteLocal.swift"))),
    report.source_main_sha256,
    "PREVIEW_SOURCE_CHANGED_DURING_BUILD",
  );
  for (const file of shared)
    assert.equal(
      digest(await readFile(join(root, "macos", file))),
      sources[file],
      "PREVIEW_SHARED_SOURCE_CHANGED_DURING_BUILD",
    );
  report.previews.push({
    fixture,
    app,
    bundle_id: bundleId,
    projected_main_sha256: digest(projected),
    native_binary_sha256: digest(
      await readFile(join(app, "Contents/MacOS/MusicMuteLocal")),
    ),
    strict_signature_verified: true,
  });
}
report.passed = true;
const reportPath = join(output, "build-result.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
console.log(JSON.stringify({ report: reportPath, previews: report.previews }));

// Source DEBUG GUI only. Never installs, registers Chrome, prepares tools, or modifies a runtime.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const component = resolve(import.meta.dirname, "..");
const workspace = dirname(component);
const base = join(workspace, ".runtime/local-logging/macos-ui");
const files = [
  "Models.swift",
  "LocalUIDebugSession.swift",
  "DesktopCloudHandoff.swift",
  "ProcessBridge.swift",
  "UIJournal.swift",
  "DesktopAuth.swift",
  "DesktopAccountState.swift",
  "BrowserProcessingBridge.swift",
  "DesktopOutboxWatcher.swift",
  "DesktopListening.swift",
  "DesktopWorkspace.swift",
  "DesktopWorker.swift",
  "DesktopWorkerView.swift",
  "DesktopAccountView.swift",
  "DesktopMediaViews.swift",
  "DesktopPreferences.swift",
  "DesktopUpdater.swift",
  "MusicMuteLocal.swift",
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const xml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const [command = "build", sessionID] = process.argv.slice(2);
async function privateJSON(path, limit) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    assert.ok(
      info.isFile() &&
        info.uid === process.getuid() &&
        info.nlink === 1 &&
        (info.mode & 0o077) === 0 &&
        info.size > 0 &&
        info.size <= limit,
      "UNSAFE_PRIVATE_JSON",
    );
    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    assert.ok(offset <= limit, "PRIVATE_JSON_TOO_LARGE");
    try {
      return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
    } catch {
      throw new Error("PRIVATE_JSON_INVALID");
    }
  } finally {
    await file.close();
  }
}
assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
if (command === "launch") {
  assert.match(sessionID ?? "", uuid);
  const file = join(base, sessionID, "session.json");
  const result = await privateJSON(file, 64 * 1024);
  assert.equal(result.session_id, sessionID);
  assert.equal(result.app, join(base, sessionID, "MusicMute Local Debug.app"));
  assert.equal(
    result.executable,
    join(
      base,
      sessionID,
      "MusicMute Local Debug.app/Contents/MacOS/MusicMuteLocal",
    ),
  );
  await exec("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    result.app,
  ]);
  assert.equal(
    hash(await readFile(result.executable)),
    result.binary_sha256,
    "BINARY_CHANGED_SINCE_BUILD",
  );
  const running = (
    await exec("/bin/ps", ["-axo", "pid=,comm="], { maxBuffer: 512 * 1024 })
  ).stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(.+?)\s*$/))
    .find((match) => match?.[2] === result.executable);
  if (running) {
    console.log(
      JSON.stringify({
        launched: false,
        already_running: true,
        pid: Number(running[1]),
        app: result.app,
        session_id: sessionID,
      }),
    );
    process.exit(0);
  }
  const config = await privateJSON(
    join(workspace, ".runtime/local-logging/keys.json"),
    16 * 1024,
  );
  assert.ok(
    typeof config.keys?.macos === "string" &&
      config.keys.macos.length >= 16 &&
      config.keys.macos.length <= 512 &&
      !/\s/.test(config.keys.macos),
    "INVALID_COLLECTOR_KEY",
  );
  const env = {
    ...process.env,
    NODE_ENV: "development",
    MUSICMUTE_LOG_ENABLED: process.env.MUSICMUTE_LOG_ENABLED ?? "1",
    MUSICMUTE_LOG_PAYLOADS: process.env.MUSICMUTE_LOG_PAYLOADS ?? "1",
    MUSICMUTE_LOG_CONSOLE: process.env.MUSICMUTE_LOG_CONSOLE ?? "0",
    MUSICMUTE_LOG_ENDPOINT: "http://127.0.0.1:19740/ingest/macos",
    MUSICMUTE_LOG_KEY: config.keys.macos,
  };
  const child = spawn(result.executable, [], {
    env,
    stdio: "ignore",
    detached: true,
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  console.log(
    JSON.stringify({
      launched: true,
      pid: child.pid,
      app: result.app,
      session_id: sessionID,
    }),
  );
} else {
  assert.equal(command, "build", "Expected build or launch <session-id>");
  const id = randomUUID(),
    directory = join(base, id),
    support = join(directory, "support");
  await mkdir(support, { recursive: true, mode: 0o700 });
  const app = join(directory, "MusicMute Local Debug.app");
  const resources = join(app, "Contents/Resources"),
    executable = join(app, "Contents/MacOS/MusicMuteLocal");
  await mkdir(resources, { recursive: true, mode: 0o700 });
  await mkdir(dirname(executable), { mode: 0o700 });
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      files.map(async (name) => [
        name,
        hash(await readFile(join(component, "macos", name))),
      ]),
    ),
  );
  for (const name of ["en.lproj", "ar.lproj", "Fonts", "licenses"])
    await cp(join(component, "macos/Resources", name), join(resources, name), {
      recursive: true,
    });
  const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>MusicMuteLocal</string><key>CFBundleIdentifier</key><string>com.hatem.musicmute.local.debug.${id}</string><key>CFBundleName</key><string>MusicMute Local Debug</string><key>CFBundleDisplayName</key><string>MusicMute Local Debug</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>0.1.3</string><key>CFBundleVersion</key><string>1</string><key>LSMinimumSystemVersion</key><string>14.0</string><key>NSHighResolutionCapable</key><true/><key>NSPrincipalClass</key><string>NSApplication</string><key>ATSApplicationFontsPath</key><string>Fonts</string><key>MusicMuteDebugWorkspace</key><string>${xml(workspace)}</string><key>MusicMuteDebugSession</key><string>${id}</string><key>MusicMuteDebugSupport</key><string>${xml(support)}</string></dict></plist>`;
  await writeFile(join(app, "Contents/Info.plist"), plist, {
    mode: 0o600,
    flag: "wx",
  });
  // The prepared executable is read only; all generated audio and metadata belong to this session.
  const installedSupport = join(
    homedir(),
    "Library/Application Support/MusicMuteLocal",
  );
  const descriptorFile = join(installedSupport, "runtime/active.json"),
    info = await lstat(descriptorFile);
  assert.ok(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.nlink === 1 &&
      info.size <= 4096,
  );
  const active = JSON.parse(await readFile(descriptorFile, "utf8"));
  assert.match(active.runtime_id, /^[a-zA-Z0-9._-]{1,128}$/);
  const runtime = await realpath(
    join(installedSupport, "runtime/releases", active.runtime_id, "runtime"),
  );
  assert.ok(
    runtime.startsWith(join(installedSupport, "runtime/releases") + "/"),
  );
  const key = hash("owned-synthetic-ui-" + id),
    audioDirectory = join(support, "cache/vocals", key);
  await mkdir(audioDirectory, { recursive: true, mode: 0o700 });
  const audio = join(audioDirectory, "vocals.mp3");
  await exec(
    join(runtime, "runtime/bin/ffmpeg"),
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=12",
      "-ac",
      "1",
      "-ar",
      "44100",
      "-b:a",
      "64k",
      "-c:a",
      "libmp3lame",
      "-n",
      audio,
    ],
    { timeout: 30_000, maxBuffer: 32 * 1024 },
  );
  const audioBytes = await readFile(audio);
  const { stdout } = await exec(
    join(runtime, "runtime/bin/ffprobe"),
    ["-v", "error", "-show_entries", "format=duration", "-of", "json", audio],
    { timeout: 10_000, maxBuffer: 8192 },
  );
  const duration = Number(JSON.parse(stdout).format.duration);
  assert.ok(Number.isFinite(duration) && duration > 0 && duration < 60);
  await writeFile(
    join(audioDirectory, "result.json"),
    JSON.stringify({
      output_path: audio,
      bytes: audioBytes.length,
      sha256: hash(audioBytes),
      duration_seconds: duration,
      owner_uid: null,
      account_job_id: null,
      source: { kind: "file" },
    }),
    { mode: 0o600, flag: "wx" },
  );
  await writeFile(
    join(support, "fixture-track.json"),
    JSON.stringify({
      cache_key: key,
      bytes: audioBytes.length,
      duration_seconds: duration,
    }),
    { mode: 0o600, flag: "wx" },
  );
  await exec("/bin/chmod", ["600", audio]);
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
      "DEBUG",
      "-framework",
      "SwiftUI",
      "-framework",
      "AppKit",
      ...files.map((name) => join(component, "macos", name)),
      "-o",
      executable,
    ],
    { timeout: 120_000, maxBuffer: 256 * 1024 },
  );
  await exec("/usr/bin/plutil", ["-lint", join(app, "Contents/Info.plist")]);
  await exec("/usr/bin/codesign", ["--force", "--sign", "-", app], {
    timeout: 30_000,
    maxBuffer: 32 * 1024,
  });
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  for (const name of files)
    assert.equal(
      hash(await readFile(join(component, "macos", name))),
      sourceHashes[name],
      "SOURCE_CHANGED_DURING_BUILD",
    );
  const result = {
    session_id: id,
    app,
    executable,
    support,
    source_sha256: sourceHashes,
    binary_sha256: hash(await readFile(executable)),
    strict_signature_verified: true,
    application_launched: false,
    runtime_access:
      "existing ffmpeg/ffprobe read-only for owned synthetic tone; no inference",
    omitted_operations: [
      "prepare",
      "native-registration",
      "worker",
      "enrollment",
      "account-network",
      "cloud",
      "provider",
      "inference",
      "cache-deletion",
    ],
  };
  await writeFile(
    join(directory, "session.json"),
    JSON.stringify(result, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  console.log(JSON.stringify(result));
}

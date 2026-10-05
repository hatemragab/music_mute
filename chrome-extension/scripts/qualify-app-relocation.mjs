// Disposable signed-app movement. Never opens the GUI or a real Chrome profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  stageExternalRuntimeForQualification,
  verifyExternalRuntimeForQualification,
} from "./external-runtime-qualification.mjs";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "output/app-relocation-proof", randomUUID());
const started = Date.now();
const children = new Set();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pause = (milliseconds) =>
  new Promise((done) => setTimeout(done, milliseconds));
const hostName = "com.musicmute.local";
const sandbox = "/usr/bin/sandbox-exec";
const safeEnvironment = { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" };
const report = {
  scope:
    "DISPOSABLE_EXACT_PACKAGE_EXTERNAL_RUNTIME_APP_MOVE_REPAIR_AND_NATIVE_HELLO",
  browser_playback: false,
  browser_installation: false,
  gui_opened: false,
  model_downloaded: false,
  inference_run: false,
  mps_readiness_probes_run: false,
  isolation:
    "PRIVATE_HOME_AND_STATE_OS_SANDBOX_DENIES_OUTBOUND_NETWORK_AND_NONFIXTURE_WRITES_EXCEPT_DEV_NULL",
  copy_strategy: "MACOS_CP_CLONE_PRESERVE_WITH_NO_FULL_COPY_FALLBACK",
  checks: [],
  commands: [],
  gaps: [
    "Chrome's remembered unpacked-extension directory and manual reload remain unverified.",
  ],
};
let finalizing = false;
let timedOut = false;

function check(name, condition) {
  assert.ok(condition, "QUALIFICATION_CHECK_FAILED");
  report.checks.push(name);
}
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  assert.ok(
    info.isDirectory() && !info.isSymbolicLink() && !(info.mode & 0o077),
    "UNSAFE_FIXTURE_DIRECTORY",
  );
}
async function privateWrite(path, bytes) {
  await privateDirectory(dirname(path));
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
}
async function boundedRead(path, maximum) {
  const info = await lstat(path);
  assert.ok(
    info.isFile() && !info.isSymbolicLink() && info.size <= maximum,
    "UNSAFE_FIXTURE_FILE",
  );
  return readFile(path);
}
function contained(parent, path) {
  const child = relative(parent, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
function signalGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* Owned group already exited. */
  }
}

function capture(
  executable,
  args,
  {
    env = safeEnvironment,
    timeout = 180_000,
    input,
    nativeHello = false,
    emergency = false,
  } = {},
) {
  assert.ok(!timedOut || emergency, "QUALIFICATION_OVERALL_TIMEOUT");
  return new Promise((done, reject) => {
    const child = spawn(executable, args, {
      cwd: output,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    let bytes = 0;
    let stderrBytes = 0;
    let stdout = Buffer.alloc(0);
    let failure;
    let killTimer;
    let helloReceived = false;
    let closed = false;
    const stop = (code) => {
      failure ??= code;
      signalGroup(child, "SIGTERM");
      killTimer ??= setTimeout(() => signalGroup(child, "SIGKILL"), 1_000);
    };
    const timer = setTimeout(
      () => stop("QUALIFICATION_CHILD_TIMEOUT"),
      timeout,
    );
    const hardDeadline = setTimeout(() => {
      if (!closed) {
        stop("QUALIFICATION_CHILD_CLEANUP_TIMEOUT");
        reject(new Error("QUALIFICATION_CHILD_CLEANUP_TIMEOUT"));
      }
    }, timeout + 5_000);
    child.on("error", () => stop("QUALIFICATION_CHILD_START_FAILED"));
    child.stdin.on("error", () => {
      if (!helloReceived && !closed) stop("QUALIFICATION_STDIN_FAILED");
    });
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) {
        stop("QUALIFICATION_OUTPUT_LIMIT");
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
      if (!nativeHello || helloReceived || stdout.length < 4) return;
      try {
        const length = stdout.readUInt32LE(0);
        assert.ok(length >= 2 && length <= 64 * 1024, "NATIVE_FRAME_INVALID");
        if (stdout.length < length + 4) return;
        const message = JSON.parse(
          stdout.subarray(4, length + 4).toString("utf8"),
        );
        assert.ok(
          message.protocol_version === 1 &&
            message.type === "HELLO" &&
            message.payload?.ready === true &&
            message.payload.platform === "darwin" &&
            message.payload.arch === "arm64",
          "NATIVE_HELLO_NOT_READY",
        );
        helloReceived = true;
        child.stdin.end();
      } catch {
        stop("NATIVE_HELLO_INVALID");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) stop("QUALIFICATION_STDERR_LIMIT");
    });
    child.once("close", (code, signal) => {
      closed = true;
      children.delete(child);
      clearTimeout(timer);
      clearTimeout(hardDeadline);
      clearTimeout(killTimer);
      if (failure) {
        reject(new Error(failure));
        return;
      }
      if (
        nativeHello &&
        (!helloReceived || stdout.length !== stdout.readUInt32LE(0) + 4)
      ) {
        reject(new Error("NATIVE_FRAME_INVALID"));
        return;
      }
      done({
        code,
        signal,
        stdout,
        stdout_bytes: bytes,
        stderr_bytes: stderrBytes,
      });
    });
    if (input) child.stdin.write(input);
    if (!nativeHello) child.stdin.end();
  });
}

async function ownedProcessIds(emergency = false) {
  const result = await capture("/usr/bin/pgrep", ["-f", output], {
    timeout: 5_000,
    emergency,
  });
  assert.ok(
    [0, 1].includes(result.code) && !result.signal,
    "OWNED_PROCESS_CHECK_FAILED",
  );
  const text = result.stdout.toString("utf8").trim();
  if (!text) return [];
  const ids = text.split("\n").map(Number);
  assert.ok(
    ids.every(
      (pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid,
    ),
    "OWNED_PROCESS_CHECK_INVALID",
  );
  return ids;
}
async function requireOwnedCleanup() {
  const expires = Date.now() + 4_000;
  let ids;
  do {
    ids = await ownedProcessIds();
    if (!ids.length) return;
    await pause(100);
  } while (Date.now() < expires);
  throw new Error("OWNED_CHILDREN_REMAIN");
}
async function cleanupFailure() {
  for (const child of children) signalGroup(child, "SIGTERM");
  await pause(1_000);
  for (const child of children) signalGroup(child, "SIGKILL");
  // Detached tool groups are identified only by this run's unique output path.
  // Unrelated applications and worker groups must never be signalled.
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const pid of await ownedProcessIds(true)) {
      try {
        process.kill(pid, signal);
      } catch {
        /* Already exited. */
      }
    }
    await pause(500);
  }
  report.owned_children_remaining = (await ownedProcessIds(true)).length;
}
async function signature(app, label) {
  const result = await capture("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    app,
  ]);
  check(label, result.code === 0 && result.signal === null);
}
async function scanCopy(app) {
  let entries = 0;
  let symlinks = 0;
  async function walk(path) {
    for (const name of await readdir(path)) {
      assert.ok(++entries <= 30_000, "APP_COPY_ENTRY_LIMIT");
      const child = join(path, name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) {
        symlinks++;
        assert.ok(
          contained(app, await realpath(child)),
          "APP_COPY_EXTERNAL_SYMLINK",
        );
      } else if (info.isDirectory()) await walk(child);
      else assert.ok(info.isFile(), "APP_COPY_SPECIAL_FILE");
    }
  }
  await walk(app);
  return { entries, symlinks };
}
function projectedStatus(status) {
  assert.ok(
    status &&
      typeof status === "object" &&
      ["ready", "runtime_ready", "model_ready", "extension_registered"].every(
        (key) => typeof status[key] === "boolean",
      ),
    "APP_STATUS_INVALID",
  );
  return {
    ready: status.ready,
    runtime_ready: status.runtime_ready,
    model_ready: status.model_ready,
    extension_registered: status.extension_registered,
  };
}
function expectedLauncher(resources, runtimeRoot, state, testHome) {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  return [
    "#!/bin/sh",
    "# MusicMute Local companion launcher v1",
    `exec /usr/bin/env -i HOME=${quote(testHome)} PATH='/usr/bin:/bin' LANG='en_US.UTF-8' MUSICMUTE_LOCAL_ROOT=${quote(state)} MUSICMUTE_LOCAL_APP_RESOURCES=${quote(resources)} ${quote(join(runtimeRoot, "runtime/python/bin/python3"))} -B ${quote(join(resources, "scripts/native-lock.py"))} ${quote(join(runtimeRoot, "runtime/node/bin/node"))} ${quote(join(resources, "companion/host.js"))} "$@"`,
    "",
  ].join("\n");
}

async function requireThinResources(resources, label) {
  let embedded = false;
  try {
    await lstat(join(resources, "runtime"));
    embedded = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  check(label, !embedded);
}

async function qualify() {
  const args = process.argv.slice(2);
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    assert.ok(
      ["--app", "--model"].includes(args[index]) &&
        args[index + 1] &&
        !options.has(args[index]),
      "INVALID_QUALIFICATION_ARGUMENTS",
    );
    options.set(args[index], args[index + 1]);
  }
  assert.ok(
    process.platform === "darwin" && process.arch === "arm64",
    "UNSUPPORTED_PLATFORM",
  );
  assert.ok(
    args.length === 4 &&
      options.size === 2 &&
      isAbsolute(options.get("--app") ?? "") &&
      isAbsolute(options.get("--model") ?? ""),
    "INVALID_QUALIFICATION_ARGUMENTS",
  );
  await access(sandbox, constants.X_OK);
  await privateDirectory(output);
  const app = await realpath(options.get("--app"));
  const originalResources = join(app, "Contents/Resources");
  const originalControl = await boundedRead(
    join(originalResources, "companion/app-control.js"),
    1024 * 1024,
  );
  const originalHost = await boundedRead(
    join(originalResources, "companion/host.js"),
    1024 * 1024,
  );
  const block = originalControl
    .toString("utf8")
    .match(/(?:var|const) MODEL = Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1];
  const filename = block?.match(/filename: "([A-Za-z0-9_.-]+)"/)?.[1];
  const modelHash = block?.match(/sha256: "([a-f0-9]{64})"/)?.[1];
  const modelSize = Number(
    block?.match(/bytes:\s*([\d_]+)/)?.[1]?.replaceAll("_", ""),
  );
  assert.ok(
    filename?.endsWith(".onnx") &&
      modelHash &&
      modelSize > 0 &&
      modelSize < 100 * 1024 ** 2,
    "INSTALLED_MODEL_IDENTITY_INVALID",
  );
  const modelSource = options.get("--model");
  const modelBytes = await boundedRead(modelSource, modelSize);
  check(
    "Provided model matches package exact size/SHA-256",
    modelBytes.length === modelSize && digest(modelBytes) === modelHash,
  );
  report.package_app_control_sha256 = digest(originalControl);
  report.package_host_sha256 = digest(originalHost);
  report.script_sha256 = digest(
    await boundedRead(import.meta.filename, 128 * 1024),
  );
  const locationA = join(output, "original location");
  const locationB = join(output, "relocated location");
  await privateDirectory(locationA);
  await privateDirectory(locationB);
  const appA = join(locationA, "MusicMute Local.app");
  const appB = join(locationB, "MusicMute Local.app");
  const copied = await capture("/bin/cp", ["-c", "-p", "-R", app, appA]);
  assert.ok(copied.code === 0 && copied.signal === null, "APP_CLONE_FAILED");
  report.copied_bundle = await scanCopy(appA);
  await signature(
    appA,
    "Disposable copy passes deep/strict signature before setup",
  );
  const state = join(output, "state");
  const testHome = join(output, "home");
  await privateDirectory(state);
  await privateDirectory(testHome);
  const stagedRuntime = await stageExternalRuntimeForQualification({
    app,
    stateRoot: state,
  });
  const { runtimeRoot, releaseRoot, activePath, runtime, packageResult } =
    stagedRuntime;
  report.runtime = {
    id: runtime.id,
    archive_sha256: runtime.archive_sha256,
    files: runtime.files.length,
    installed_bytes: runtime.installed_bytes,
    reuse: "ONE_DISPOSABLE_RELEASE_FOR_BOTH_APP_LOCATIONS",
  };
  check(
    "Exact package runtime is verified and staged outside the app",
    stagedRuntime.resources === originalResources,
  );
  await requireThinResources(
    join(appA, "Contents/Resources"),
    "Location A copy contains no embedded runtime",
  );
  const model = join(state, "models", modelHash, filename);
  await privateDirectory(dirname(model));
  const copiedModel = await capture("/bin/cp", [
    "-c",
    "-p",
    modelSource,
    model,
  ]);
  assert.ok(
    copiedModel.code === 0 && copiedModel.signal === null,
    "MODEL_CLONE_FAILED",
  );
  await chmod(model, 0o600);
  check(
    "Private model copy is verified and has no shared hard link",
    (await lstat(model)).nlink === 1 &&
      digest(await boundedRead(model, modelSize)) === modelHash,
  );
  const profile = join(output, "sandbox.sb");
  const profilePath = output.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const protectedRuntimePath = dirname(activePath)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  await privateWrite(
    profile,
    // subprocess.DEVNULL opens /dev/null read/write; this fixed sink is not data.
    `(version 1)\n(allow default)\n(deny network-outbound)\n(deny file-write* (subpath "${protectedRuntimePath}"))\n(deny file-write* (require-all (require-not (subpath "${profilePath}")) (require-not (literal "/dev/null"))))\n`,
  );
  const guard = join(output, "probe-guard.mjs");
  await privateWrite(
    guard,
    `import { appendFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
const resources = process.env.MUSICMUTE_LOCAL_APP_RESOURCES;
const runtime = process.env.QUALIFICATION_RUNTIME_ROOT;
const root = process.env.MUSICMUTE_LOCAL_ROOT;
if (!runtime || homedir() !== process.env.QUALIFICATION_HOME) throw new Error('QUALIFICATION_HOME_INVALID');
const record = (value) => appendFileSync(process.env.QUALIFICATION_MARKER, JSON.stringify(value)+'\\n', {mode:0o600});
const deny = (code) => { record({kind:'denied',code}); throw new Error('QUALIFICATION_FORBIDDEN_OPERATION'); };
globalThis.fetch = () => deny('NETWORK_CALL');
for (const module of [http,https]) for (const method of ['request','get']) module[method] = () => deny('NETWORK_CALL');
for (const method of ['connect','createConnection']) net[method] = () => deny('NETWORK_CALL');
net.Socket.prototype.connect = () => deny('NETWORK_CALL');
const originalSpawn = childProcess.spawn;
const python = join(runtime,'runtime/python/bin/python3');
const runner = join(resources,'engine/local_pipeline.py');
const prefix = [runner,'--tool',python,'--','-I','-B','-S',join(runtime,'tools/downloader/downloader_bootstrap.py')];
const probes = [
 ['engine-doctor',[runner,'--doctor','--model-cache',join(root,'models')]],
 ['downloader-version',[...prefix,'--ignore-config','--no-plugin-dirs','--version']],
 ['downloader-help',[...prefix,'--ignore-config','--no-plugin-dirs','--help']],
 ['downloader-ejs',[...prefix,'--musicmute-check-ejs']],
 ['downloader-version',[runner,'--tool',join(runtime,'tools/yt-dlp'),'--','--ignore-config','--no-plugin-dirs','--version']],
 ['downloader-help',[runner,'--tool',join(runtime,'tools/yt-dlp'),'--','--ignore-config','--no-plugin-dirs','--help']],
];
childProcess.spawn = (executable,args,options) => {
 const probe = probes.find((value) => JSON.stringify(value[1]) === JSON.stringify(args));
 if (executable !== python || !probe || options?.shell !== false || options?.env?.HOME !== process.env.QUALIFICATION_HOME || options?.env?.TMPDIR !== root) return deny('SUBPROCESS_CALL');
 const child = originalSpawn(executable,args,options);
 record({kind:'probe',probe:probe[0],pid:child.pid});
 return child;
};
for (const method of ['spawnSync','exec','execSync','execFile','execFileSync','fork']) childProcess[method] = () => deny('SUBPROCESS_CALL');
syncBuiltinESMExports();
`,
  );
  const environment = (resources, marker) => ({
    ...safeEnvironment,
    HOME: testHome,
    TMPDIR: state,
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    MUSICMUTE_LOCAL_ROOT: state,
    MUSICMUTE_LOCAL_APP_RESOURCES: resources,
    QUALIFICATION_RUNTIME_ROOT: runtimeRoot,
    QUALIFICATION_HOME: testHome,
    QUALIFICATION_MARKER: marker,
  });
  async function appCommand(resources, command, label) {
    const marker = join(output, `guard-${randomUUID()}.jsonl`);
    const at = Date.now();
    const result = await capture(
      sandbox,
      [
        "-f",
        profile,
        join(runtimeRoot, "runtime/node/bin/node"),
        "--import",
        guard,
        join(resources, "companion/app-control.js"),
        command,
      ],
      { env: environment(resources, marker) },
    );
    assert.ok(
      result.code === 0 && result.signal === null,
      "APP_COMMAND_FAILED",
    );
    const messages = result.stdout
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => {
        assert.ok(Buffer.byteLength(line) <= 64 * 1024, "APP_FRAME_LIMIT");
        const message = JSON.parse(line);
        assert.ok(
          message.protocol_version === 1 &&
            ["progress", "result"].includes(message.type),
          "APP_REPLY_INVALID",
        );
        return message;
      });
    const terminals = messages.filter((message) => message.type === "result");
    assert.equal(terminals.length, 1, "APP_TERMINAL_INVALID");
    let records = [];
    try {
      records = (await boundedRead(marker, 16 * 1024))
        .toString("utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert.ok(
      records.every(
        (record) =>
          record.kind === "probe" &&
          [
            "engine-doctor",
            "downloader-version",
            "downloader-help",
            "downloader-ejs",
          ].includes(record.probe),
      ),
      "FORBIDDEN_OPERATION_ATTEMPTED",
    );
    if (records.some((record) => record.probe === "engine-doctor"))
      report.mps_readiness_probes_run = true;
    await requireOwnedCleanup();
    const status = terminals[0].status;
    assert.equal(
      status.extension_path,
      join(resources, "extension"),
      "EXTENSION_PATH_INVALID",
    );
    report.commands.push({
      phase: label,
      command,
      elapsed_ms: Date.now() - at,
      exit_code: result.code,
      stdout_bytes: result.stdout_bytes,
      stderr_bytes: result.stderr_bytes,
      status: projectedStatus(status),
      probes: records.map((record) => record.probe),
      owned_children_remaining: 0,
    });
    return status;
  }
  const resourcesA = join(appA, "Contents/Resources");
  const readyA = await appCommand(resourcesA, "setup", "before_move");
  check(
    "Setup at location A is ready with only private registration",
    readyA.ready &&
      readyA.runtime_ready &&
      readyA.model_ready &&
      readyA.extension_registered,
  );
  const launcherPath = join(state, "native-launcher.sh");
  const manifestPath = join(
    testHome,
    `Library/Application Support/Google/Chrome/NativeMessagingHosts/${hostName}.json`,
  );
  const firstLauncher = (await boundedRead(launcherPath, 16 * 1024)).toString(
    "utf8",
  );
  check(
    "Original launcher contains exclusively copied-app/private paths",
    firstLauncher ===
      expectedLauncher(resourcesA, runtimeRoot, state, testHome),
  );
  await rename(appA, appB);
  const resourcesB = join(appB, "Contents/Resources");
  await requireThinResources(
    resourcesB,
    "Relocated location B contains no embedded runtime",
  );
  const stale = await appCommand(resourcesB, "status", "moved_before_repair");
  check(
    "Physical movement detects the stale launcher",
    !stale.ready &&
      stale.runtime_ready &&
      stale.model_ready &&
      !stale.extension_registered &&
      (await boundedRead(launcherPath, 16 * 1024)).toString("utf8") ===
        firstLauncher,
  );
  const repaired = await appCommand(resourcesB, "setup", "moved_after_repair");
  check(
    "Setup at location B repairs registration and becomes ready",
    repaired.ready &&
      repaired.runtime_ready &&
      repaired.model_ready &&
      repaired.extension_registered,
  );
  const repairedLauncher = (
    await boundedRead(launcherPath, 16 * 1024)
  ).toString("utf8");
  const nativeManifest = JSON.parse(await boundedRead(manifestPath, 16 * 1024));
  const extensionManifest = JSON.parse(
    await boundedRead(join(resourcesB, "extension/manifest.json"), 64 * 1024),
  );
  const extensionId = digest(Buffer.from(extensionManifest.key, "base64"))
    .slice(0, 32)
    .split("")
    .map((hex) => String.fromCharCode(97 + Number.parseInt(hex, 16)))
    .join("");
  const origin = `chrome-extension://${extensionId}`;
  check(
    "Repaired launcher/manifest are private and reference B only",
    repairedLauncher ===
      expectedLauncher(resourcesB, runtimeRoot, state, testHome) &&
      !repairedLauncher.includes(resourcesA) &&
      nativeManifest.name === hostName &&
      nativeManifest.path === launcherPath &&
      nativeManifest.type === "stdio" &&
      JSON.stringify(nativeManifest.allowed_origins) ===
        JSON.stringify([`${origin}/`]) &&
      ((await lstat(launcherPath)).mode & 0o777) === 0o700 &&
      ((await lstat(manifestPath)).mode & 0o777) === 0o600,
  );
  const helloBody = Buffer.from(
    JSON.stringify({
      protocol_version: 1,
      request_id: randomUUID(),
      type: "HELLO",
      payload: {},
    }),
  );
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(helloBody.length);
  const helloStart = Date.now();
  const hello = await capture(sandbox, ["-f", profile, launcherPath, origin], {
    env: { ...safeEnvironment, HOME: testHome },
    input: Buffer.concat([prefix, helloBody]),
    nativeHello: true,
  });
  check(
    "Actual repaired launcher returns native HELLO ready and exits normally",
    hello.code === 0 && hello.signal === null,
  );
  await requireOwnedCleanup();
  report.commands.push({
    phase: "repaired_launcher",
    command: "HELLO",
    elapsed_ms: Date.now() - helloStart,
    exit_code: hello.code,
    stdout_bytes: hello.stdout_bytes,
    stderr_bytes: hello.stderr_bytes,
    ready: true,
    owned_children_remaining: 0,
  });
  await signature(
    appB,
    "Moved copy passes deep/strict signature after repair and HELLO",
  );
  await verifyExternalRuntimeForQualification({
    releaseRoot,
    activePath,
    runtime,
    packageResult,
  });
  check(
    "One staged external runtime remains immutable after both locations",
    true,
  );
  check(
    "Package source and copied companion bytes remain unchanged",
    digest(
      await boundedRead(
        join(originalResources, "companion/app-control.js"),
        1024 * 1024,
      ),
    ) === report.package_app_control_sha256 &&
      digest(
        await boundedRead(
          join(originalResources, "companion/host.js"),
          1024 * 1024,
        ),
      ) === report.package_host_sha256 &&
      digest(
        await boundedRead(
          join(resourcesB, "companion/app-control.js"),
          1024 * 1024,
        ),
      ) === report.package_app_control_sha256 &&
      digest(
        await boundedRead(join(resourcesB, "companion/host.js"), 1024 * 1024),
      ) === report.package_host_sha256,
  );
  check(
    "Copied model remains verified and the sandbox home has no worker state",
    digest(await boundedRead(model, modelSize)) === modelHash &&
      !(await readdir(join(testHome, "Library/Application Support"))).includes(
        "MusicMuteWorker",
      ),
  );
  await requireOwnedCleanup();
  report.owned_children_remaining = 0;
  report.passed = true;
}

async function finish() {
  if (finalizing) return;
  finalizing = true;
  report.wall_ms = Date.now() - started;
  await privateDirectory(output);
  const path = join(output, "result.json");
  const bytes = JSON.stringify(report, null, 2) + "\n";
  assert.ok(
    Buffer.byteLength(bytes) <= 64 * 1024 &&
      !bytes.includes("http://") &&
      !bytes.includes("https://") &&
      !bytes.includes("chrome-extension://") &&
      !bytes.includes("capability="),
    "REPORT_PRIVACY_FAILED",
  );
  await privateWrite(path, bytes);
  assert.ok(((await lstat(path)).mode & 0o777) === 0o600, "REPORT_NOT_PRIVATE");
  process.stdout.write(
    JSON.stringify({
      passed: report.passed,
      report: path,
      checks: report.checks.length,
      ...(report.error_code ? { error_code: report.error_code } : {}),
    }) + "\n",
  );
  process.exitCode = report.passed ? 0 : 1;
}
const overallDeadline = setTimeout(() => {
  timedOut = true;
  report.passed = false;
  report.error_code = "QUALIFICATION_OVERALL_TIMEOUT";
  void cleanupFailure()
    .then(finish)
    .finally(() => process.exit(1));
}, 300_000);
try {
  await privateDirectory(output);
  await qualify();
} catch (error) {
  report.passed = false;
  report.error_code = /^[A-Z_]{1,70}$/.test(error.message ?? "")
    ? error.message
    : "QUALIFICATION_FAILED";
  await cleanupFailure();
} finally {
  clearTimeout(overallDeadline);
  await finish();
}

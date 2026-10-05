// Explicit installed-app qualification; all mutable state is disposable/private.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const output = join(root, "output/registration-conflict-proof", randomUUID());
const testHome = join(output, "home");
const state = join(output, "state");
const temporary = join(output, "temporary");
const quarantine = join(output, "preserved-foreign-fixtures");
const policy = join(output, "qualification.sb");
const modelDigest =
  "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";
const modelBytes = 66_759_214;
const modelFilename = "Kim_Vocal_2.onnx";
const origin = "chrome-extension://dclpfemnpknfdlpcbfcjkmdbnociippd/";
const started = Date.now();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const delay = (milliseconds) =>
  new Promise((done) => setTimeout(done, milliseconds));
const report = {
  scope: "INSTALLED_APP_ISOLATED_REGISTRATION_CONFLICT_AND_EXPLICIT_RECOVERY",
  status: "FAILED",
  browser_playback: false,
  fixture_mode: false,
  checks: [],
  commands: [],
  gaps: [
    "Isolated HOME on this Mac is not a fresh OS user, Gatekeeper, Chrome installation or browser playback proof.",
    "A verified existing MusicMute Local model is explicitly APFS-cloned; first model download is outside this check.",
    "Only setup readiness and native HELLO run; no acquisition or separation job starts.",
  ],
};
let app;
let resources;
let node;
let env;
let stopActive;
let interrupted = false;
let sourceModel;
let clonedModel;
let controlHash;
let hostHash;
let wholeDeadline;

function check(code, condition) {
  report.checks.push({ code, passed: Boolean(condition) });
  assert.ok(condition, code);
}
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  assert.ok(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      !(info.mode & 0o077) &&
      info.uid === process.getuid(),
    "QUALIFICATION_DIRECTORY_UNSAFE",
  );
}
async function privateWrite(path, bytes, mode = 0o600) {
  await privateDirectory(dirname(path));
  await writeFile(path, bytes, { flag: "wx", mode });
}
async function boundedRead(path, maximum) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    assert.ok(
      info.isFile() && info.nlink === 1 && info.size <= maximum,
      "QUALIFICATION_READ_UNSAFE",
    );
    const bytes = await handle.readFile();
    assert.ok(bytes.length <= maximum, "QUALIFICATION_READ_LIMIT");
    return bytes;
  } finally {
    await handle.close();
  }
}
async function modelHash(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    assert.ok(
      info.isFile() &&
        info.nlink === 1 &&
        info.size === modelBytes &&
        !(info.mode & 0o077) &&
        info.uid === process.getuid(),
      "QUALIFICATION_MODEL_UNSAFE",
    );
    const hash = createHash("sha256");
    for await (const bytes of handle.createReadStream({ autoClose: false }))
      hash.update(bytes);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
async function signature(code) {
  let valid = false;
  try {
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
      timeout: 30_000,
      maxBuffer: 128 * 1024,
    });
    valid = true;
  } catch {
    /* Project the result without exposing arbitrary codesign output. */
  }
  check(code, valid);
}
async function processTable() {
  const { stdout } = await exec(
    "/bin/ps",
    ["-U", String(process.getuid()), "-o", "pid=,ppid=,pgid=,lstart="],
    { timeout: 2_000, maxBuffer: 512 * 1024 },
  );
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match
      ? [
          {
            pid: +match[1],
            parent: +match[2],
            group: +match[3],
            birth: match[4],
          },
        ]
      : [];
  });
}
function discover(rows, owned, pid) {
  const main = rows.find((row) => row.pid === pid);
  if (main && !owned.has(pid)) owned.set(pid, main);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const parent = owned.get(row.parent);
      if (
        !owned.has(row.pid) &&
        parent &&
        rows.some(
          (value) => value.pid === parent.pid && value.birth === parent.birth,
        )
      ) {
        owned.set(row.pid, row);
        changed = true;
      }
    }
  }
}
async function cleanup(owned) {
  let rows;
  let remaining;
  for (let attempt = 0; attempt < 6; attempt++) {
    rows = await processTable();
    remaining = rows.filter((row) => owned.get(row.pid)?.birth === row.birth);
    if (!remaining.length) return { clean: true, escalated: false };
    await delay(250);
  }
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    rows = await processTable();
    remaining = rows.filter((row) => owned.get(row.pid)?.birth === row.birth);
    for (const group of new Set(remaining.map((row) => row.group))) {
      assert.ok(
        rows
          .filter((row) => row.group === group)
          .every((row) => owned.get(row.pid)?.birth === row.birth),
        "QUALIFICATION_CLEANUP_UNSAFE",
      );
      try {
        process.kill(-group, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await delay(500);
  }
  rows = await processTable();
  return {
    clean: !rows.some((row) => owned.get(row.pid)?.birth === row.birth),
    escalated: true,
  };
}
function statusProjection(value) {
  assert.ok(
    value &&
      value.platform === "darwin" &&
      value.arch === "arm64" &&
      value.diagnostic_mode === "LOCAL_ONLY" &&
      ["ready", "runtime_ready", "model_ready", "extension_registered"].every(
        (key) => typeof value[key] === "boolean",
      ) &&
      Number.isSafeInteger(value.model_bytes),
    "QUALIFICATION_STATUS_INVALID",
  );
  return {
    ready: value.ready,
    runtime_ready: value.runtime_ready,
    model_ready: value.model_ready,
    extension_registered: value.extension_registered,
    model_bytes: value.model_bytes,
    extension_path_matches:
      value.extension_path === join(resources, "extension"),
  };
}
function nativeFrame(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length);
  return Buffer.concat([header, bytes]);
}
async function command(
  name,
  executable,
  args,
  { native = false, guard = false } = {},
) {
  assert.ok(!interrupted, "QUALIFICATION_CANCELLED");
  const summary = {
    code: name,
    progress: [],
    stdout_bytes: 0,
    stderr_bytes: 0,
  };
  report.commands.push(summary);
  const commandStarted = Date.now();
  const child = spawn(
    "/usr/bin/sandbox-exec",
    ["-f", policy, executable, ...args],
    {
      cwd: output,
      env,
      detached: true,
      stdio: [native ? "pipe" : "ignore", "pipe", "pipe"],
    },
  );
  const owned = new Map();
  let buffer = Buffer.alloc(0);
  let terminal;
  let failure;
  let closed = false;
  let monitorWork = Promise.resolve();
  let escalation;
  const requestId = randomUUID();
  const kill = (signal) => {
    if (closed || !child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") failure ??= "QUALIFICATION_SIGNAL_FAILED";
    }
  };
  const stop = (code) => {
    failure ??= code;
    kill("SIGTERM");
    escalation ??= setTimeout(() => kill("SIGKILL"), 3_000);
  };
  stopActive = () => stop("QUALIFICATION_CANCELLED");
  const monitor = setInterval(() => {
    monitorWork = monitorWork
      .then(async () => {
        if (!closed) discover(await processTable(), owned, child.pid);
      })
      .catch(() => stop("QUALIFICATION_PROCESS_SCAN_FAILED"));
  }, 200);
  const deadline = setTimeout(
    () => stop("QUALIFICATION_COMMAND_TIMEOUT"),
    native ? 75_000 : guard ? 5_000 : 90_000,
  );
  const parse = (bytes) => {
    const value = JSON.parse(bytes.toString("utf8"));
    if (native) {
      assert.ok(
        !terminal &&
          value.protocol_version === 1 &&
          value.request_id === requestId &&
          value.type === "HELLO",
        "QUALIFICATION_HELLO_INVALID",
      );
      const hello = value.payload;
      assert.ok(
        typeof hello?.ready === "boolean" &&
          hello.platform === "darwin" &&
          hello.arch === "arm64" &&
          hello.max_duration_seconds === 1200,
        "QUALIFICATION_HELLO_INVALID",
      );
      terminal = {
        type: "HELLO",
        ready: hello.ready,
        ...(hello.error_code && /^[A-Z_0-9]{1,80}$/.test(hello.error_code)
          ? { error_code: hello.error_code }
          : {}),
      };
      child.stdin.end();
      return;
    }
    if (guard) {
      assert.ok(
        !terminal && value.scope === "ISOLATION_GUARD",
        "QUALIFICATION_GUARD_INVALID",
      );
      terminal = {
        type: "guard",
        read_denials: value.read_denials,
        missing_paths: value.missing_paths,
        readable_paths: value.readable_paths,
        read_errors: value.read_errors,
        outbound_denied: value.outbound_denied,
        app_read: value.app_read,
        home_isolated: value.home_isolated,
      };
      return;
    }
    assert.ok(
      value.protocol_version === 1 &&
        ["progress", "result", "error"].includes(value.type),
      "QUALIFICATION_REPLY_INVALID",
    );
    if (value.type === "progress") {
      assert.ok(
        !terminal &&
          ["model_download", "validation", "registration", "ready"].includes(
            value.phase,
          ) &&
          Number.isFinite(value.percent) &&
          value.percent >= 0 &&
          value.percent <= 100 &&
          summary.progress.length < 64,
        "QUALIFICATION_PROGRESS_INVALID",
      );
      summary.progress.push({
        phase: value.phase,
        percent: value.percent,
        elapsed_ms: Date.now() - commandStarted,
      });
      assert.ok(
        value.phase !== "model_download" || value.percent === 0,
        "QUALIFICATION_UNEXPECTED_MODEL_DOWNLOAD",
      );
    } else {
      assert.ok(!terminal, "QUALIFICATION_TERMINAL_INVALID");
      if (value.type === "error") {
        assert.ok(
          typeof value.error_code === "string" &&
            /^[A-Z_0-9]{1,80}$/.test(value.error_code),
          "QUALIFICATION_ERROR_INVALID",
        );
        terminal = { type: "error", error_code: value.error_code };
      } else
        terminal = { type: "result", status: statusProjection(value.status) };
    }
  };
  child.stdout.on("data", (bytes) => {
    summary.stdout_bytes += bytes.length;
    if (summary.stdout_bytes > 128 * 1024)
      return stop("QUALIFICATION_OUTPUT_LIMIT");
    buffer = Buffer.concat([buffer, bytes]);
    try {
      if (native) {
        while (buffer.length >= 4) {
          const size = buffer.readUInt32LE();
          assert.ok(size > 0 && size <= 64 * 1024, "QUALIFICATION_FRAME_LIMIT");
          if (buffer.length < size + 4) break;
          parse(buffer.subarray(4, size + 4));
          buffer = buffer.subarray(size + 4);
        }
      } else {
        let boundary;
        while ((boundary = buffer.indexOf(10)) >= 0) {
          parse(buffer.subarray(0, boundary));
          buffer = buffer.subarray(boundary + 1);
        }
      }
      assert.ok(buffer.length <= 64 * 1024, "QUALIFICATION_FRAME_LIMIT");
    } catch (error) {
      const code = error?.message;
      stop(
        typeof code === "string" && /^QUALIFICATION_[A-Z_]+$/.test(code)
          ? code
          : "QUALIFICATION_REPLY_INVALID",
      );
    }
  });
  child.stderr.on("data", (bytes) => {
    summary.stderr_bytes += bytes.length;
    if (summary.stderr_bytes > 32 * 1024) stop("QUALIFICATION_STDERR_LIMIT");
  });
  child.once("error", () => stop("QUALIFICATION_CHILD_START_FAILED"));
  child.stdin?.on("error", () => stop("QUALIFICATION_INPUT_FAILED"));
  if (native)
    child.stdin.write(
      nativeFrame({
        protocol_version: 1,
        request_id: requestId,
        type: "HELLO",
        payload: {},
      }),
    );
  const exit = await new Promise((done) =>
    child.once("close", (code, signal) => done({ code, signal })),
  );
  closed = true;
  stopActive = undefined;
  clearTimeout(deadline);
  clearTimeout(escalation);
  clearInterval(monitor);
  await monitorWork;
  const cleaned = await cleanup(owned);
  summary.elapsed_ms = Date.now() - commandStarted;
  summary.exit_code = exit.code;
  summary.signal = exit.signal;
  summary.children_clean = cleaned.clean;
  summary.cleanup_escalated = cleaned.escalated;
  if (terminal) summary.terminal = terminal;
  assert.ok(cleaned.clean, "QUALIFICATION_CHILDREN_REMAIN");
  assert.ok(!failure, failure ?? "QUALIFICATION_COMMAND_FAILED");
  assert.ok(buffer.length === 0 && terminal, "QUALIFICATION_TERMINAL_MISSING");
  return summary;
}
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    interrupted = true;
    stopActive?.();
  });

try {
  assert.ok(
    process.platform === "darwin" && process.arch === "arm64",
    "UNSUPPORTED_PLATFORM",
  );
  assert.equal(process.argv.length, 2, "INVALID_QUALIFICATION_ARGUMENTS");
  for (const path of [output, testHome, state, temporary, quarantine])
    await privateDirectory(path);
  wholeDeadline = setTimeout(() => {
    interrupted = true;
    stopActive?.();
  }, 235_000);
  app = await realpath(join(homedir(), "Applications/MusicMute Local.app"));
  const appInfo = await lstat(app);
  assert.ok(
    appInfo.isDirectory() &&
      !appInfo.isSymbolicLink() &&
      appInfo.uid === process.getuid(),
    "INSTALLED_APP_UNSAFE",
  );
  resources = join(app, "Contents/Resources");
  node = join(resources, "runtime/runtime/node/bin/node");
  const control = await boundedRead(
    join(resources, "companion/app-control.js"),
    1024 * 1024,
  );
  controlHash = digest(control);
  hostHash = digest(
    await boundedRead(join(resources, "companion/host.js"), 1024 * 1024),
  );
  report.installed_app_control_sha256 = controlHash;
  report.installed_native_host_sha256 = hostHash;
  const modelBlock = control
    .toString("utf8")
    .match(/(?:var|const) MODEL = Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1];
  check(
    "INSTALLED_MODEL_IDENTITY_PINNED",
    Boolean(
      modelBlock?.includes(`filename: "${modelFilename}"`) &&
      modelBlock.includes(`sha256: "${modelDigest}"`) &&
      modelBlock.match(/bytes:\s*(\d+)/)?.[1] === String(modelBytes),
    ),
  );
  const audit = JSON.parse(
    await boundedRead(join(resources, "bundle-audit.json"), 8 * 1024 * 1024),
  );
  check(
    "PACKAGED_ARM64_NO_WEIGHTS_OR_FLEET_STATE",
    audit.architecture === "arm64" &&
      audit.includes_model_weights === false &&
      audit.includes_worker_state === false,
  );
  await signature("INSTALLED_SIGNATURE_BEFORE");
  env = {
    HOME: testHome,
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TMPDIR: temporary,
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTORCH_ENABLE_MPS_FALLBACK: "0",
    MUSICMUTE_LOCAL_ROOT: state,
    MUSICMUTE_LOCAL_APP_RESOURCES: resources,
  };
  const denied = [
    join(root, "../worker"),
    join(homedir(), "Library"),
    join(homedir(), ".musicmute-worker"),
    join(homedir(), ".ssh"),
    join(homedir(), ".aws"),
    "/opt/homebrew",
    "/usr/local",
  ].map((path) => resolve(path));
  const sandboxString = (value) => JSON.stringify(value);
  await privateWrite(
    policy,
    [
      "(version 1)",
      "(allow default)",
      "(deny network-outbound)",
      `(deny file-write* (require-all (require-not (subpath ${sandboxString(output)})) (require-not (literal "/dev/null"))))`,
      ...denied.map(
        (path) => `(deny file-read* (subpath ${sandboxString(path)}))`,
      ),
      "",
    ].join("\n"),
  );
  const guardCode = `
    import { lstatSync, readFileSync } from 'node:fs';
    import { homedir } from 'node:os';
    import { createConnection } from 'node:net';
    const denied = ${JSON.stringify(denied)};
    const readOutcomes = denied.map(path => {
      try { lstatSync(path); return 'READABLE'; }
      catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') return 'DENIED';
        return error.code === 'ENOENT' ? 'MISSING' : 'ERROR';
      }
    });
    const outboundDenied = await new Promise(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port: 1 });
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
      socket.once('error', error => { clearTimeout(timer); resolve(error.code === 'EPERM' || error.code === 'EACCES'); });
      socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(false); });
    });
    console.log(JSON.stringify({ scope: 'ISOLATION_GUARD', read_denials: readOutcomes.filter(value => value === 'DENIED').length,
      missing_paths: readOutcomes.filter(value => value === 'MISSING').length,
      readable_paths: readOutcomes.filter(value => value === 'READABLE').length,
      read_errors: readOutcomes.filter(value => value === 'ERROR').length,
      outbound_denied: outboundDenied, app_read: readFileSync(${JSON.stringify(join(resources, "companion/app-control.js"))}).length > 0,
      home_isolated: homedir() === process.env.HOME }));
  `;
  const guard = await command(
    "ISOLATION_GUARD",
    node,
    ["--input-type=module", "-e", guardCode],
    { guard: true },
  );
  check(
    "OUTBOUND_NETWORK_AND_REAL_DEPENDENCY_READS_DENIED",
    guard.exit_code === 0 &&
      guard.terminal.read_denials + guard.terminal.missing_paths ===
        denied.length &&
      guard.terminal.readable_paths === 0 &&
      guard.terminal.read_errors === 0 &&
      guard.terminal.outbound_denied === true &&
      guard.terminal.app_read === true &&
      guard.terminal.home_isolated === true,
  );
  sourceModel = join(
    homedir(),
    "Library/Application Support/MusicMuteLocal/models",
    modelDigest,
    modelFilename,
  );
  clonedModel = join(state, "models", modelDigest, modelFilename);
  check(
    "SOURCE_MODEL_VERIFIED_READ_ONLY",
    (await modelHash(sourceModel)) === modelDigest,
  );
  await privateDirectory(dirname(clonedModel));
  await exec("/bin/cp", ["-c", sourceModel, clonedModel], {
    timeout: 10_000,
    maxBuffer: 4096,
  });
  await chmod(clonedModel, 0o400);
  const sourceInfo = await lstat(sourceModel);
  const cloneInfo = await lstat(clonedModel);
  check(
    "MODEL_APFS_CLONE_PINNED_AND_SEPARATE",
    sourceInfo.ino !== cloneInfo.ino &&
      sourceInfo.dev === cloneInfo.dev &&
      (await modelHash(clonedModel)) === modelDigest &&
      (cloneInfo.mode & 0o777) === 0o400,
  );
  const manifest = join(
    testHome,
    "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.musicmute.local.json",
  );
  const foreignLauncher = join(state, "foreign-helper.sh");
  const foreignLauncherBytes = Buffer.from(
    "#!/bin/sh\n# Foreign qualification fixture; never execute.\nexit 72\n",
  );
  const foreignManifestBytes = Buffer.from(
    JSON.stringify({
      name: "com.musicmute.local",
      path: foreignLauncher,
      type: "stdio",
      allowed_origins: [origin],
    }) + "\n",
  );
  await privateWrite(foreignLauncher, foreignLauncherBytes, 0o700);
  await privateWrite(manifest, foreignManifestBytes);
  const conflicted = await command("SETUP_FOREIGN_REGISTRATION", node, [
    join(resources, "companion/app-control.js"),
    "setup",
  ]);
  check(
    "FOREIGN_MANIFEST_AND_LAUNCHER_UNCHANGED",
    (await boundedRead(manifest, 16 * 1024)).equals(foreignManifestBytes) &&
      (await boundedRead(foreignLauncher, 4096)).equals(foreignLauncherBytes),
  );
  check(
    "SETUP_REACHES_REGISTRATION_AND_REFUSES_FOREIGN_OWNER",
    conflicted.exit_code === 1 &&
      conflicted.terminal.type === "error" &&
      conflicted.terminal.error_code === "FOREIGN_NATIVE_REGISTRATION_EXISTS" &&
      conflicted.progress.some(
        (event) => event.phase === "registration" && event.percent === 95,
      ),
  );
  const savedManifest = join(quarantine, "foreign-manifest.json");
  const savedLauncher = join(quarantine, "foreign-helper.sh");
  await rename(manifest, savedManifest);
  await rename(foreignLauncher, savedLauncher);
  check(
    "EXPLICIT_FIXTURE_RESOLUTION_PRESERVES_QUARANTINE_BYTES",
    (await boundedRead(savedManifest, 16 * 1024)).equals(
      foreignManifestBytes,
    ) && (await boundedRead(savedLauncher, 4096)).equals(foreignLauncherBytes),
  );
  const recovered = await command("SETUP_EXPLICIT_RECOVERY", node, [
    join(resources, "companion/app-control.js"),
    "setup",
  ]);
  check(
    "RECOVERY_READY_WITH_PINNED_MODEL",
    recovered.exit_code === 0 &&
      recovered.terminal.type === "result" &&
      Object.entries(recovered.terminal.status).every(([key, value]) =>
        key === "model_bytes" ? value === modelBytes : value === true,
      ),
  );
  const installedManifest = JSON.parse(
    (await boundedRead(manifest, 16 * 1024)).toString("utf8"),
  );
  const launcher = join(state, "native-launcher.sh");
  const launcherBytes = (await boundedRead(launcher, 16 * 1024)).toString(
    "utf8",
  );
  check(
    "ISOLATED_NATIVE_REGISTRATION_PRIVATE_AND_EXACT",
    installedManifest.name === "com.musicmute.local" &&
      installedManifest.type === "stdio" &&
      installedManifest.path === launcher &&
      JSON.stringify(installedManifest.allowed_origins) ===
        JSON.stringify([origin]) &&
      (await lstat(manifest)).mode % 512 === 0o600 &&
      (await lstat(launcher)).mode % 512 === 0o700 &&
      launcherBytes.includes(resources) &&
      launcherBytes.includes(state) &&
      launcherBytes.includes(testHome) &&
      !launcherBytes.includes("MusicMuteWorker") &&
      !launcherBytes.includes("/opt/homebrew"),
  );
  const hello = await command(
    "RECOVERED_ACTUAL_NATIVE_HELLO",
    launcher,
    [origin],
    { native: true },
  );
  check(
    "RECOVERED_NATIVE_HELLO_READY",
    hello.exit_code === 0 &&
      hello.terminal.type === "HELLO" &&
      hello.terminal.ready === true &&
      hello.children_clean,
  );
  check(
    "FOREIGN_QUARANTINE_RETAINED_AFTER_RECOVERY",
    (await boundedRead(savedManifest, 16 * 1024)).equals(
      foreignManifestBytes,
    ) && (await boundedRead(savedLauncher, 4096)).equals(foreignLauncherBytes),
  );
  check(
    "NO_MODEL_DOWNLOAD_PROGRESS",
    report.commands.every((value) =>
      value.progress.every(
        (event) => event.phase !== "model_download" || event.percent === 0,
      ),
    ),
  );
  report.status = "VERIFIED";
} catch (error) {
  const code = error?.message;
  report.failure_code =
    typeof code === "string" && /^[A-Z_0-9]{1,100}$/.test(code)
      ? code
      : "QUALIFICATION_FAILED";
  process.exitCode = 1;
} finally {
  clearTimeout(wholeDeadline);
  for (const [code, operation] of [
    [
      "SOURCE_USER_MODEL_UNCHANGED",
      async () => (await modelHash(sourceModel)) === modelDigest,
    ],
    [
      "ISOLATED_MODEL_UNCHANGED",
      async () => (await modelHash(clonedModel)) === modelDigest,
    ],
    [
      "INSTALLED_APP_CONTROL_UNCHANGED",
      async () =>
        digest(
          await boundedRead(
            join(resources, "companion/app-control.js"),
            1024 * 1024,
          ),
        ) === controlHash,
    ],
    [
      "INSTALLED_NATIVE_HOST_UNCHANGED",
      async () =>
        digest(
          await boundedRead(join(resources, "companion/host.js"), 1024 * 1024),
        ) === hostHash,
    ],
  ]) {
    if (!resources || !sourceModel || !clonedModel) break;
    try {
      check(code, await operation());
    } catch {
      if (!report.checks.some((value) => value.code === code))
        report.checks.push({ code, passed: false });
      report.status = "FAILED";
      process.exitCode = 1;
    }
  }
  if (app) {
    try {
      await signature("INSTALLED_SIGNATURE_AFTER");
    } catch {
      report.status = "FAILED";
      process.exitCode = 1;
    }
  }
  report.wall_ms = Date.now() - started;
  try {
    await privateDirectory(output);
    await privateWrite(
      join(output, "result.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    process.stdout.write(
      JSON.stringify({
        status: report.status,
        checks: report.checks.length,
        failure_code: report.failure_code,
        report: join(output, "result.json"),
      }) + "\n",
    );
  } catch {
    process.stdout.write(
      '{"status":"FAILED","failure_code":"QUALIFICATION_REPORT_FAILED"}\n',
    );
    process.exitCode = 1;
  }
}

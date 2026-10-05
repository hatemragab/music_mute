import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const output = join(root, "output/model-recovery-proof", randomUUID());
const testHome = join(output, "home");
const state = join(output, "state");
const temporary = join(output, "temporary");
const expectedModel = {
  filename: "Kim_Vocal_2.onnx",
  bytes: 66_759_214,
  sha256: "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b",
  url: "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx",
};
const report = {
  scope: "INSTALLED_APP_ISOLATED_HOME_FIRST_MODEL_CANCEL_AND_RETRY",
  status: "FAILED",
  checks: [],
  commands: [],
  gaps: [
    "An isolated HOME on this Mac is not a fresh OS user or Gatekeeper qualification.",
    "No browser installation, UI, YouTube acquisition, audio inference or listening is exercised.",
  ],
};
let app;
let resources;
let node;
let env;
let stopActive;
let interrupted = false;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (milliseconds) =>
  new Promise((done) => setTimeout(done, milliseconds));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function check(code, condition) {
  report.checks.push({ code, passed: Boolean(condition) });
  return Boolean(condition);
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
async function privateFile(path, maximum, mode) {
  const info = await lstat(path);
  assert.ok(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.nlink === 1 &&
      info.size <= maximum &&
      info.uid === process.getuid() &&
      (info.mode & 0o777) === mode,
    "QUALIFICATION_FILE_UNSAFE",
  );
  return info;
}
async function boundedRead(path, maximum) {
  const info = await lstat(path);
  assert.ok(
    info.isFile() && !info.isSymbolicLink() && info.size <= maximum,
    "QUALIFICATION_READ_UNSAFE",
  );
  return readFile(path);
}
async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function verifySignature(code) {
  try {
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
      timeout: 30_000,
      maxBuffer: 128 * 1024,
    });
    return check(code, true);
  } catch {
    return check(code, false);
  }
}
async function processTable() {
  const { stdout } = await exec(
    "/bin/ps",
    ["-U", String(process.getuid()), "-o", "pid=,ppid=,pgid=,lstart="],
    {
      timeout: 2_000,
      maxBuffer: 512 * 1024,
    },
  );
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match
      ? [
          {
            pid: Number(match[1]),
            parent: Number(match[2]),
            group: Number(match[3]),
            birth: match[4],
          },
        ]
      : [];
  });
}
function discoverOwned(rows, owned, pid) {
  const parent = rows.find((row) => row.pid === pid);
  if (parent && !owned.has(pid)) owned.set(pid, parent);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const knownParent = owned.get(row.parent);
      if (
        !owned.has(row.pid) &&
        knownParent &&
        rows.some(
          (candidate) =>
            candidate.pid === knownParent.pid &&
            candidate.birth === knownParent.birth,
        )
      ) {
        owned.set(row.pid, row);
        changed = true;
      }
    }
  }
}
async function cleanupOwned(owned) {
  const live = async () => {
    const rows = await processTable();
    return {
      rows,
      remaining: rows.filter((row) => owned.get(row.pid)?.birth === row.birth),
    };
  };
  let current;
  for (let attempt = 0; attempt < 6; attempt++) {
    current = await live();
    if (!current.remaining.length) return { clean: true, escalated: false };
    await delay(250);
  }
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    current = await live();
    for (const group of new Set(current.remaining.map((row) => row.group))) {
      const members = current.rows.filter((row) => row.group === group);
      assert.ok(
        members.every((row) => owned.get(row.pid)?.birth === row.birth),
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
  current = await live();
  return { clean: current.remaining.length === 0, escalated: true };
}
function statusProjection(value) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    "QUALIFICATION_STATUS_INVALID",
  );
  assert.ok(
    ["ready", "runtime_ready", "model_ready", "extension_registered"].every(
      (key) => typeof value[key] === "boolean",
    ) &&
      value.platform === "darwin" &&
      value.arch === "arm64" &&
      value.diagnostic_mode === "LOCAL_ONLY" &&
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
async function setupAttempt(name, cancelDownload) {
  assert.ok(!interrupted, "QUALIFICATION_CANCELLED");
  const started = Date.now();
  const owned = new Map();
  const summary = {
    code: name,
    progress: [],
    stdout_bytes: 0,
    stderr_bytes: 0,
    cancel_sent: false,
  };
  report.commands.push(summary);
  const child = spawn(
    node,
    [join(resources, "companion/app-control.js"), "setup"],
    {
      cwd: output,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let buffer = "";
  let terminal;
  let failure;
  let escalation;
  let monitoring = Promise.resolve();
  let closed = false;
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
    escalation ??= setTimeout(() => kill("SIGKILL"), 5_000);
  };
  stopActive = () => stop("QUALIFICATION_CANCELLED");
  const monitor = setInterval(() => {
    monitoring = monitoring
      .then(async () => {
        if (!closed) discoverOwned(await processTable(), owned, child.pid);
      })
      .catch(() => stop("QUALIFICATION_PROCESS_SCAN_FAILED"));
  }, 250);
  // Leave five seconds for graceful termination within the three-minute bound.
  const deadline = setTimeout(() => stop("QUALIFICATION_TIMEOUT"), 175_000);
  const parse = (line) => {
    assert.ok(
      Buffer.byteLength(line) <= 64 * 1024,
      "QUALIFICATION_FRAME_LIMIT",
    );
    const value = JSON.parse(line);
    assert.ok(
      value &&
        value.protocol_version === 1 &&
        ["progress", "result", "error"].includes(value.type),
      "QUALIFICATION_REPLY_INVALID",
    );
    if (value.type === "progress") {
      assert.ok(
        ["model_download", "validation", "registration", "ready"].includes(
          value.phase,
        ) &&
          Number.isFinite(value.percent) &&
          value.percent >= 0 &&
          value.percent <= 100,
        "QUALIFICATION_PROGRESS_INVALID",
      );
      summary.progress.push({
        phase: value.phase,
        percent: value.percent,
        elapsed_ms: Date.now() - started,
      });
      assert.ok(summary.progress.length <= 128, "QUALIFICATION_PROGRESS_LIMIT");
      if (
        cancelDownload &&
        !summary.cancel_sent &&
        value.phase === "model_download" &&
        value.percent > 0 &&
        value.percent < 55 &&
        value.label === "Downloading the voice model"
      ) {
        summary.cancel_percent = value.percent;
        summary.cancel_sent = child.kill("SIGTERM");
        escalation ??= setTimeout(() => {
          failure ??= "QUALIFICATION_CANCEL_TIMEOUT";
          kill("SIGKILL");
        }, 5_000);
      }
    } else {
      assert.ok(!terminal, "QUALIFICATION_TERMINAL_INVALID");
      if (value.type === "error") {
        assert.ok(
          typeof value.error_code === "string" &&
            /^[A-Z_]{1,60}$/.test(value.error_code),
          "QUALIFICATION_ERROR_INVALID",
        );
        terminal = { type: "error", error_code: value.error_code };
      } else
        terminal = { type: "result", status: statusProjection(value.status) };
    }
  };
  child.stdout.on("data", (chunk) => {
    summary.stdout_bytes += chunk.length;
    if (summary.stdout_bytes > 128 * 1024) {
      stop("QUALIFICATION_OUTPUT_LIMIT");
      return;
    }
    buffer += chunk.toString("utf8");
    try {
      let boundary;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        parse(line);
      }
      if (Buffer.byteLength(buffer) > 64 * 1024)
        stop("QUALIFICATION_FRAME_LIMIT");
    } catch {
      stop("QUALIFICATION_REPLY_INVALID");
    }
  });
  child.stderr.on("data", (chunk) => {
    summary.stderr_bytes += chunk.length;
    if (summary.stderr_bytes > 32 * 1024) stop("QUALIFICATION_STDERR_LIMIT");
  });
  child.once("error", () => {
    failure ??= "QUALIFICATION_CHILD_START_FAILED";
  });
  const completion = await new Promise((done) =>
    child.once("close", (exitCode, signal) => done({ exitCode, signal })),
  );
  closed = true;
  stopActive = undefined;
  clearInterval(monitor);
  clearTimeout(deadline);
  clearTimeout(escalation);
  await monitoring;
  const cleanup = await cleanupOwned(owned);
  summary.elapsed_ms = Date.now() - started;
  summary.exit_code = completion.exitCode;
  summary.signal = completion.signal;
  summary.children_clean = cleanup.clean;
  summary.cleanup_escalated = cleanup.escalated;
  assert.ok(cleanup.clean, "QUALIFICATION_CHILDREN_REMAIN");
  assert.ok(!failure, failure ?? "QUALIFICATION_COMMAND_FAILED");
  assert.ok(!buffer.trim() && terminal, "QUALIFICATION_TERMINAL_INVALID");
  summary.terminal = terminal;
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
  await privateDirectory(output);
  for (const path of [testHome, state, temporary]) await privateDirectory(path);
  app = join(homedir(), "Applications/MusicMute Local.app");
  const appInfo = await lstat(app);
  assert.ok(
    appInfo.isDirectory() &&
      !appInfo.isSymbolicLink() &&
      appInfo.uid === process.getuid(),
    "INSTALLED_APP_UNSAFE",
  );
  app = await realpath(app);
  resources = join(app, "Contents/Resources");
  node = join(resources, "runtime/runtime/node/bin/node");
  const control = await boundedRead(
    join(resources, "companion/app-control.js"),
    1024 * 1024,
  );
  const modelBlock = control
    .toString("utf8")
    .match(/(?:var|const) MODEL = Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1];
  assert.ok(modelBlock, "INSTALLED_MODEL_IDENTITY_MISSING");
  assert.ok(
    modelBlock.includes(`filename: "${expectedModel.filename}"`) &&
      modelBlock.match(/bytes:\s*(\d+)/)?.[1] === String(expectedModel.bytes) &&
      modelBlock.includes(`sha256: "${expectedModel.sha256}"`) &&
      modelBlock.includes(`url: "${expectedModel.url}"`),
    "INSTALLED_MODEL_IDENTITY_INVALID",
  );
  report.installed_app_control_sha256 = digest(control);
  const audit = JSON.parse(
    await boundedRead(join(resources, "bundle-audit.json"), 8 * 1024 * 1024),
  );
  assert.ok(
    audit.architecture === "arm64" &&
      audit.includes_model_weights === false &&
      audit.includes_worker_state === false,
    "INSTALLED_APP_AUDIT_INVALID",
  );
  assert.ok(
    await verifySignature("INSTALLED_SIGNATURE_BEFORE"),
    "INSTALLED_SIGNATURE_INVALID",
  );
  env = {
    HOME: testHome,
    PATH: [
      dirname(node),
      join(resources, "runtime/runtime/python/bin"),
      "/usr/bin",
      "/bin",
    ].join(":"),
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TMPDIR: temporary,
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTORCH_ENABLE_MPS_FALLBACK: "0",
    MUSICMUTE_LOCAL_APP_RESOURCES: resources,
    MUSICMUTE_LOCAL_ROOT: state,
  };
  const { stdout: isolatedHome } = await exec(
    node,
    [
      "--input-type=module",
      "-e",
      "import { homedir } from 'node:os'; process.stdout.write(homedir() === process.env.HOME ? 'ISOLATED_HOME' : 'HOME_INVALID');",
    ],
    { cwd: output, env, timeout: 5_000, maxBuffer: 1024 },
  );
  assert.equal(isolatedHome, "ISOLATED_HOME", "QUALIFICATION_HOME_INVALID");
  check(
    "BUNDLED_PYTHON_NO_BYTECODE",
    control.includes(Buffer.from('PYTHONDONTWRITEBYTECODE: "1"')),
  );
  const modelDirectory = join(state, "models", expectedModel.sha256);
  const model = join(modelDirectory, expectedModel.filename);
  const manifest = join(
    testHome,
    "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.musicmute.local.json",
  );
  assert.ok(
    !(await exists(model)) && !(await exists(manifest)),
    "QUALIFICATION_STATE_NOT_FRESH",
  );
  check("FRESH_ISOLATED_STATE", true);
  const first = await setupAttempt("FIRST_DOWNLOAD_CANCEL", true);
  const publishedAfterCancel = await exists(model);
  const partialsAfterCancel = (await exists(modelDirectory))
    ? (await readdir(modelDirectory)).filter((name) =>
        name.startsWith(".download-"),
      )
    : [];
  check("CANCEL_PARTIAL_FILES_REMOVED", partialsAfterCancel.length === 0);
  if (publishedAfterCancel) {
    report.gaps.push(
      "Model publication raced cancellation; cancellation before publication is inconclusive. The retry may reuse only this qualification's owned model.",
    );
    first.cancellation_proof = "INCONCLUSIVE_PUBLICATION_RACE";
  } else {
    first.cancellation_proof = check(
      "NONZERO_DOWNLOAD_CANCELLED",
      first.cancel_sent &&
        first.cancel_percent > 0 &&
        first.cancel_percent < 55 &&
        first.terminal.type === "error" &&
        first.terminal.error_code === "CANCELLED" &&
        first.exit_code === 1,
    )
      ? "VERIFIED"
      : "FAILED";
  }
  const second = await setupAttempt("EXPLICIT_RETRY", false);
  check(
    "RETRY_READY",
    second.exit_code === 0 &&
      second.terminal.type === "result" &&
      Object.entries(second.terminal.status).every(([key, value]) =>
        key === "model_bytes" ? value === expectedModel.bytes : value === true,
      ),
  );
  check(
    "RETRY_OWNER_DOWNLOAD_OBSERVED",
    publishedAfterCancel ||
      second.progress.some(
        (event) =>
          event.phase === "model_download" &&
          event.percent > 0 &&
          event.percent <= 55,
      ),
  );
  for (const path of [
    state,
    join(state, "models"),
    modelDirectory,
    join(state, "cache"),
    join(state, "logs"),
    dirname(manifest),
  ])
    await privateDirectory(path);
  const modelInfo = await privateFile(model, expectedModel.bytes, 0o600);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(model)) hash.update(chunk);
  report.model_bytes = modelInfo.size;
  report.model_sha256 = hash.digest("hex");
  check(
    "OWNED_MODEL_PINNED",
    modelInfo.size === expectedModel.bytes &&
      report.model_sha256 === expectedModel.sha256,
  );
  check(
    "RETRY_PARTIAL_FILES_REMOVED",
    !(await readdir(modelDirectory)).some((name) =>
      name.startsWith(".download-"),
    ),
  );
  await privateFile(manifest, 16 * 1024, 0o600);
  const registration = JSON.parse(await boundedRead(manifest, 16 * 1024));
  const extension = JSON.parse(
    await boundedRead(join(resources, "extension/manifest.json"), 32 * 1024),
  );
  const id = digest(Buffer.from(extension.key, "base64"))
    .slice(0, 32)
    .split("")
    .map((hex) => String.fromCharCode(97 + Number.parseInt(hex, 16)))
    .join("");
  const launcher = join(state, "native-launcher.sh");
  await privateFile(launcher, 16 * 1024, 0o700);
  const launcherText = (await boundedRead(launcher, 16 * 1024)).toString(
    "utf8",
  );
  check(
    "ISOLATED_NATIVE_REGISTRATION",
    registration.name === "com.musicmute.local" &&
      registration.type === "stdio" &&
      registration.path === launcher &&
      JSON.stringify(registration.allowed_origins) ===
        JSON.stringify([`chrome-extension://${id}/`]) &&
      launcherText.includes(`HOME=${quote(testHome)}`) &&
      launcherText.includes(`MUSICMUTE_LOCAL_ROOT=${quote(state)}`) &&
      launcherText.includes(
        `MUSICMUTE_LOCAL_APP_RESOURCES=${quote(resources)}`,
      ) &&
      launcherText.includes(
        `${quote(join(resources, "runtime/runtime/python/bin/python3"))} -B ${quote(join(resources, "scripts/native-lock.py"))}`,
      ) &&
      launcherText.includes(
        `${quote(node)} ${quote(join(resources, "companion/host.js"))}`,
      ),
  );
  check(
    "INSTALLED_CONTROL_UNCHANGED",
    digest(
      await boundedRead(
        join(resources, "companion/app-control.js"),
        1024 * 1024,
      ),
    ) === report.installed_app_control_sha256,
  );
  report.status = report.checks.every((item) => item.passed)
    ? publishedAfterCancel
      ? "INCONCLUSIVE"
      : "VERIFIED"
    : "FAILED";
} catch (error) {
  report.error_code =
    typeof error.message === "string" && /^[A-Z_]{1,80}$/.test(error.message)
      ? error.message
      : "QUALIFICATION_FAILED";
} finally {
  if (app) await verifySignature("INSTALLED_SIGNATURE_AFTER");
  if (report.checks.some((item) => !item.passed)) report.status = "FAILED";
  await privateDirectory(output);
  await writeFile(
    join(output, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      status: report.status,
      checks: report.checks.length,
      report: join(output, "result.json"),
      ...(report.error_code ? { error_code: report.error_code } : {}),
    }),
  );
  if (report.status === "FAILED") process.exitCode = 1;
}

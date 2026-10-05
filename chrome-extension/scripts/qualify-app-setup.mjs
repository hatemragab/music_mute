import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "output/app-setup-proof", randomUUID());
const report = {
  scope: "INSTALLED_APP_ISOLATED_CLI_NO_DOWNLOAD_OR_GPU",
  installed_app: "MusicMute Local.app",
  checks: [],
  commands: [],
  gaps: [
    "Native UI interaction and a clean OS user are outside this CLI check.",
    "Model download, doctor, inference and successful registration are deliberately not run.",
    "Foreign registration status and preservation are checked; setup's registration-conflict error requires prior model/readiness success and remains untested here.",
  ],
  network_calls: 0,
  child_process_calls: 0,
};
let guard;
let resources;
let node;

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
async function writePrivate(path, bytes) {
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
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(name) {
  const directory = join(output, name);
  const state = join(directory, "state");
  const testHome = join(directory, "home");
  await privateDirectory(state);
  await privateDirectory(testHome);
  return { directory, state, testHome };
}
async function execute(command, test, overrides = {}) {
  const marker = join(test.directory, `guard-${randomUUID()}.jsonl`);
  const env = {
    HOME: test.testHome,
    PATH: [
      dirname(node),
      join(resources, "runtime/runtime/python/bin"),
      "/usr/bin",
      "/bin",
    ].join(":"),
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TMPDIR: test.directory,
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    QUALIFICATION_HOME: test.testHome,
    QUALIFICATION_MARKER: marker,
    MUSICMUTE_LOCAL_APP_RESOURCES: resources,
    MUSICMUTE_LOCAL_ROOT: test.state,
    ...overrides,
  };
  const started = Date.now();
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(
      node,
      ["--import", guard, join(resources, "companion/app-control.js"), command],
      {
        cwd: test.directory,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    let bytes = 0;
    let stderrBytes = 0;
    let stdout = "";
    let failure;
    let killTimer;
    const stop = (code) => {
      failure ??= code;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* Already exited. */
      }
      killTimer ??= setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }, 1000);
    };
    const timeout = setTimeout(() => stop("QUALIFICATION_TIMEOUT"), 10_000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 128 * 1024) stop("QUALIFICATION_OUTPUT_LIMIT");
      else stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 16 * 1024) stop("QUALIFICATION_STDERR_LIMIT");
    });
    child.once("error", () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      reject(new Error("QUALIFICATION_CHILD_START_FAILED"));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      if (failure) {
        reject(new Error(failure));
        return;
      }
      try {
        const lines = stdout.trim().split("\n");
        const messages = lines.map((line) => {
          assert.ok(
            Buffer.byteLength(line) <= 64 * 1024,
            "QUALIFICATION_FRAME_LIMIT",
          );
          const message = JSON.parse(line);
          assert.equal(
            message.protocol_version,
            1,
            "QUALIFICATION_PROTOCOL_INVALID",
          );
          assert.ok(
            ["progress", "result", "error"].includes(message.type),
            "QUALIFICATION_REPLY_INVALID",
          );
          if (message.type === "error")
            assert.ok(
              typeof message.error_code === "string" &&
                /^[A-Z_]{1,60}$/.test(message.error_code),
              "QUALIFICATION_ERROR_CODE_INVALID",
            );
          return message;
        });
        const terminals = messages.filter(
          (message) => message.type !== "progress",
        );
        assert.equal(terminals.length, 1, "QUALIFICATION_TERMINAL_INVALID");
        resolveResult({
          terminal: terminals[0],
          messages,
          code,
          signal,
          stderrBytes,
        });
      } catch {
        reject(new Error("QUALIFICATION_REPLY_INVALID"));
      }
    });
  });
  let markers = [];
  try {
    markers = (await boundedRead(marker, 4096))
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  report.network_calls += markers.filter(
    (value) => value === "NETWORK_CALL",
  ).length;
  report.child_process_calls += markers.filter(
    (value) => value === "SUBPROCESS_CALL",
  ).length;
  assert.equal(markers.length, 0, "QUALIFICATION_FORBIDDEN_OPERATION");
  report.commands.push({
    case: relative(output, test.directory),
    command,
    exit_code: result.code,
    terminal: result.terminal.type,
    elapsed_ms: Date.now() - started,
    ...(result.terminal.error_code
      ? { error_code: result.terminal.error_code }
      : {}),
    stderr_bytes: result.stderrBytes,
  });
  return result;
}

try {
  assert.ok(
    process.platform === "darwin" && process.arch === "arm64",
    "UNSUPPORTED_PLATFORM",
  );
  const args = process.argv.slice(2);
  assert.ok(
    !args.length ||
      (args.length === 2 && args[0] === "--app" && isAbsolute(args[1])),
    "INVALID_QUALIFICATION_ARGUMENTS",
  );
  const app = await realpath(
    args[1] ?? join(homedir(), "Applications/MusicMute Local.app"),
  );
  resources = join(app, "Contents/Resources");
  node = join(resources, "runtime/runtime/node/bin/node");
  const code = (
    await boundedRead(join(resources, "companion/app-control.js"), 1024 * 1024)
  ).toString("utf8");
  const modelBlock = code.match(
    /(?:var|const) MODEL = Object\.freeze\(\{([\s\S]*?)\}\);/,
  )?.[1];
  assert.ok(modelBlock, "INSTALLED_MODEL_IDENTITY_MISSING");
  const filename = modelBlock.match(/filename: "([A-Za-z0-9_.-]+)"/)?.[1];
  const sha256 = modelBlock.match(/sha256: "([a-f0-9]{64})"/)?.[1];
  assert.ok(
    filename?.endsWith(".onnx") && sha256,
    "INSTALLED_MODEL_IDENTITY_INVALID",
  );
  const audit = JSON.parse(
    await boundedRead(join(resources, "bundle-audit.json"), 8 * 1024 * 1024),
  );
  check(
    "Installed bundle is ARM64 and excludes weights/fleet state",
    audit.architecture === "arm64" &&
      audit.includes_model_weights === false &&
      audit.includes_worker_state === false,
  );
  report.installed_app_control_sha256 = digest(code);
  assert.ok(
    Number.isSafeInteger(audit.native_binaries) &&
      audit.native_binaries > 0 &&
      audit.native_binaries <= 10_000,
    "INSTALLED_AUDIT_INVALID",
  );
  report.native_binaries = audit.native_binaries;
  await privateDirectory(output);
  guard = join(output, "guard.mjs");
  await writePrivate(
    guard,
    `import { appendFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { homedir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
if (homedir() !== process.env.QUALIFICATION_HOME) throw new Error('QUALIFICATION_HOME_INVALID');
const deny = (code) => { appendFileSync(process.env.QUALIFICATION_MARKER, JSON.stringify(code)+'\\n', {mode:0o600}); throw new Error('QUALIFICATION_FORBIDDEN_OPERATION'); };
globalThis.fetch = () => deny('NETWORK_CALL');
for (const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) childProcess[method] = () => deny('SUBPROCESS_CALL');
syncBuiltinESMExports();
`,
  );

  const fresh = await fixture("missing-model");
  const missing = await execute("status", fresh);
  check(
    "Fresh private state reports missing model without doctor/download",
    missing.code === 0 &&
      missing.terminal.status.runtime_ready === true &&
      missing.terminal.status.model_ready === false &&
      missing.terminal.status.ready === false &&
      missing.terminal.status.model_bytes === 0,
  );

  const corrupt = await fixture("corrupt-model");
  const corruptPath = join(corrupt.state, "models", sha256, filename);
  await writePrivate(corruptPath, "owned corrupt fixture model");
  const corruptBefore = digest(await boundedRead(corruptPath, 4096));
  const invalid = await execute("status", corrupt);
  check(
    "Corrupt app-owned model is not reported ready",
    invalid.code === 0 &&
      invalid.terminal.status.model_ready === false &&
      invalid.terminal.status.ready === false,
  );
  const setup = await execute("setup", corrupt);
  check(
    "Corrupt-model setup gives an actionable safe error before download/doctor",
    setup.code === 1 &&
      setup.terminal.error_code === "MODEL_CACHE_INVALID" &&
      typeof setup.terminal.action === "string" &&
      setup.messages.every(
        (message) =>
          message.type !== "progress" || message.phase === "model_download",
      ),
  );
  check(
    "Corrupt model bytes are preserved for explicit repair",
    digest(await boundedRead(corruptPath, 4096)) === corruptBefore,
  );

  const foreign = await fixture("foreign-registration");
  const manifest = join(
    foreign.testHome,
    "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.musicmute.local.json",
  );
  await writePrivate(
    manifest,
    JSON.stringify({
      name: "foreign.fixture",
      type: "stdio",
      path: "/invalid/fixture/launcher",
      allowed_origins: ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"],
    }),
  );
  const foreignBefore = digest(await boundedRead(manifest, 16 * 1024));
  const foreignStatus = await execute("status", foreign);
  check(
    "Foreign registration in isolated HOME is not treated as MusicMute registration",
    foreignStatus.code === 0 &&
      foreignStatus.terminal.status.extension_registered === false &&
      foreignStatus.terminal.status.ready === false,
  );
  check(
    "Foreign registration remains byte-for-byte unchanged",
    digest(await boundedRead(manifest, 16 * 1024)) === foreignBefore,
  );

  const ignored = await execute("status", fresh, {
    MUSICMUTE_LOCAL_RUNTIME: "invalid-relative-development-runtime",
    MUSICMUTE_LOCAL_MODELS: "invalid-relative-development-models",
    MUSICMUTE_LOCAL_YT_DLP: "invalid-relative-development-downloader",
    MUSICMUTE_LOCAL_RUNNER: "invalid-relative-development-runner",
  });
  check(
    "Packaged quick status ignores developer runtime/model/downloader/runner overrides",
    ignored.code === 0 &&
      ignored.terminal.status.runtime_ready === true &&
      ignored.terminal.status.model_ready === false &&
      ignored.terminal.status.extension_path === join(resources, "extension"),
  );

  const privateProbe = "qualification-private-raw-field";
  await writePrivate(
    join(corrupt.state, "logs/ui-events.jsonl"),
    JSON.stringify({
      schema_version: 1,
      at: new Date().toISOString(),
      session_id: randomUUID(),
      event: "app_operation_error",
      code: "MODEL_CACHE_INVALID",
      command: "setup",
      raw_error: privateProbe,
    }) + "\n",
  );
  const exported = await execute("export", corrupt);
  assert.ok(
    isAbsolute(exported.terminal.path) &&
      relative(
        join(corrupt.state, "logs/exports"),
        exported.terminal.path,
      ).match(/^diagnostics-[a-f0-9-]{36}\.json$/),
    "QUALIFICATION_EXPORT_PATH_INVALID",
  );
  const exportedBytes = await boundedRead(
    exported.terminal.path,
    5 * 1024 * 1024,
  );
  const exportedReport = JSON.parse(exportedBytes);
  check(
    "Installed CLI exports projected app UI/setup evidence privately",
    exported.code === 0 &&
      exportedReport.app_ui_events.length === 1 &&
      !!exportedReport.app_setup_diagnostics &&
      !exportedBytes.includes(privateProbe) &&
      ((await lstat(exported.terminal.path)).mode & 0o777) === 0o600,
  );
  report.export_artifact = relative(output, exported.terminal.path);

  const failedLogs = await fixture("nonprivate-logs");
  const failedLogsPath = join(failedLogs.state, "logs");
  await privateDirectory(failedLogsPath);
  await chmod(failedLogsPath, 0o755);
  const logging = await execute("setup", failedLogs);
  check(
    "Unsafe logging directory produces an actionable error before model/network/GPU work",
    logging.code === 1 &&
      logging.terminal.error_code === "LOCAL_DIRECTORY_NOT_PRIVATE" &&
      typeof logging.terminal.action === "string",
  );

  const failedJournal = await fixture("nonprivate-setup-journal");
  await writePrivate(
    join(failedJournal.state, "models", sha256, filename),
    "owned corrupt fixture model",
  );
  const journal = join(failedJournal.state, "logs/setup/events.jsonl");
  await writePrivate(journal, "");
  await chmod(journal, 0o644);
  await execute("setup", failedJournal);
  const loggingSnapshot = await execute("snapshot", failedJournal);
  check(
    "Setup diagnostic write failure is observable in the installed CLI snapshot",
    loggingSnapshot.code === 0 &&
      loggingSnapshot.terminal.report.app_setup_diagnostics.availability ===
        "diagnostics_unavailable" &&
      loggingSnapshot.terminal.report.app_setup_diagnostics.failure_code ===
        "DIAGNOSTICS_UNAVAILABLE",
  );
  check(
    "Execution guards observed no network or subprocess attempts",
    report.network_calls === 0 && report.child_process_calls === 0,
  );
  report.success = true;
} catch (error) {
  report.success = false;
  report.failure_code =
    error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
      ? error.message
      : "QUALIFICATION_FAILED";
  process.exitCode = 1;
} finally {
  await privateDirectory(output);
  await writePrivate(
    join(output, "result.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify({ ...report, output }, null, 2));
}

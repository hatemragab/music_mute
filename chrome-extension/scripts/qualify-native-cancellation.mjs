// Explicit live qualification: one public 19-second source, at most three starts.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  stageExternalRuntimeForQualification,
  verifyExternalRuntimeForQualification,
} from "./external-runtime-qualification.mjs";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const output = join(root, "output/native-cancellation-proof", randomUUID());
const state = join(output, "state");
const testHome = join(output, "home");
const modelDigest =
  "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";
const modelBytes = 66_759_214;
const videoId = "jNQXAC9IVRw";
const durationSeconds = 19;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const started = Date.now();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pause = (milliseconds) =>
  new Promise((done) => setTimeout(done, milliseconds));
const report = {
  scope:
    "EXACT_PACKAGE_EXTERNAL_RUNTIME_LIVE_DOWNLOAD_AND_SEPARATION_CANCELLATION_WITH_SUCCESSOR",
  status: "FAILED",
  public_video_id: videoId,
  duration_seconds: durationSeconds,
  browser_playback: false,
  fixture_mode: false,
  checks: [],
  jobs: [],
  gaps: [
    "This is a native-host qualification on this Mac, not Chrome installation, fresh-OS-user, Gatekeeper or listening proof.",
  ],
};
let session;
let app;
let resources;
let runtimeRoot;
let stagedRuntime;
let origin;
let cancelled = false;
const cancelledJobs = new Map();

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
async function boundedRead(path, limit) {
  const info = await lstat(path);
  assert.ok(
    info.isFile() && !info.isSymbolicLink() && info.size <= limit,
    "QUALIFICATION_READ_UNSAFE",
  );
  return readFile(path);
}
async function modelHash(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    assert.ok(
      info.isFile() &&
        info.nlink === 1 &&
        !(info.mode & 0o077) &&
        info.uid === process.getuid() &&
        info.size === modelBytes,
      "QUALIFICATION_MODEL_UNSAFE",
    );
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false }))
      hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await file.close();
  }
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
            pid: Number(match[1]),
            parent: Number(match[2]),
            group: Number(match[3]),
            birth: match[4],
          },
        ]
      : [];
  });
}
function discover(rows, owned, pid) {
  const parent = rows.find((row) => row.pid === pid);
  if (parent && !owned.has(pid)) owned.set(pid, parent);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const known = owned.get(row.parent);
      if (
        !owned.has(row.pid) &&
        known &&
        rows.some(
          (candidate) =>
            candidate.pid === known.pid && candidate.birth === known.birth,
        )
      ) {
        owned.set(row.pid, row);
        changed = true;
      }
    }
  }
}
async function killTrackedGroups(owned) {
  const rows = await processTable();
  const remaining = rows.filter(
    (row) => owned.get(row.pid)?.birth === row.birth,
  );
  for (const group of new Set(remaining.map((row) => row.group))) {
    assert.ok(
      rows
        .filter((row) => row.group === group)
        .every((row) => owned.get(row.pid)?.birth === row.birth),
      "QUALIFICATION_CLEANUP_UNSAFE",
    );
    try {
      process.kill(-group, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
function observeMessage(message) {
  if (message.type !== "JOB" || message.payload === null) return;
  const job = message.payload;
  assert.ok(
    uuid.test(job.job_id) &&
      job.video_id === videoId &&
      job.provider === "LOCAL_MACOS" &&
      [
        "DOWNLOADING",
        "PROCESSING",
        "VALIDATING",
        "READY",
        "FAILED",
        "CANCELLED",
      ].includes(job.state) &&
      typeof job.stage === "string" &&
      /^[a-zA-Z0-9_-]{1,80}$/.test(job.stage),
    "QUALIFICATION_JOB_INVALID",
  );
  const previous = cancelledJobs.get(job.job_id);
  if (previous && (job.state === "READY" || job.media)) {
    previous.ready_or_grant_seen = true;
    assert.ok(
      !previous.cancel_settled,
      "CANCELLED_JOB_PUBLISHED_AFTER_SETTLEMENT",
    );
  }
}
function hostSession() {
  const child = spawn(
    join(runtimeRoot, "runtime/python/bin/python3"),
    [
      "-B",
      join(resources, "scripts/native-lock.py"),
      join(runtimeRoot, "runtime/node/bin/node"),
      join(resources, "companion/host.js"),
      origin,
    ],
    {
      cwd: output,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        HOME: testHome,
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        TMPDIR: output,
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTORCH_ENABLE_MPS_FALLBACK: "0",
        MUSICMUTE_LOCAL_ROOT: state,
        MUSICMUTE_LOCAL_APP_RESOURCES: resources,
      },
    },
  );
  const owned = new Map();
  const base = new Set();
  const queue = [];
  let buffer = Buffer.alloc(0);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let frames = 0;
  let starts = 0;
  let failure;
  let closing = false;
  let exit;
  let waiter;
  let waiterTimer;
  let killTimer;
  let monitoring = Promise.resolve();
  const closed = new Promise((done) =>
    child.once("close", (code, signal) => {
      exit = { code, signal };
      if (!closing) fail("COMPANION_DISCONNECTED");
      done(exit);
    }),
  );
  const signalGroup = (signal) => {
    if (exit || !child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH")
        failure ??= new Error("QUALIFICATION_SIGNAL_FAILED");
    }
  };
  function terminate() {
    signalGroup("SIGTERM");
    killTimer ??= setTimeout(() => signalGroup("SIGKILL"), 3_000);
  }
  function fail(code) {
    failure ??= new Error(code);
    clearTimeout(waiterTimer);
    waiter?.reject(failure);
    waiter = undefined;
    if (!exit) terminate();
  }
  async function scan() {
    const rows = await processTable();
    discover(rows, owned, child.pid);
    return rows.filter((row) => owned.get(row.pid)?.birth === row.birth);
  }
  const monitor = setInterval(() => {
    monitoring = monitoring
      .then(() => scan())
      .catch(() => fail("QUALIFICATION_PROCESS_SCAN_FAILED"));
  }, 200);
  const deadline = setTimeout(
    () => fail("QUALIFICATION_WHOLE_TIMEOUT"),
    // Reserve the remaining 70 seconds for bounded cleanup and code signing.
    Math.max(1, 230_000 - (Date.now() - started)),
  );
  child.once("error", () => fail("COMPANION_START_FAILED"));
  child.stdin.on("error", () => {
    if (!closing) fail("COMPANION_DISCONNECTED");
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 128 * 1024) fail("COMPANION_STDERR_LIMIT");
  });
  child.stdout.on("data", (chunk) => {
    if (failure) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > 512 * 1024) {
      fail("COMPANION_OUTPUT_LIMIT");
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        assert.ok(
          length >= 2 && length <= 64 * 1024,
          "QUALIFICATION_FRAME_INVALID",
        );
        if (buffer.length < length + 4) break;
        const message = JSON.parse(
          buffer.subarray(4, length + 4).toString("utf8"),
        );
        buffer = buffer.subarray(length + 4);
        assert.ok(
          ++frames <= 512 &&
            message?.protocol_version === 1 &&
            uuid.test(message.request_id) &&
            ["HELLO", "JOB", "ERROR"].includes(message.type) &&
            (message.payload === null
              ? message.type === "JOB"
              : message.payload &&
                typeof message.payload === "object" &&
                !Array.isArray(message.payload)),
          "QUALIFICATION_FRAME_INVALID",
        );
        observeMessage(message);
        if (waiter) {
          clearTimeout(waiterTimer);
          waiter.resolve(message);
          waiter = undefined;
        } else {
          assert.ok(queue.length < 128, "QUALIFICATION_QUEUE_LIMIT");
          queue.push(message);
        }
      }
    } catch (error) {
      fail(safeCode(error, "QUALIFICATION_FRAME_INVALID"));
    }
  });
  return {
    command(type, payload = {}) {
      assert.ok(!failure && !closing && !cancelled, "COMPANION_UNAVAILABLE");
      if (type === "START")
        assert.ok(++starts <= 3, "QUALIFICATION_START_LIMIT");
      const requestId = randomUUID();
      const body = Buffer.from(
        JSON.stringify({
          protocol_version: 1,
          request_id: requestId,
          type,
          payload,
        }),
      );
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      child.stdin.write(Buffer.concat([header, body]));
      return requestId;
    },
    next(timeout) {
      if (failure) return Promise.reject(failure);
      assert.ok(timeout > 0 && timeout <= 180_000, "QUALIFICATION_JOB_TIMEOUT");
      if (queue.length) return Promise.resolve(queue.shift());
      assert.ok(!waiter, "QUALIFICATION_CONCURRENT_READ");
      return new Promise((resolveMessage, reject) => {
        waiter = { resolve: resolveMessage, reject };
        waiterTimer = setTimeout(
          () => fail("QUALIFICATION_JOB_TIMEOUT"),
          timeout,
        );
      });
    },
    async recordBase() {
      for (const row of await scan()) base.add(row.pid);
      assert.ok(base.has(child.pid), "QUALIFICATION_HOST_NOT_TRACKED");
    },
    async toolsGone() {
      for (let attempt = 0; attempt < 8; attempt++) {
        if (!(await scan()).some((row) => !base.has(row.pid))) return true;
        await pause(250);
      }
      return false;
    },
    abort() {
      fail("QUALIFICATION_CANCELLED");
    },
    async close() {
      closing = true;
      clearTimeout(waiterTimer);
      waiter?.reject(new Error("QUALIFICATION_CLOSING"));
      waiter = undefined;
      child.stdin.end();
      const grace = setTimeout(terminate, 2_000);
      let closeTimer;
      try {
        await Promise.race([
          closed,
          new Promise((_, reject) => {
            closeTimer = setTimeout(() => {
              terminate();
              reject(new Error("QUALIFICATION_CLEANUP_TIMEOUT"));
            }, 7_000);
          }),
        ]);
        clearInterval(monitor);
        await monitoring;
        for (let attempt = 0; attempt < 8; attempt++) {
          if (!(await scan()).length) break;
          await pause(250);
        }
        const remaining = await scan();
        if (remaining.length) {
          const rows = await processTable();
          for (const group of new Set(remaining.map((row) => row.group))) {
            assert.ok(
              rows
                .filter((row) => row.group === group)
                .every((row) => owned.get(row.pid)?.birth === row.birth),
              "QUALIFICATION_CLEANUP_UNSAFE",
            );
            try {
              process.kill(-group, "SIGKILL");
            } catch (error) {
              if (error.code !== "ESRCH") throw error;
            }
          }
          await pause(250);
        }
        return {
          exit_code: exit?.code,
          signal: exit?.signal,
          owned_processes_gone: !(await scan()).length,
          stdout_bytes: stdoutBytes,
          stderr_bytes: stderrBytes,
          starts,
        };
      } finally {
        clearInterval(monitor);
        clearTimeout(deadline);
        clearTimeout(grace);
        clearTimeout(closeTimer);
        clearTimeout(killTimer);
        if (!exit) signalGroup("SIGKILL");
        // Failure paths also clean detached tool groups, using captured birth
        // identities and rejecting groups containing any unrelated process.
        await killTrackedGroups(owned);
      }
    },
  };
}
function safeCode(error, fallback = "QUALIFICATION_FAILED") {
  return typeof error?.message === "string" &&
    /^[A-Z_0-9]{1,80}$/.test(error.message)
    ? error.message
    : fallback;
}
function jobEvent(summary, job, start) {
  const event = {
    state: job.state,
    stage: job.stage,
    elapsed_ms: Date.now() - start,
  };
  if (
    Number.isFinite(job.completed) &&
    Number.isFinite(job.total) &&
    job.total > 0 &&
    job.completed >= 0 &&
    job.completed <= job.total
  ) {
    event.completed = job.completed;
    event.total = job.total;
  }
  summary.events.push(event);
  assert.ok(summary.events.length <= 128, "QUALIFICATION_EVENT_LIMIT");
}
async function scratchEmpty() {
  try {
    return (await readdir(join(state, "cache/jobs"))).length === 0;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}
async function cancelAt(stage, code) {
  const began = Date.now();
  const expires = began + 180_000;
  const summary = {
    code,
    events: [],
    stage_observed: false,
    cancel_settled: false,
    ready_or_grant_seen: false,
  };
  report.jobs.push(summary);
  const requestId = session.command("START", {
    video_id: videoId,
    duration_seconds: durationSeconds,
    provider: "LOCAL_MACOS",
  });
  let jobId;
  let cancelId;
  for (;;) {
    const reply = await session.next(
      Math.min(10_000 + (cancelId ? 0 : 170_000), expires - Date.now()),
    );
    if (reply.type === "ERROR")
      throw new Error(
        typeof reply.payload.error_code === "string" &&
          /^[A-Z_0-9]{1,80}$/.test(reply.payload.error_code)
          ? reply.payload.error_code
          : "QUALIFICATION_NATIVE_ERROR",
      );
    assert.ok(
      reply.type === "JOB" &&
        reply.payload &&
        [requestId, cancelId].includes(reply.request_id),
      "QUALIFICATION_JOB_REPLY_INVALID",
    );
    const job = reply.payload;
    jobId ??= job.job_id;
    assert.equal(job.job_id, jobId, "QUALIFICATION_JOB_CHANGED");
    jobEvent(summary, job, began);
    if (job.state === "READY" || job.media) summary.ready_or_grant_seen = true;
    if (!cancelId && (job.stage === stage || job.state === "READY")) {
      summary.stage_observed = job.stage === stage;
      summary.ready_or_grant_seen = job.state === "READY" || Boolean(job.media);
      cancelledJobs.set(jobId, summary);
      cancelId = session.command("CANCEL", { job_id: jobId });
    }
    if (job.state === "FAILED")
      throw new Error(job.error_code ?? "QUALIFICATION_JOB_FAILED");
    if (reply.request_id === cancelId) {
      assert.ok(
        job.state === "CANCELLED" && !job.media,
        "QUALIFICATION_CANCEL_REPLY_INVALID",
      );
      summary.cancel_settled = true;
      summary.wall_ms = Date.now() - began;
      summary.scratch_empty = await scratchEmpty();
      summary.owned_tools_gone = await session.toolsGone();
      check(
        `${code}_SETTLED_AND_CLEAN`,
        summary.scratch_empty && summary.owned_tools_gone,
      );
      if (!summary.stage_observed || summary.ready_or_grant_seen)
        throw new Error("QUALIFICATION_STAGE_WINDOW_MISSED");
      check(`${code}_NO_READY_OR_GRANTS`, true);
      return;
    }
  }
}
async function successor() {
  const began = Date.now();
  const summary = { code: "SUCCESSOR", events: [] };
  report.jobs.push(summary);
  const requestId = session.command("START", {
    video_id: videoId,
    duration_seconds: durationSeconds,
    provider: "LOCAL_MACOS",
  });
  let jobId;
  for (;;) {
    const reply = await session.next(began + 180_000 - Date.now());
    if (reply.type === "ERROR")
      throw new Error(reply.payload.error_code ?? "QUALIFICATION_NATIVE_ERROR");
    assert.ok(
      reply.type === "JOB" && reply.request_id === requestId && reply.payload,
      "QUALIFICATION_SUCCESSOR_REPLY_INVALID",
    );
    const job = reply.payload;
    jobId ??= job.job_id;
    assert.ok(
      job.job_id === jobId && !cancelledJobs.has(jobId),
      "QUALIFICATION_SUCCESSOR_ID_INVALID",
    );
    jobEvent(summary, job, began);
    if (["FAILED", "CANCELLED"].includes(job.state))
      throw new Error(job.error_code ?? "QUALIFICATION_SUCCESSOR_FAILED");
    if (job.state !== "READY") continue;
    assert.ok(
      job.cache_hit === false &&
        job.media?.trim_enabled === false &&
        job.media.model_id === modelDigest &&
        Number.isFinite(job.media.duration_seconds) &&
        Math.abs(job.media.duration_seconds - durationSeconds) <= 0.5,
      "QUALIFICATION_SUCCESSOR_MEDIA_INVALID",
    );
    const url = new URL(job.media.url);
    assert.ok(
      url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        /^\d+$/.test(url.port) &&
        url.pathname === `/media/${jobId}` &&
        /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("capability") ?? "") &&
        [...url.searchParams.keys()].length === 1,
      "QUALIFICATION_SUCCESSOR_URL_INVALID",
    );
    const response = await fetch(url, {
      headers: { Origin: origin, Range: "bytes=0-1023" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    assert.ok(
      response.status === 206 &&
        response.headers.get("content-type") === "audio/mpeg" &&
        response.headers.get("content-length") === "1024" &&
        /^bytes 0-1023\/\d+$/.test(response.headers.get("content-range") ?? ""),
      "QUALIFICATION_RANGE_INVALID",
    );
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      assert.ok(bytes <= 1024, "QUALIFICATION_RANGE_LIMIT");
    }
    assert.equal(bytes, 1024, "QUALIFICATION_RANGE_BYTES_INVALID");
    summary.range_status = response.status;
    summary.range_bytes = bytes;
    summary.duration_seconds = job.media.duration_seconds;
    summary.trim_enabled = false;
    summary.wall_ms = Date.now() - began;
    const statusId = session.command("STATUS");
    for (;;) {
      const status = await session.next(5_000);
      if (status.request_id !== statusId) continue;
      assert.ok(
        status.type === "JOB" &&
          status.payload?.job_id === jobId &&
          status.payload.state === "READY",
        "QUALIFICATION_SUCCESSOR_STATUS_INVALID",
      );
      break;
    }
    for (let attempt = 0; attempt < 8 && !(await scratchEmpty()); attempt++)
      await pause(250);
    summary.scratch_empty = await scratchEmpty();
    summary.owned_tools_gone = await session.toolsGone();
    check(
      "SUCCESSOR_READY_RANGE_AND_CLEAN",
      summary.scratch_empty && summary.owned_tools_gone,
    );
    return;
  }
}
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    cancelled = true;
    session?.abort();
  });

try {
  assert.ok(
    process.platform === "darwin" && process.arch === "arm64",
    "UNSUPPORTED_PLATFORM",
  );
  const args = process.argv.slice(2);
  assert.ok(
    args.length === 2 && args[0] === "--app" && isAbsolute(args[1]),
    "INVALID_QUALIFICATION_ARGUMENTS",
  );
  await privateDirectory(output);
  for (const path of [state, testHome]) await privateDirectory(path);
  app = await realpath(args[1]);
  stagedRuntime = await stageExternalRuntimeForQualification({
    app,
    stateRoot: state,
  });
  resources = stagedRuntime.resources;
  runtimeRoot = stagedRuntime.runtimeRoot;
  report.runtime = {
    id: stagedRuntime.runtime.id,
    archive_sha256: stagedRuntime.runtime.archive_sha256,
    files: stagedRuntime.runtime.files.length,
    installed_bytes: stagedRuntime.runtime.installed_bytes,
    state: "DISPOSABLE_EXACT_PACKAGE_RUNTIME_VERIFIED",
  };
  check("EXACT_PACKAGE_EXTERNAL_RUNTIME_STAGED", true);
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
    timeout: 30_000,
    maxBuffer: 128 * 1024,
  });
  check("PACKAGE_SIGNATURE_BEFORE", true);
  const audit = JSON.parse(
    await boundedRead(join(resources, "bundle-audit.json"), 8 * 1024 * 1024),
  );
  check(
    "PACKAGED_ARM64_WITHOUT_WEIGHTS_OR_FLEET_STATE",
    audit.architecture === "arm64" &&
      audit.includes_model_weights === false &&
      audit.includes_worker_state === false,
  );
  const sourceModel = join(
    homedir(),
    "Library/Application Support/MusicMuteLocal/models",
    modelDigest,
    "Kim_Vocal_2.onnx",
  );
  check(
    "SOURCE_USER_MODEL_VERIFIED_READ_ONLY",
    (await modelHash(sourceModel)) === modelDigest,
  );
  const modelDirectory = join(state, "models", modelDigest);
  await privateDirectory(modelDirectory);
  const model = join(modelDirectory, "Kim_Vocal_2.onnx");
  await copyFile(sourceModel, model, constants.COPYFILE_EXCL);
  await chmod(model, 0o400);
  check(
    "ISOLATED_MODEL_COPY_VERIFIED",
    (await modelHash(model)) === modelDigest,
  );
  report.package_host_sha256 = digest(
    await boundedRead(join(resources, "companion/host.js"), 1024 * 1024),
  );
  const manifest = JSON.parse(
    await boundedRead(join(resources, "extension/manifest.json"), 32 * 1024),
  );
  assert.ok(
    typeof manifest.key === "string" &&
      /^[A-Za-z0-9+/=]{128,8192}$/.test(manifest.key),
    "QUALIFICATION_EXTENSION_KEY_INVALID",
  );
  const extensionId = digest(Buffer.from(manifest.key, "base64"))
    .slice(0, 32)
    .split("")
    .map((hex) => String.fromCharCode(97 + Number.parseInt(hex, 16)))
    .join("");
  origin = `chrome-extension://${extensionId}`;
  session = hostSession();
  const helloId = session.command("HELLO");
  const hello = await session.next(90_000);
  assert.ok(
    hello.type === "HELLO" &&
      hello.request_id === helloId &&
      hello.payload.ready === true &&
      hello.payload.platform === "darwin" &&
      hello.payload.arch === "arm64",
    "QUALIFICATION_HELLO_NOT_READY",
  );
  check("EXACT_PACKAGE_HOST_READY", true);
  await session.recordBase();
  await cancelAt("downloading", "DOWNLOAD_CANCEL");
  await cancelAt("separation", "SEPARATION_CANCEL");
  await successor();
  check(
    "CANCELLED_IDS_NEVER_PUBLISH_READY_OR_GRANTS",
    [...cancelledJobs.values()].every(
      (job) => job.cancel_settled && !job.ready_or_grant_seen,
    ),
  );
  check(
    "SOURCE_USER_MODEL_UNCHANGED",
    (await modelHash(sourceModel)) === modelDigest,
  );
  check("ISOLATED_MODEL_UNCHANGED", (await modelHash(model)) === modelDigest);
  report.status = "VERIFIED";
} catch (error) {
  report.error_code = safeCode(error);
  if (report.error_code === "QUALIFICATION_STAGE_WINDOW_MISSED") {
    report.status = "INCONCLUSIVE";
    report.gaps.push(
      "A requested cancellation stage was missed or raced completed media publication; no further START was attempted.",
    );
  }
} finally {
  if (session) {
    try {
      report.cleanup = await session.close();
      check(
        "OWNED_HOST_AND_TOOLS_CLEAN",
        report.cleanup.exit_code === 0 &&
          report.cleanup.signal === null &&
          report.cleanup.owned_processes_gone,
      );
    } catch (error) {
      report.status = "FAILED";
      report.cleanup_error_code = safeCode(
        error,
        "QUALIFICATION_CLEANUP_FAILED",
      );
    }
  }
  if (stagedRuntime) {
    try {
      await verifyExternalRuntimeForQualification(stagedRuntime);
      check("EXTERNAL_RUNTIME_IMMUTABLE_AFTER_QUALIFICATION", true);
    } catch {
      report.status = "FAILED";
      report.runtime_error_code = "EXTERNAL_RUNTIME_POST_AUDIT_FAILED";
    }
  }
  if (app && resources) {
    try {
      await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
        timeout: 30_000,
        maxBuffer: 128 * 1024,
      });
      check("PACKAGE_SIGNATURE_AFTER", true);
      check(
        "PACKAGE_HOST_UNCHANGED",
        digest(
          await boundedRead(join(resources, "companion/host.js"), 1024 * 1024),
        ) === report.package_host_sha256,
      );
    } catch {
      report.status = "FAILED";
      report.signature_error_code = "INSTALLED_SIGNATURE_INVALID";
    }
  }
  report.wall_ms = Date.now() - started;
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

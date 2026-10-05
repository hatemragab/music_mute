// Installed cache/protocol acceptance only: readiness and acquisition are bypassed.
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
  rename,
  statfs,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "output/native-cache-proof", randomUUID());
const started = Date.now();
const exec = promisify(execFile);
let outputValidated = false;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pause = (milliseconds) =>
  new Promise((done) => setTimeout(done, milliseconds));
const report = {
  scope: "INSTALLED_HOST_REAL_CACHE_REPLAY_WITH_FIXTURE_PROVIDER_GUARD",
  runtime_scope: "PACKAGED_APP",
  browser_playback: false,
  readiness_bypassed: true,
  acquisition_bypassed: true,
  inference_bypassed: true,
  historical_cache_timings_are_not_new_inference: false,
  checks: [],
  replays: [],
  same_host_cycles: [],
  forbidden_network_attempts: 0,
  forbidden_tool_attempts: 0,
  host_sessions: [],
  process_group_observations: [],
  storage_pressure: {
    limit_bytes: null,
    fixture_content: "SPARSE_STORAGE_ACCOUNTING_ONLY_NOT_PLAYABLE_AUDIO",
    real_user_cache_modified: false,
  },
};
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
async function prepareOutput() {
  assert.equal(await realpath(root), root, "OUTPUT_ROOT_NOT_CANONICAL");
  let parent = root;
  for (const name of ["output", "native-cache-proof"]) {
    parent = join(parent, name);
    try {
      await mkdir(parent, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const info = await lstat(parent);
    assert.ok(
      info.isDirectory() &&
        !info.isSymbolicLink() &&
        info.uid === process.getuid() &&
        !(info.mode & 0o022) &&
        (await realpath(parent)) === parent,
      "OUTPUT_PARENT_UNSAFE",
    );
  }
  await privateDirectory(output);
  assert.equal(await realpath(output), output, "OUTPUT_NOT_CANONICAL");
  outputValidated = true;
}
async function boundedRead(path, maximum) {
  const info = await lstat(path);
  assert.ok(
    info.isFile() && !info.isSymbolicLink() && info.size <= maximum,
    "UNSAFE_FIXTURE_FILE",
  );
  return readFile(path);
}
function groupExists(pid) {
  const valid = Number.isSafeInteger(pid) && pid > 0;
  assert.ok(valid, "COMPANION_PROCESS_ID_INVALID");
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    const code = /^[A-Z][A-Z0-9_]{0,69}$/.test(error.code ?? "")
      ? error.code
      : "UNKNOWN_PROCESS_GROUP_ERROR";
    if (
      !report.process_group_observations.some(
        (entry) => entry.code === code && entry.pid === pid,
      )
    )
      report.process_group_observations.push({
        code,
        pid,
        pid_type: typeof pid,
        valid_positive_pid: valid,
        group_gone: false,
      });
    // Permission denial is evidence of an inaccessible group, never its absence.
    if (code === "EPERM") return true;
    throw new Error("PROCESS_GROUP_CHECK_FAILED");
  }
}

function hostSession(
  resources,
  state,
  testHome,
  guard,
  marker,
  origin,
  pinPid,
) {
  // Chrome permits one launcher-owned host. This isolated second process tests
  // the installed eviction component against the first host's disk pin, as a
  // concurrent native cache mutation would; it is not a two-Chrome-host test.
  const concurrentEvictionFixture = pinPid !== undefined;
  const child = spawn(
    join(
      resources,
      concurrentEvictionFixture
        ? "runtime/runtime/node/bin/node"
        : "runtime/runtime/python/bin/python3",
    ),
    [
      ...(!concurrentEvictionFixture
        ? [
            "-B",
            join(resources, "scripts/native-lock.py"),
            join(resources, "runtime/runtime/node/bin/node"),
          ]
        : []),
      "--import",
      guard,
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
        TMPDIR: testHome,
        MUSICMUTE_LOCAL_ROOT: state,
        MUSICMUTE_LOCAL_APP_RESOURCES: resources,
        MUSICMUTE_LOCAL_TEST_MODE: "1",
        MUSICMUTE_LOCAL_FIXTURE_AUDIO: join(output, "nonexistent-fixture.mp3"),
        QUALIFICATION_HOME: testHome,
        QUALIFICATION_MARKER: marker,
        QUALIFICATION_PARENT_PID: String(process.pid),
        ...(pinPid ? { QUALIFICATION_PIN_PID: String(pinPid) } : {}),
      },
    },
  );
  let ownedPid = child.pid;
  const launch = {
    spawned: false,
    initial_pid_type: typeof ownedPid,
    initial_pid_valid: Number.isSafeInteger(ownedPid) && ownedPid > 0,
  };
  report.host_sessions.push(launch);
  child.once("spawn", () => {
    ownedPid = child.pid;
    launch.spawned = true;
    launch.spawn_pid_valid = Number.isSafeInteger(ownedPid) && ownedPid > 0;
    if (!launch.spawn_pid_valid) fail("COMPANION_PROCESS_ID_INVALID");
  });
  let buffer = Buffer.alloc(0);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let frames = 0;
  let failure;
  let closing = false;
  let forced = false;
  let waiter;
  let killTimer;
  const queue = [];
  let closeResult;
  const closed = new Promise((done) =>
    child.once("close", (code, signal) => {
      closeResult = { code, signal };
      if (!closing) fail("COMPANION_DISCONNECTED");
      done(closeResult);
    }),
  );
  function terminate() {
    forced = true;
    try {
      if (Number.isSafeInteger(ownedPid) && ownedPid > 0)
        process.kill(-ownedPid, "SIGTERM");
    } catch {
      /* Already exited. */
    }
    killTimer ??= setTimeout(() => {
      try {
        if (Number.isSafeInteger(ownedPid) && ownedPid > 0)
          process.kill(-ownedPid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }, 1_000);
  }
  function fail(code) {
    failure ??= new Error(code);
    waiter?.reject(failure);
    waiter = undefined;
    if (!closeResult) terminate();
  }
  const deadline = setTimeout(() => fail("COMPANION_TIMEOUT"), 20_000);
  child.on("error", (error) => {
    launch.spawn_error_code = /^[A-Z][A-Z0-9_]{0,69}$/.test(error.code ?? "")
      ? error.code
      : "UNKNOWN_SPAWN_ERROR";
    fail("COMPANION_START_FAILED");
  });
  child.stdin.on("error", () => {
    if (!closing) fail("COMPANION_DISCONNECTED");
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 64 * 1024) fail("COMPANION_OUTPUT_LIMIT");
  });
  child.stdout.on("data", (chunk) => {
    if (failure) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > 256 * 1024) {
      fail("COMPANION_OUTPUT_LIMIT");
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        assert.ok(length >= 2 && length <= 64 * 1024, "FRAME_INVALID");
        if (buffer.length < length + 4) break;
        const message = JSON.parse(
          buffer.subarray(4, length + 4).toString("utf8"),
        );
        buffer = buffer.subarray(length + 4);
        assert.ok(
          ++frames <= 96 &&
            message?.protocol_version === 1 &&
            uuid.test(message.request_id) &&
            ["HELLO", "JOB", "ERROR"].includes(message.type) &&
            ((message.type === "JOB" && message.payload === null) ||
              (message.payload &&
                typeof message.payload === "object" &&
                !Array.isArray(message.payload))),
          "FRAME_INVALID",
        );
        if (waiter) {
          waiter.resolve(message);
          waiter = undefined;
        } else queue.push(message);
      }
    } catch {
      fail("FRAME_INVALID");
    }
  });
  return {
    get pid() {
      return ownedPid;
    },
    command(type, payload = {}) {
      assert.ok(!failure && !closing, "COMPANION_UNAVAILABLE");
      const requestId = randomUUID();
      const body = Buffer.from(
        JSON.stringify({
          protocol_version: 1,
          request_id: requestId,
          type,
          payload,
        }),
      );
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(body.length);
      child.stdin.write(Buffer.concat([prefix, body]));
      return requestId;
    },
    next() {
      if (failure) return Promise.reject(failure);
      if (queue.length) return Promise.resolve(queue.shift());
      assert.ok(!waiter, "CONCURRENT_PROTOCOL_READ");
      return new Promise((resolveMessage, reject) => {
        waiter = { resolve: resolveMessage, reject };
      });
    },
    async close() {
      closing = true;
      child.stdin.end();
      const graceful = setTimeout(terminate, 2_000);
      let closeDeadline;
      const cleanupDeadline = new Promise((_, reject) => {
        closeDeadline = setTimeout(() => {
          fail("COMPANION_CLEANUP_TIMEOUT");
          reject(new Error("COMPANION_CLEANUP_TIMEOUT"));
        }, 5_000);
      });
      let cleanup;
      let closeError;
      try {
        const result = await Promise.race([closed, cleanupDeadline]);
        launch.close_pid_type = typeof child.pid;
        launch.close_pid_valid =
          Number.isSafeInteger(child.pid) && child.pid > 0;
        launch.captured_pid_unchanged = child.pid === ownedPid;
        launch.exit_code = result.code;
        launch.exit_signal = result.signal;
        assert.ok(
          !forced &&
            result.code === 0 &&
            result.signal === null &&
            buffer.length === 0,
          "COMPANION_CLEANUP_FAILED",
        );
        const expires = Date.now() + 2_000;
        while (groupExists(ownedPid) && Date.now() < expires) await pause(25);
        assert.ok(!groupExists(ownedPid), "COMPANION_GROUP_REMAINS");
        cleanup = {
          exit_code: result.code,
          forced_shutdown: false,
          owned_process_group_gone: true,
          stdout_bytes: stdoutBytes,
          stderr_bytes: stderrBytes,
        };
      } catch (error) {
        closeError = failure ?? error;
      } finally {
        clearTimeout(deadline);
        clearTimeout(graceful);
        clearTimeout(closeDeadline);
        clearTimeout(killTimer);
        killTimer = undefined;
        try {
          if (
            Number.isSafeInteger(ownedPid) &&
            ownedPid > 0 &&
            groupExists(ownedPid)
          )
            terminate();
        } catch (error) {
          closeError ??= failure ?? error;
        }
      }
      if (closeError) throw closeError;
      return cleanup;
    },
  };
}

async function rangeProof(media, jobId, origin, audio) {
  const url = new URL(media?.url);
  assert.ok(
    url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      /^\d+$/.test(url.port) &&
      url.pathname === `/media/${jobId}` &&
      /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("capability") ?? "") &&
      [...url.searchParams.keys()].length === 1,
    "MEDIA_INVALID",
  );
  const response = await fetch(url, {
    headers: { Origin: origin, Range: "bytes=0-1023" },
    redirect: "error",
    signal: AbortSignal.timeout(3_000),
  });
  assert.ok(
    response.status === 206 &&
      response.headers.get("content-type") === "audio/mpeg" &&
      response.headers.get("content-length") === "1024" &&
      response.headers.get("content-range") === `bytes 0-1023/${audio.length}`,
    "RANGE_INVALID",
  );
  const chunks = [];
  let count = 0;
  for await (const chunk of response.body) {
    count += chunk.length;
    assert.ok(count <= 1024, "RANGE_OUTPUT_LIMIT");
    chunks.push(chunk);
  }
  assert.ok(
    count === 1024 && Buffer.concat(chunks).equals(audio.subarray(0, 1024)),
    "RANGE_BYTES_INVALID",
  );
  const withoutCapability = new URL(url);
  withoutCapability.search = "";
  const denied = await fetch(withoutCapability, {
    method: "HEAD",
    headers: { Origin: origin },
    redirect: "error",
    signal: AbortSignal.timeout(3_000),
  });
  assert.equal(denied.status, 403, "CAPABILITY_NOT_PROTECTED");
  return {
    url,
    capability: url.searchParams.get("capability"),
    proof: {
      range_status: 206,
      range_bytes: count,
      matches_retained_bytes: true,
      missing_capability_status: denied.status,
    },
  };
}

async function resourceObservation(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "RESOURCE_PID_INVALID");
  const memory = await exec("/bin/ps", ["-p", String(pid), "-o", "rss=,vsz="], {
    timeout: 2_000,
    maxBuffer: 1024,
    encoding: "utf8",
  });
  const fields = memory.stdout.trim().match(/^(\d+)\s+(\d+)$/);
  assert.ok(fields, "RESOURCE_MEMORY_INVALID");
  const files = await exec(
    "/usr/sbin/lsof",
    ["-nP", "-p", String(pid), "-Ff"],
    {
      timeout: 3_000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    },
  );
  const descriptors = files.stdout
    .split("\n")
    .filter((line) => /^f\d+(?:[a-z]*)$/.test(line)).length;
  const rssKiB = Number(fields[1]);
  const virtualKiB = Number(fields[2]);
  assert.ok(
    Number.isSafeInteger(rssKiB) &&
      rssKiB > 0 &&
      Number.isSafeInteger(virtualKiB) &&
      virtualKiB > 0 &&
      descriptors > 0,
    "RESOURCE_OBSERVATION_INVALID",
  );
  return {
    rss_kib: rssKiB,
    virtual_kib: virtualKiB,
    file_descriptors: descriptors,
  };
}

try {
  await prepareOutput();
  const args = process.argv.slice(2);
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    assert.ok(
      ["--app", "--source", "--video"].includes(args[index]) &&
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
  const video = options.get("--video");
  assert.ok(
    /^[A-Za-z0-9_-]{11}$/.test(video ?? "") &&
      isAbsolute(options.get("--source") ?? "") &&
      (!options.has("--app") || isAbsolute(options.get("--app"))),
    "INVALID_QUALIFICATION_ARGUMENTS",
  );
  const source = await realpath(options.get("--source"));
  const sourceRelative = relative(join(root, "output"), source);
  assert.ok(
    sourceRelative &&
      !sourceRelative.startsWith("..") &&
      !isAbsolute(sourceRelative),
    "SOURCE_OUTSIDE_IGNORED_OUTPUT",
  );
  const app = await realpath(
    options.get("--app") ?? join(homedir(), "Applications/MusicMute Local.app"),
  );
  const resources = join(app, "Contents/Resources");
  const sourceReport = JSON.parse(
    await boundedRead(join(source, "result.json"), 64 * 1024),
  );
  check(
    "Source proof passed actual packaged acquisition/MPS/Range",
    sourceReport.passed === true &&
      sourceReport.runtime_scope === "PACKAGED_APP" &&
      sourceReport.scope ===
        "ONE_PUBLIC_YOUTUBE_ACQUISITION_AND_LOCAL_PREPARATION_AND_RANGE",
  );
  const hostPath = join(resources, "companion/host.js");
  const hostBytes = await boundedRead(hostPath, 1024 * 1024);
  const hostSource = hostBytes.toString("utf8");
  const recipe = hostSource.match(
    /model:\s*("[a-f0-9]{64}"|MODEL_SHA256),\s*revision:\s*(\d+),\s*trim:\s*false,\s*source:\s*(?:sourceDigest\s*\?\?\s*)?"default"/,
  );
  assert.ok(recipe, "INSTALLED_CACHE_RECIPE_MISSING");
  const model =
    recipe[1] === "MODEL_SHA256"
      ? hostSource.match(
          /\b(?:var|const|let) MODEL_SHA256 = "([a-f0-9]{64})";/,
        )?.[1]
      : recipe[1].slice(1, -1);
  const revision = Number(recipe[2]);
  assert.ok(
    model && Number.isSafeInteger(revision) && revision > 0,
    "INSTALLED_CACHE_RECIPE_INVALID",
  );
  report.cache_recipe = { model, revision, source: "default" };
  const key = digest(
    JSON.stringify({
      video_id: video,
      provider: "LOCAL_MACOS",
      model,
      revision,
      trim: false,
      source: "default",
    }),
  );
  const sourceCache = join(source, "cache/vocals", key);
  const sourceMetadata = await boundedRead(
    join(sourceCache, "result.json"),
    64 * 1024,
  ).catch((error) => {
    if (error.code === "ENOENT")
      throw new Error("SOURCE_CACHE_RECIPE_UNAVAILABLE");
    throw error;
  });
  const cached = JSON.parse(sourceMetadata);
  const audio = await boundedRead(
    join(sourceCache, "vocals.mp3"),
    30 * 1024 ** 2,
  );
  check(
    "Retained actual output has verified model/timeline/MP3 hash",
    audio.length >= 1024 &&
      cached.bytes === audio.length &&
      cached.sha256 === digest(audio) &&
      cached.model_id === model &&
      cached.trim_enabled === false &&
      Number.isFinite(cached.source_duration_seconds) &&
      cached.source_duration_seconds > 0 &&
      cached.source_duration_seconds <= 1200 &&
      Math.abs(cached.source_duration_seconds - cached.duration_seconds) <=
        0.25,
  );
  report.installed_host_sha256 = digest(hostBytes);
  report.script_sha256 = digest(
    await boundedRead(import.meta.filename, 64 * 1024),
  );
  report.source_proof = relative(root, source);
  report.retained_audio_sha256 = cached.sha256;
  report.retained_audio_bytes = audio.length;
  report.retained_duration_seconds = cached.duration_seconds;
  const capacity = await statfs(output);
  const availableBytes = Number(capacity.bavail) * Number(capacity.bsize);
  check(
    "Pinned-corrupt qualification has the required 3 GiB free admission capacity",
    Number.isSafeInteger(availableBytes) && availableBytes >= 3 * 1024 ** 3,
  );
  report.storage_pressure.available_disk_bytes_at_start = availableBytes;
  await privateDirectory(output);
  const state = join(output, "state");
  const testHome = join(output, "home");
  const cache = join(state, "cache/vocals", key);
  await privateDirectory(testHome);
  await privateDirectory(cache);
  const audioPath = join(cache, "vocals.mp3");
  const titleFixture = "MusicMute title fixture • عنوان الفيديو";
  await copyFile(
    join(sourceCache, "vocals.mp3"),
    audioPath,
    constants.COPYFILE_EXCL,
  );
  await chmod(audioPath, 0o600);
  await privateWrite(
    join(cache, "result.json"),
    JSON.stringify({
      ...cached,
      output_path: audioPath,
      source_title: titleFixture,
    }),
  );
  const guard = join(output, "guard.mjs");
  await privateWrite(
    guard,
    `import { appendFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { homedir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
if (homedir() !== process.env.QUALIFICATION_HOME) throw new Error('QUALIFICATION_HOME_INVALID');
const deny = (code) => { appendFileSync(process.env.QUALIFICATION_MARKER, JSON.stringify(code)+'\\n', {mode:0o600}); throw new Error('QUALIFICATION_FORBIDDEN_OPERATION'); };
const originalExecFile = childProcess.execFile;
const custom = Symbol.for('nodejs.util.promisify.custom');
const validateIdentityQuery = (file,args,options) => {
  if (file !== '/bin/ps' || !Array.isArray(args) || args.length !== 4 || args[0] !== '-p' || args[2] !== '-o' || args[3] !== 'lstart=' || !/^[1-9]\\d{0,9}$/.test(args[1]) || ![process.pid, Number(process.env.QUALIFICATION_PARENT_PID), Number(process.env.QUALIFICATION_PIN_PID)].includes(Number(args[1])) || options?.timeout !== 2000 || options?.maxBuffer !== 512 || options?.encoding !== 'utf8' || options?.shell) return deny('SUBPROCESS_CALL');
  appendFileSync(process.env.QUALIFICATION_MARKER+'.identity', '1\\n', {mode:0o600});
};
globalThis.fetch = () => deny('NETWORK_CALL');
for (const module of [http,https]) for (const method of ['request','get']) module[method] = () => deny('NETWORK_CALL');
for (const method of ['connect','createConnection']) net[method] = () => deny('NETWORK_CALL');
net.Socket.prototype.connect = () => deny('NETWORK_CALL');
for (const method of ['spawn','spawnSync','exec','execSync','execFileSync','fork']) childProcess[method] = () => deny('SUBPROCESS_CALL');
childProcess.execFile = (...args) => { validateIdentityQuery(...args); return originalExecFile(...args); };
childProcess.execFile[custom] = (...args) => { validateIdentityQuery(...args); return originalExecFile[custom](...args); };
syncBuiltinESMExports();
`,
  );
  const manifest = JSON.parse(
    await boundedRead(join(resources, "extension/manifest.json"), 64 * 1024),
  );
  const inventoryDigest = digest(
    await boundedRead(join(resources, "bundle-audit.json"), 8 * 1024 * 1024),
  );
  assert.ok(
    typeof manifest.key === "string" && manifest.key.length < 8192,
    "EXTENSION_KEY_INVALID",
  );
  const extensionId = digest(Buffer.from(manifest.key, "base64"))
    .slice(0, 32)
    .split("")
    .map((hex) => String.fromCharCode(97 + Number.parseInt(hex, 16)))
    .join("");
  const origin = `chrome-extension://${extensionId}`;
  async function playbackPins() {
    return readdir(join(state, "cache/pins")).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  }
  async function waitForCacheLeaseRelease() {
    const deadline = Date.now() + 1_000;
    while (
      await lstat(join(state, "cache/.mutation.lock")).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      })
    ) {
      assert.ok(Date.now() < deadline, "CACHE_LEASE_NOT_RELEASED");
      await pause(20);
    }
  }
  async function independentCacheClear(pinPid) {
    await waitForCacheLeaseRelease();
    const marker = join(output, "cross-process-clear-guard.jsonl");
    const cleaner = hostSession(
      resources,
      state,
      testHome,
      guard,
      marker,
      origin,
      pinPid,
    );
    let failure;
    let cleanup;
    try {
      const helloID = cleaner.command("HELLO");
      const hello = await cleaner.next();
      assert.ok(
        hello.type === "HELLO" &&
          hello.request_id === helloID &&
          hello.payload.ready === true,
        "CLEAR_HELLO_INVALID",
      );
      const clearID = cleaner.command("CLEAR_CACHE");
      const reply = await cleaner.next();
      assert.ok(
        reply.type === "JOB" &&
          reply.request_id === clearID &&
          reply.payload === null,
        "CROSS_PROCESS_CLEAR_FAILED",
      );
    } catch (error) {
      failure = error;
    } finally {
      try {
        cleanup = await cleaner.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
    const forbidden = await boundedRead(marker, 4096).catch((error) => {
      if (error.code === "ENOENT") return Buffer.alloc(0);
      throw error;
    });
    check(
      "Concurrent installed eviction component protects the active Chrome grant without acquisition/inference",
      forbidden.length === 0 &&
        digest(await boundedRead(audioPath, 30 * 1024 ** 2)) ===
          cached.sha256 &&
        (await playbackPins()).length === 1,
    );
    report.cross_process_playback_pin = {
      independent_clear_preserved_active_vocals: true,
      eviction_fixture_skips_chrome_single_host_launcher: true,
      ...cleanup,
    };
  }
  let previous;
  for (let index = 1; index <= 2; index++) {
    const marker = join(output, `guard-${index}.jsonl`);
    const session = hostSession(
      resources,
      state,
      testHome,
      guard,
      marker,
      origin,
    );
    const replayStart = Date.now();
    let cleanup;
    let job;
    let media;
    let replayError;
    try {
      const helloId = session.command("HELLO");
      const hello = await session.next();
      assert.ok(
        hello.type === "HELLO" &&
          hello.request_id === helloId &&
          hello.payload.ready === true,
        "HELLO_INVALID",
      );
      const startId = session.command("START", {
        video_id: video,
        duration_seconds: cached.source_duration_seconds,
        provider: "LOCAL_MACOS",
      });
      for (;;) {
        const message = await session.next();
        assert.ok(
          message.type === "JOB" &&
            message.request_id === startId &&
            ["DOWNLOADING", "READY"].includes(message.payload.state) &&
            ["cache-check", "ready"].includes(message.payload.stage),
          "CACHE_MISS_OR_UNEXPECTED_REPLY",
        );
        if (message.payload.state !== "READY") continue;
        job = message.payload;
        assert.ok(
          uuid.test(job.job_id) &&
            job.cache_hit === true &&
            job.media?.model_id === cached.model_id &&
            job.media.trim_enabled === false &&
            job.media.duration_seconds === cached.duration_seconds,
          "CACHE_REPLAY_INVALID",
        );
        break;
      }
      media = await rangeProof(job.media, job.job_id, origin, audio);
      if (index === 1) {
        const names = await playbackPins();
        assert.ok(
          names.length === 1 && /^playback-[a-f0-9-]{36}\.json$/.test(names[0]),
          "CHROME_PLAYBACK_PIN_MISSING",
        );
        const pin = JSON.parse(
          await boundedRead(join(state, "cache/pins", names[0]), 1024),
        );
        assert.ok(
          pin.cache_key === key &&
            Number.isSafeInteger(pin.pid) &&
            pin.pid > 0 &&
            /^[a-f0-9]{64}$/.test(pin.process_start_identity),
          "CHROME_PLAYBACK_PIN_INVALID",
        );
        await independentCacheClear(pin.pid);
      }
      if (previous)
        check(
          "Host restart creates a fresh job and capability",
          previous.jobId !== job.job_id &&
            previous.capability !== media.capability,
        );
      previous = { jobId: job.job_id, capability: media.capability };
    } catch (error) {
      replayError = error;
    }
    try {
      cleanup = await session.close();
    } catch (error) {
      if (replayError)
        report.cleanup_error_code = /^[A-Z_]{1,70}$/.test(error.message ?? "")
          ? error.message
          : "QUALIFICATION_CLEANUP_FAILED";
      else replayError = error;
    }
    if (replayError) throw replayError;
    check(
      `Replay ${index} releases its Chrome disk pin on clean EOF`,
      (await playbackPins()).length === 0,
    );
    let markers = [];
    try {
      markers = (await boundedRead(marker, 4096))
        .toString("utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    report.forbidden_network_attempts += markers.filter(
      (code) => code === "NETWORK_CALL",
    ).length;
    report.forbidden_tool_attempts += markers.filter(
      (code) => code === "SUBPROCESS_CALL",
    ).length;
    check(
      `Replay ${index} bypassed acquisition/inference and removed its job scratch`,
      markers.length === 0 &&
        (await readdir(join(state, "cache/jobs"))).length === 0 &&
        digest(await boundedRead(audioPath, 30 * 1024 ** 2)) === cached.sha256,
    );
    // Read the owned durable log after clean shutdown. A true cache replay must
    // report this job's measured work, not its retained original inference.
    const events = (
      await boundedRead(join(state, "logs/events.jsonl"), 512 * 1024)
    )
      .toString("utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.job_id === job.job_id);
    const cacheHits = events.filter((event) => event.event === "cache_hit");
    const readyEvents = events.filter((event) => event.event === "job_ready");
    const stages = events.filter((event) => event.event === "stage_completed");
    const expectedStages = ["cache-lookup", "cache-validation", "media-grant"];
    const measured = (value) =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= Number.MAX_SAFE_INTEGER;
    check(
      `Replay ${index} persists one measured current cache hit`,
      cacheHits.length === 1 &&
        cacheHits[0].component === "companion" &&
        cacheHits[0].metrics?.cache_hit === true &&
        measured(cacheHits[0].metrics?.duration_ms),
    );
    check(
      `Replay ${index} persists exactly current lookup, validation and grant timings`,
      stages.length === expectedStages.length &&
        stages.every(
          (event, stageIndex) =>
            event.component === "companion" &&
            event.metrics?.cache_hit === true &&
            event.metrics?.stage === expectedStages[stageIndex] &&
            measured(event.metrics?.duration_ms),
        ),
    );
    check(
      `Replay ${index} never reports historical inference as current job work`,
      events.every(
        (event) =>
          event.component !== "engine" &&
          (event.metrics?.stage === undefined ||
            expectedStages.includes(event.metrics.stage)),
      ),
    );
    check(
      `Replay ${index} identifies the current recorder and verified retained model`,
      events.length > 0 &&
        events.every(
          (event) =>
            event.identity?.software_version === manifest.version &&
            event.identity?.runtime_scope === "PACKAGED_APP" &&
            event.identity?.expected_model_sha256 === model &&
            event.identity?.package_inventory_sha256 === inventoryDigest &&
            (event.verified_model_sha256 === undefined ||
              (["job_ready", "cache_hit"].includes(event.event) &&
                event.verified_model_sha256 === model)),
        ) &&
        readyEvents.length === 1 &&
        readyEvents[0].verified_model_sha256 === model,
    );
    report.replays.push({
      replay: index,
      cache_hit: true,
      elapsed_ms: Date.now() - replayStart,
      media: media.proof,
      scratch_empty: true,
      diagnostics: {
        software_version: manifest.version,
        package_inventory_sha256: inventoryDigest,
        verified_model_sha256: model,
        current_cache_hit_duration_ms: cacheHits[0].metrics.duration_ms,
        stages_ms: Object.fromEntries(
          stages.map((event) => [
            event.metrics.stage,
            event.metrics.duration_ms,
          ]),
        ),
        current_inference_events: 0,
        historical_inference_timings_replayed: false,
      },
      ...cleanup,
    });
  }

  const cycleMarker = join(output, "same-host-guard.jsonl");
  const cycleSession = hostSession(
    resources,
    state,
    testHome,
    guard,
    cycleMarker,
    origin,
  );
  const cycleJobs = new Set();
  const cycleCapabilities = new Set();
  let cycleError;
  let cycleCleanup;
  try {
    const helloID = cycleSession.command("HELLO");
    const hello = await cycleSession.next();
    assert.ok(
      hello.type === "HELLO" &&
        hello.request_id === helloID &&
        hello.payload.ready === true,
      "CYCLE_HELLO_INVALID",
    );
    for (let cycle = 1; cycle <= 10; cycle++) {
      const startID = cycleSession.command("START", {
        video_id: video,
        duration_seconds: cached.source_duration_seconds,
        provider: "LOCAL_MACOS",
      });
      let job;
      for (;;) {
        const message = await cycleSession.next();
        assert.ok(
          message.type === "JOB" &&
            message.request_id === startID &&
            ["DOWNLOADING", "READY"].includes(message.payload.state),
          "CYCLE_CACHE_REPLY_INVALID",
        );
        if (message.payload.state !== "READY") continue;
        job = message.payload;
        assert.ok(
          uuid.test(job.job_id) &&
            job.cache_hit === true &&
            job.media?.model_id === cached.model_id &&
            job.media.trim_enabled === false &&
            job.media.duration_seconds === cached.duration_seconds &&
            !cycleJobs.has(job.job_id),
          "CYCLE_CACHE_REPLAY_INVALID",
        );
        cycleJobs.add(job.job_id);
        break;
      }
      const media = await rangeProof(job.media, job.job_id, origin, audio);
      assert.ok(
        !cycleCapabilities.has(media.capability),
        "CYCLE_CAPABILITY_REUSED",
      );
      cycleCapabilities.add(media.capability);
      const cancelID = cycleSession.command("CANCEL", { job_id: job.job_id });
      for (;;) {
        const message = await cycleSession.next();
        assert.ok(
          message.type === "JOB" &&
            [startID, cancelID].includes(message.request_id) &&
            message.payload.job_id === job.job_id &&
            message.payload.state === "CANCELLED",
          "CYCLE_CANCEL_REPLY_INVALID",
        );
        if (message.request_id === cancelID) break;
      }
      const revoked = await fetch(media.url, {
        method: "HEAD",
        headers: { Origin: origin },
        redirect: "error",
        signal: AbortSignal.timeout(3_000),
      });
      assert.equal(revoked.status, 403, "CYCLE_MEDIA_NOT_REVOKED");
      assert.equal(
        (await readdir(join(state, "cache/jobs"))).length,
        0,
        "CYCLE_JOB_SCRATCH_REMAINS",
      );
      await waitForCacheLeaseRelease();
      assert.equal(
        (await playbackPins()).length,
        0,
        "CYCLE_PLAYBACK_PIN_REMAINS",
      );
      report.same_host_cycles.push({
        cycle,
        cache_hit: true,
        fresh_job_and_capability: true,
        media: media.proof,
        cancelled: true,
        revoked_capability_status: revoked.status,
        scratch_empty: true,
        playback_pin_released: true,
        ...(cycle === 1 || cycle === 10
          ? { resources: await resourceObservation(cycleSession.pid) }
          : {}),
      });
    }
  } catch (error) {
    cycleError = error;
  }
  try {
    cycleCleanup = await cycleSession.close();
  } catch (error) {
    cycleError ??= error;
  }
  if (cycleError) throw cycleError;
  let forbiddenCycles = Buffer.alloc(0);
  try {
    forbiddenCycles = await boundedRead(cycleMarker, 4096);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  check(
    "Ten same-host replay/cancel cycles use fresh grants, revoke old grants and leave no scratch",
    report.same_host_cycles.length === 10 &&
      cycleJobs.size === 10 &&
      cycleCapabilities.size === 10,
  );
  check(
    "Same-host cycles perform no acquisition, inference or network and preserve retained audio",
    forbiddenCycles.length === 0 &&
      digest(await boundedRead(audioPath, 30 * 1024 ** 2)) === cached.sha256,
  );
  const cycleEvents = (
    await boundedRead(join(state, "logs/events.jsonl"), 512 * 1024)
  )
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => cycleJobs.has(event.job_id));
  check(
    "Same-host diagnostics contain ten current cache hits and no engine events",
    cycleEvents.filter((event) => event.event === "cache_hit").length === 10 &&
      cycleEvents.filter((event) => event.event === "job_ready").length ===
        10 &&
      cycleEvents.every((event) => event.component !== "engine"),
  );
  report.same_host_cleanup = cycleCleanup;
  report.same_host_resources_are_observations_not_universal_leak_proof = true;

  const libraryRequestID = randomUUID();
  // Reproduce an old catalog row with missing display metadata, while retaining
  // this exact copied audio's verified title. Only isolated guest fixtures change.
  const catalogPath = join(state, "desktop-catalog/guest/entries.json");
  const legacyCatalog = JSON.parse(
    await boundedRead(catalogPath, 4 * 1024 ** 2),
  );
  assert.ok(
    legacyCatalog.owner_uid === null &&
      legacyCatalog.entries.length === 1 &&
      legacyCatalog.entries[0].cache_key === key,
    "TITLE_CATALOG_FIXTURE_INVALID",
  );
  const titleTimes = {
    created: legacyCatalog.entries[0].created_at,
    updated: legacyCatalog.entries[0].updated_at,
  };
  const titleRevision = legacyCatalog.revision;
  delete legacyCatalog.entries[0].source_title;
  const legacyTemporary = join(
    dirname(catalogPath),
    `.title-fixture-${randomUUID()}.tmp`,
  );
  await privateWrite(legacyTemporary, JSON.stringify(legacyCatalog));
  await rename(legacyTemporary, catalogPath);
  const libraryMarker = join(output, "native-library-guard.jsonl");
  const libraryCommand = exec(
    join(resources, "runtime/runtime/node/bin/node"),
    ["--import", guard, join(resources, "companion/desktop-control.js")],
    {
      cwd: output,
      timeout: 15_000,
      maxBuffer: 65_536,
      env: {
        HOME: testHome,
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        TMPDIR: testHome,
        MUSICMUTE_LOCAL_ROOT: state,
        MUSICMUTE_LOCAL_APP_RESOURCES: resources,
        MUSICMUTE_LOCAL_TEST_MODE: "1",
        QUALIFICATION_HOME: testHome,
        QUALIFICATION_MARKER: libraryMarker,
        QUALIFICATION_PARENT_PID: String(process.pid),
      },
    },
  );
  libraryCommand.child.stdin.end(
    JSON.stringify({
      protocol_version: 1,
      request_id: libraryRequestID,
      type: "LIBRARY_CACHE",
      payload: { limit: 50 },
    }),
  );
  const libraryReply = await libraryCommand;
  const library = JSON.parse(libraryReply.stdout.trim());
  check(
    "Installed native Library retains the bounded title fixture after host restart without acquisition",
    libraryReply.stderr.length === 0 &&
      library.type === "result" &&
      library.request_id === libraryRequestID &&
      library.payload?.items?.length === 1 &&
      library.payload.items[0].cache_key === key &&
      library.payload.items[0].source_title === titleFixture,
  );
  report.native_library_title_fixture_retained = true;
  const budgetBytes = library.payload.budget_bytes;
  check(
    "Installed Library reports a valid whole-GB offline storage budget",
    Number.isSafeInteger(budgetBytes) &&
      budgetBytes >= 1_000_000_000 &&
      budgetBytes <= 9_007_199_000_000_000 &&
      budgetBytes % 1_000_000_000 === 0,
  );
  report.storage_pressure.limit_bytes = budgetBytes;
  const repairedCatalog = JSON.parse(
    await boundedRead(catalogPath, 4 * 1024 ** 2),
  );
  check(
    "Installed Library recovers and persists a missing legacy catalog title from the exact validated retained manifest",
    repairedCatalog.entries.length === 1 &&
      repairedCatalog.entries[0].source_title === titleFixture &&
      repairedCatalog.entries[0].created_at === titleTimes.created &&
      repairedCatalog.entries[0].updated_at === titleTimes.updated &&
      repairedCatalog.revision !== titleRevision,
  );
  report.native_library_legacy_title_fixture_recovered = true;
  report.native_library_visual_acceptance = false;
  const libraryGuard = await boundedRead(libraryMarker, 4096).catch((error) => {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  });
  check(
    "Native Library title check performs no network or tools",
    libraryGuard.length === 0,
  );
  // Exercise the installed host's effective offline storage policy in an isolated
  // home. Sparse files prove byte accounting/eviction, not decoding or audio
  // quality. Only the copied, previously qualified MP3 is ever played.
  const vocalsRoot = join(state, "cache/vocals");
  const pinsRoot = join(state, "cache/pins");
  await privateDirectory(pinsRoot);
  const pressureKeys = Array.from({ length: 34 }, (_, index) =>
    digest(`owned-storage-pressure-${index}`),
  );
  const pressureBytes = Math.ceil(budgetBytes / pressureKeys.length) + 1;
  const oldest = Date.now() - 900_000;
  async function createPressureEntry(index) {
    const entry = join(vocalsRoot, pressureKeys[index]);
    await privateDirectory(entry);
    const file = await open(join(entry, "vocals.mp3"), "wx", 0o600);
    try {
      await file.truncate(pressureBytes);
    } finally {
      await file.close();
    }
    await privateWrite(join(entry, "result.json"), "{}");
    const modified = new Date(oldest + index * 1_000);
    await utimes(entry, modified, modified);
  }
  const pins = new Map();
  async function pin(cacheKey) {
    if (pins.has(cacheKey)) return;
    const path = join(pinsRoot, `playback-${randomUUID()}.json`);
    await privateWrite(
      path,
      JSON.stringify({ version: 1, cache_key: cacheKey, pid: process.pid }),
    );
    pins.set(cacheKey, path);
  }
  async function usage() {
    let total = 0;
    for (const entry of await readdir(vocalsRoot)) {
      assert.ok(/^[a-f0-9]{64}$/.test(entry), "UNSAFE_STORAGE_FIXTURE");
      for (const name of await readdir(join(vocalsRoot, entry))) {
        assert.ok(
          ["vocals.mp3", "result.json"].includes(name),
          "UNSAFE_STORAGE_FIXTURE",
        );
        const info = await lstat(join(vocalsRoot, entry, name));
        assert.ok(
          info.isFile() &&
            !info.isSymbolicLink() &&
            info.nlink === 1 &&
            info.uid === process.getuid() &&
            !(info.mode & 0o077),
          "UNSAFE_STORAGE_FIXTURE",
        );
        total += info.size;
      }
    }
    return total;
  }
  let matrixIndex = 0;
  async function matrixCommand(type, expectedCode) {
    const marker = join(output, `storage-guard-${++matrixIndex}.jsonl`);
    const session = hostSession(
      resources,
      state,
      testHome,
      guard,
      marker,
      origin,
    );
    let originalError;
    let cleanup;
    let terminal;
    try {
      const helloId = session.command("HELLO");
      const hello = await session.next();
      assert.ok(
        hello.type === "HELLO" &&
          hello.request_id === helloId &&
          hello.payload.ready === true,
        "HELLO_INVALID",
      );
      const id = session.command(
        type,
        type === "START"
          ? {
              video_id: video,
              duration_seconds: cached.source_duration_seconds,
              provider: "LOCAL_MACOS",
            }
          : {},
      );
      for (;;) {
        const message = await session.next();
        assert.equal(message.request_id, id, "UNEXPECTED_STORAGE_REPLY");
        if (message.type === "ERROR") {
          assert.ok(
            expectedCode && message.payload.error_code === expectedCode,
            "UNEXPECTED_STORAGE_ERROR",
          );
          terminal = message.payload;
          break;
        }
        assert.equal(message.type, "JOB", "UNEXPECTED_STORAGE_REPLY");
        if (type === "CLEAR_CACHE") {
          assert.equal(message.payload, null, "UNEXPECTED_STORAGE_REPLY");
          break;
        }
        const job = message.payload;
        assert.ok(job, "UNEXPECTED_STORAGE_REPLY");
        if (job.state === "FAILED") {
          assert.ok(
            expectedCode && job.error_code === expectedCode,
            "UNEXPECTED_STORAGE_ERROR",
          );
          terminal = job;
          break;
        }
        assert.ok(
          ["DOWNLOADING", "READY"].includes(job.state) &&
            ["cache-check", "ready"].includes(job.stage),
          "STORAGE_FIXTURE_INFERENCE_ATTEMPTED",
        );
        if (job.state === "READY") {
          assert.ok(!expectedCode && job.cache_hit, "CACHE_REPLAY_INVALID");
          await rangeProof(job.media, job.job_id, origin, audio);
          terminal = job;
          break;
        }
      }
    } catch (error) {
      originalError = error;
    } finally {
      try {
        cleanup = await session.close();
      } catch (error) {
        originalError ??= error;
      }
    }
    if (originalError) throw originalError;
    const markers = await boundedRead(marker, 4096).catch((error) => {
      if (error.code === "ENOENT") return Buffer.alloc(0);
      throw error;
    });
    check(
      `Storage case ${matrixIndex} runs no network/tools and leaves no job scratch`,
      markers.length === 0 &&
        (await readdir(join(state, "cache/jobs"))).length === 0,
    );
    report.storage_pressure[`case_${matrixIndex}`] = {
      command: type,
      ...(expectedCode
        ? { expected_error: expectedCode }
        : type === "START"
          ? { cache_hit: true }
          : {}),
      ...cleanup,
    };
    return terminal;
  }
  for (let index = 0; index < pressureKeys.length; index++)
    await createPressureEntry(index);
  await pin(pressureKeys[0]);
  const beforePressure = await usage();
  check(
    "Owned storage fixtures exceed the installed offline storage budget",
    beforePressure > budgetBytes,
  );
  await matrixCommand("START");
  const afterPressure = await usage();
  const surviving = new Set(await readdir(vocalsRoot));
  const evicted = pressureKeys.filter((entry) => !surviving.has(entry));
  check(
    "Installed LRU evicts oldest unpinned entries and keeps playback-pinned vocals",
    afterPressure <= budgetBytes &&
      surviving.has(key) &&
      surviving.has(pressureKeys[0]) &&
      evicted.length > 0 &&
      evicted.every((entry, index) => entry === pressureKeys[index + 1]),
  );
  for (const entry of evicted)
    await createPressureEntry(pressureKeys.indexOf(entry));
  for (const entry of [key, ...pressureKeys]) await pin(entry);
  const protectedBytes = await usage();
  await matrixCommand("START", "OFFLINE_CACHE_FULL");
  check(
    "Over-budget protected cache refuses playback admission without deleting pinned vocals",
    protectedBytes > budgetBytes &&
      (await usage()) === protectedBytes &&
      (await readdir(vocalsRoot)).length === pressureKeys.length + 1 &&
      digest(await boundedRead(audioPath, 30 * 1024 ** 2)) === cached.sha256,
  );
  const metadataPath = join(cache, "result.json");
  const ownedMetadata = await boundedRead(metadataPath, 64 * 1024);
  const corruptMetadata = Buffer.from("{owned-incomplete-metadata");
  await writeFile(metadataPath, corruptMetadata, { flag: "r+" });
  const file = await open(metadataPath, "r+");
  try {
    await file.truncate(corruptMetadata.length);
  } finally {
    await file.close();
  }
  await matrixCommand("START", "CACHE_UNSAFE");
  check(
    "Pinned damaged metadata never permits replacing vocals or attempting inference",
    (await boundedRead(metadataPath, 64 * 1024)).equals(corruptMetadata) &&
      digest(await boundedRead(audioPath, 30 * 1024 ** 2)) === cached.sha256,
  );
  await writeFile(metadataPath, ownedMetadata, { flag: "r+" });
  await matrixCommand("CLEAR_CACHE");
  check(
    "Clear cache preserves all active playback pins",
    (await readdir(vocalsRoot)).length === pressureKeys.length + 1,
  );
  for (const path of pins.values()) await unlink(path);
  await matrixCommand("CLEAR_CACHE");
  check(
    "Clear cache removes only unpinned owned entries after playback ends",
    (await readdir(vocalsRoot)).length === 0,
  );
  Object.assign(report.storage_pressure, {
    before_bytes: beforePressure,
    after_bytes: afterPressure,
    evicted_entries: evicted.length,
    protected_refusal_bytes: protectedBytes,
    protected_corrupt_metadata_refused: true,
  });
  check(
    "Installed host bytes remain unchanged",
    digest(await boundedRead(hostPath, 1024 * 1024)) ===
      report.installed_host_sha256,
  );
  check(
    "Source cache bytes and metadata remain unchanged",
    digest(
      await boundedRead(join(sourceCache, "vocals.mp3"), 30 * 1024 ** 2),
    ) === cached.sha256 &&
      (await boundedRead(join(sourceCache, "result.json"), 64 * 1024)).equals(
        sourceMetadata,
      ),
  );
  report.historical_cache_timings_are_not_new_inference = true;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error_code = /^[A-Z_]{1,70}$/.test(error.message ?? "")
    ? error.message
    : "QUALIFICATION_FAILED";
} finally {
  report.wall_ms = Date.now() - started;
  if (!outputValidated) {
    process.stdout.write(
      JSON.stringify({
        passed: false,
        error_code: report.error_code ?? "OUTPUT_PARENT_UNSAFE",
      }) + "\n",
    );
    process.exitCode = 1;
  } else {
    await privateDirectory(output);
    const path = join(output, "result.json");
    const bytes = JSON.stringify(report, null, 2) + "\n";
    assert.ok(
      !bytes.includes("capability=") &&
        !bytes.includes("http://") &&
        !bytes.includes("chrome-extension://") &&
        Buffer.byteLength(bytes) <= 64 * 1024,
      "REPORT_PRIVACY_FAILED",
    );
    await privateWrite(path, bytes);
    assert.ok(
      ((await lstat(path)).mode & 0o777) === 0o600,
      "REPORT_NOT_PRIVATE",
    );
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
}

// Installed native orchestration only; fixture mode bypasses readiness/inference.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  statfs,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const output = join(root, "output/native-write-fault-proof", randomUUID());
const started = Date.now();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const video = "jNQXAC9IVRw";
const report = {
  scope: "INSTALLED_NATIVE_WRITE_FAILURE_AND_FIXTURE_SUCCESSOR_RECOVERY",
  runtime_scope: "PACKAGED_APP",
  browser_playback: false,
  readiness_bypassed: true,
  acquisition_bypassed: true,
  inference_bypassed: true,
  fixture_timings_are_not_normal_processing_proof: true,
  disk_filled: false,
  consumer_or_fleet_state_modified: false,
  checks: [],
  scenarios: [],
  forbidden_network_attempts: 0,
  forbidden_tool_attempts: 0,
};
function check(name, value) {
  assert.ok(value, "QUALIFICATION_CHECK_FAILED");
  report.checks.push(name);
}
function within(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
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
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
}
async function boundedRead(path, maximum) {
  const info = await lstat(path);
  assert.ok(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.nlink === 1 &&
      info.size <= maximum,
    "UNSAFE_FIXTURE_FILE",
  );
  return readFile(path);
}
function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw new Error("PROCESS_GROUP_CHECK_FAILED");
  }
}

function session(
  resources,
  state,
  home,
  profile,
  guard,
  origin,
  fixture,
  marker,
  partialLogWrite = false,
) {
  const child = spawn(
    "/usr/bin/sandbox-exec",
    [
      "-f",
      profile,
      join(resources, "runtime/runtime/python/bin/python3"),
      "-B",
      join(resources, "scripts/native-lock.py"),
      join(resources, "runtime/runtime/node/bin/node"),
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
        HOME: home,
        TMPDIR: home,
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        MUSICMUTE_LOCAL_ROOT: state,
        MUSICMUTE_LOCAL_APP_RESOURCES: resources,
        MUSICMUTE_LOCAL_TEST_MODE: "1",
        MUSICMUTE_LOCAL_FIXTURE_AUDIO: fixture,
        QUALIFICATION_MARKER: marker,
        ...(partialLogWrite
          ? {
              QUALIFICATION_PARTIAL_WRITE_LOG: join(state, "logs/events.jsonl"),
              QUALIFICATION_PARTIAL_WRITE_MARKER: join(
                dirname(marker),
                "partial-write-injection.json",
              ),
            }
          : {}),
      },
    },
  );
  const messages = [];
  const jobs = [];
  let buffer = Buffer.alloc(0);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let failure;
  let waiter;
  let closing = false;
  let forced = false;
  let exit;
  let escalation;
  function terminate() {
    forced = true;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* Already exited. */
    }
    escalation ??= setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }, 1000);
  }
  function fail(code) {
    failure ??= new Error(code);
    waiter?.reject(failure);
    waiter = undefined;
    if (!exit) terminate();
  }
  const closed = new Promise((done) =>
    child.once("close", (code, signal) => {
      exit = { code, signal };
      if (!closing) fail("COMPANION_DISCONNECTED");
      done(exit);
    }),
  );
  const deadline = setTimeout(() => fail("COMPANION_TIMEOUT"), 20000);
  child.on("error", () => fail("COMPANION_START_FAILED"));
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
    if (stdoutBytes > 512 * 1024) {
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
          message?.protocol_version === 1 &&
            /^[a-f0-9-]{36}$/i.test(message.request_id) &&
            ["HELLO", "JOB", "ERROR", "REPORT"].includes(message.type),
          "FRAME_INVALID",
        );
        if (message.type === "JOB" && message.payload) {
          assert.ok(
            typeof message.payload === "object" &&
              !Array.isArray(message.payload) &&
              /^[a-f0-9-]{36}$/i.test(message.payload.job_id),
            "JOB_INVALID",
          );
          jobs.push({
            job_id: message.payload.job_id,
            state: message.payload.state,
            has_media: Boolean(message.payload.media),
          });
        }
        assert.ok(
          messages.length < 60 && jobs.length < 60,
          "FRAME_OUTPUT_LIMIT",
        );
        if (waiter) {
          waiter.resolve(message);
          waiter = undefined;
        } else messages.push(message);
      }
    } catch {
      fail("FRAME_INVALID");
    }
  });
  function command(type, payload = {}) {
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
  }
  function next() {
    if (failure) return Promise.reject(failure);
    if (messages.length) return Promise.resolve(messages.shift());
    assert.ok(!waiter, "CONCURRENT_PROTOCOL_READ");
    return new Promise((resolveMessage, reject) => {
      waiter = { resolve: resolveMessage, reject };
    });
  }
  async function reply(type, payload = {}) {
    const id = command(type, payload);
    for (;;) {
      const message = await next();
      if (message.request_id === id) return message;
    }
  }
  return {
    command,
    next,
    reply,
    jobs,
    async close() {
      closing = true;
      child.stdin.end();
      const grace = setTimeout(terminate, 2000);
      let closeTimer;
      try {
        const result = await Promise.race([
          closed,
          new Promise((_, reject) => {
            closeTimer = setTimeout(() => {
              terminate();
              reject(new Error("COMPANION_CLEANUP_TIMEOUT"));
            }, 5000);
          }),
        ]);
        assert.ok(
          result.code === 0 && !result.signal && !forced && buffer.length === 0,
          "COMPANION_CLEANUP_FAILED",
        );
        const expiry = Date.now() + 2000;
        while (groupExists(child.pid) && Date.now() < expiry) await pause(25);
        assert.ok(!groupExists(child.pid), "COMPANION_GROUP_REMAINS");
        return {
          exit_code: result.code,
          owned_group_gone: true,
          forced_shutdown: false,
          stdout_bytes: stdoutBytes,
          stderr_bytes: stderrBytes,
        };
      } finally {
        clearTimeout(deadline);
        clearTimeout(grace);
        clearTimeout(closeTimer);
        clearTimeout(escalation);
        if (child.pid && groupExists(child.pid)) terminate();
      }
    },
  };
}

async function terminal(host, duration) {
  const id = host.command("START", {
    video_id: video,
    duration_seconds: duration,
    provider: "LOCAL_MACOS",
  });
  for (;;) {
    const message = await host.next();
    if (message.request_id !== id) continue;
    if (message.type === "ERROR")
      throw new Error(
        message.payload.error_code === "DISK_SPACE_LOW"
          ? "QUALIFICATION_DISK_RESERVE_UNAVAILABLE"
          : "START_REFUSED",
      );
    assert.ok(message.type === "JOB" && message.payload, "JOB_INVALID");
    if (["READY", "FAILED", "CANCELLED"].includes(message.payload.state))
      return message.payload;
  }
}
async function nativeReport(host, state) {
  const message = await host.reply("DIAGNOSTICS");
  assert.ok(
    message.type === "REPORT" &&
      message.payload?.report &&
      isAbsolute(message.payload.path) &&
      within(join(state, "logs/exports"), message.payload.path),
    "DIAGNOSTICS_REPORT_INVALID",
  );
  return {
    snapshot: message.payload.report,
    exported: JSON.parse(
      (await boundedRead(message.payload.path, 128 * 1024)).toString("utf8"),
    ),
  };
}
async function rangeProof(media, origin, audio) {
  const url = new URL(media?.url);
  assert.ok(
    url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      /^\d+$/.test(url.port),
    "MEDIA_INVALID",
  );
  const response = await fetch(url, {
    headers: { Origin: origin, Range: "bytes=0-1023" },
    redirect: "error",
    signal: AbortSignal.timeout(3000),
  });
  const data = Buffer.from(await response.arrayBuffer());
  assert.ok(
    response.status === 206 &&
      data.length === 1024 &&
      data.equals(audio.subarray(0, 1024)),
    "RANGE_INVALID",
  );
  return { range_status: 206, range_bytes: 1024, matches_source_fixture: true };
}

try {
  assert.ok(
    process.platform === "darwin" && process.arch === "arm64",
    "UNSUPPORTED_PLATFORM",
  );
  const args = process.argv.slice(2);
  assert.ok(
    args.length === 2 && args[0] === "--source" && isAbsolute(args[1]),
    "INVALID_QUALIFICATION_ARGUMENTS",
  );
  const source = await realpath(args[1]);
  assert.ok(
    within(join(root, "output"), source) && source !== join(root, "output"),
    "SOURCE_OUTSIDE_IGNORED_OUTPUT",
  );
  const sourceReport = JSON.parse(
    (await boundedRead(join(source, "result.json"), 64 * 1024)).toString(
      "utf8",
    ),
  );
  check(
    "Source is an existing successful packaged native acquisition/MPS/Range proof",
    sourceReport.passed === true &&
      sourceReport.runtime_scope === "PACKAGED_APP" &&
      sourceReport.scope ===
        "ONE_PUBLIC_YOUTUBE_ACQUISITION_AND_LOCAL_PREPARATION_AND_RANGE",
  );
  const app = await realpath(
    join(homedir(), "Applications/MusicMute Local.app"),
  );
  const resources = join(app, "Contents/Resources");
  const packageInventorySha256 = digest(
    await boundedRead(join(resources, "bundle-audit.json"), 8 * 1024 ** 2),
  );
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
    timeout: 30000,
    maxBuffer: 64 * 1024,
  });
  const hostBytes = await boundedRead(
    join(resources, "companion/host.js"),
    1024 * 1024,
  );
  const hostSource = hostBytes.toString("utf8");
  const recipe = hostSource.match(
    /model:\s*("[a-f0-9]{64}"|MODEL_SHA256),\s*revision:\s*(\d+),\s*trim:\s*false,\s*source:\s*"default"/,
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
  const cached = JSON.parse(sourceMetadata.toString("utf8"));
  const audio = await boundedRead(
    join(sourceCache, "vocals.mp3"),
    2 * 1024 ** 2,
  );
  check(
    "Retained source fixture has verified model/timeline/audio checksum",
    cached.model_id === model &&
      cached.verified_model_sha256 === model &&
      cached.bytes === audio.length &&
      cached.sha256 === digest(audio) &&
      audio.length >= 1024 &&
      cached.trim_enabled === false &&
      cached.source_duration_seconds > 0 &&
      cached.source_duration_seconds <= 20 &&
      Math.abs(cached.source_duration_seconds - cached.duration_seconds) <=
        0.25,
  );
  report.installed_host_sha256 = digest(hostBytes);
  report.source_proof = relative(root, source);
  report.fixture_audio_bytes = audio.length;
  report.fixture_audio_sha256 = cached.sha256;
  await privateDirectory(output);
  const disk = await statfs(output);
  report.available_disk_bytes_before = Number(disk.bavail) * Number(disk.bsize);
  assert.ok(
    report.available_disk_bytes_before >= 3 * 1024 ** 3 + 3 * 1024 ** 2,
    "QUALIFICATION_DISK_RESERVE_UNAVAILABLE",
  );
  const fixture = join(output, "fixture.mp3");
  await privateWrite(fixture, audio);
  const guard = join(output, "guard.mjs");
  await privateWrite(
    guard,
    `import fs,{appendFileSync} from 'node:fs';import childProcess from 'node:child_process';import http from 'node:http';import https from 'node:https';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';
const deny=(code)=>{appendFileSync(process.env.QUALIFICATION_MARKER,JSON.stringify(code)+'\\n',{mode:0o600});throw new Error('QUALIFICATION_FORBIDDEN_OPERATION');};globalThis.fetch=()=>deny('NETWORK_CALL');for(const module of [http,https])for(const method of ['request','get'])module[method]=()=>deny('NETWORK_CALL');for(const method of ['connect','createConnection'])net[method]=()=>deny('NETWORK_CALL');net.Socket.prototype.connect=()=>deny('NETWORK_CALL');for(const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])childProcess[method]=()=>deny('SUBPROCESS_CALL');
const target=process.env.QUALIFICATION_PARTIAL_WRITE_LOG;if(target){if(target!==process.env.MUSICMUTE_LOCAL_ROOT+'/logs/events.jsonl')throw new Error('QUALIFICATION_INJECTION_TARGET_INVALID');const originalOpen=fs.openSync;const originalWrite=fs.writeSync;const originalClose=fs.closeSync;const tracked=new Set();let complete=0;let injected=false;
fs.openSync=(...args)=>{const fd=originalOpen(...args);if(args[0]===target)tracked.add(fd);return fd;};fs.closeSync=(fd)=>{tracked.delete(fd);return originalClose(fd);};fs.writeSync=(...args)=>{if(!tracked.has(args[0]))return originalWrite(...args);const [fd,bytes,offset,length,position]=args;if(!Buffer.isBuffer(bytes)||!Number.isInteger(offset)||!Number.isInteger(length))throw new Error('QUALIFICATION_INJECTION_ARGUMENTS_INVALID');if(!injected&&complete>=2){injected=true;const prefix=Math.min(48,length-1);if(prefix<1||bytes.subarray(offset,offset+prefix).includes(10))throw new Error('QUALIFICATION_INJECTION_PREFIX_INVALID');const written=originalWrite(fd,bytes,offset,prefix,position);fs.writeFileSync(process.env.QUALIFICATION_PARTIAL_WRITE_MARKER,JSON.stringify({schema_version:1,type:'PARTIAL_LOG_WRITE',prefix_bytes:written,complete_events_before:complete,error_code:'ENOSPC'})+'\\n',{flag:'wx',mode:0o600});const error=new Error('QUALIFICATION_PARTIAL_LOG_WRITE');error.code='ENOSPC';throw error;}const written=originalWrite(...args);if(written===length&&bytes[offset+length-1]===10)complete++;return written;};}
syncBuiltinESMExports();\n`,
  );
  const manifest = JSON.parse(
    (
      await boundedRead(join(resources, "extension/manifest.json"), 64 * 1024)
    ).toString("utf8"),
  );
  const id = digest(Buffer.from(manifest.key, "base64"))
    .slice(0, 32)
    .split("")
    .map((hex) => String.fromCharCode(97 + Number.parseInt(hex, 16)))
    .join("");
  const origin = `chrome-extension://${id}`;
  const escaped = (path) =>
    path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  for (const kind of [
    "scratch",
    "retained-media",
    "diagnostic-log",
    "diagnostic-partial-write",
  ]) {
    const dataWriteFault = kind === "scratch" || kind === "retained-media";
    const scenarioRoot = join(output, kind);
    const state = join(scenarioRoot, "state");
    const home = join(scenarioRoot, "home");
    await privateDirectory(home);
    await privateDirectory(join(state, "cache/jobs"));
    await privateDirectory(join(state, "cache/vocals"));
    await privateDirectory(join(state, "logs"));
    const denied =
      kind === "scratch"
        ? join(state, "cache/jobs")
        : kind === "retained-media"
          ? join(state, "cache/vocals")
          : join(state, "logs/events.jsonl");
    if (dataWriteFault) await chmod(denied, 0o500);
    const profile = join(scenarioRoot, "sandbox.sb");
    const logRule =
      kind === "diagnostic-log"
        ? `\n(deny file-write* (literal "${escaped(denied)}"))`
        : "";
    await privateWrite(
      profile,
      `(version 1)\n(allow default)\n(deny network-outbound)\n(deny file-write* (require-all (require-not (subpath "${escaped(output)}")) (require-not (literal "/dev/null"))))${logRule}\n`,
    );
    const marker = join(scenarioRoot, "guard-events.jsonl");
    const host = session(
      resources,
      state,
      home,
      profile,
      guard,
      origin,
      fixture,
      marker,
      kind === "diagnostic-partial-write",
    );
    const result = {
      kind,
      enforcement:
        kind === "diagnostic-log"
          ? "OS_SANDBOX_DENIED_JSONL_WRITES"
          : kind === "diagnostic-partial-write"
            ? "FIXED_PRIVATE_LOG_DESCRIPTOR_REAL_PREFIX_WRITE_THEN_INJECTED_ENOSPC"
            : "OWNED_DIRECTORY_OWNER_WRITE_PERMISSION_REMOVED",
      readiness_bypassed: true,
      acquisition_bypassed: true,
      inference_bypassed: true,
      fixture_timings_excluded: true,
    };
    let partialBytes;
    try {
      const hello = await host.reply("HELLO");
      assert.ok(
        hello.type === "HELLO" && hello.payload?.ready === true,
        "HELLO_INVALID",
      );
      if (dataWriteFault) {
        const failed = await terminal(host, cached.source_duration_seconds);
        check(
          `${kind}: denied write produces a safe FAILED job without media`,
          failed.state === "FAILED" &&
            ["EACCES", "EPERM"].includes(failed.error_code) &&
            !failed.media &&
            !host.jobs.some(
              (job) =>
                job.job_id === failed.job_id &&
                (job.state === "READY" || job.has_media),
            ),
        );
        await pause(100);
        check(
          `${kind}: failed job scratch is removed`,
          (await readdir(join(state, "cache/jobs"))).length === 0,
        );
        const diagnostics = await nativeReport(host, state);
        result.failed_error_code = failed.error_code;
        result.diagnostic_error_codes =
          diagnostics.snapshot.jobs.find((job) => job.job_id === failed.job_id)
            ?.error_codes ?? [];
        check(
          `${kind}: native and exported diagnostics preserve the filesystem error code`,
          [diagnostics.snapshot, diagnostics.exported].every((retained) => {
            const codes =
              retained.jobs.find((job) => job.job_id === failed.job_id)
                ?.error_codes ?? [];
            const errors = retained.recent_errors.filter(
              (event) => event.job_id === failed.job_id,
            );
            return (
              codes.includes(failed.error_code) &&
              !codes.includes("UNKNOWN_ERROR") &&
              errors.some(
                (event) =>
                  event.event === "job_failed" &&
                  event.code === failed.error_code,
              ) &&
              !errors.some((event) => event.code === "UNKNOWN_ERROR")
            );
          }),
        );
        check(
          `${kind}: failure remains visible in native diagnostics`,
          diagnostics.snapshot.counts.job_failed >= 1 &&
            diagnostics.exported.counts.job_failed >= 1,
        );
        await chmod(denied, 0o700);
      } else if (kind === "diagnostic-log") {
        const diagnostics = await nativeReport(host, state);
        check(
          "diagnostic-log: native REPORT exposes degraded logging and missing coverage",
          diagnostics.snapshot.availability === "diagnostics_unavailable" &&
            diagnostics.snapshot.failure_code === "DIAGNOSTICS_UNAVAILABLE" &&
            diagnostics.snapshot.coverage.incomplete_history === true &&
            diagnostics.exported.availability === "diagnostics_unavailable",
        );
        result.logging_availability = diagnostics.snapshot.availability;
        result.logging_failure_code = diagnostics.snapshot.failure_code;
      } else {
        const diagnostics = await nativeReport(host, state);
        check(
          "diagnostic-partial-write: writer is healthy before the injected fault",
          diagnostics.snapshot.availability === "available" &&
            diagnostics.snapshot.coverage.failed_writes === 0,
        );
      }
      const successor = await terminal(host, cached.source_duration_seconds);
      check(
        `${kind}: uncached fixture successor safely becomes READY`,
        successor.state === "READY" &&
          successor.cache_hit === false &&
          successor.media?.trim_enabled === false,
      );
      result.uncached_fixture_successor = await rangeProof(
        successor.media,
        origin,
        audio,
      );
      if (kind === "diagnostic-partial-write") {
        const injection = JSON.parse(
          (
            await boundedRead(
              join(scenarioRoot, "partial-write-injection.json"),
              1024,
            )
          ).toString("utf8"),
        );
        partialBytes = injection.prefix_bytes;
        const log = await boundedRead(
          join(state, "logs/events.jsonl"),
          32 * 1024,
        );
        const boundary = log.lastIndexOf(10) + 1;
        const completeEvents = log
          .subarray(0, boundary)
          .toString("utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        check(
          "diagnostic-partial-write: actual log contains valid events followed by the injected torn prefix",
          injection.schema_version === 1 &&
            injection.type === "PARTIAL_LOG_WRITE" &&
            injection.error_code === "ENOSPC" &&
            injection.complete_events_before >= 2 &&
            Number.isInteger(partialBytes) &&
            partialBytes > 0 &&
            partialBytes <= 48 &&
            log.length - boundary === partialBytes &&
            completeEvents.length === injection.complete_events_before &&
            completeEvents.every((event) => event.schema_version === 1),
        );
        const diagnostics = await nativeReport(host, state);
        check(
          "diagnostic-partial-write: continued READY and Range coexist with visible midstream logging degradation",
          [diagnostics.snapshot, diagnostics.exported].every(
            (retained) =>
              retained.availability === "diagnostics_unavailable" &&
              retained.failure_code === "DIAGNOSTICS_UNAVAILABLE" &&
              retained.coverage.failed_writes === 1 &&
              retained.coverage.incomplete_history === true,
          ),
        );
        result.injection = injection;
        result.logging_availability = diagnostics.snapshot.availability;
        result.failed_writes = diagnostics.snapshot.coverage.failed_writes;
      }
      await pause(100);
      const replay = await terminal(host, cached.source_duration_seconds);
      check(
        `${kind}: cached fixture successor safely becomes READY`,
        replay.state === "READY" &&
          replay.cache_hit === true &&
          replay.job_id !== successor.job_id,
      );
      result.cached_fixture_successor = await rangeProof(
        replay.media,
        origin,
        audio,
      );
      const evidence = await nativeReport(host, state);
      const identities = [evidence.snapshot, evidence.exported];
      const sameIdentity = (identity) =>
        identity?.software_version === manifest.version &&
        identity?.runtime_scope === "PACKAGED_APP" &&
        identity?.expected_model_sha256 === model &&
        identity?.package_inventory_sha256 === packageInventorySha256;
      check(
        `${kind}: current reports and retained events identify the installed package`,
        identities.every(
          (retained) =>
            sameIdentity(retained.identity) &&
            retained.recent_events.length > 0 &&
            retained.recent_events.every((event) =>
              sameIdentity(event.identity),
            ),
        ),
      );
      const readyEvents = evidence.exported.recent_events.filter(
        (event) =>
          event.event === "job_ready" &&
          [successor.job_id, replay.job_id].includes(event.job_id),
      );
      const fixtureMetadata = JSON.parse(
        (
          await boundedRead(
            join(state, "cache/vocals", key, "result.json"),
            64 * 1024,
          )
        ).toString("utf8"),
      );
      check(
        `${kind}: fixture preparation and replay never gain verified-model provenance`,
        readyEvents.length === 2 &&
          identities.every((retained) =>
            retained.recent_events.every(
              (event) => event.verified_model_sha256 === undefined,
            ),
          ) &&
          fixtureMetadata.verified_model_sha256 === undefined,
      );
      result.fixture_verification_claimed = false;
      result.package_inventory_sha256 = packageInventorySha256;
      await pause(100);
      check(
        `${kind}: successful scratch is removed`,
        (await readdir(join(state, "cache/jobs"))).length === 0,
      );
      result.scratch_empty = true;
    } finally {
      if (dataWriteFault) await chmod(denied, 0o700);
      result.cleanup = await host.close();
    }
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
      (event) => event === "NETWORK_CALL",
    ).length;
    report.forbidden_tool_attempts += markers.filter(
      (event) => event === "SUBPROCESS_CALL",
    ).length;
    check(
      `${kind}: fixture mode attempts no network or tools`,
      markers.length === 0,
    );
    report.scenarios.push(result);
    if (kind === "diagnostic-log" || kind === "diagnostic-partial-write") {
      const healthyProfile = join(scenarioRoot, "healthy-sandbox.sb");
      await privateWrite(
        healthyProfile,
        `(version 1)\n(allow default)\n(deny network-outbound)\n(deny file-write* (require-all (require-not (subpath "${escaped(output)}")) (require-not (literal "/dev/null"))))\n`,
      );
      const healthy = session(
        resources,
        state,
        home,
        healthyProfile,
        guard,
        origin,
        fixture,
        marker,
      );
      try {
        assert.ok(
          (await healthy.reply("HELLO")).payload?.ready === true,
          "HELLO_INVALID",
        );
        const diagnostics = await nativeReport(healthy, state);
        check(
          `${kind}: clean restart restores writable local diagnostics`,
          diagnostics.snapshot.availability === "available" &&
            diagnostics.snapshot.failure_code === null &&
            diagnostics.exported.availability === "available",
        );
        result.healthy_restart_logging_available = true;
        if (kind === "diagnostic-partial-write") {
          check(
            "diagnostic-partial-write: restart recovers the precise torn tail and preserves incomplete coverage",
            [diagnostics.snapshot, diagnostics.exported].every(
              (retained) =>
                retained.coverage.recovered_tail_bytes === partialBytes &&
                retained.coverage.malformed_records === 0 &&
                retained.coverage.incomplete_history === true &&
                retained.recent_events.some(
                  (event) =>
                    event.event === "diagnostics_recovered" &&
                    event.code === "DIAGNOSTIC_HISTORY_RECOVERED",
                ),
            ),
          );
          const repaired = await boundedRead(
            join(state, "logs/events.jsonl"),
            32 * 1024,
          );
          check(
            "diagnostic-partial-write: restart removes torn bytes and leaves parseable complete JSONL",
            repaired.at(-1) === 10 &&
              repaired
                .toString("utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line))
                .every((event) => event.schema_version === 1),
          );
          const replay = await terminal(
            healthy,
            cached.source_duration_seconds,
          );
          check(
            "diagnostic-partial-write: recovered writer safely replays unchanged cached audio",
            replay.state === "READY" &&
              replay.cache_hit === true &&
              digest(
                await boundedRead(
                  join(state, "cache/vocals", key, "vocals.mp3"),
                  2 * 1024 ** 2,
                ),
              ) === cached.sha256,
          );
          result.healthy_restart_cached_replay = await rangeProof(
            replay.media,
            origin,
            audio,
          );
          await pause(100);
          check(
            "diagnostic-partial-write: recovered replay leaves no job scratch",
            (await readdir(join(state, "cache/jobs"))).length === 0,
          );
          result.recovered_tail_bytes = partialBytes;
        }
      } finally {
        result.healthy_restart_cleanup = await healthy.close();
      }
    }
  }
  check(
    "Installed host bytes remain unchanged",
    digest(
      await boundedRead(join(resources, "companion/host.js"), 1024 * 1024),
    ) === report.installed_host_sha256,
  );
  check(
    "Source proof audio and metadata remain unchanged",
    digest(
      await boundedRead(join(sourceCache, "vocals.mp3"), 2 * 1024 ** 2),
    ) === cached.sha256 &&
      (await boundedRead(join(sourceCache, "result.json"), 64 * 1024)).equals(
        sourceMetadata,
      ),
  );
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
    timeout: 30000,
    maxBuffer: 64 * 1024,
  });
  check("Installed signature remains valid after native faults", true);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error_code = /^[A-Z_]{1,70}$/.test(error.message ?? "")
    ? error.message
    : "QUALIFICATION_FAILED";
} finally {
  report.wall_ms = Date.now() - started;
  await privateDirectory(output);
  const bytes = JSON.stringify(report, null, 2) + "\n";
  assert.ok(
    Buffer.byteLength(bytes) <= 64 * 1024 &&
      !bytes.includes("capability=") &&
      !bytes.includes("http://") &&
      !bytes.includes("chrome-extension://"),
    "REPORT_PRIVACY_FAILED",
  );
  const path = join(output, "result.json");
  await privateWrite(path, bytes);
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

// Explicit opt-in live acquisition test; local-only evidence, no browser cookies.
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  stageExternalRuntimeForQualification,
  verifyExternalRuntimeForQualification,
} from "./external-runtime-qualification.mjs";
const root = resolve(import.meta.dirname, "..");
const videoId = process.argv[2];
const duration = Number(process.argv[3]);
if (
  !/^[A-Za-z0-9_-]{11}$/.test(videoId ?? "") ||
  !Number.isFinite(duration) ||
  duration <= 0 ||
  duration > 1200
)
  throw new Error(
    "Usage: npm run smoke:youtube -- VIDEO_ID EXPECTED_DURATION_SECONDS",
  );
const appSetting = process.env.MUSICMUTE_LOCAL_APP_RESOURCES;
if (appSetting !== undefined && !isAbsolute(appSetting))
  throw new Error("INVALID_APP_RESOURCES");
const output = join(
  root,
  "output",
  `live-smoke-${Date.now()}-${randomUUID()}.noindex`,
);
await mkdir(output, { recursive: true, mode: 0o700 });
let appResources;
let stagedRuntime;
let runtime;
if (appSetting) {
  const resolvedResources = await realpath(appSetting);
  const app = dirname(dirname(resolvedResources));
  if (
    resolvedResources !== appSetting ||
    resolvedResources !== join(app, "Contents/Resources")
  )
    throw new Error("INVALID_APP_RESOURCES");
  stagedRuntime = await stageExternalRuntimeForQualification({
    app,
    stateRoot: output,
  });
  appResources = stagedRuntime.resources;
  runtime = stagedRuntime.runtimeRoot;
} else {
  runtime = await realpath(
    join(
      homedir(),
      "Library/Application Support/MusicMuteWorker/runtime/current",
    ),
  );
}
const binary = appResources
  ? join(runtime, "tools/yt-dlp")
  : join(
      homedir(),
      "Library/Application Support/MusicMuteLocalMvp/tools/yt-dlp",
    );
const manifest = JSON.parse(
  await readFile(
    join(appResources ?? join(root, "dist"), "extension/manifest.json"),
    "utf8",
  ),
);
const hash = createHash("sha256")
  .update(Buffer.from(manifest.key, "base64"))
  .digest("hex")
  .slice(0, 32);
const extensionId = [...hash]
  .map((c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
  .join("");
if (appResources) {
  // A private test copy isolates every cache/log/lock write from consumer state.
  const digest =
    "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";
  const modelDirectory = join(output, "models", digest);
  await mkdir(modelDirectory, { recursive: true, mode: 0o700 });
  const model = join(modelDirectory, "Kim_Vocal_2.onnx");
  const sourceModel = join(
    homedir(),
    "Library/Application Support/MusicMuteLocal/models",
    digest,
    "Kim_Vocal_2.onnx",
  );
  if (process.platform === "darwin") {
    // BSD cp performs an independent APFS clone; Node's forced clone is ENOSYS
    // on macOS. The private UUID destination is new and never reused.
    await new Promise((done, reject) => {
      execFile(
        "/bin/cp",
        ["-c", "-p", "-n", sourceModel, model],
        {
          timeout: 5_000,
          maxBuffer: 4096,
          env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
        },
        (error) =>
          error ? reject(new Error("MODEL_TEST_COPY_FAILED")) : done(),
      );
    });
  } else await copyFile(sourceModel, model, constants.COPYFILE_EXCL);
  await chmod(model, 0o600);
}
const origin = `chrome-extension://${extensionId}`;
const child = spawn(
  join(runtime, "runtime/python/bin/python3"),
  [
    "-B",
    join(appResources ?? root, "scripts/native-lock.py"),
    join(runtime, "runtime/node/bin/node"),
    join(appResources ?? join(root, "dist"), "companion/host.js"),
    origin,
  ],
  {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      HOME: homedir(),
      MUSICMUTE_LOCAL_ROOT: output,
      ...(appResources
        ? { MUSICMUTE_LOCAL_APP_RESOURCES: appResources }
        : { MUSICMUTE_LOCAL_YT_DLP: binary }),
    },
  },
);
let buffer = Buffer.alloc(0);
let done = false;
let startSent = false;
let verificationStarted = false;
let stderrBytes = 0;
const events = [];
let mediaProof;
let diagnosticIdentityProof;
const start = Date.now();
const deadline = setTimeout(() => finish(false, "LIVE_SMOKE_TIMEOUT"), 180_000);
function command(type, payload = {}) {
  const body = Buffer.from(
    JSON.stringify({
      protocol_version: 1,
      request_id: randomUUID(),
      type,
      payload,
    }),
  );
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(body.length);
  child.stdin.write(Buffer.concat([prefix, body]));
}
async function finish(passed, error_code) {
  if (done) return;
  done = true;
  clearTimeout(deadline);
  child.stdin.end();
  const kill = setTimeout(() => child.kill("SIGTERM"), 2000);
  kill.unref();
  if (stagedRuntime) {
    try {
      await verifyExternalRuntimeForQualification(stagedRuntime);
    } catch {
      passed = false;
      error_code = "EXTERNAL_RUNTIME_POST_AUDIT_FAILED";
    }
  }
  const result = {
    scope: "ONE_PUBLIC_YOUTUBE_ACQUISITION_AND_LOCAL_PREPARATION_AND_RANGE",
    runtime_scope: appResources ? "PACKAGED_APP" : "DEVELOPMENT",
    ...(stagedRuntime
      ? {
          runtime: {
            id: stagedRuntime.runtime.id,
            archive_sha256: stagedRuntime.runtime.archive_sha256,
            state: "DISPOSABLE_EXACT_PACKAGE_RUNTIME_VERIFIED",
          },
        }
      : {}),
    browser_playback: false,
    passed,
    ...(error_code ? { error_code } : {}),
    wall_ms: Date.now() - start,
    events,
    ...(mediaProof ? { media: mediaProof } : {}),
    ...(diagnosticIdentityProof
      ? { diagnostic_identity: diagnosticIdentityProof }
      : {}),
  };
  try {
    await writeFile(
      join(output, "result.json"),
      JSON.stringify(result, null, 2),
      { mode: 0o600 },
    );
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exitCode = passed ? 0 : 1;
  } catch {
    process.stderr.write("REPORT_WRITE_FAILED\n");
    process.exitCode = 1;
  }
}
async function verifyReadyMedia(media, jobId) {
  if (done || verificationStarted) return;
  verificationStarted = true;
  let verificationFailure = "MEDIA_RANGE_VERIFICATION_FAILED";
  try {
    const url = new URL(media?.url);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      media.trim_enabled !== false ||
      !Number.isFinite(media.duration_seconds) ||
      Math.abs(media.duration_seconds - duration) > 0.5
    )
      throw new Error("MEDIA_INVALID");
    const response = await fetch(url, {
      headers: { Origin: origin, Range: "bytes=0-1023" },
      signal: AbortSignal.timeout(5_000),
    });
    const bytes = (await response.arrayBuffer()).byteLength;
    if (
      response.status !== 206 ||
      bytes !== 1024 ||
      response.headers.get("content-type") !== "audio/mpeg" ||
      !/^bytes 0-1023\/\d+$/.test(response.headers.get("content-range") ?? "")
    )
      throw new Error("RANGE_FAILED");
    mediaProof = {
      range_status: response.status,
      range_bytes: bytes,
      duration_seconds: media.duration_seconds,
      trim_enabled: false,
    };
    if (appResources) {
      verificationFailure = "DIAGNOSTIC_IDENTITY_VERIFICATION_FAILED";
      const modelDigest =
        "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";
      const auditPath = join(appResources, "bundle-audit.json");
      const auditInfo = await lstat(auditPath);
      if (
        !auditInfo.isFile() ||
        auditInfo.isSymbolicLink() ||
        auditInfo.nlink !== 1 ||
        auditInfo.uid !== process.getuid() ||
        (auditInfo.mode & 0o022) !== 0 ||
        auditInfo.size > 8 * 1024 * 1024
      )
        throw new Error("DIAGNOSTIC_IDENTITY_INVALID");
      const auditDigest = createHash("sha256")
        .update(await readFile(auditPath))
        .digest("hex");
      const eventsPath = join(output, "logs/events.jsonl");
      const eventsInfo = await lstat(eventsPath);
      if (
        !eventsInfo.isFile() ||
        eventsInfo.isSymbolicLink() ||
        eventsInfo.nlink !== 1 ||
        eventsInfo.uid !== process.getuid() ||
        (eventsInfo.mode & 0o077) !== 0 ||
        eventsInfo.size > 5 * 1024 * 1024
      )
        throw new Error("DIAGNOSTIC_IDENTITY_INVALID");
      const records = (await readFile(eventsPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((record) => record.job_id === jobId);
      const verified = records.filter((record) =>
        ["local_pipeline_completed", "job_ready"].includes(record.event),
      );
      const completed = verified.find(
        (record) => record.event === "local_pipeline_completed",
      );
      if (
        !/^[0-9a-f-]{36}$/.test(jobId ?? "") ||
        records.length === 0 ||
        records.some(
          (record) =>
            record.identity?.software_version !== manifest.version ||
            record.identity?.runtime_scope !== "PACKAGED_APP" ||
            record.identity?.expected_model_sha256 !== modelDigest ||
            record.identity?.package_inventory_sha256 !== auditDigest,
        ) ||
        verified.length !== 2 ||
        verified.some(
          (record) => record.verified_model_sha256 !== modelDigest,
        ) ||
        typeof completed?.metrics?.source_audio_track_id_known !== "boolean" ||
        (completed.metrics.source_audio_is_default !== undefined &&
          typeof completed.metrics.source_audio_is_default !== "boolean") ||
        records.some((record) => record.metrics?.cache_hit === true)
      )
        throw new Error("DIAGNOSTIC_IDENTITY_INVALID");
      diagnosticIdentityProof = {
        software_version: manifest.version,
        runtime_scope: "PACKAGED_APP",
        package_inventory_sha256: auditDigest,
        expected_model_sha256: modelDigest,
        verified_model_sha256: modelDigest,
        verified_events: verified.map((record) => record.event),
        source_audio_identity: {
          full_track_id_known: completed.metrics.source_audio_track_id_known,
          ...(completed.metrics.source_audio_is_default === undefined
            ? {}
            : {
                extractor_audio_is_default:
                  completed.metrics.source_audio_is_default,
              }),
          extractor_metadata_only: true,
        },
        package_fingerprint_is_not_full_installed_byte_verification: true,
      };
    }
    await finish(true);
  } catch {
    await finish(false, verificationFailure);
  }
}
child.stdout.on("data", (chunk) => {
  if (done) return;
  buffer = Buffer.concat([buffer, chunk]);
  while (!done && buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (length === 0 || length > 65536) {
      void finish(false, "FRAME_INVALID");
      return;
    }
    if (buffer.length < length + 4) return;
    let reply;
    try {
      reply = JSON.parse(buffer.subarray(4, length + 4).toString());
      if (
        !reply ||
        typeof reply !== "object" ||
        Array.isArray(reply) ||
        reply.protocol_version !== 1 ||
        !["HELLO", "JOB", "ERROR", "REPORT"].includes(reply.type) ||
        (reply.payload !== null &&
          (typeof reply.payload !== "object" ||
            Array.isArray(reply.payload))) ||
        (reply.type !== "JOB" && !reply.payload)
      )
        throw new Error("FRAME_INVALID");
    } catch {
      void finish(false, "FRAME_INVALID");
      return;
    }
    buffer = buffer.subarray(length + 4);
    if (reply.type === "HELLO") {
      if (!reply.payload.ready) {
        void finish(false, reply.payload.error_code);
        return;
      }
      if (startSent) continue;
      startSent = true;
      command("START", {
        video_id: videoId,
        duration_seconds: duration,
        provider: "LOCAL_MACOS",
      });
    } else if (reply.type === "JOB" && reply.payload) {
      const job = reply.payload;
      events.push({
        state: job.state,
        stage: job.stage,
        elapsed_ms: Date.now() - start,
      });
      if (job.state === "READY") void verifyReadyMedia(job.media, job.job_id);
      if (job.state === "FAILED" || job.state === "CANCELLED")
        void finish(false, job.error_code);
    } else if (reply.type === "ERROR")
      void finish(false, reply.payload.error_code);
  }
});
child.stderr.on("data", (chunk) => {
  stderrBytes += chunk.length;
  if (stderrBytes > 128 * 1024) void finish(false, "TOOL_OUTPUT_LIMIT");
});
child.on("error", () => {
  void finish(false, "COMPANION_UNAVAILABLE");
});
child.stdin.on("error", () => {
  void finish(false, "COMPANION_DISCONNECTED");
});
child.on("exit", () => {
  if (!done) void finish(false, "COMPANION_DISCONNECTED");
});
command("HELLO");

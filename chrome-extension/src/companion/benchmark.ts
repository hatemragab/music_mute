import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { loadLocalConfig, localToolEnvironment } from "./config.js";
import { MODEL_SHA256, runBounded } from "./local-provider.js";
import { Diagnostics } from "./diagnostics.js";
import { resolveDiagnosticIdentity } from "./diagnostic-identity.js";
import { beginSample } from "./resource-monitor.js";
import { parseBenchmarkOptions } from "./benchmark-options.js";

const options = parseBenchmarkOptions(process.argv.slice(2));
const config = await loadLocalConfig();
const identity = resolveDiagnosticIdentity(config);
const jobId = randomUUID();
const outputRoot = resolve(
  import.meta.dirname,
  "../../output/engine-proof",
  jobId,
);
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
const diagnostics = new Diagnostics(join(outputRoot, "logs"), { identity });
const signal = new AbortController().signal;
const env = localToolEnvironment(config, outputRoot);
const started = performance.now();
diagnostics.record({
  component: "harness",
  severity: "info",
  event: "job_started",
  job_id: jobId,
});
const stopSample = beginSample(process.pid, (event) =>
  diagnostics.record({ ...event, job_id: jobId }),
);
let result: Record<string, unknown> | null = null;
let stage = "speech-fixture";
let engineCode: string | undefined;
try {
  const speech = join(outputRoot, "speech.aiff");
  await runBounded(
    "/usr/bin/say",
    [
      "-o",
      speech,
      "MusicMute keeps this spoken sentence in its original position. This is a short local development test with quiet background music.",
    ],
    { signal, timeout_ms: 30_000, env, max_output_bytes: 32_768 },
  );
  const workRoot = join(outputRoot, randomUUID());
  await mkdir(workRoot, { mode: 0o700 });
  const source = join(workRoot, `source.${options.input_format}`);
  stage = "mix-fixture";
  await runBounded(
    config.ffmpeg_path,
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-stream_loop",
      "-1",
      "-i",
      speech,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=220:sample_rate=${options.sample_rate}:duration=${options.duration_seconds}`,
      "-filter_complex",
      "[1:a]volume=0.04[m];[0:a][m]amix=inputs=2:duration=shortest",
      "-t",
      String(options.duration_seconds),
      "-ar",
      String(options.sample_rate),
      "-ac",
      "2",
      ...(options.input_format === "mp3"
        ? ["-c:a", "libmp3lame", "-b:a", "192k"]
        : []),
      source,
    ],
    { signal, timeout_ms: 30_000, env, max_output_bytes: 32_768 },
  );
  stage = "engine";
  await runBounded(
    config.python_path,
    [
      config.runner_path,
      "--input",
      source,
      "--work-root",
      workRoot,
      "--model-cache",
      config.models_root,
      "--ffmpeg",
      config.ffmpeg_path,
      "--ffprobe",
      config.ffprobe_path,
    ],
    {
      signal,
      timeout_ms: Math.max(180_000, options.duration_seconds * 1_000),
      env: localToolEnvironment(config, workRoot),
      max_output_bytes: 512_000,
      on_spawn: (pid) =>
        beginSample(pid, (event) =>
          diagnostics.record({ ...event, job_id: jobId }),
        ),
      on_stdout_line(line) {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "progress" && typeof event.stage === "string")
          diagnostics.record({
            component: "engine",
            severity: "info",
            event: "job_progress",
            job_id: jobId,
            metrics: {
              stage: event.stage,
              elapsed_ms: performance.now() - started,
            },
          });
        else if (
          event.type === "resource" &&
          event.metrics &&
          typeof event.metrics === "object"
        )
          diagnostics.record({
            component: "engine",
            severity: "info",
            event: "resource_sample",
            job_id: jobId,
            metrics: event.metrics as Record<string, number>,
          });
        else if (
          event.type === "result" &&
          event.result &&
          typeof event.result === "object"
        )
          result = event.result as Record<string, unknown>;
        else if (event.type === "error")
          engineCode =
            typeof event.code === "string" ? event.code : "ENGINE_PROOF_FAILED";
      },
    },
  );
  const prepared = result as Record<string, unknown> | null;
  if (
    !prepared ||
    prepared.trimEnabled !== false ||
    prepared.removedSamples !== 0 ||
    prepared.sourceSamples !== prepared.outputSamples ||
    prepared.modelDigest !== MODEL_SHA256 ||
    typeof prepared.sourceDurationSeconds !== "number" ||
    Math.abs(prepared.sourceDurationSeconds - options.duration_seconds) > 0.2 ||
    typeof prepared.measuredOutputDurationSeconds !== "number" ||
    Math.abs(
      prepared.measuredOutputDurationSeconds - prepared.sourceDurationSeconds,
    ) > 0.5
  )
    throw new Error("TIMELINE_PROOF_FAILED");
  const summary = {
    scope:
      options.duration_seconds === 10
        ? "SHORT_SYNTHETIC_SPEECH_PLUS_TONE_MPS"
        : "LONG_SYNTHETIC_SPEECH_PLUS_TONE_MPS",
    fixture: true,
    youtube_network: false,
    ...options,
    runtime_scope: config.app_resources ? "PACKAGED_APP" : "DEVELOPMENT",
    passed: true,
    trim_enabled: false,
    removed_samples: prepared.removedSamples,
    source_samples: prepared.sourceSamples,
    output_samples: prepared.outputSamples,
    source_duration_seconds: prepared.sourceDurationSeconds,
    output_duration_seconds: prepared.measuredOutputDurationSeconds,
    wall_ms: performance.now() - started,
    stage_timings: prepared.stageTimings,
    separation_timings: prepared.separationTimings,
    engine_peak_rss_bytes: prepared.enginePeakRssBytes,
    engine_mps_allocated_bytes_at_end: prepared.engineMpsAllocatedBytes,
    engine_mps_driver_allocated_bytes_at_end:
      prepared.engineMpsDriverAllocatedBytes,
    resource_observations: diagnostics.snapshot().peaks,
  };
  await writeFile(
    join(outputRoot, "result.json"),
    JSON.stringify(summary, null, 2),
    { mode: 0o600 },
  );
  diagnostics.recordVerified(
    {
      component: "harness",
      severity: "info",
      event: "job_ready",
      job_id: jobId,
      metrics: { elapsed_ms: summary.wall_ms },
    },
    MODEL_SHA256,
  );
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
} catch (error) {
  const candidate =
    engineCode ??
    (error && typeof error === "object" && "code" in error
      ? String(error.code)
      : error instanceof Error
        ? error.message
        : "PROCESSING_FAILED");
  const code = /^[A-Z][A-Z_0-9]{2,64}$/.test(candidate)
    ? candidate
    : "PROCESSING_FAILED";
  diagnostics.record({
    component: "harness",
    severity: "error",
    event: "job_failed",
    job_id: jobId,
    code,
    metrics: { stage },
  });
  process.stderr.write(JSON.stringify({ stage, error_code: code }) + "\n");
  process.stderr.write(
    "Local engine proof failed; inspect the local report.\n",
  );
  process.exitCode = 1;
} finally {
  stopSample();
  const report = await diagnostics.export();
  process.stdout.write(
    JSON.stringify({ diagnostics_path: report.path }) + "\n",
  );
  diagnostics.close();
}

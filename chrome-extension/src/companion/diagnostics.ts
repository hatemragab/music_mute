import { randomUUID } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { DiagnosticInput } from "../shared/protocol.js";
import type { AppUiFields } from "./app-journal.js";
import {
  isSha256,
  sanitizeDiagnosticIdentity,
  type DiagnosticIdentity,
} from "./diagnostic-identity.js";

const SEGMENT_BYTES = 5 * 1024 * 1024;
const FILE_COUNT = 4;
const RECENT_LIMIT = 500;
const JOB_LIMIT = 100;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENTS = new Set([
  "companion_started",
  "companion_stopped",
  "job_started",
  "job_progress",
  "stage_started",
  "stage_completed",
  "job_ready",
  "job_failed",
  "job_cancelled",
  "process_started",
  "process_exited",
  "playback_started",
  "playback_stopped",
  "playback_suspended",
  "playback_drift",
  "playback_seek",
  "resource_sample",
  "diagnostic_error",
  "diagnostics_recovered",
  "diagnostic_event_rejected",
  "harness_result",
  "performance_alert",
  "clock_adjusted",
  "cache_hit",
  "cache_miss",
  "cache_evicted",
  "local_pipeline_completed",
  "clock_stale",
  "content_error",
  "content_rejection",
  "offscreen_error",
  "offscreen_rejection",
  "background_error",
  "background_rejection",
]);
const COMPONENTS = new Set(["extension", "companion", "engine", "harness"]);
const SEVERITIES = new Set(["info", "warning", "error"]);
const NUMBER_METRICS = new Set([
  "host_initialization_ms",
  "launcher_ms",
  "duration_ms",
  "elapsed_ms",
  "completed",
  "total",
  "progress_completed",
  "progress_total",
  "drift_ms",
  "generation",
  "rss_bytes",
  "child_rss_bytes",
  "heap_used_bytes",
  "heap_total_bytes",
  "cpu_percent",
  "active_resources",
  "active_jobs",
  "active_processes",
  "active_tabs",
  "cache_bytes",
  "audio_duration_seconds",
  "output_duration_seconds",
  "output_bytes",
  "exit_code",
  "http_status",
  "acquisition_stderr_bytes",
  "pid",
  "sample_interval_ms",
  "growth_bytes",
  "growth_ratio",
  "clock_delta_ms",
  "samples",
  "buffered_seconds",
  "real_time_factor",
  "source_duration_seconds",
  "download_ms",
  "processing_ms",
  "separation_ms",
  "validation_ms",
  "total_ms",
  "metadata_ms",
  "engine_peak_rss_bytes",
  "engine_mps_allocated_bytes",
  "engine_mps_driver_allocated_bytes",
]);
const BOOLEAN_METRICS = new Set([
  "installation_checks",
  "local_engine_warm",
  "cache_hit",
  "trim_enabled",
  "paused",
  "buffering",
  "ad_active",
  "passed",
  "playing",
  "source_audio_track_id_known",
  "source_audio_is_default",
]);
export const LOCAL_JOB_PHASES = [
  "cache_lock",
  "cache_lookup",
  "account_restore",
  "workspace",
  "cache_pin",
  "cache_budget",
  "outbox_admission",
  "provider",
  "validation",
  "publication",
  "playback",
] as const;
export type LocalJobPhase = (typeof LOCAL_JOB_PHASES)[number];
export const FILESYSTEM_ERRNOS = [
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOSPC",
  "EDQUOT",
  "EROFS",
  "EMFILE",
  "ENFILE",
  "EIO",
] as const;
const STAGES = new Set([
  "player_rebound",
  "session_recovered",
  "native_io",
  "native_command",
  "start-to-playback",
  "cloud_processing",
  "cloud_download_validation",
  "shared-cache-lookup",
  "shared-cache-download",
  "shared-cache-validation",
  "shared-original-download",
  "durable-stage",
  "engine-doctor",
  "downloader-version",
  "downloader-help",
  "downloader-ejs",
  "javascript-runtime",
  "token-provider",
  "model-download",
  "runtime-validation",
  "registration",
  "download",
  "downloading",
  "model",
  "model_download",
  "decode",
  "decoding",
  "separation",
  "processing",
  "encode",
  "encoding",
  "validation",
  "validating",
  "ready",
  "playback",
  "content",
  "background",
  "offscreen",
  "popup",
  "setup",
  "cache",
  "cleanup",
  "cancelled",
  "failed",
  "metadata",
  "input-validation",
  "model-load",
  "preparation",
  "output-validation",
  "output-ready",
  "cache-lookup",
  "cache-validation",
  "account_cache_restore",
  "account_cache_restore_complete",
  "media-grant",
  // Qualified immutable pipeline timing keys. Never accept arbitrary prefixes.
  "total",
  "engine_modelValidation",
  "engine_inputIdentity",
  "engine_mediaValidation",
  "engine_preparation",
  "engine_modelLoad",
  "engine_separation",
  "engine_encode",
  "engine_outputValidation",
  "separator_separationMixPreparation",
  "separator_separationPrimaryDemix",
  "separator_separationMatchMix",
  "separator_separationWavWrite",
  "separator_separationCleanup",
]);
const STRING_METRICS: Record<string, Set<string>> = {
  exception_kind: new Set([
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "ReferenceError",
    "other",
  ]),
  native_command: new Set([
    "none",
    "HELLO",
    "START",
    "CANCEL",
    "STATUS",
    "EVENT",
    "DIAGNOSTICS",
    "CLEAR_CACHE",
    "CHECK",
    "PLAYBACK_STARTED",
  ]),
  stage: STAGES,
  cache_origin: new Set(["local", "shared", "pending", "cloud", "processed"]),
  local_job_phase: new Set(LOCAL_JOB_PHASES),
  filesystem_errno: new Set(FILESYSTEM_ERRNOS),
  acquisition_stage: new Set(["metadata", "download"]),
  acquisition_stderr_kind: new Set([
    "empty",
    "terminal_error",
    "python_traceback",
    "unclassified",
  ]),
  acquisition_block_reason: new Set([
    "SOURCE_BOT_CHALLENGE",
    "ACQUISITION_RATE_LIMITED",
    "ACQUISITION_INTERRUPTED",
  ]),
  refusal_code: new Set(["SOURCE_BOT_CHALLENGE", "ACQUISITION_RATE_LIMITED"]),
  provider: new Set(["LOCAL_MACOS", "LOCAL_WINDOWS", "ONLINE_MUSICMUTE"]),
  error_origin: new Set([
    "download",
    "separation",
    "decode",
    "sync",
    "native",
    "storage",
    "setup",
  ]),
  resource_scope: new Set(["companion", "child"]),
  model_id: new Set([
    "Kim_Vocal_2",
    "Kim_Vocal_2.onnx",
    "kim-vocals-v2-trim",
    "kim-vocals-v2",
  ]),
};
const ALERT_CODES = new Set([
  "PLAYBACK_DRIFT_SUSTAINED",
  "JOB_STALLED",
  "JOB_LONG_RUNNING",
  "RESOURCE_RSS_GROWTH",
  "RESOURCE_COUNT_HIGH",
  "CLOCK_ADJUSTED",
  "DIAGNOSTICS_UNAVAILABLE",
  "DIAGNOSTIC_HISTORY_RECOVERED",
]);
const CODES = new Set([
  "INSTALLATION_CHECK_BUSY",
  "INSTALLATION_CHECK_FAILED",
  // Fixed filesystem codes identify write failures without retaining paths or messages.
  ...FILESYSTEM_ERRNOS,
  "YT_DLP_EJS_MISSING",
  "YT_DLP_IDENTITY_INVALID",
  "MODEL_CACHE_INVALID",
  "MODEL_DOWNLOAD_FAILED",
  "MODEL_DOWNLOAD_TIMEOUT",
  "MODEL_CHECKSUM_INVALID",
  "MODEL_SOURCE_INVALID",
  "MODEL_REDIRECT_INVALID",
  "MODEL_SIZE_INVALID",
  "APP_RUNTIME_MISSING",
  "APP_RESOURCES_MISSING",
  "APP_COMMAND_FAILED",
  "FOREIGN_NATIVE_REGISTRATION_EXISTS",
  "FOREIGN_NATIVE_LAUNCHER_EXISTS",
  "SETUP_BUSY",
  "CLI_OPTION_UNSUPPORTED",
  ...ALERT_CODES,
  "UNKNOWN_ERROR",
  "DEV_RUNTIME_INCOMPLETE",
  "DEV_RUNTIME_MISSING",
  "ENGINE_DOCTOR_INVALID",
  "ENGINE_MISSING",
  "ENGINE_NOT_READY",
  "INVALID_LOCAL_CONFIG",
  "LOCAL_DIRECTORY_NOT_PRIVATE",
  "UNSUPPORTED_PLATFORM",
  "YT_DLP_MISSING",
  "YT_DLP_VERSION_INVALID",
  "CANCELLED",
  "DISK_SPACE_LOW",
  "LOCAL_COMPANION_BUSY",
  "LOCAL_COMPANION_LOCK_UNSAFE",
  "LOCAL_COMPANION_START_FAILED",
  "LOCAL_SYNC_STAGING_FAILED",
  "LOCAL_SYNC_RECOVERY_FAILED",
  "LOCAL_SYNC_FAILED",
  "LOCAL_SYNC_EXPIRED",
  "CATALOG_SAVE_FAILED",
  "CATALOG_AUDIO_INVALID",
  "CATALOG_FULL",
  "PROVIDER_LIMIT_INVALID",
  "ACCOUNT_STATE_UNSAFE",
  "ACCOUNT_STATE_INVALID",
  "ACCOUNT_STATE_CHANGED",
  "ACCOUNT_STATE_CLOSED",
  "FILE_INPUT_INVALID",
  "FILE_STAGING_FULL",
  "FILE_STAGING_UNSAFE",
  "FILE_TYPE_UNSUPPORTED",
  "UPLOAD_UNAVAILABLE",
  "OFFLINE_CACHE_FULL",
  "SOURCE_IDENTITY_INVALID",
  "SOURCE_AUDIO_INVALID",
  "ORIGINAL_DECLARATION_INVALID",
  "CAPTURE_SOURCE_UNAVAILABLE",
  "CAPTURE_SOURCE_CHANGED",
  "CAPTURE_FAILED",
  "CAPTURE_UNSAFE",
  "CAPTURE_FULL",
  "CAPTURE_BUSY",
  "CAPTURE_TICKET_MISSING",
  "CAPTURE_STALE_ATTEMPT",
  "CAPTURE_RECORD_INVALID",
  "CAPTURE_ACCOUNT_INVALID",
  "CAPTURE_ALREADY_FINISHED",
  "CAPTURE_CACHE_MISSING",
  "CAPTURE_INTERRUPTED",
  "CAPTURE_PREPARE_FAILED",
  "CAPTURE_RECOVERY_REQUIRED",
  "CAPTURE_REQUEST_CONFLICT",
  "CAPTURE_SOURCE_LIMIT",
  "OUTBOX_FULL",
  "OUTBOX_BUSY",
  "OUTBOX_ARTIFACT_INVALID",
  "OUTBOX_RECOVERY_INVALID",
  "OUTBOX_STALE_ATTEMPT",
  "ACCOUNT_CHANGED",
  "API_UNAVAILABLE",
  "UPLOAD_REJECTED",
  "ENGINE_UNAVAILABLE",
  "ENGINE_SOCKET_UNSAFE",
  "ENGINE_PROTOCOL_INVALID",
  "PROCESSING_FAILED",
  "PROVIDER_NOT_AVAILABLE",
  "STALE_JOB",
  "TIMELINE_MISMATCH",
  "UNSUPPORTED_VIDEO",
  "DOWNLOAD_INVALID",
  "DOWNLOAD_LIMIT_EXCEEDED",
  "DURATION_LIMIT_EXCEEDED",
  "ENGINE_PROTOCOL_INVALID",
  "INVALID_REQUEST",
  "INVALID_WORK_ROOT",
  "LIVE_NOT_SUPPORTED",
  "OUTPUT_CHECKSUM_MISMATCH",
  "OUTPUT_DURATION_MISMATCH",
  "OUTPUT_INVALID",
  "SOURCE_AUDIO_FORMAT_INVALID",
  "SOURCE_AUDIO_TRACK_UNVERIFIED",
  "SOURCE_AUDIO_TRACK_UNSUPPORTED",
  "SOURCE_AUDIO_TRACK_MISMATCH",
  "SOURCE_DURATION_INVALID",
  "SOURCE_DURATION_MISMATCH",
  "SOURCE_IDENTITY_MISMATCH",
  "SOURCE_METADATA_INVALID",
  "TIMELINE_NOT_PRESERVED",
  "TOOL_FAILED",
  "TOOL_OUTPUT_LIMIT",
  "TOOL_INPUT_LIMIT",
  "TOOL_TIMEOUT",
  "READINESS_PROBE_FAILED",
  "DENO_MISSING",
  "DENO_VERSION_INVALID",
  "PO_TOKEN_PROVIDER_MISSING",
  "PO_TOKEN_PROVIDER_INVALID",
  "PO_TOKEN_PROVIDER_UNAVAILABLE",
  "APP_UPDATE_REQUIRED",
  "CLOUD_HANDOFF_FAILED",
  "TOOL_UNAVAILABLE",
  "MEDIA_FORBIDDEN",
  "MEDIA_SERVER_FAILED",
  "MEDIA_UNAVAILABLE",
  "METHOD_NOT_ALLOWED",
  "ORIGIN_FORBIDDEN",
  "RANGE_NOT_SATISFIABLE",
  "FRAME_INVALID",
  "FRAME_TOO_LARGE",
  "FRAME_TRUNCATED",
  "INVALID_COMMAND",
  "AUDIO_CONTEXT_LOST",
  "AUDIO_LOAD_FAILED",
  "AUDIO_NETWORK_FAILED",
  "AUDIO_SOURCE_REJECTED",
  "OFFSCREEN_CREATION_FAILED",
  "OFFSCREEN_MESSAGE_FAILED",
  "CACHE_UNSAFE",
  "CACHE_MISS",
  "PROCESS_IDENTITY_UNAVAILABLE",
  "ACCOUNT_RESTORE_UNSAFE",
  "ACCOUNT_RESTORE_FULL",
  "ACCOUNT_RESTORE_CONFLICT",
  "ACCOUNT_RESTORE_UNAVAILABLE",
  "SOURCE_AUTH_REQUIRED",
  "SOURCE_BOT_CHALLENGE",
  "SOURCE_AGE_RESTRICTED",
  "SOURCE_ACCESS_RESTRICTED",
  "SOURCE_TOKEN_REQUIRED",
  "SOURCE_HTTP_UNAUTHORIZED",
  "SOURCE_HTTP_FORBIDDEN",
  "SOURCE_TRANSFER_INCOMPLETE",
  "SOURCE_TRANSFER_EMPTY",
  "SOURCE_TLS_FAILED",
  "SOURCE_POSTPROCESSING_FAILED",
  "ACQUISITION_STORAGE_FAILED",
  "DOWNLOADER_ARGUMENTS_INVALID",
  "DOWNLOADER_ISOLATION_REQUIRED",
  "SOURCE_UNAVAILABLE",
  "ACQUISITION_NETWORK_FAILED",
  "ACQUISITION_RATE_LIMITED",
  "ACQUISITION_COOLDOWN",
  "ACQUISITION_BUSY",
  "ACQUISITION_STATE_INVALID",
  "SOURCE_AUDIO_FORMAT_UNAVAILABLE",
  "SOURCE_CHALLENGE_FAILED",
  "BACKGROUND_UNCAUGHT_ERROR",
  "BACKGROUND_UNHANDLED_REJECTION",
  "COMPANION_DISCONNECTED",
  "COMPANION_NOT_READY",
  "COMPANION_TIMEOUT",
  "COMPANION_UNAVAILABLE",
  "EXTENSION_OPERATION_FAILED",
  "SESSION_STOPPED",
  "PLAYBACK_SESSION_LOST",
  "PLAYBACK_PAGE_LOST",
  "PLAYBACK_SOURCE_CHANGED",
  "PLAYBACK_NAVIGATION",
  "PLAYBACK_USER_STOP",
  "PLAYBACK_REPLACED",
  "UNCAUGHT_ERROR",
  "UNHANDLED_REJECTION",
  "AUDIO_BUFFER_UNDERRUN",
  "AUDIO_DECODE_FAILED",
  "AUDIO_DURATION_MISMATCH",
  "AUDIO_LOAD_TIMEOUT",
  "AUDIO_PLAYBACK_BLOCKED",
  "INVALID_MEDIA_SOURCE",
  "PLAYBACK_CLOCK_STALE",
  "RESOURCE_SAMPLE_UNAVAILABLE",
  "MEMORY_LOW",
  "COMPANION_CRASH",
  "NATIVE_PIPE_CLOSED",
  "NATIVE_PIPE_FAILED",
  "COMPANION_REJECTION",
  "COMMAND_FAILED",
  "SETUP_REQUIRED",
]);
const TERMINAL = new Set([
  "job_ready",
  "job_failed",
  "job_cancelled",
  "companion_stopped",
]);
const VERIFIED_EVENTS = new Set([
  "local_pipeline_completed",
  "job_ready",
  "cache_hit",
]);

function acceptsVerification(input: DiagnosticInput): boolean {
  return (
    ["companion", "engine", "harness"].includes(input.component) &&
    input.severity === "info" &&
    VERIFIED_EVENTS.has(input.event)
  );
}

export interface DiagnosticRecord extends DiagnosticInput {
  schema_version: 1;
  session_id: string;
  sequence: number;
  recorded_at: string;
  monotonic_ms: number;
  identity?: DiagnosticIdentity;
  verified_model_sha256?: string;
}
export interface JobDiagnosticSummary {
  job_id: string;
  state: "active" | "ready" | "failed" | "cancelled";
  first_at: string;
  last_at: string;
  elapsed_ms: number | null;
  stages_ms: Record<string, number>;
  peaks: Record<string, number>;
  error_codes: string[];
  warnings: number;
  incomplete: boolean;
}
export interface DiagnosticReport {
  schema_version: 1;
  identity?: DiagnosticIdentity;
  session_id: string;
  created_at: string;
  availability: "available" | "diagnostics_unavailable" | "closed";
  failure_code: string | null;
  privacy: "local_only_allowlisted_no_media_credentials_urls_or_paths";
  coverage: {
    first_sequence: number | null;
    last_sequence: number | null;
    earliest_at: string | null;
    latest_at: string | null;
    incomplete_history: boolean;
    malformed_records: number;
    recovered_tail_bytes: number;
    rejected_fields: number;
    failed_writes: number;
    retained_bytes: number;
    max_log_bytes: number;
    recent_events_truncated: boolean;
    job_summaries_truncated: boolean;
    alerts_are_observations_not_proof_of_leaks: true;
    snapshot_is_summary: boolean;
    full_report_available_in_export: boolean;
    read_only: boolean;
    unmeasured: string[];
  };
  counts: Record<string, number>;
  peaks: Record<string, number>;
  jobs: JobDiagnosticSummary[];
  recent_errors: DiagnosticRecord[];
  recent_warnings: DiagnosticRecord[];
  recent_events: DiagnosticRecord[];
}
export interface DiagnosticsOptions {
  /** Native recorder identity, resolved once by the process entry point. */
  identity?: DiagnosticIdentity;
  /** CLI inspections can coexist with the native host's single writer. */
  readOnly?: boolean;
  /** Smaller quotas and deterministic clocks are useful in fixture tests. */
  segmentBytes?: number;
  now?: () => number;
  monotonic?: () => number;
}
interface JobState {
  summary: JobDiagnosticSummary;
  session: string;
  started: number;
  progressAt: number;
  progressValue: number | undefined;
  stage: string | undefined;
  stageAt: number;
  longAlerted: boolean;
  stalledAlerted: boolean;
}

/** Bounded, private local evidence. Callers never pass raw stderr, errors or URLs. */
export class Diagnostics {
  private readonly root: string;
  private readonly sessionId = randomUUID();
  private readonly segmentBytes: number;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly started: number;
  private readonly readOnly: boolean;
  private readonly identity: DiagnosticIdentity | undefined;
  private fd: number | null = null;
  private bytes = 0;
  private nextSequence = 1;
  private available = true;
  private closed = false;
  private failureCode: string | null = null;
  private malformed = 0;
  private recoveredTail = 0;
  private rejectedFields = 0;
  private failedWrites = 0;
  private incomplete = false;
  private recentTruncated = false;
  private jobsTruncated = false;
  private lastSync = 0;
  private lastClock: { wall: number; monotonic: number } | null = null;
  private events: DiagnosticRecord[] = [];
  private errors: DiagnosticRecord[] = [];
  private warnings: DiagnosticRecord[] = [];
  private counts: Record<string, number> = {};
  private peaks: Record<string, number> = {};
  private jobs = new Map<string, JobState>();
  private drift = new Map<
    string,
    { start: number; last: number; samples: number; alerted: boolean }
  >();
  private resources = new Map<
    string,
    { start: number; rss: number; samples: number; alerted: boolean }
  >();

  constructor(logsRoot: string, options: DiagnosticsOptions = {}) {
    this.root = resolve(logsRoot);
    this.readOnly = options.readOnly === true;
    this.identity = sanitizeDiagnosticIdentity(options.identity);
    if (options.identity !== undefined && !this.identity) {
      this.rejectedFields++;
      this.incomplete = true;
    }
    this.segmentBytes = options.segmentBytes ?? SEGMENT_BYTES;
    if (
      !Number.isSafeInteger(this.segmentBytes) ||
      this.segmentBytes < 512 ||
      this.segmentBytes > SEGMENT_BYTES
    )
      throw new TypeError("INVALID_DIAGNOSTICS_QUOTA");
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.started = this.monotonic();
    try {
      if (this.readOnly) assertPrivateDirectory(this.root);
      else privateDirectory(this.root);
      this.recover();
      if (!this.readOnly) {
        this.fd = privateFile(
          this.path(0),
          constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY,
        );
        this.bytes = fstatSync(this.fd).size;
      }
    } catch {
      this.unavailable("DIAGNOSTICS_UNAVAILABLE");
    }
    if (!this.readOnly && (this.recoveredTail || this.malformed))
      this.record({
        component: "companion",
        severity: "warning",
        event: "diagnostics_recovered",
        code: "DIAGNOSTIC_HISTORY_RECOVERED",
      });
  }

  record(input: DiagnosticInput): void {
    this.recordTrusted(input);
  }

  /** Internal native callers invoke this only after successful model/result validation. */
  recordVerified(input: DiagnosticInput, verifiedModelSha256: string): void {
    if (this.closed || this.readOnly) return;
    const verified =
      acceptsVerification(input) && isSha256(verifiedModelSha256)
        ? verifiedModelSha256
        : undefined;
    if (verified === undefined) this.rejectedFields++;
    this.recordTrusted(input, verified);
  }

  private recordTrusted(input: DiagnosticInput, verified?: string): void {
    if (this.closed || this.readOnly) return;
    const safe = this.sanitize(input);
    const wall = this.now();
    const monotonic = Math.max(0, this.monotonic() - this.started);
    this.store(safe, wall, monotonic, verified);
    if (this.lastClock) {
      const delta =
        wall - this.lastClock.wall - (monotonic - this.lastClock.monotonic);
      if (Math.abs(delta) >= 5_000)
        this.store(
          {
            component: "companion",
            severity: "warning",
            event: "clock_adjusted",
            code: "CLOCK_ADJUSTED",
            metrics: { clock_delta_ms: delta },
          },
          wall,
          monotonic,
        );
    }
    this.lastClock = { wall, monotonic };
    this.observe(safe, wall, monotonic);
  }

  snapshot(): DiagnosticReport {
    return this.report(false);
  }

  private report(full: boolean): DiagnosticReport {
    const first = this.events[0];
    const last = this.events.at(-1);
    let retained = 0;
    for (let index = 0; index < FILE_COUNT; index++) {
      try {
        const info = lstatSync(this.path(index));
        if (info.isFile() && !info.isSymbolicLink()) retained += info.size;
      } catch {
        /* Missing generations are normal. */
      }
    }
    const report: DiagnosticReport = structuredClone({
      schema_version: 1,
      ...(this.identity ? { identity: this.identity } : {}),
      session_id: this.sessionId,
      created_at: new Date(this.now()).toISOString(),
      availability: !this.available
        ? "diagnostics_unavailable"
        : this.closed
          ? "closed"
          : "available",
      failure_code: this.failureCode,
      privacy: "local_only_allowlisted_no_media_credentials_urls_or_paths",
      coverage: {
        first_sequence: first?.sequence ?? null,
        last_sequence: last?.sequence ?? null,
        earliest_at: first?.recorded_at ?? null,
        latest_at: last?.recorded_at ?? null,
        incomplete_history:
          this.incomplete ||
          this.recentTruncated ||
          this.jobsTruncated ||
          !this.available,
        malformed_records: this.malformed,
        recovered_tail_bytes: this.recoveredTail,
        rejected_fields: this.rejectedFields,
        failed_writes: this.failedWrites,
        retained_bytes: retained,
        max_log_bytes: this.segmentBytes * FILE_COUNT,
        recent_events_truncated: this.recentTruncated,
        job_summaries_truncated: this.jobsTruncated,
        alerts_are_observations_not_proof_of_leaks: true,
        snapshot_is_summary: !full,
        full_report_available_in_export: !full,
        read_only: this.readOnly,
        unmeasured: [
          "unsampled_processes",
          "gpu_memory",
          "audio_quality",
          "browser_frame_memory",
          "operating_system_audio_latency",
          "events_before_retained_history",
        ],
      },
      counts: this.counts,
      peaks: this.peaks,
      jobs: [...this.jobs.values()].map((job) => job.summary),
      recent_errors: this.errors,
      recent_warnings: this.warnings,
      recent_events: this.events,
    });
    if (!full) {
      report.recent_events = report.recent_events.slice(-10);
      report.recent_errors = report.recent_errors.slice(-8);
      report.recent_warnings = report.recent_warnings.slice(-8);
      report.jobs = report.jobs.slice(-10);
      report.coverage.recent_events_truncated ||=
        this.events.length > report.recent_events.length;
      report.coverage.job_summaries_truncated ||=
        this.jobs.size > report.jobs.length;
      while (Buffer.byteLength(JSON.stringify(report)) > 24 * 1024) {
        if (report.recent_events.length) {
          report.recent_events.shift();
          report.coverage.recent_events_truncated = true;
        } else if (report.jobs.length) {
          report.jobs.shift();
          report.coverage.job_summaries_truncated = true;
        } else if (report.recent_warnings.length)
          report.recent_warnings.shift();
        else if (report.recent_errors.length) report.recent_errors.shift();
        else break;
      }
      report.coverage.incomplete_history ||=
        report.coverage.recent_events_truncated ||
        report.coverage.job_summaries_truncated;
    }
    return report;
  }

  async export(
    appUi?: AppUiFields & {
      app_setup_diagnostics?: DiagnosticReport;
      app_desktop_diagnostics?: DiagnosticReport;
    },
  ): Promise<{ path: string; report: DiagnosticReport }> {
    const report = { ...this.report(true), ...appUi };
    try {
      if (this.fd !== null) fsyncSync(this.fd);
      const exportsRoot = join(this.root, "exports");
      privateDirectory(exportsRoot);
      const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
      if (bytes.length > SEGMENT_BYTES)
        throw new Error("DIAGNOSTICS_EXPORT_TOO_LARGE");
      const previous = readdirSync(exportsRoot)
        .filter((name) => /^diagnostics-[0-9a-f-]{36}\.json$/.test(name))
        .map((name) => {
          const path = join(exportsRoot, name);
          if (!existsSafeFile(path)) throw new Error("UNSAFE_DIAGNOSTICS_FILE");
          return { path, created: lstatSync(path).mtimeMs };
        })
        .sort((a, b) => a.created - b.created);
      for (const old of previous.slice(0, Math.max(0, previous.length - 3)))
        unlinkSync(old.path);
      // Never accept arbitrary destinations or overwrite an existing export.
      const path = join(exportsRoot, `diagnostics-${randomUUID()}.json`);
      const fd = privateFile(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      );
      try {
        writeAll(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return { path, report };
    } catch {
      this.unavailable("DIAGNOSTICS_EXPORT_FAILED");
      throw new Error("DIAGNOSTICS_EXPORT_FAILED");
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.fd !== null) {
      try {
        fsyncSync(this.fd);
      } catch {
        this.unavailable("DIAGNOSTICS_UNAVAILABLE");
      }
      // Still release the descriptor if flushing failed (for example, disk full).
      try {
        closeSync(this.fd);
      } catch {
        this.unavailable("DIAGNOSTICS_UNAVAILABLE");
      }
    }
    this.fd = null;
    this.closed = true;
  }

  private path(index: number): string {
    return join(
      this.root,
      index === 0 ? "events.jsonl" : `events.${index}.jsonl`,
    );
  }

  private sanitize(input: DiagnosticInput, persisted = false): DiagnosticInput {
    const source =
      input && typeof input === "object"
        ? (input as DiagnosticInput)
        : ({} as DiagnosticInput);
    const event = EVENTS.has(source.event)
      ? source.event
      : "diagnostic_event_rejected";
    const safe: DiagnosticInput = {
      component: COMPONENTS.has(source.component)
        ? source.component
        : "companion",
      severity: SEVERITIES.has(source.severity) ? source.severity : "warning",
      event,
    };
    if (!persisted)
      for (const key of ["identity", "verified_model_sha256"])
        if (key in source) this.rejectedFields++;
    if (event !== source.event) this.rejectedFields++;
    for (const key of ["job_id", "request_id"] as const) {
      const value = source[key];
      if (typeof value === "string" && UUID.test(value))
        safe[key] = value.toLowerCase();
      else if (value !== undefined) this.rejectedFields++;
    }
    if (typeof source.code === "string" && CODES.has(source.code))
      safe.code = source.code;
    else if (source.code !== undefined) {
      safe.code = "UNKNOWN_ERROR";
      this.rejectedFields++;
    }
    const metrics: Record<string, number | boolean | string> = {};
    if (source.metrics && typeof source.metrics === "object") {
      for (const [key, value] of Object.entries(source.metrics).slice(0, 64)) {
        if (
          NUMBER_METRICS.has(key) &&
          typeof value === "number" &&
          Number.isFinite(value) &&
          Math.abs(value) <= Number.MAX_SAFE_INTEGER &&
          (key !== "http_status" ||
            (Number.isInteger(value) && value >= 400 && value <= 599)) &&
          (key !== "acquisition_stderr_bytes" ||
            (Number.isInteger(value) && value >= 0 && value <= 131072))
        )
          metrics[key] = value;
        else if (BOOLEAN_METRICS.has(key) && typeof value === "boolean")
          metrics[key] = value;
        else if (
          STRING_METRICS[key]?.has(String(value)) &&
          typeof value === "string"
        )
          metrics[key] = value;
        else this.rejectedFields++;
      }
    }
    if (event === "job_cancelled") {
      delete metrics.local_job_phase;
      delete metrics.filesystem_errno;
    } else if (
      metrics.local_job_phase === "provider" ||
      metrics.error_origin === "download"
    ) {
      delete metrics.filesystem_errno;
    }
    if (Object.keys(metrics).length) safe.metrics = metrics;
    return safe;
  }

  private store(
    input: DiagnosticInput,
    wall: number,
    monotonic: number,
    verified?: string,
  ): void {
    const record: DiagnosticRecord = {
      ...input,
      schema_version: 1,
      session_id: this.sessionId,
      sequence: this.nextSequence++,
      recorded_at: new Date(wall).toISOString(),
      monotonic_ms: Math.round(monotonic),
      ...(this.identity ? { identity: this.identity } : {}),
      ...(verified ? { verified_model_sha256: verified } : {}),
    };
    this.ingest(record);
    if (!this.available || this.fd === null) return;
    try {
      const buffer = Buffer.from(`${JSON.stringify(record)}\n`);
      if (buffer.length > this.segmentBytes) {
        this.rejectedFields++;
        this.incomplete = true;
        return;
      }
      if (this.bytes + buffer.length > this.segmentBytes) this.rotate();
      if (this.fd === null) throw new Error("DIAGNOSTICS_UNAVAILABLE");
      writeAll(this.fd, buffer);
      this.bytes += buffer.length;
      if (
        TERMINAL.has(record.event) ||
        record.severity === "error" ||
        monotonic - this.lastSync >= 5_000
      ) {
        fsyncSync(this.fd);
        this.lastSync = monotonic;
      }
    } catch {
      this.failedWrites++;
      this.unavailable("DIAGNOSTICS_UNAVAILABLE");
    }
  }

  private ingest(record: DiagnosticRecord): void {
    this.events.push(record);
    if (this.events.length > RECENT_LIMIT) {
      this.events.shift();
      this.recentTruncated = true;
    }
    if (record.severity === "error") {
      this.errors.push(record);
      if (this.errors.length > 50) this.errors.shift();
    }
    if (record.severity === "warning") {
      this.warnings.push(record);
      if (this.warnings.length > 50) this.warnings.shift();
    }
    this.counts[record.event] = (this.counts[record.event] ?? 0) + 1;
    for (const [key, value] of Object.entries(record.metrics ?? {}))
      if (
        typeof value === "number" &&
        key !== "pid" &&
        key !== "exit_code" &&
        key !== "http_status" &&
        key !== "clock_delta_ms"
      )
        this.peaks[key] = Math.max(
          this.peaks[key] ?? -Infinity,
          Math.abs(value),
        );
    if (!record.job_id) return;
    let job = this.jobs.get(record.job_id);
    if (!job) {
      if (this.jobs.size >= JOB_LIMIT) {
        const oldest = this.jobs.keys().next().value;
        if (oldest) this.jobs.delete(oldest);
        this.jobsTruncated = true;
      }
      job = {
        summary: {
          job_id: record.job_id,
          state: "active",
          first_at: record.recorded_at,
          last_at: record.recorded_at,
          elapsed_ms: null,
          stages_ms: {},
          peaks: {},
          error_codes: [],
          warnings: 0,
          incomplete: record.event !== "job_started",
        },
        session: record.session_id,
        started: record.monotonic_ms,
        progressAt: record.monotonic_ms,
        progressValue: undefined,
        stage: undefined,
        stageAt: record.monotonic_ms,
        longAlerted: false,
        stalledAlerted: false,
      };
      this.jobs.set(record.job_id, job);
    }
    const sameClock = job.session === record.session_id;
    if (!sameClock) job.summary.incomplete = true;
    job.summary.last_at = record.recorded_at;
    if (job.summary.state === "active")
      job.summary.elapsed_ms = sameClock
        ? Math.max(0, record.monotonic_ms - job.started)
        : null;
    if (record.severity === "warning") job.summary.warnings++;
    if (
      record.severity === "error" &&
      record.code &&
      !job.summary.error_codes.includes(record.code) &&
      job.summary.error_codes.length < 20
    )
      job.summary.error_codes.push(record.code);
    for (const [key, value] of Object.entries(record.metrics ?? {}))
      if (typeof value === "number" && key !== "pid" && key !== "http_status")
        job.summary.peaks[key] = Math.max(
          job.summary.peaks[key] ?? -Infinity,
          Math.abs(value),
        );
    const stage =
      typeof record.metrics?.stage === "string"
        ? record.metrics.stage
        : undefined;
    if (
      record.event === "stage_completed" &&
      stage &&
      typeof record.metrics?.duration_ms === "number"
    )
      job.summary.stages_ms[stage] = Math.max(0, record.metrics.duration_ms);
    if (
      stage &&
      stage !== job.stage &&
      job.summary.state === "active" &&
      record.event !== "stage_completed"
    ) {
      if (job.stage && sameClock)
        job.summary.stages_ms[job.stage] =
          (job.summary.stages_ms[job.stage] ?? 0) +
          Math.max(0, record.monotonic_ms - job.stageAt);
      job.stage = stage;
      job.stageAt = record.monotonic_ms;
      job.progressAt = record.monotonic_ms;
      job.stalledAlerted = false;
    }
    const progress =
      record.metrics?.completed ?? record.metrics?.progress_completed;
    if (typeof progress === "number" && progress !== job.progressValue) {
      job.progressValue = progress;
      job.progressAt = record.monotonic_ms;
      job.stalledAlerted = false;
    }
    if (TERMINAL.has(record.event)) {
      if (job.stage && sameClock)
        job.summary.stages_ms[job.stage] =
          (job.summary.stages_ms[job.stage] ?? 0) +
          Math.max(0, record.monotonic_ms - job.stageAt);
      job.stage = undefined;
      job.summary.state =
        record.event === "job_ready"
          ? "ready"
          : record.event === "job_cancelled"
            ? "cancelled"
            : "failed";
    }
  }

  private observe(
    input: DiagnosticInput,
    wall: number,
    monotonic: number,
  ): void {
    const alert = (
      code: string,
      metrics: Record<string, number | boolean | string>,
    ) => {
      if (!ALERT_CODES.has(code)) return;
      const event: DiagnosticInput = {
        component: input.component,
        severity: "warning",
        event: "performance_alert",
        code,
        metrics,
      };
      if (input.job_id) event.job_id = input.job_id;
      this.store(event, wall, monotonic);
    };
    const job = input.job_id ? this.jobs.get(input.job_id) : undefined;
    if (
      job &&
      job.summary.state === "active" &&
      job.session === this.sessionId
    ) {
      if (!job.longAlerted && monotonic - job.started >= 300_000) {
        job.longAlerted = true;
        alert("JOB_LONG_RUNNING", { elapsed_ms: monotonic - job.started });
      }
      // No progress observation can indicate a stall, but is not proof of a deadlock.
      if (!job.stalledAlerted && monotonic - job.progressAt >= 120_000) {
        job.stalledAlerted = true;
        alert("JOB_STALLED", { elapsed_ms: monotonic - job.progressAt });
      }
    }
    const drift = input.metrics?.drift_ms;
    const key = input.job_id ?? this.sessionId;
    if (
      input.event === "playback_stopped" ||
      input.event === "playback_suspended"
    )
      this.drift.delete(key);
    if (typeof drift === "number") {
      const previous = this.drift.get(key);
      if (previous && monotonic - previous.last > 10_000)
        this.drift.delete(key);
      if (Math.abs(drift) < 75) this.drift.delete(key);
      else if (Math.abs(drift) < 150 && !this.drift.get(key)?.alerted)
        this.drift.delete(key);
      else if (Math.abs(drift) >= 150) {
        const state = this.drift.get(key) ?? {
          start: monotonic,
          last: monotonic,
          samples: 0,
          alerted: false,
        };
        state.last = monotonic;
        state.samples++;
        if (
          !state.alerted &&
          state.samples >= 3 &&
          monotonic - state.start >= 2_000
        ) {
          state.alerted = true;
          alert("PLAYBACK_DRIFT_SUSTAINED", {
            drift_ms: drift,
            elapsed_ms: monotonic - state.start,
            samples: state.samples,
          });
        }
        this.drift.set(key, state);
        boundMap(this.drift);
      }
    }
    const rss = input.metrics?.rss_bytes ?? input.metrics?.child_rss_bytes;
    if (
      input.event === "resource_sample" &&
      typeof rss === "number" &&
      rss > 0
    ) {
      const resourceKey = `${key}:${input.metrics?.resource_scope === "child" ? "child" : "companion"}:${typeof input.metrics?.pid === "number" ? input.metrics.pid : 0}`;
      const state = this.resources.get(resourceKey) ?? {
        start: monotonic,
        rss,
        samples: 0,
        alerted: false,
      };
      state.samples++;
      if (
        !state.alerted &&
        state.samples >= 6 &&
        monotonic - state.start >= 30_000 &&
        rss - state.rss >= 256 * 1024 * 1024 &&
        rss / state.rss >= 1.5
      ) {
        state.alerted = true;
        alert("RESOURCE_RSS_GROWTH", {
          growth_bytes: rss - state.rss,
          growth_ratio: rss / state.rss,
          elapsed_ms: monotonic - state.start,
          samples: state.samples,
        });
      }
      this.resources.set(resourceKey, state);
      boundMap(this.resources);
    }
    if (
      typeof input.metrics?.active_resources === "number" &&
      input.metrics.active_resources > 128 &&
      (this.counts["performance_alert"] ?? 0) < 100
    )
      alert("RESOURCE_COUNT_HIGH", {
        active_resources: input.metrics.active_resources,
      });
  }

  private rotate(): void {
    if (this.fd !== null) {
      fsyncSync(this.fd);
      closeSync(this.fd);
      this.fd = null;
    }
    const oldest = this.path(FILE_COUNT - 1);
    if (existsSafeFile(oldest)) {
      unlinkSync(oldest);
      this.incomplete = true;
    }
    for (let index = FILE_COUNT - 2; index >= 0; index--)
      if (existsSafeFile(this.path(index)))
        renameSync(this.path(index), this.path(index + 1));
    this.fd = privateFile(
      this.path(0),
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY,
    );
    this.bytes = 0;
  }

  private recover(): void {
    let expected: number | null = null;
    for (let index = FILE_COUNT - 1; index >= 0; index--) {
      const path = this.path(index);
      if (!existsSafeFile(path)) continue;
      const bytes = readFileSync(path);
      if (bytes.length > this.segmentBytes)
        throw new Error("DIAGNOSTIC_FILE_TOO_LARGE");
      let limit = bytes.lastIndexOf(10) + 1;
      if (limit < bytes.length) {
        this.incomplete = true;
        this.recoveredTail += bytes.length - limit;
        if (index === 0 && !this.readOnly) truncateSync(path, limit);
      }
      for (const line of bytes
        .subarray(0, limit)
        .toString("utf8")
        .split("\n")) {
        if (!line) continue;
        try {
          const raw: unknown = JSON.parse(line);
          if (!validRecord(raw)) throw new Error("INVALID_DIAGNOSTIC_RECORD");
          const safe = this.sanitize(raw, true);
          const identity = sanitizeDiagnosticIdentity(raw.identity);
          if (raw.identity != null) {
            if (!identity) {
              this.rejectedFields++;
              this.incomplete = true;
            } else {
              const omitted = Object.keys(raw.identity).filter(
                (key) =>
                  ![
                    "software_version",
                    "runtime_scope",
                    "expected_model_sha256",
                    "package_inventory_sha256",
                  ].includes(key),
              ).length;
              if (omitted > 0) {
                this.rejectedFields += omitted;
                this.incomplete = true;
              }
            }
          }
          const verified =
            acceptsVerification(raw) && isSha256(raw.verified_model_sha256)
              ? raw.verified_model_sha256
              : undefined;
          if (raw.verified_model_sha256 != null && !verified) {
            this.rejectedFields++;
            this.incomplete = true;
          }
          const record: DiagnosticRecord = {
            ...safe,
            schema_version: 1,
            session_id: raw.session_id,
            sequence: raw.sequence,
            recorded_at: raw.recorded_at,
            monotonic_ms: raw.monotonic_ms,
            ...(identity ? { identity } : {}),
            ...(verified ? { verified_model_sha256: verified } : {}),
          };
          if (
            (expected !== null && record.sequence !== expected) ||
            (expected === null && record.sequence !== 1)
          )
            this.incomplete = true;
          expected = record.sequence + 1;
          this.nextSequence = Math.max(this.nextSequence, expected);
          this.ingest(record);
        } catch {
          this.malformed++;
          this.incomplete = true;
        }
      }
    }
  }

  private unavailable(code: string): void {
    this.available = false;
    this.failureCode = code;
    this.incomplete = true;
  }
}

function validRecord(value: unknown): value is DiagnosticRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<DiagnosticRecord>;
  return (
    record.schema_version === 1 &&
    typeof record.session_id === "string" &&
    UUID.test(record.session_id) &&
    Number.isSafeInteger(record.sequence) &&
    (record.sequence ?? 0) > 0 &&
    typeof record.recorded_at === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.recorded_at) &&
    Number.isFinite(Date.parse(record.recorded_at)) &&
    typeof record.monotonic_ms === "number" &&
    Number.isFinite(record.monotonic_ms) &&
    record.monotonic_ms >= 0
  );
}
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("UNSAFE_DIAGNOSTICS_DIRECTORY");
  chmodSync(path, 0o700);
}
function assertPrivateDirectory(path: string): void {
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("UNSAFE_DIAGNOSTICS_DIRECTORY");
}
function privateFile(path: string, flags: number): number {
  const fd = openSync(path, flags | constants.O_NOFOLLOW, 0o600);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("UNSAFE_DIAGNOSTICS_FILE");
    if ((info.mode & 0o077) !== 0)
      throw new Error("NONPRIVATE_DIAGNOSTICS_FILE");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function existsSafeFile(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("UNSAFE_DIAGNOSTICS_FILE");
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
}
function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("DIAGNOSTICS_WRITE_FAILED");
    offset += written;
  }
}
function boundMap<T>(map: Map<string, T>): void {
  if (map.size > JOB_LIMIT) {
    const first = map.keys().next().value;
    if (first) map.delete(first);
  }
}

import {
  DIAGNOSTIC_SUBSYSTEMS,
  DIAGNOSTIC_UUID,
  type WindowsDiagnosticEvent,
  type WindowsDiagnosticIdentity,
  type WindowsDiagnosticReport,
  type WindowsDiagnosticJob,
} from "../../shared/diagnostics-contracts.js";
const SHA = /^[a-f0-9]{64}$/u;
const EVENTS = [
  "started",
  "progress",
  "completed",
  "failed",
  "cancelled",
  "resource_sample",
  "ui_error",
  "recovered",
  "diagnostic_rejected",
];
const PHASES = [
  "idle",
  "starting",
  "preparing",
  "download",
  "decode",
  "separation",
  "encode",
  "validation",
  "publication",
  "playback",
  "refresh",
  "reconnect",
  "draining",
  "rollback",
  "recovery",
  "stopped",
  "complete",
];
const NUMBERS = [
  "duration_ms",
  "elapsed_ms",
  "completed",
  "total",
  "rss_bytes",
  "child_rss_bytes",
  "heap_used_bytes",
  "active_jobs",
  "active_processes",
  "active_tabs",
  "cache_bytes",
  "output_bytes",
  "audio_duration_seconds",
  "drift_ms",
  "growth_bytes",
  "samples",
  "http_status",
  "failed_writes",
  "malformed_records",
  "recovered_tail_bytes",
];
const BOOLEANS = [
  "playing",
  "buffering",
  "cache_hit",
  "trim_enabled",
  "passed",
  "online",
];
const CODES = new Set([
  "DESKTOP_STARTED",
  "PREPARATION_STATE",
  "UPDATE_STATE",
  "PERSONAL_STATE",
  "ACCOUNT_SCOPE_TRANSITION_FAILED",
  "ACCOUNT_AUTHORITY_RETIREMENT_FAILED",
  "ACCOUNT_STATE",
  "REALTIME_STATE",
  "LIBRARY_STATE",
  "OUTBOX_STATE",
  "FLEET_STATE",
  "WORKER_STATE",
  "ADVANCED_STATE",
  "PREPARATION_FAILED",
  "PERSONAL_PROCESSING_FAILED",
  "OUTBOX_SAVE_FAILED",
  "FLEET_UNAVAILABLE",
  "ADVANCED_OPERATION_FAILED",
  "PLAYBACK_FAILED",
  "OK",
  "UNKNOWN_ERROR",
  "CANCELLED",
  "DIAGNOSTICS_UNAVAILABLE",
  "DIAGNOSTICS_WRITE_FAILED",
  "DIAGNOSTICS_STORAGE_UNSAFE",
  "DIAGNOSTICS_RECOVERED",
  "DIAGNOSTICS_EVENT_REJECTED",
  "DISK_SPACE_LOW",
  "ENOSPC",
  "EACCES",
  "EPERM",
  "EIO",
  "ENOENT",
  "SETUP_REQUIRED",
  "PREPARE_REQUIRED",
  "HELPER_INTEGRITY_INVALID",
  "GPU_REQUALIFICATION_REQUIRED",
  "GPU_UNAVAILABLE",
  "MODEL_NOT_READY",
  "MODEL_CHECKSUM_INVALID",
  "ENGINE_PROTOCOL_INVALID",
  "TOOL_FAILED",
  "TOOL_TIMEOUT",
  "ACCOUNT_CHANGED",
  "ACCOUNT_RESTORE_FAILED",
  "ACCOUNT_UNAVAILABLE",
  "API_UNAVAILABLE",
  "REALTIME_DISCONNECTED",
  "LIBRARY_UNAVAILABLE",
  "OUTBOX_FULL",
  "OUTBOX_RECOVERY_REQUIRED",
  "STORAGE_RECOVERY_PENDING",
  "PLAYBACK_SOURCE_CHANGED",
  "PLAYBACK_CLOCK_STALE",
  "COMPANION_DISCONNECTED",
  "NATIVE_PIPE_CLOSED",
  "FLEET_PREPARE_REQUIRED",
  "FLEET_APPROVAL_REQUIRED",
  "FLEET_REVOKED",
  "ADVANCED_BENCHMARK_TREE_UNCERTAIN",
  "UPDATE_UNAVAILABLE",
  "UPDATE_RECOVERY_REQUIRED",
  "UPDATE_FINALIZE_UNCONFIRMED",
  "RESOURCE_RSS_GROWTH",
]);
function data(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Buffer.isBuffer(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return {};
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.fromEntries(
    Object.entries(descriptors)
      .filter(([, v]) => "value" in v)
      .map(([k, v]) => [k, v.value]),
  );
}
export function diagnosticCode(value: unknown): string {
  return typeof value === "string" && CODES.has(value)
    ? value
    : "UNKNOWN_ERROR";
}
export function parseDiagnosticIdentity(
  value: unknown,
): WindowsDiagnosticIdentity {
  const row = data(value);
  if (
    typeof row.softwareVersion !== "string" ||
    row.softwareVersion.length > 64 ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]{1,32})?$/u.test(
      row.softwareVersion,
    ) ||
    typeof row.runtimeScope !== "string" ||
    !["packaged-app", "development"].includes(row.runtimeScope) ||
    typeof row.expectedModelSha256 !== "string" ||
    !SHA.test(row.expectedModelSha256) ||
    (row.packageInventorySha256 !== undefined &&
      (typeof row.packageInventorySha256 !== "string" ||
        !SHA.test(row.packageInventorySha256)))
  )
    throw new Error("DIAGNOSTICS_IDENTITY_INVALID");
  return {
    softwareVersion: row.softwareVersion,
    runtimeScope: row.runtimeScope as WindowsDiagnosticIdentity["runtimeScope"],
    expectedModelSha256: row.expectedModelSha256,
    ...(row.packageInventorySha256 === undefined
      ? {}
      : { packageInventorySha256: row.packageInventorySha256 as string }),
  };
}
export function projectDiagnosticInput(value: unknown) {
  const row = data(value),
    metrics = data(row.metrics),
    safe: Record<string, number | boolean> = {};
  let rejected = Object.keys(row).filter(
    (k) =>
      ![
        "subsystem",
        "event",
        "severity",
        "code",
        "phase",
        "metrics",
        "job",
      ].includes(k),
  ).length;
  for (const [key, v] of Object.entries(metrics)) {
    if (
      NUMBERS.includes(key) &&
      typeof v === "number" &&
      Number.isFinite(v) &&
      Math.abs(v) <= Number.MAX_SAFE_INTEGER &&
      (v >= 0 || key === "drift_ms")
    )
      safe[key] = v;
    else if (BOOLEANS.includes(key) && typeof v === "boolean") safe[key] = v;
    else rejected++;
  }
  const known =
    DIAGNOSTIC_SUBSYSTEMS.includes(row.subsystem as never) &&
    typeof row.event === "string" &&
    EVENTS.includes(row.event);
  if (!known) rejected++;
  const severity =
    typeof row.severity === "string" &&
    ["info", "warning", "error"].includes(row.severity)
      ? (row.severity as WindowsDiagnosticEvent["severity"])
      : "error";
  const phase =
    typeof row.phase === "string" && PHASES.includes(row.phase)
      ? (row.phase as string)
      : null;
  if (row.phase != null && phase === null) rejected++;
  const job =
    typeof row.job === "string" && DIAGNOSTIC_UUID.test(row.job)
      ? row.job
      : null;
  if (row.job != null && !job) rejected++;
  const code = diagnosticCode(row.code);
  if (row.code !== undefined && code === "UNKNOWN_ERROR" && row.code !== code)
    rejected++;
  return {
    rejected,
    input: {
      subsystem: known
        ? (row.subsystem as WindowsDiagnosticEvent["subsystem"])
        : ("lifecycle" as const),
      event: known
        ? (row.event as WindowsDiagnosticEvent["event"])
        : ("diagnostic_rejected" as const),
      severity: known ? severity : ("error" as const),
      code: known ? code : "DIAGNOSTICS_EVENT_REJECTED",
      phase,
      metrics: safe,
      job,
    },
  };
}
export function parseDiagnosticRecord(value: unknown): WindowsDiagnosticEvent {
  const row = data(value),
    { input, rejected } = projectDiagnosticInput({
      subsystem: row.subsystem,
      event: row.event,
      severity: row.severity,
      code: row.code,
      phase: row.phase,
      metrics: row.metrics,
      job: row.job,
    });
  if (
    row.version !== 1 ||
    typeof row.session !== "string" ||
    !DIAGNOSTIC_UUID.test(row.session) ||
    !Number.isSafeInteger(row.sequence) ||
    (row.sequence as number) < 1 ||
    !Number.isSafeInteger(row.rejectedFields) ||
    (row.rejectedFields as number) < 0 ||
    typeof row.severity !== "string" ||
    !["info", "warning", "error"].includes(row.severity) ||
    typeof row.at !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(row.at) ||
    !Number.isFinite(Date.parse(row.at)) ||
    rejected ||
    Object.keys(row).some(
      (k) =>
        ![
          "version",
          "session",
          "sequence",
          "at",
          "identity",
          "subsystem",
          "event",
          "severity",
          "code",
          "phase",
          "metrics",
          "job",
          "rejectedFields",
          "verifiedModelSha256",
        ].includes(k),
    ) ||
    (row.verifiedModelSha256 !== undefined &&
      (input.event !== "completed" ||
        input.severity !== "info" ||
        typeof row.verifiedModelSha256 !== "string" ||
        !SHA.test(row.verifiedModelSha256)))
  )
    throw new Error("DIAGNOSTICS_RECORD_INVALID");
  return {
    version: 1,
    session: row.session as string,
    sequence: row.sequence as number,
    at: row.at,
    identity: parseDiagnosticIdentity(row.identity),
    rejectedFields: row.rejectedFields as number,
    ...input,
    ...(row.verifiedModelSha256 === undefined
      ? {}
      : { verifiedModelSha256: row.verifiedModelSha256 as string }),
  };
}
export function diagnosticReport(options: {
  events: WindowsDiagnosticEvent[];
  identity: WindowsDiagnosticIdentity;
  now: number;
  availability: WindowsDiagnosticReport["availability"];
  failureCode: string | null;
  malformed: number;
  recovered: number;
  rejected: number;
  failedWrites: number;
  retained: number;
  maximum: number;
  incomplete: boolean;
  full?: boolean;
}): WindowsDiagnosticReport {
  const events = options.events,
    counts: Record<string, number> = {},
    peaks: Record<string, number> = {},
    jobs = new Map<string, WindowsDiagnosticJob>(),
    alerts = new Map<string, WindowsDiagnosticEvent>();
  for (const event of events) {
    counts[`${event.subsystem}.${event.event}`] =
      (counts[`${event.subsystem}.${event.event}`] ?? 0) + 1;
    for (const [key, value] of Object.entries(event.metrics))
      if (typeof value === "number")
        peaks[key] = Math.max(peaks[key] ?? 0, value);
    if (event.severity !== "info")
      alerts.set(`${JSON.stringify(event.identity)}:${event.severity}`, event);
    if (event.job) {
      let job = jobs.get(event.job);
      if (!job) {
        job = {
          job: event.job,
          state: "active",
          firstAt: event.at,
          lastAt: event.at,
          stagesMilliseconds: {},
          peaks: {},
          codes: [],
          warnings: 0,
          incomplete: event.event !== "started",
        };
        jobs.set(event.job, job);
      }
      job.lastAt = event.at;
      if (event.event === "completed") job.state = "ready";
      else if (event.event === "failed") job.state = "failed";
      else if (event.event === "cancelled") job.state = "cancelled";
      if (event.phase && typeof event.metrics.duration_ms === "number")
        job.stagesMilliseconds[event.phase] =
          (job.stagesMilliseconds[event.phase] ?? 0) +
          event.metrics.duration_ms;
      for (const [key, v] of Object.entries(event.metrics))
        if (typeof v === "number")
          job.peaks[key] = Math.max(job.peaks[key] ?? 0, v);
      if (event.code !== "OK" && !job.codes.includes(event.code))
        job.codes.push(event.code);
      if (event.severity === "warning") job.warnings++;
    }
  }
  const required = [...alerts.values()],
    warnings = events.filter((e) => e.severity === "warning"),
    errors = events.filter((e) => e.severity === "error");
  const report: WindowsDiagnosticReport = {
    version: 1,
    createdAt: new Date(options.now).toISOString(),
    privacy: "local-only-no-media-credentials-urls-paths-account-identifiers",
    availability: options.availability,
    failureCode: options.failureCode,
    identity: options.identity,
    coverage: {
      firstSequence: events[0]?.sequence ?? null,
      lastSequence: events.at(-1)?.sequence ?? null,
      malformedRecords:
        options.malformed +
        events
          .filter((e) => e.event === "recovered")
          .reduce(
            (n, e) =>
              n +
              (typeof e.metrics.malformed_records === "number"
                ? e.metrics.malformed_records
                : 0),
            0,
          ),
      recoveredTailBytes:
        options.recovered +
        events
          .filter((e) => e.event === "recovered")
          .reduce(
            (n, e) =>
              n +
              (typeof e.metrics.recovered_tail_bytes === "number"
                ? e.metrics.recovered_tail_bytes
                : 0),
            0,
          ),
      rejectedFields: options.rejected,
      failedWrites: Math.max(
        options.failedWrites,
        events
          .filter((e) => e.code === "DIAGNOSTICS_WRITE_FAILED")
          .reduce(
            (n, e) =>
              n +
              (typeof e.metrics.failed_writes === "number"
                ? e.metrics.failed_writes
                : 0),
            0,
          ),
      ),
      retainedBytes: options.retained,
      maxLogBytes: options.maximum,
      incompleteHistory:
        options.incomplete ||
        options.malformed > 0 ||
        options.recovered > 0 ||
        options.failedWrites > 0,
      truncated: false,
      readOnly: true,
      observationsAreNotLeakOrAudioQualityProof: true,
      unmeasured: [
        "live-inference",
        "audio-quality",
        "unsampled-processes",
        "operating-system-audio-latency",
        "events-before-retained-history",
      ],
    },
    counts,
    peaks,
    jobs: [...jobs.values()].slice(-100),
    recentErrors: options.full
      ? errors
      : [
          ...new Set([
            ...errors.slice(-8),
            ...required.filter((e) => e.severity === "error"),
          ]),
        ],
    recentWarnings: options.full
      ? warnings
      : [
          ...new Set([
            ...warnings.slice(-8),
            ...required.filter((e) => e.severity === "warning"),
          ]),
        ],
    recentEvents: options.full ? events : events.slice(-20),
  };
  report.coverage.truncated =
    report.jobs.length < jobs.size ||
    report.recentEvents.length < events.length;
  const limit = options.full ? 2 * 1024 ** 2 : 28 * 1024;
  while (Buffer.byteLength(JSON.stringify(report)) > limit) {
    if (report.recentEvents.length) report.recentEvents.shift();
    else if (report.jobs.length) report.jobs.shift();
    else {
      const key = ["recentWarnings", "recentErrors"] as const;
      let removed = false;
      for (const k of key) {
        const i = report[k].findIndex((e) => !required.includes(e));
        if (i >= 0) {
          report[k].splice(i, 1);
          removed = true;
          break;
        }
      }
      if (!removed) throw new Error("DIAGNOSTICS_REPORT_TOO_LARGE");
    }
    report.coverage.truncated = true;
  }
  report.coverage.incompleteHistory ||=
    report.coverage.truncated ||
    report.coverage.malformedRecords > 0 ||
    report.coverage.recoveredTailBytes > 0 ||
    report.coverage.failedWrites > 0;
  return report;
}

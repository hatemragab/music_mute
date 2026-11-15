import {
  DIAGNOSTIC_SUBSYSTEMS,
  DIAGNOSTIC_UUID,
  type WindowsDiagnosticReport,
  type WindowsDiagnosticEvent,
  type WindowsDiagnosticJob,
} from "../../shared/diagnostics-contracts.js";
import {
  diagnosticCode,
  parseDiagnosticIdentity,
  parseDiagnosticRecord,
  projectDiagnosticInput,
} from "./projection.js";
export const CHROME_DIAGNOSTIC_FILE_BYTES = 2 * 1024 ** 2;
export const CHROME_DIAGNOSTIC_REPLY_BYTES = 28 * 1024;
export interface ChromeDiagnosticExport {
  report: WindowsDiagnosticReport;
  receipt: string;
}
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
const UNMEASURED = [
  "live-inference",
  "audio-quality",
  "unsampled-processes",
  "operating-system-audio-latency",
  "events-before-retained-history",
];
function invalid(): never {
  throw new Error("DIAGNOSTICS_REPORT_INVALID");
}
function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some((k) => typeof k !== "string") ||
    Object.values(descriptors).some((v) => !("value" in v))
  )
    return invalid();
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  const row = object(value);
  if (Object.keys(row).sort().join() !== keys.sort().join()) return invalid();
  return row;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  const d = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some(
      (k) => typeof k !== "string" || (k !== "length" && !/^\d+$/u.test(k)),
    ) ||
    Object.values(d).some((v) => !("value" in v))
  )
    return invalid();
  if (Object.keys(value).length !== value.length) return invalid();
  for (let i = 0; i < value.length; i++)
    if (!Object.hasOwn(value, i)) return invalid();
  return value;
}
function identity(value: unknown) {
  const row = object(value);
  if (
    Object.keys(row).sort().join() !==
      [
        "softwareVersion",
        "runtimeScope",
        "expectedModelSha256",
        ...(row.packageInventorySha256 === undefined
          ? []
          : ["packageInventorySha256"]),
      ]
        .sort()
        .join() ||
    typeof row.runtimeScope !== "string"
  )
    return invalid();
  return parseDiagnosticIdentity(row);
}
function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) return invalid();
  return value as number;
}
function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return invalid();
  return value;
}
function code(value: unknown): string {
  if (typeof value !== "string" || diagnosticCode(value) !== value)
    return invalid();
  return value;
}
function numbers(
  value: unknown,
  kind: "counts" | "peaks" | "stages",
): Record<string, number> {
  const row = object(value),
    safe: Record<string, number> = {};
  if (Object.keys(row).length > 128) return invalid();
  for (const [key, v] of Object.entries(row)) {
    if (
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      v < 0 ||
      v > Number.MAX_SAFE_INTEGER
    )
      return invalid();
    if (kind === "counts") {
      const [subsystem, event] = key.split(".");
      if (
        !DIAGNOSTIC_SUBSYSTEMS.includes(subsystem as never) ||
        !EVENTS.includes(event ?? "") ||
        key !== `${subsystem}.${event}` ||
        !Number.isSafeInteger(v)
      )
        return invalid();
    } else if (kind === "peaks") {
      const projected = projectDiagnosticInput({
        subsystem: "runtime",
        event: "resource_sample",
        code: "OK",
        metrics: { [key]: v },
      });
      if (projected.rejected || projected.input.metrics[key] !== v)
        return invalid();
    } else if (
      projectDiagnosticInput({
        subsystem: "personal",
        event: "progress",
        code: "OK",
        phase: key,
      }).input.phase !== key
    )
      return invalid();
    safe[key] = v;
  }
  return safe;
}
function event(value: unknown): WindowsDiagnosticEvent {
  const row = object(value);
  identity(row.identity);
  object(row.metrics);
  for (const key of ["subsystem", "event", "severity", "code", "at", "session"])
    if (typeof row[key] !== "string") return invalid();
  timestamp(row.at);
  if (
    (row.phase !== null && typeof row.phase !== "string") ||
    (row.job !== null && typeof row.job !== "string")
  )
    return invalid();
  return parseDiagnosticRecord(row);
}
function job(value: unknown): WindowsDiagnosticJob {
  const row = exact(value, [
    "job",
    "state",
    "firstAt",
    "lastAt",
    "stagesMilliseconds",
    "peaks",
    "codes",
    "warnings",
    "incomplete",
  ]);
  if (
    typeof row.job !== "string" ||
    !DIAGNOSTIC_UUID.test(row.job) ||
    typeof row.state !== "string" ||
    !["active", "ready", "failed", "cancelled"].includes(row.state) ||
    typeof row.incomplete !== "boolean"
  )
    return invalid();
  return {
    job: row.job,
    state: row.state as WindowsDiagnosticJob["state"],
    firstAt: timestamp(row.firstAt),
    lastAt: timestamp(row.lastAt),
    stagesMilliseconds: numbers(row.stagesMilliseconds, "stages"),
    peaks: numbers(row.peaks, "peaks"),
    codes: array(row.codes, 128).map(code),
    warnings: integer(row.warnings),
    incomplete: row.incomplete,
  };
}
/** Repeat the allowlist at the personal browser boundary; never serialize unknown fields/getters. */
export function parseChromeDiagnosticReport(
  value: unknown,
): WindowsDiagnosticReport {
  const row = exact(value, [
      "version",
      "createdAt",
      "privacy",
      "availability",
      "failureCode",
      "identity",
      "coverage",
      "counts",
      "peaks",
      "jobs",
      "recentErrors",
      "recentWarnings",
      "recentEvents",
    ]),
    coverage = exact(row.coverage, [
      "firstSequence",
      "lastSequence",
      "malformedRecords",
      "recoveredTailBytes",
      "rejectedFields",
      "failedWrites",
      "retainedBytes",
      "maxLogBytes",
      "incompleteHistory",
      "truncated",
      "readOnly",
      "observationsAreNotLeakOrAudioQualityProof",
      "unmeasured",
    ]);
  if (
    row.version !== 1 ||
    row.privacy !==
      "local-only-no-media-credentials-urls-paths-account-identifiers" ||
    typeof row.availability !== "string" ||
    !["available", "no-logs", "unavailable", "closed"].includes(
      row.availability,
    ) ||
    coverage.readOnly !== true ||
    coverage.observationsAreNotLeakOrAudioQualityProof !== true ||
    typeof coverage.incompleteHistory !== "boolean" ||
    typeof coverage.truncated !== "boolean"
  )
    return invalid();
  identity(row.identity);
  const errors = array(row.recentErrors, 4096).map(event),
    warnings = array(row.recentWarnings, 4096).map(event);
  if (
    errors.some((v) => v.severity !== "error") ||
    warnings.some((v) => v.severity !== "warning")
  )
    return invalid();
  const unmeasured = array(coverage.unmeasured, UNMEASURED.length);
  if (
    unmeasured.some((v) => typeof v !== "string" || !UNMEASURED.includes(v)) ||
    new Set(unmeasured).size !== unmeasured.length
  )
    return invalid();
  const result: WindowsDiagnosticReport = {
    version: 1,
    createdAt: timestamp(row.createdAt),
    privacy: row.privacy,
    availability: row.availability as WindowsDiagnosticReport["availability"],
    failureCode: row.failureCode === null ? null : code(row.failureCode),
    identity: identity(row.identity),
    coverage: {
      firstSequence:
        coverage.firstSequence === null
          ? null
          : integer(coverage.firstSequence, 1),
      lastSequence:
        coverage.lastSequence === null
          ? null
          : integer(coverage.lastSequence, 1),
      malformedRecords: integer(coverage.malformedRecords),
      recoveredTailBytes: integer(coverage.recoveredTailBytes),
      rejectedFields: integer(coverage.rejectedFields),
      failedWrites: integer(coverage.failedWrites),
      retainedBytes: integer(coverage.retainedBytes),
      maxLogBytes: integer(coverage.maxLogBytes),
      incompleteHistory: coverage.incompleteHistory,
      truncated: coverage.truncated,
      readOnly: true,
      observationsAreNotLeakOrAudioQualityProof: true,
      unmeasured: unmeasured as string[],
    },
    counts: numbers(row.counts, "counts"),
    peaks: numbers(row.peaks, "peaks"),
    jobs: array(row.jobs, 100).map(job),
    recentErrors: errors,
    recentWarnings: warnings,
    recentEvents: array(row.recentEvents, 4096).map(event),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > CHROME_DIAGNOSTIC_FILE_BYTES)
    throw new Error("DIAGNOSTICS_REPORT_TOO_LARGE");
  return result;
}
/** Preserve exact aggregates/coverage and the newest warning/error for each historical identity. */
export function chromeDiagnosticSummary(
  value: unknown,
): WindowsDiagnosticReport {
  const report = parseChromeDiagnosticReport(value),
    required = new Set<WindowsDiagnosticEvent>();
  for (const alerts of [report.recentErrors, report.recentWarnings]) {
    const newest = new Map<string, WindowsDiagnosticEvent>();
    for (const e of alerts) newest.set(JSON.stringify(e.identity), e);
    for (const e of newest.values()) required.add(e);
  }
  while (
    Buffer.byteLength(JSON.stringify(report)) > CHROME_DIAGNOSTIC_REPLY_BYTES
  ) {
    const info = report.recentEvents.findIndex((e) => e.severity === "info");
    if (info >= 0) report.recentEvents.splice(info, 1);
    else if (report.jobs.length) report.jobs.shift();
    else if (report.recentEvents.length) report.recentEvents.shift();
    else {
      let dropped = false;
      for (const alerts of [report.recentWarnings, report.recentErrors]) {
        const index = alerts.findIndex((e) => !required.has(e));
        if (index >= 0) {
          alerts.splice(index, 1);
          dropped = true;
          break;
        }
      }
      if (!dropped) throw new Error("DIAGNOSTICS_REPORT_TOO_LARGE");
    }
    report.coverage.truncated = true;
    report.coverage.incompleteHistory = true;
  }
  return report;
}
export function parseChromeDiagnosticExport(
  value: unknown,
): ChromeDiagnosticExport {
  const row = exact(value, ["report", "receipt"]);
  if (typeof row.receipt !== "string" || !DIAGNOSTIC_UUID.test(row.receipt))
    return invalid();
  const report = parseChromeDiagnosticReport(row.report);
  if (Buffer.byteLength(JSON.stringify(report)) > CHROME_DIAGNOSTIC_REPLY_BYTES)
    throw new Error("DIAGNOSTICS_REPORT_TOO_LARGE");
  return { report, receipt: row.receipt };
}

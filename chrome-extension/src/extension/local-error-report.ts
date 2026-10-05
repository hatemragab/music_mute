import type { DiagnosticInput } from "../shared/protocol";
import { isErrorCode, type ExtensionStatus } from "./messages";
import { failureGuidance } from "./error-guidance";

export interface LocalErrorEvent extends DiagnosticInput {
  recorded_at?: string;
}
const events = new Set([
  "diagnostic_error",
  "job_failed",
  "job_cancelled",
  "playback_suspended",
]);
const stages = new Set([
  "content",
  "background",
  "offscreen",
  "popup",
  "setup",
  "failed",
  "metadata",
  "download",
  "playback",
  "account",
  "storage",
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
]);
/** Project storage on every read; old or tampered records cannot enter copied reports. */
export function safeLocalErrors(value: unknown): LocalErrorEvent[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-50).flatMap((input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return [];
    const row = input as Record<string, unknown>;
    if (
      row.component !== "extension" ||
      typeof row.severity !== "string" ||
      !["warning", "error"].includes(row.severity) ||
      typeof row.event !== "string" ||
      !events.has(row.event)
    )
      return [];
    const result: LocalErrorEvent = {
      component: "extension",
      severity: row.severity as "warning" | "error",
      event: row.event,
    };
    if (isErrorCode(row.code)) result.code = row.code;
    if (
      typeof row.recorded_at === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.recorded_at) &&
      Number.isFinite(Date.parse(row.recorded_at))
    )
      result.recorded_at = row.recorded_at;
    const metrics = row.metrics;
    if (metrics && typeof metrics === "object" && !Array.isArray(metrics)) {
      const stage = (metrics as Record<string, unknown>).stage;
      if (typeof stage === "string" && stages.has(stage))
        result.metrics = { stage };
    }
    return [result];
  });
}
export function localErrorReport(state: ExtensionStatus): string {
  const rows = safeLocalErrors(state.diagnostics);
  return [
    "MusicMute local diagnostics",
    `Generated: ${new Date().toISOString()}`,
    `Helper: ${state.hello?.ready ? "ready" : "setup or connection needed"}`,
    "No media, source URLs, cookies, credentials or account identifiers are included.",
    state.error && isErrorCode(state.error)
      ? `Last error: ${state.error}\n${failureGuidance(state.error, state.error_context).message}`
      : "",
    ...rows.map(
      (row) =>
        `${row.recorded_at ?? "Historical time unknown"} · ${row.metrics?.stage ?? "operation"} · ${row.code ?? row.event}\n${row.code ? failureGuidance(row.code).message : "Local operation interrupted."}`,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

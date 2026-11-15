import type { DiagnosticInput } from "../shared/protocol";
import type { ExtensionStatus } from "./messages";
import { failureGuidance } from "./error-guidance";
import { projectDiagnosticCode } from "../shared/diagnostic-codes";

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
  let entries: unknown[];
  try {
    if (!Array.isArray(value)) return [];
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0) return [];
    entries = Array.from(
      { length: Math.min(length, 50) },
      (_, i) =>
        Object.getOwnPropertyDescriptor(
          value,
          String(Math.max(0, length - 50) + i),
        )?.value,
    );
  } catch {
    return [];
  }
  return entries.flatMap((input: unknown) => {
    const fields: PropertyDescriptorMap = {};
    try {
      if (!input || typeof input !== "object" || Array.isArray(input))
        return [];
      for (const key of [
        "component",
        "severity",
        "event",
        "code",
        "recorded_at",
        "metrics",
      ]) {
        const field = Object.getOwnPropertyDescriptor(input, key);
        if (field) fields[key] = field;
      }
    } catch {
      return [];
    }
    // Stored JSON needs data properties only. Accessors are never called.
    const row: Record<string, unknown> = Object.fromEntries(
      Object.entries(fields).map(([key, field]) => [key, field.value]),
    );
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
    if (Object.hasOwn(fields, "code"))
      result.code = projectDiagnosticCode(row.code);
    if (
      typeof row.recorded_at === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.recorded_at) &&
      Number.isFinite(Date.parse(row.recorded_at))
    )
      result.recorded_at = row.recorded_at;
    const metrics = row.metrics;
    if (metrics && typeof metrics === "object" && !Array.isArray(metrics)) {
      let stage: unknown;
      try {
        stage = Object.getOwnPropertyDescriptor(metrics, "stage")?.value;
      } catch {
        stage = undefined;
      }
      if (typeof stage === "string" && stages.has(stage))
        result.metrics = { stage };
    }
    return [result];
  });
}
export function localErrorReport(state: ExtensionStatus): string {
  const rows = safeLocalErrors(state.diagnostics);
  const currentCode =
    state.error === undefined ? undefined : projectDiagnosticCode(state.error);
  return [
    "MusicMute local diagnostics",
    `Generated: ${new Date().toISOString()}`,
    `Helper: ${state.hello?.ready ? "ready" : "setup or connection needed"}`,
    "No media, source URLs, cookies, credentials or account identifiers are included.",
    currentCode
      ? `Last error: ${currentCode}\n${failureGuidance(currentCode, state.error_context, Date.now(), state.hello).message}`
      : "",
    ...rows.map(
      (row) =>
        `${row.recorded_at ?? "Historical time unknown"} · ${row.metrics?.stage ?? "operation"} · ${row.code ?? row.event}\n${row.code ? failureGuidance(row.code, undefined, Date.now(), state.hello).message : "Local operation interrupted."}`,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

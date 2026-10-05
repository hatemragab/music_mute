import type { AppUiFields } from "./app-journal.js";
import type { DiagnosticReport } from "./diagnostics.js";
import { LocalSetupError } from "./config.js";

type CombinedReport = DiagnosticReport &
  AppUiFields & {
    app_setup_diagnostics: DiagnosticReport;
    app_desktop_diagnostics?: DiagnosticReport;
  };
type AppDiagnosticReply = {
  type: "result";
  report: CombinedReport;
  path?: string;
};
const MAX_REPLY_BYTES = 64 * 1024;

function dropEvent(report: DiagnosticReport, activityOnly = false): boolean {
  if (!report.recent_events.length) return false;
  const activity = report.recent_events.findIndex(
    (event) => event.severity === "info",
  );
  if (activityOnly && activity < 0) return false;
  report.recent_events.splice(Math.max(0, activity), 1);
  report.coverage.recent_events_truncated = true;
  report.coverage.incomplete_history = true;
  return true;
}
function dropJob(report: DiagnosticReport): boolean {
  if (!report.jobs.length) return false;
  report.jobs.shift();
  report.coverage.job_summaries_truncated = true;
  report.coverage.incomplete_history = true;
  return true;
}
function dropAlert(report: DiagnosticReport): boolean {
  // Keep the newest warning and error in every process/identity scope.
  if (report.recent_warnings.length > 1) report.recent_warnings.shift();
  else if (report.recent_errors.length > 1) report.recent_errors.shift();
  else return false;
  report.coverage.recent_events_truncated = true;
  report.coverage.incomplete_history = true;
  return true;
}

/** Bound the combined control envelope; the separately written full export is unchanged. */
export function boundedAppDiagnosticReply(
  report: DiagnosticReport,
  extra: AppUiFields & {
    app_setup_diagnostics: DiagnosticReport;
    app_desktop_diagnostics?: DiagnosticReport;
  },
  path?: string,
): AppDiagnosticReply {
  const reply: AppDiagnosticReply = structuredClone({
    type: "result",
    report: { ...report, ...extra },
    ...(path === undefined ? {} : { path }),
  });
  const combined = reply.report;
  const reports = [combined, combined.app_setup_diagnostics];
  if (combined.app_desktop_diagnostics)
    reports.push(combined.app_desktop_diagnostics);
  while (
    Buffer.byteLength(
      JSON.stringify({ protocol_version: 1, ...reply }) + "\n",
    ) > MAX_REPLY_BYTES
  ) {
    if (
      reports.some((scope) => dropEvent(scope, true)) ||
      reports.some(dropJob)
    )
      continue;
    const activity = combined.app_ui_events.findIndex(
      (event) => event.event !== "app_operation_error",
    );
    if (activity >= 0) {
      combined.app_ui_events.splice(activity, 1);
      combined.app_ui_coverage.history_truncated = true;
      continue;
    }
    // Detailed alert events duplicate the dedicated recent alert collections.
    if (reports.some((scope) => dropEvent(scope))) continue;
    if (combined.app_ui_events.length > 1) {
      combined.app_ui_events.shift();
      combined.app_ui_coverage.history_truncated = true;
      continue;
    }
    if (reports.some(dropAlert)) continue;
    // Valid bounded diagnostic projections always fit once retained detail is removed.
    throw new LocalSetupError("APP_REPLY_TOO_LARGE");
  }
  return reply;
}

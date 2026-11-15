import { useState } from "react";
import type { DiagnosticsUiCommand } from "../shared/contracts.js";
import type {
  WindowsDiagnosticsView,
  WindowsDiagnosticCheck,
} from "../shared/diagnostics-contracts.js";
import { ModalDialog } from "./dialog.js";
import { t } from "./i18n.js";
const checks: Record<WindowsDiagnosticCheck["name"], string> = {
  "signed-runtime": "Processing runtime",
  "native-host": "Windows helper",
  "physical-gpu": "Graphics adapter",
  "python-lock": "Python dependencies",
  "engine-protocol": "Processing protocol",
  "media-tools": "Audio tools",
  "model-bytes": "Voice model verification",
  "live-inference": "GPU processing test",
};
const status: Record<WindowsDiagnosticCheck["status"], string> = {
  passed: "Passed",
  failed: "Needs attention",
  warning: "Needs review",
  "not-run": "Not run",
};
export function DiagnosticsPanel({
  view,
  unavailable,
  busy,
  execute,
  exportReport,
  clear,
}: {
  view?: WindowsDiagnosticsView | undefined;
  unavailable?: boolean | undefined;
  busy: boolean;
  execute(command: DiagnosticsUiCommand): Promise<void>;
  exportReport(): Promise<void>;
  clear(): Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false),
    working = busy || view?.busy === true;
  return (
    <section className="panel" aria-label={t("Local diagnostics")}>
      <h2>{t("Local diagnostics")}</h2>
      <p>
        {t(
          "Reports stay on this PC. Export or copy a report when you choose to share it.",
        )}
      </p>
      {unavailable && (
        <p role="alert">
          {t(
            "Local diagnostics are unavailable. Reopen the signed app after preparation or storage recovery.",
          )}
        </p>
      )}
      {view?.problem && (
        <p role="alert" className="error">
          {t(
            "The diagnostic action could not finish. Your audio, account, and worker data are retained.",
          )}
        </p>
      )}
      <div className="actions">
        <button
          disabled={working || unavailable}
          onClick={() => void execute({ type: "INSPECT" })}
        >
          {t("Inspect local diagnostics")}
        </button>
        <button
          disabled={working || unavailable}
          onClick={() => void execute({ type: "DOCTOR" })}
        >
          {t("Check local tools")}
        </button>
        <button
          disabled={working || unavailable || !view?.report}
          onClick={() => void execute({ type: "COPY" })}
        >
          {t("Copy report")}
        </button>
        <button
          disabled={working || unavailable || !view?.report}
          onClick={() => void exportReport()}
        >
          {t("Export local diagnostics")}
        </button>
        <button
          disabled={working || unavailable}
          onClick={() => void execute({ type: "REVEAL_LOGS" })}
        >
          {t("Reveal local logs")}
        </button>
        <button
          disabled={working || unavailable || !view?.exportReceipt}
          onClick={() => void execute({ type: "SHOW_REPORT" })}
        >
          {t("Show saved report")}
        </button>
        <button
          disabled={working || unavailable || !view?.report}
          onClick={() => setConfirm(true)}
        >
          {t("Clear local diagnostics")}
        </button>
        {view?.busy && (
          <button onClick={() => void execute({ type: "CANCEL" })}>
            {t("Cancel diagnostic action")}
          </button>
        )}
      </div>
      {view?.busy && <p role="status">{t("Checking local diagnostics…")}</p>}
      {view?.doctor && (
        <>
          <h3>{t("Local tool checks")}</h3>
          <p>
            {t(
              "Tool checks inspect installed components. Prepare verifies model processing on the GPU.",
            )}
          </p>
          <dl>
            {view.doctor.checks.map((check) => (
              <div key={check.name}>
                <dt>{t(checks[check.name])}</dt>
                <dd>{t(status[check.status])}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {view?.report && (
        <>
          <h3>{t("Recorded observations")}</h3>
          <p role="status">
            {t(
              view.report.availability === "available"
                ? "Local records are available."
                : view.report.availability === "no-logs"
                  ? "No local records yet."
                  : "Local records could not be read.",
            )}
          </p>
          {(view.report.coverage.incompleteHistory ||
            view.report.coverage.truncated ||
            view.report.coverage.malformedRecords > 0 ||
            view.report.coverage.failedWrites > 0) && (
            <p role="alert">
              {t(
                "This report contains partial history. Missing observations are marked unavailable.",
              )}
            </p>
          )}
          <p>
            {t(
              "Observed counts and peaks describe recorded activity. Audio quality and sustained GPU behavior need device testing.",
            )}
          </p>
          <details>
            <summary>{t("View sanitized report details")}</summary>
            <pre className="diagnostics-report">
              {JSON.stringify(view.report, null, 2)}
            </pre>
          </details>
        </>
      )}
      {confirm && (
        <ModalDialog
          label={t("Confirm local diagnostics clear")}
          busy={working}
          onClose={() => setConfirm(false)}
        >
          <p>
            {t(
              "Clear the app's local diagnostic records? Audio, models, account, and worker records are retained.",
            )}
          </p>
          <button
            disabled={working}
            onClick={() => {
              setConfirm(false);
              void clear();
            }}
          >
            {t("Clear local diagnostics")}
          </button>
          <button
            data-dialog-initial-focus
            disabled={working}
            onClick={() => setConfirm(false)}
          >
            {t("Keep local diagnostics")}
          </button>
        </ModalDialog>
      )}
    </section>
  );
}

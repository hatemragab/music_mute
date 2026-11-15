import { t } from "./i18n.js";
import type {
  PrepareView,
  PrepareErrorCode,
} from "../shared/prepare-contracts.js";
const stages = {
  inspect: "Checking this PC",
  space: "Planning downloads and space",
  runtime: "Preparing the processing runtime",
  model: "Verifying the voice model",
  gpu: "Testing GPU processing",
  activate: "Finishing preparation",
};
const errors: Record<PrepareErrorCode, string> = {
  GPU_UNSUPPORTED:
    "GPU qualification did not pass. Update your graphics driver, then retry.",
  NETWORK_UNAVAILABLE:
    "The model download was interrupted. Check your connection, then retry.",
  INTEGRITY_INVALID:
    "A required file could not be verified. Reinstall the signed app or repair preparation.",
  LOW_DISK: "There is not enough free space. Free some space, then retry.",
  NATIVE_HELPER_UNAVAILABLE:
    "The native helper is unavailable. Reinstall the signed app, then retry.",
  PERMISSION_DENIED:
    "MusicMute could not write its private files. Check your user account's folder access, then retry.",
  BUSY: "MusicMute preparation or GPU processing is busy. Wait for it to finish, then retry.",
  PREPARE_INTERRUPTED:
    "Preparation was cancelled. You can resume it when ready.",
  OPERATION_FAILED: "Preparation could not finish. Retry, or use Repair.",
  JOURNAL_CORRUPT:
    "The saved preparation state could not be verified. Reinstall the signed app to recover safely.",
};
const size = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
export function PreparePanel({
  view,
  message,
  busy,
  execute,
}: {
  view?: PrepareView;
  message: string;
  busy: boolean;
  execute: (action: "start" | "cancel" | "repair" | "check") => Promise<void>;
}) {
  const running = view?.state === "preparing";
  return (
    <section className="panel">
      <h2>{"" + t("Local processing") + ""}</h2>
      <p role="status">
        {t(running && view?.stage ? stages[view.stage] : message)}
      </p>
      {running && (
        <progress
          aria-label={t("Preparation progress")}
          max={100}
          {...(view.percent === null ? {} : { value: view.percent })}
        />
      )}
      {view?.completedBytes !== null &&
        view?.completedBytes !== undefined &&
        view.totalBytes !== null && (
          <p>
            {t("{done} of {total}", {
              done: size(view.completedBytes),
              total: size(view.totalBytes),
            })}
          </p>
        )}
      {view?.requiredBytes !== null &&
        view?.requiredBytes !== undefined &&
        view.availableBytes !== null && (
          <p className="muted">
            {t("{required} required · {available} available", {
              required: size(view.requiredBytes),
              available: size(view.availableBytes),
            })}
          </p>
        )}
      {view?.errorCode && (
        <p role="alert" className="error">
          {t(errors[view.errorCode])}
        </p>
      )}
      {view?.state === "ready" && view.browser === "attention-needed" && (
        <p>
          {"" +
            t("Local processing is ready. Chrome connection needs repair.") +
            ""}
        </p>
      )}
      <div className="home-links">
        {running ? (
          <button disabled={busy} onClick={() => void execute("cancel")}>
            {"" + t("Cancel preparation") + ""}
          </button>
        ) : (
          <>
            <button disabled={busy} onClick={() => void execute("check")}>
              {t("Check readiness")}
            </button>
            {view?.state !== "ready" && (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void execute("start")}
              >
                {view?.state === "missing" || !view
                  ? t("Prepare this PC")
                  : t("Retry preparation")}
              </button>
            )}
            <button disabled={busy} onClick={() => void execute("repair")}>
              {"" + t("Repair preparation") + ""}
            </button>
          </>
        )}
      </div>
      <p className="muted">
        {"" +
          t(
            "Your account and worker enrollment are separate from local preparation.",
          ) +
          ""}
      </p>
    </section>
  );
}

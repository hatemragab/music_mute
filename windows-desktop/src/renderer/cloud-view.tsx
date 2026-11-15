import { t } from "./i18n.js";
import { useEffect, useState } from "react";
import type { CloudCommand, CloudView } from "../shared/cloud-contracts.js";
import { parseYouTubeVideoId } from "../../../chrome-extension/src/shared/protocol.js";
const messages: Record<string, string> = {
  SIGN_IN_REQUIRED: "Sign in to use cloud processing.",
  EMAIL_VERIFICATION_REQUIRED:
    "Verify your email before using cloud processing.",
  CLOUD_POLICY_UNAVAILABLE:
    "Cloud availability could not be confirmed. Try again after reconnecting.",
  PROCESSING_ALLOWANCE_EXHAUSTED: "Your cloud processing allowance is used up.",
  APP_UPDATE_REQUIRED: "Update MusicMute before submitting more work.",
  MEDIA_TOOLS_REQUIRED: "Prepare the audio tools before uploading a file.",
  CLOUD_IMPORT_CANCELLATION_UNAVAILABLE:
    "The local wait stopped. The server may still finish importing this link.",
};
export function CloudPanel({
  view,
  selected,
  busy,
  execute,
  openLibrary,
}: {
  view?: CloudView;
  selected?: { capability: string; name: string; bytes: number };
  busy: boolean;
  execute(command: CloudCommand): Promise<void>;
  openLibrary(): void;
}) {
  const [url, setUrl] = useState(""),
    [rights, setRights] = useState(false),
    [inputError, setInputError] = useState<string>();
  useEffect(() => {
    setRights(false);
  }, [view?.confirmation?.capability]);
  if (!view) return null;
  return (
    <section className="processing-panel" aria-label={t("Cloud processing")}>
      {view.mode === "cloud" && (
        <>
          <h3>{"" + t("Cloud processing") + ""}</h3>
          <p>
            {"" +
              t(
                "Upload your audio for processing with your MusicMute account. Confirm each submission before it starts.",
              ) +
              ""}
          </p>
          {!view.ready && (
            <p role="status">
              {t(
                messages[view.reason ?? ""] ??
                  (view.signInRequired
                    ? t("Sign in to use cloud processing.")
                    : "Cloud processing is unavailable. Check your account and connection."),
              )}
            </p>
          )}
          <div className="home-links">
            <button
              disabled={busy || view.busy || !view.ready || !selected}
              onClick={() =>
                selected &&
                void execute({
                  type: "PREPARE_FILE",
                  fileCapability: selected.capability,
                  name: selected.name,
                  bytes: selected.bytes,
                })
              }
            >
              {"" + t("Review selected file") + ""}
            </button>
          </div>
          {view.linkImportVisible && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setInputError(undefined);
                const videoId = parseYouTubeVideoId(url);
                if (!videoId) {
                  setInputError("Enter a supported YouTube video link.");
                  return;
                }
                void execute({ type: "PREPARE_YOUTUBE", videoId });
              }}
            >
              <label>
                {"" + t("YouTube video link") + ""}
                <input
                  type="url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://www.youtube.com/watch?v=…"
                />
              </label>
              <button disabled={busy || view.busy || !view.ready}>
                {"" + t("Review link") + ""}
              </button>
            </form>
          )}
          {inputError && (
            <p role="alert" className="error">
              {t(inputError)}
            </p>
          )}
          {view.confirmation && !view.busy && (
            <section
              className="cloud-confirmation"
              aria-label={t("Confirm cloud submission")}
            >
              <h4>{"" + t("Confirm submission") + ""}</h4>
              <p>{view.confirmation.title}</p>
              <p>
                {view.confirmation.estimatedDurationSeconds === null
                  ? t("Duration is checked before processing.")
                  : t("{minutes} minutes", {
                      minutes: Math.ceil(
                        view.confirmation.estimatedDurationSeconds / 60,
                      ),
                    })}{" "}
                {"" +
                  t("Your account allowance and storage limits apply.") +
                  ""}
              </p>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={rights}
                  onChange={(event) => setRights(event.target.checked)}
                />
                {"" + t("I have the rights to process this content.") + ""}
              </label>
              <div className="home-links">
                <button
                  className="primary"
                  disabled={busy || !rights || !view.ready}
                  onClick={() =>
                    void execute({
                      type: "CONFIRM",
                      capability: view.confirmation!.capability,
                      rightsConfirmed: true,
                    })
                  }
                >
                  {"" + t("Confirm cloud processing") + ""}
                </button>
                <button
                  disabled={busy}
                  onClick={() => void execute({ type: "CLEAR_CONFIRMATION" })}
                >
                  {"" + t("Back") + ""}
                </button>
              </div>
            </section>
          )}
          {view.phase !== "idle" && view.phase !== "confirming" && (
            <p role="status">
              {view.phase === "cancellation-requested"
                ? t(
                    "Cancellation requested. The Library shows the server's final status.",
                  )
                : view.phase === "ready"
                  ? t("Your processed audio is ready.")
                  : view.phase === "failed"
                    ? t("Cloud processing needs attention.")
                    : view.phase === "cancelled"
                      ? t("The local request stopped.")
                      : t("Cloud {phase}…", { phase: t(view.phase) })}
            </p>
          )}
          {view.job && (
            <p className="muted">
              <bdi>{view.job.title ?? t("Audio")}</bdi> · {t(view.job.status)}
            </p>
          )}
          {view.errorCode && (
            <p role="alert" className="error">
              {t(
                messages[view.errorCode] ??
                  "Cloud processing could not complete this request. Check your account and connection.",
              )}
            </p>
          )}
          {view.busy && (
            <button
              disabled={busy}
              onClick={() => void execute({ type: "CANCEL" })}
            >
              {"" + t("Cancel cloud request") + ""}
            </button>
          )}
          {view.phase === "ready" && (
            <button onClick={openLibrary}>{"" + t("Open Library") + ""}</button>
          )}
        </>
      )}
    </section>
  );
}
export function ProcessingChoice({
  view,
  busy,
  execute,
}: {
  view?: CloudView;
  busy: boolean;
  execute(command: CloudCommand): Promise<void>;
}) {
  if (!view) return null;
  return (
    <fieldset className="processing-choice" disabled={busy || view.busy}>
      <legend>{"" + t("Processing location") + ""}</legend>
      <label>
        <input
          type="radio"
          name="processing-mode"
          value="local"
          checked={view.mode === "local"}
          onChange={() => void execute({ type: "SET_MODE", mode: "local" })}
        />
        {"" + t("This PC · GPU") + ""}
      </label>
      <label>
        <input
          type="radio"
          name="processing-mode"
          value="cloud"
          checked={view.mode === "cloud"}
          onChange={() => void execute({ type: "SET_MODE", mode: "cloud" })}
        />
        {"" + t("MusicMute cloud") + ""}
      </label>
    </fieldset>
  );
}

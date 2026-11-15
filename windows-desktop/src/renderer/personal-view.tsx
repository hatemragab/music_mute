import { t } from "./i18n.js";
import { useEffect, useState } from "react";
import type {
  PersonalUiCommand,
  PersonalUiView,
} from "../shared/personal-ui-contracts.js";
import type {
  PersonalJobView,
  PersonalStage,
} from "../shared/personal-contracts.js";
const stages: Record<PersonalStage, string> = {
  queued: "Waiting for local processing",
  metadata: "Checking the source",
  downloading: "Downloading the source audio",
  "input-validation": "Checking the selected audio",
  preparation: "Preparing local processing",
  "model-load": "Loading the voice model",
  separation: "Separating voice from music",
  encoding: "Saving the voice audio",
  "output-validation": "Verifying the processed audio",
};
export function personalWaitText(job?: PersonalJobView): string | null {
  if (job?.state !== "preparing" || job.stage !== "preparation") return null;
  switch (job.waitReason) {
    case "waiting-for-worker":
      return t("Waiting for worker");
    case "gpu-busy":
      return t("The GPU is busy");
    case "recovering":
      return t("Recovering local processing");
    default:
      return null;
  }
}
export function PersonalPanel(props: {
  view?: PersonalUiView;
  selected?: { capability: string; name: string; bytes: number };
  prepared: boolean;
  busy: boolean;
  execute(command: PersonalUiCommand): Promise<void>;
  defaultSource?: "file" | "youtube";
  linkImportVisible?: boolean;
  sourceChanged?(source: "file" | "youtube"): void;
}) {
  const [source, setSource] = useState<"file" | "youtube">("file"),
    [url, setUrl] = useState(""),
    [rights, setRights] = useState(false),
    [trim, setTrim] = useState(false);
  useEffect(() => setRights(false), [props.selected?.capability]);
  useEffect(() => {
    if (props.linkImportVisible === false) setSource("file");
    else if (props.defaultSource) setSource(props.defaultSource);
    setRights(false);
  }, [props.defaultSource, props.linkImportVisible]);
  const eligible =
    props.prepared && props.view?.connected === true && !props.busy;
  const submit = async () => {
    if (!rights) return;
    if (source === "file" && props.selected)
      await props.execute({
        type: "SUBMIT_FILE",
        capability: props.selected.capability,
        rightsConfirmed: true,
        trimEnabled: trim,
      });
    else if (source === "youtube" && url.trim())
      await props.execute({
        type: "SUBMIT_YOUTUBE",
        url: url.trim(),
        rightsConfirmed: true,
        trimEnabled: trim,
      });
    setRights(false);
  };
  return (
    <section className="processing-panel" aria-label={t("Local processing")}>
      <div
        className="segmented"
        role="group"
        aria-label={t("Processing source")}
      >
        <button
          aria-pressed={source === "file"}
          onClick={() => {
            setSource("file");
            props.sourceChanged?.("file");
            setRights(false);
          }}
        >
          {"" + t("Selected file") + ""}
        </button>
        {props.linkImportVisible !== false && (
          <button
            aria-pressed={source === "youtube"}
            onClick={() => {
              setSource("youtube");
              props.sourceChanged?.("youtube");
              setRights(false);
            }}
          >
            {"" + t("YouTube link") + ""}
          </button>
        )}
      </div>
      {source === "youtube" && (
        <label>
          {"" + t("YouTube link") + ""}
          <input
            type="url"
            value={url}
            maxLength={4096}
            placeholder="https://www.youtube.com/watch?v=…"
            onChange={(event) => {
              setUrl(event.target.value);
              setRights(false);
            }}
          />
        </label>
      )}
      <p className="muted">
        {"" +
          t(
            "Local processing supports up to 20 minutes and uses your qualified GPU. Your account is optional.",
          ) +
          ""}
      </p>
      <label className="check-row">
        <input
          type="checkbox"
          checked={rights}
          onChange={(event) => setRights(event.target.checked)}
        />
        {"" + t("I have permission to download and process this audio.") + ""}
      </label>
      <details>
        <summary>{"" + t("Processing options") + ""}</summary>
        <label className="check-row">
          <input
            type="checkbox"
            checked={trim}
            onChange={(event) => setTrim(event.target.checked)}
          />
          {"" + t("Remove silent parts from the voice result") + ""}
        </label>
        <p className="muted">
          {"" + t("Chrome playback keeps the full timeline.") + ""}
        </p>
      </details>
      <button
        className="primary"
        disabled={
          !eligible ||
          !rights ||
          (source === "file" ? !props.selected : !url.trim())
        }
        onClick={() => void submit()}
      >
        {"" + t("Process locally") + ""}
      </button>
      {!props.prepared && (
        <p role="status">
          {"" + t("Prepare this PC before local processing.") + ""}
        </p>
      )}
      {props.prepared && !props.view?.connected && !props.view?.error && (
        <p role="status">
          {"" + t("Connecting to the local processing agent…") + ""}
        </p>
      )}
      {props.view?.error && <p role="alert">{errorText(props.view.error)}</p>}
      <div className="processing-jobs" aria-live="polite">
        {props.view?.jobs.map((job) => (
          <article key={job.id}>
            <strong>
              <bdi>{job.name}</bdi>
            </strong>
            <p>
              {job.state === "preparing"
                ? (personalWaitText(job) ??
                  t(stages[job.stage] ?? "Preparing local processing"))
                : job.state === "ready"
                  ? t("Voice ready — available in Library")
                  : job.state === "cancelled"
                    ? t("Cancelled")
                    : errorText(job.error ?? "PROCESSING_FAILED")}
            </p>
            {job.state === "preparing" && (
              <>
                <progress
                  {...(job.progress !== null && !personalWaitText(job)
                    ? { value: job.progress * 100, max: 100 }
                    : {})}
                  aria-label={t("Processing progress for {name}", {
                    name: job.name,
                  })}
                />
                <button
                  onClick={() =>
                    void props.execute({ type: "CANCEL", jobId: job.id })
                  }
                >
                  {"" + t("Cancel") + ""}
                </button>
              </>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
function errorText(code: string): string {
  const messages: Record<string, string> = {
    INPUT_CHANGED: t("The selected file changed. Choose it again."),
    INPUT_LIMIT: t(
      "The file or available disk space does not meet the processing limit.",
    ),
    INPUT_UNSUPPORTED: t("Choose a supported audio or video file."),
    DURATION_LIMIT: t("Choose audio no longer than 20 minutes."),
    GPU_BUSY: t(
      "The GPU is busy. Wait for current work to finish, then try again.",
    ),
    GPU_UNSUPPORTED: t("The GPU needs preparation or a supported driver."),
    PREPARE_REQUIRED: t(
      "The local agent is unavailable. Open Prepare or reinstall the signed app.",
    ),
    SOURCE_UNAVAILABLE: t(
      "This source is unavailable. Check the link or choose a file.",
    ),
    SOURCE_BOT_CHALLENGE: t(
      "The source provider requires attention. Try a file instead.",
    ),
    ACQUISITION_RATE_LIMITED: t(
      "The source provider is busy. Try again later.",
    ),
    ACQUISITION_COOLDOWN: t(
      "The source provider is cooling down. Try again later.",
    ),
    SCOPE_CHANGED: t("Your account changed. Confirm the source again."),
    STOP_UNCONFIRMED: t(
      "MusicMute is still confirming that your personal work stopped.",
    ),
    CANCELLED: t("Cancelled."),
  };
  return (
    messages[code] ??
    t("Processing could not finish. Check the source and try again.")
  );
}

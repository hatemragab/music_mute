import { t } from "./i18n.js";
import type {
  SetupAssistanceCommand,
  SetupAssistanceView,
} from "../shared/setup-assistance-contracts.js";
export function SetupAssistancePanel({
  view,
  busy,
  execute,
}: {
  view?: SetupAssistanceView;
  busy: boolean;
  execute(command: SetupAssistanceCommand): Promise<void>;
}) {
  const working = busy || view?.busy === true;
  return (
    <section className="panel" aria-label={t("Chrome extension")}>
      <h3>{t("Chrome extension")}</h3>
      {!view || view.state === "checking" ? (
        <p role="status">{t("Checking extension files…")}</p>
      ) : view.extension === "available" ? (
        <p>
          {t("The bundled extension is ready for development installation.")}
        </p>
      ) : (
        <p role="alert">
          {t(
            "The bundled extension could not be verified. Reinstall the signed app.",
          )}
        </p>
      )}
      {view?.problem && (
        <p role="alert">
          {t(
            "Setup assistance could not finish. Your source files and account are unchanged.",
          )}
        </p>
      )}
      <details>
        <summary>{t("Development installation")}</summary>
        <p>
          {t(
            "Open Chrome extensions, enable Developer mode, then choose Load unpacked and select the folder shown by MusicMute.",
          )}
        </p>
        <div className="home-links">
          <button
            disabled={working || view?.chrome !== "available"}
            onClick={() => void execute({ type: "OPEN_CHROME_EXTENSIONS" })}
          >
            {t("Open Chrome extensions")}
          </button>
          <button
            disabled={working || view?.extension !== "available"}
            onClick={() => void execute({ type: "REVEAL_EXTENSION" })}
          >
            {t("Reveal extension folder")}
          </button>
          <button
            disabled={working || view?.extension !== "available"}
            onClick={() => void execute({ type: "COPY_EXTENSION_PATH" })}
          >
            {t("Copy extension folder path")}
          </button>
        </div>
        <p>
          {t(
            "After replacing the app, reload MusicMute in Chrome and refresh YouTube.",
          )}
        </p>
      </details>
      {view?.modelFolder === "available" && (
        <button
          disabled={working}
          onClick={() => void execute({ type: "REVEAL_MODEL" })}
        >
          {t("Show voice model folder")}
        </button>
      )}
    </section>
  );
}

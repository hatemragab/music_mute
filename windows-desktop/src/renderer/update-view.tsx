import { useState } from "react";
import type {
  ConsumerUpdateCommand,
  ConsumerUpdateView,
} from "../shared/update-contracts.js";
import { ModalDialog } from "./dialog.js";
import { t } from "./i18n.js";
const phases: Record<ConsumerUpdateView["phase"], string> = {
  idle: "Updates are ready to check.",
  available: "An update is available.",
  current: "MusicMute is up to date.",
  downloading: "Downloading a verified update…",
  waiting: "Waiting for processing and playback to finish.",
  activating: "Installing the verified update…",
  "health-check": "Checking the updated components…",
  "restart-required": "MusicMute will close to finish installing.",
  complete: "Update completed.",
  "rolled-back": "The previous working version was restored.",
  blocked: "The update needs attention.",
};
export function ConsumerUpdatePanel({
  view,
  unavailable,
  maintenance,
  busy,
  execute,
}: {
  view?: ConsumerUpdateView | undefined;
  unavailable?: boolean | undefined;
  maintenance?: boolean | undefined;
  busy: boolean;
  execute(command: ConsumerUpdateCommand): Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  if (view?.distribution === "microsoft-store")
    return (
      <section className="panel" aria-label={t("MusicMute updates")}>
        <h2>{t("MusicMute updates")}</h2>
        <p role="status">
          {t("Microsoft Store manages app and worker updates.")}
        </p>
        <div className="actions">
          {(["gui", "worker"] as const).map((product) => (
            <button
              key={product}
              disabled={busy || unavailable}
              onClick={() =>
                void execute({
                  version: 1,
                  request_id: crypto.randomUUID(),
                  action: "store_open",
                  product,
                })
              }
            >
              {t(
                product === "gui"
                  ? "Open MusicMute in Microsoft Store"
                  : "Open MusicMute Worker in Microsoft Store",
              )}
            </button>
          ))}
        </div>
      </section>
    );
  const send = (action: "check" | "install" | "recover") =>
    execute({ version: 1, request_id: crypto.randomUUID(), action });
  const active =
    view &&
    ["downloading", "activating", "health-check", "restart-required"].includes(
      view.phase,
    ) &&
    view.problem !== "UPDATE_RECOVERY_REQUIRED";
  return (
    <section className="panel" aria-label={t("MusicMute updates")}>
      <h2>{t("MusicMute updates")}</h2>
      <p role="status">
        {t(
          unavailable
            ? "Update checks are unavailable in this application package."
            : view
              ? phases[view.phase]
              : "Opening update settings…",
        )}
      </p>
      {view?.required && (
        <p role="alert">
          {t(
            "Install the required update to continue using online processing.",
          )}
        </p>
      )}
      {view?.available && (
        <dl>
          <dt>{t("App version")}</dt>
          <dd>{view.available.app.version}</dd>
          {view.scope === "prepared" && (
            <>
              <dt>{t("Runtime version")}</dt>
              <dd>{view.available.runtime.version}</dd>
              <dt>{t("Model version")}</dt>
              <dd>{view.available.model.version}</dd>
            </>
          )}
        </dl>
      )}
      {view?.scope === "app-only" && (
        <p>
          {t(
            "This update installs the app. Local GPU preparation remains a separate step.",
          )}
        </p>
      )}
      {view?.problem && (
        <p className="error" role="alert">
          {t(
            "The update could not finish. Close active processing and playback, then retry recovery.",
          )}
        </p>
      )}
      <label className="check-row">
        <input
          type="checkbox"
          checked={view?.automaticDiscovery ?? false}
          disabled={busy || !view || unavailable || maintenance || !!active}
          onChange={(event) =>
            void execute({
              version: 1,
              request_id: crypto.randomUUID(),
              action: "automatic_discovery",
              enabled: event.target.checked,
            })
          }
        />
        {t("Check for updates when MusicMute opens")}
      </label>
      <div className="actions">
        <button
          disabled={busy || unavailable || !view || maintenance || !!active}
          onClick={() => void send("check")}
        >
          {t("Check for updates")}
        </button>
        <button
          disabled={
            busy ||
            unavailable ||
            !view?.available ||
            maintenance ||
            view.phase !== "available"
          }
          onClick={() => setConfirm(true)}
        >
          {t("Install update")}
        </button>
        <button
          disabled={
            busy ||
            unavailable ||
            !view ||
            !!active ||
            !["blocked", "waiting", "rolled-back", "restart-required"].includes(
              view.phase,
            )
          }
          onClick={() => void send("recover")}
        >
          {t("Recover update")}
        </button>
      </div>
      {confirm && (
        <ModalDialog
          label={t("Confirm MusicMute update")}
          busy={busy}
          onClose={() => setConfirm(false)}
        >
          <p>
            {t(
              "Finish processing and stop playback before installing. MusicMute may close while the installer runs. Your Library, account, and worker identity are retained.",
            )}
          </p>
          <button
            disabled={busy || maintenance}
            onClick={() => {
              setConfirm(false);
              void send("install");
            }}
          >
            {t("Install update")}
          </button>
          <button
            data-dialog-initial-focus
            disabled={busy}
            onClick={() => setConfirm(false)}
          >
            {t("Cancel")}
          </button>
        </ModalDialog>
      )}
    </section>
  );
}

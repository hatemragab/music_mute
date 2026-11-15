import { ModalDialog } from "./dialog.js";
import { t } from "./i18n.js";
import { useState } from "react";
import { FIXED_SHORTCUTS, TEXT_SHORTCUTS } from "./shortcuts.js";
import type {
  DesktopPreferences,
  PreferencesCommand,
  PreferencesView,
} from "../shared/preferences-contracts.js";
export function PreferencesPanel({
  view,
  busy,
  execute,
}: {
  view?: PreferencesView;
  busy: boolean;
  execute(command: PreferencesCommand): Promise<void>;
}) {
  const [reset, setReset] = useState(false);
  if (!view) return <p role="status">{"" + t("Opening preferences…") + ""}</p>;
  const set = (patch: Partial<Omit<DesktopPreferences, "version">>) =>
    execute({ type: "SET", patch });
  const enabled = view.state === "ready" && !busy;
  return (
    <section className="panel" aria-label={t("Preferences")}>
      <h2>{"" + t("Preferences") + ""}</h2>
      {view.state === "error" && (
        <p role="alert" className="error">
          {"" +
            t(
              "Saved preferences could not be read. Reset them to restore the defaults; your audio and account remain saved.",
            ) +
            ""}
        </p>
      )}
      <div className="settings-grid">
        <label>
          {"" + t("Appearance") + ""}
          <select
            disabled={!enabled}
            value={view.value.appearance}
            onChange={(event) =>
              void set({
                appearance: event.target
                  .value as DesktopPreferences["appearance"],
              })
            }
          >
            <option value="system">{"" + t("System") + ""}</option>
            <option value="light">{"" + t("Light") + ""}</option>
            <option value="dark">{"" + t("Dark") + ""}</option>
          </select>
        </label>
        <label>
          {"" + t("Accent") + ""}
          <select
            disabled={!enabled}
            value={view.value.accent}
            onChange={(event) =>
              void set({
                accent: event.target.value as DesktopPreferences["accent"],
              })
            }
          >
            <option value="orange">{"" + t("Orange") + ""}</option>
            <option value="mint">{"" + t("Mint") + ""}</option>
            <option value="blue">{"" + t("Blue") + ""}</option>
            <option value="purple">{"" + t("Purple") + ""}</option>
          </select>
        </label>
        <label>
          {"" + t("Text size") + ""}
          <select
            disabled={!enabled}
            value={view.value.textSize}
            onChange={(event) =>
              void set({
                textSize: event.target.value as DesktopPreferences["textSize"],
              })
            }
          >
            {[
              ["system", t("System")],
              ["compact", t("Compact")],
              ["small", t("Small")],
              ["standard", t("Standard")],
              ["large", t("Large")],
              ["extraLarge", t("Extra Large")],
              ["accessibility", t("Accessibility")],
            ].map(([value, title]) => (
              <option key={value} value={value}>
                {title}
              </option>
            ))}
          </select>
        </label>
        <label>
          {"" + t("Language") + ""}
          <select
            disabled={!enabled}
            value={view.value.language}
            onChange={(event) =>
              void set({
                language: event.target.value as DesktopPreferences["language"],
              })
            }
          >
            <option value="system">{"" + t("Automatic") + ""}</option>
            <option value="en">{"" + t("English") + ""}</option>
            <option value="ar">العربية</option>
          </select>
        </label>
        <label>
          {"" + t("Default import source") + ""}
          <select
            disabled={!enabled}
            value={view.value.importSource}
            onChange={(event) =>
              void set({
                importSource: event.target
                  .value as DesktopPreferences["importSource"],
              })
            }
          >
            <option value="file">{"" + t("Selected file") + ""}</option>
            <option value="youtube">{"" + t("YouTube link") + ""}</option>
          </select>
        </label>
      </div>
      <label className="check-row">
        <input
          disabled={!enabled}
          type="checkbox"
          checked={view.value.expandPlayer}
          onChange={(event) => void set({ expandPlayer: event.target.checked })}
        />
        {"" + t("Expand the player by default") + ""}
      </label>
      <label className="check-row">
        <input
          disabled={!enabled}
          type="checkbox"
          checked={view.value.restoreLastPage}
          onChange={(event) =>
            void set({ restoreLastPage: event.target.checked })
          }
        />
        {"" + t("Open the last page when MusicMute starts") + ""}
      </label>
      <p className="muted">
        {"" +
          t(
            "Processing location is saved from Home. Your Chrome extension follows the shared processing setting.",
          ) +
          ""}
      </p>
      <details>
        <summary>{"" + t("Keyboard shortcuts") + ""}</summary>
        <dl>
          {[...FIXED_SHORTCUTS, ...TEXT_SHORTCUTS].map((row) => (
            <div key={row.chord}>
              <dt>{t(row.label)}</dt>
              <dd>
                <kbd>{row.chord}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      </details>
      <button disabled={busy} onClick={() => setReset(true)}>
        {"" + t("Reset preferences") + ""}
      </button>
      {reset && (
        <ModalDialog
          label={t("Confirm preferences reset")}
          busy={busy}
          onClose={() => setReset(false)}
        >
          <p>
            {"" +
              t(
                "Restore the default preferences? Audio, accounts, and worker enrollment are retained.",
              ) +
              ""}
          </p>
          <button
            disabled={busy}
            onClick={() => {
              void execute({ type: "RESET", confirmed: true });
              setReset(false);
            }}
          >
            {"" + t("Confirm reset") + ""}
          </button>
          <button
            data-dialog-initial-focus
            disabled={busy}
            onClick={() => setReset(false)}
          >
            {"" + t("Keep preferences") + ""}
          </button>
        </ModalDialog>
      )}
    </section>
  );
}

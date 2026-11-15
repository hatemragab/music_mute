import { useEffect, useState } from "react";
import type { OutboxCommand, OutboxView } from "../shared/outbox-contracts.js";
import { ModalDialog } from "./dialog.js";
import { t } from "./i18n.js";
const states = {
  capturing: "Keeping a safe copy",
  pending: "Waiting to save",
  saving: "Saving to your account",
  retry: "Save will retry",
  blocked: "Save needs attention",
  saved: "Saved to your account",
  discarded: "Save discarded",
};
export function OutboxPanel({
  view,
  busy,
  execute,
}: {
  view?: OutboxView;
  busy: boolean;
  execute(command: OutboxCommand): Promise<void>;
}) {
  const [discard, setDiscard] = useState<string>();
  useEffect(() => setDiscard(undefined), [view?.authenticated]);
  if (!view?.authenticated) return null;
  return (
    <section className="panel" aria-label={t("Background account saves")}>
      <h2>{t("Background account saves")}</h2>
      <p className="muted">
        {t(
          "Saving continues independently of playback. Pending copies stay on this PC until saved or discarded.",
        )}
      </p>
      {view.errorCode && (
        <p role="alert">
          {t("Background saving needs attention. Your retained audio is kept.")}
        </p>
      )}
      {!view.items.length && <p>{t("No pending account saves.")}</p>}
      {view.items.some((item) => ["pending", "retry"].includes(item.state)) && (
        <button
          disabled={busy || view.busy}
          onClick={() => void execute({ type: "SAVE_PENDING" })}
        >
          {t("Save pending audio")}
        </button>
      )}
      <ul className="outbox-items">
        {view.items.map((item) => (
          <li key={item.requestId}>
            <bdi>{item.title}</bdi> ·{" "}
            <span role="status">{t(states[item.state])}</span>
            {item.errorCode && (
              <p className="muted">
                {t(
                  "This save could not finish. Retry with the same account or discard its pending copy.",
                )}
              </p>
            )}
            {["retry", "blocked"].includes(item.state) && (
              <button
                disabled={busy}
                onClick={() =>
                  void execute({ type: "RETRY", requestId: item.requestId })
                }
              >
                {t("Retry save")}
              </button>
            )}
            {!["saved", "discarded"].includes(item.state) && (
              <button
                disabled={busy}
                onClick={() => setDiscard(item.requestId)}
              >
                {t("Discard pending save")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {discard && (
        <ModalDialog
          label={t("Confirm pending save discard")}
          busy={busy}
          onClose={() => setDiscard(undefined)}
        >
          <p>
            {t(
              "Discard this pending account save? Its retained upload copy will be removed. Your Library result is kept.",
            )}
          </p>
          <button
            disabled={busy}
            onClick={() => {
              const requestId = discard;
              setDiscard(undefined);
              void execute({ type: "DISCARD", requestId });
            }}
          >
            {t("Confirm discard")}
          </button>
          <button
            data-dialog-initial-focus
            disabled={busy}
            onClick={() => setDiscard(undefined)}
          >
            {t("Keep pending save")}
          </button>
        </ModalDialog>
      )}
    </section>
  );
}

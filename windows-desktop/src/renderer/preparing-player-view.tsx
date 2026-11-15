import { useState } from "react";
import type { PersonalJobView } from "../shared/personal-contracts.js";
import { t } from "./i18n.js";
import { personalWaitText } from "./personal-view.js";

/** An accepted desktop intent can be visible before any verified audio exists. */
export function PreparingPlayerPanel({
  job,
  cancel,
}: {
  job?: PersonalJobView;
  cancel(): Promise<void>;
}) {
  const [cancelling, setCancelling] = useState(false);
  if (job?.state === "failed" || job?.state === "cancelled") return null;
  const waiting = personalWaitText(job);
  return (
    <section className="player-panel" aria-label={t("Preparing playback")}>
      <div className="player-heading">
        <strong>
          <bdi>{job?.name ?? t("Your audio")}</bdi>
        </strong>
        <span role="status">{waiting ?? t("Preparing playback…")}</span>
      </div>
      <p>
        {t(
          "Your voice is being prepared. Playback starts after the audio is verified.",
        )}
      </p>
      <progress
        aria-label={t("Preparing playback progress")}
        {...(job?.state === "preparing" && job.progress !== null && !waiting
          ? { value: job.progress * 100, max: 100 }
          : {})}
      />
      <button
        disabled={cancelling}
        onClick={() => {
          setCancelling(true);
          void cancel().finally(() => setCancelling(false));
        }}
      >
        {cancelling ? t("Cancelling…") : t("Cancel pending playback")}
      </button>
    </section>
  );
}

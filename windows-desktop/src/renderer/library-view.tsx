import { ModalDialog } from "./dialog.js";
import { t, trackCount } from "./i18n.js";
import { useEffect, useState } from "react";
import type {
  LibraryAction,
  LibraryView,
  LibraryQuery,
  LibraryTrackView,
} from "../shared/library-contracts.js";
import type {
  HistoryCommand,
  HistoryView,
} from "../shared/history-contracts.js";
export function LibraryPanel({
  view,
  history,
  busy,
  execute,
  play,
  queue,
  playNext,
  download,
  exportTrack,
  shareTrack,
  shareResult,
  nextPage,
  historyCommand,
  saveToAccount,
  accountSavingAvailable = false,
}: {
  view?: LibraryView;
  history?: HistoryView;
  busy: boolean;
  execute(command: LibraryAction): Promise<void>;
  play(id: string, variant?: "voice" | "original"): void;
  queue(id: string): void;
  playNext?(id: string): void;
  download(id: string, variant: "voice" | "original"): Promise<void>;
  exportTrack(id: string, variant: "voice" | "original"): Promise<void>;
  shareTrack?(id: string, variant: "voice" | "original"): Promise<void>;
  shareResult?: "completed" | "cancelled" | "pending" | undefined;
  nextPage(): Promise<void>;
  historyCommand(command: HistoryCommand): Promise<void>;
  saveToAccount?(id: string): Promise<void>;
  accountSavingAvailable?: boolean;
}) {
  const [editing, setEditing] = useState<string>(),
    [title, setTitle] = useState(""),
    [deleting, setDeleting] = useState<{
      id: string;
      kind: "account" | "local";
    }>(),
    [clear, setClear] = useState(false);
  useEffect(() => {
    setEditing(undefined);
    setDeleting(undefined);
  }, [view?.accountState]);
  if (!view) return <p role="status">{"" + t("Opening your Library…") + ""}</p>;
  const query = (patch: Partial<LibraryQuery>) =>
    execute({ type: "QUERY", query: { ...view.query, ...patch } });
  const byId = new Map(view.tracks.map((track) => [track.id, track])),
    rows = view.visibleIds
      .map((id) => byId.get(id))
      .filter((track): track is LibraryTrackView => !!track);
  return (
    <section className="library-panel" aria-label={t("Audio Library")}>
      {shareResult && (
        <p role="status">
          {t(
            shareResult === "completed"
              ? "Windows sharing completed."
              : shareResult === "cancelled"
                ? "Windows sharing was cancelled."
                : "Windows sharing is still pending. Its temporary audio is retained.",
          )}
        </p>
      )}
      <div className="library-filters">
        <label>
          {"" + t("Search Library") + ""}
          <input
            type="search"
            maxLength={300}
            value={view.query.search}
            onChange={(event) => void query({ search: event.target.value })}
          />
        </label>
        <label>
          {"" + t("Show") + ""}
          <select
            value={view.query.filter}
            onChange={(event) =>
              void query({
                filter: event.target.value as LibraryQuery["filter"],
              })
            }
          >
            {[
              ["all", t("All audio")],
              ["offline", t("On this PC")],
              ["online", t("Online")],
              ["starred", t("Starred")],
              ["removed", t("Hidden")],
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {"" + t("Sort") + ""}
          <select
            value={view.query.sort}
            onChange={(event) =>
              void query({ sort: event.target.value as LibraryQuery["sort"] })
            }
          >
            <option value="newest">{"" + t("Newest") + ""}</option>
            <option value="title">{"" + t("Title") + ""}</option>
            <option value="most-played">{"" + t("Most played") + ""}</option>
          </select>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={view.query.mostPlayedOnly}
            onChange={(event) =>
              void query({ mostPlayedOnly: event.target.checked })
            }
          />
          {"" + t("Played audio only") + ""}
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={view.query.starredOnly}
            onChange={(event) =>
              void query({ starredOnly: event.target.checked })
            }
          />
          {"" + t("Starred only") + ""}
        </label>
      </div>
      {view.accountState === "disconnected" && (
        <p role="status">
          {"" +
            t(
              "Your account is offline. Audio saved on this PC remains available.",
            ) +
            ""}
        </p>
      )}
      {view.state === "loading" && (
        <p role="status">{"" + t("Opening your audio…") + ""}</p>
      )}
      {(view.errorCode || view.accountState === "error") && (
        <p role="alert" className="error">
          {"" +
            t(
              "Some Library information is unavailable. Saved audio remains available when verified.",
            ) +
            ""}
        </p>
      )}
      {history && history.state !== "ready" && history.state !== "loading" && (
        <section className="panel" aria-label={t("Listening history recovery")}>
          <p role="alert">
            {"" +
              t("Listening history needs attention. Your audio is retained.") +
              ""}
          </p>
          {history.state === "recovery-required" && (
            <button
              disabled={busy}
              onClick={() => void historyCommand({ type: "RECOVER" })}
            >
              {"" + t("Restore last good history") + ""}
            </button>
          )}
          <button disabled={busy} onClick={() => setClear(true)}>
            {"" + t("Clear listening history") + ""}
          </button>
        </section>
      )}
      {clear && (
        <ModalDialog
          label={t("Confirm history clear")}
          busy={busy}
          onClose={() => setClear(false)}
        >
          <p>
            {"" +
              t(
                "Clear play counts and listening history for this account on this PC?",
              ) +
              ""}
          </p>
          <button
            disabled={busy}
            onClick={() => {
              void historyCommand({ type: "CLEAR" });
              setClear(false);
            }}
          >
            {"" + t("Confirm clear history") + ""}
          </button>
          <button
            data-dialog-initial-focus
            disabled={busy}
            onClick={() => setClear(false)}
          >
            {"" + t("Keep history") + ""}
          </button>
        </ModalDialog>
      )}
      <p className="muted">{trackCount(view.total)}</p>
      {!rows.length && view.state !== "loading" && (
        <p>{"" + t("No audio matches this view.") + ""}</p>
      )}
      <div className="library-tracks">
        {rows.map((track) => (
          <article className="library-track" key={track.id}>
            {track.thumbnailDataUrl ? (
              <img
                className="track-artwork"
                src={track.thumbnailDataUrl}
                alt=""
                loading="lazy"
              />
            ) : (
              <span className="track-artwork placeholder" aria-hidden="true">
                ≋
              </span>
            )}
            <div className="track-details">
              <h3>
                <bdi>{track.title}</bdi>
              </h3>
              <p className="muted">
                {Math.ceil(track.durationSeconds / 60)}
                {" " + t("min ·") + ""}{" "}
                {track.offline
                  ? t("On this PC")
                  : track.online
                    ? t("Online")
                    : t("Unavailable")}{" "}
                · {t("{count} plays", { count: track.playCount })}
              </p>
              <div className="track-actions">
                <button
                  className="primary"
                  disabled={busy || (!track.offline && !track.online)}
                  onClick={() => play(track.id)}
                >
                  {"" + t("Play") + ""}
                </button>
                {track.originalAvailable && (
                  <button
                    disabled={busy}
                    onClick={() => play(track.id, "original")}
                  >
                    {t("Play original")}
                  </button>
                )}
                <button
                  disabled={busy || (!track.offline && !track.online)}
                  onClick={() => queue(track.id)}
                >
                  {"" + t("Add to queue") + ""}
                </button>
                {playNext && (
                  <button
                    disabled={busy || (!track.offline && !track.online)}
                    onClick={() => playNext(track.id)}
                  >
                    {t("Play next")}
                  </button>
                )}
                <button
                  aria-pressed={track.starred}
                  disabled={busy}
                  onClick={() =>
                    void execute({ type: "STAR", trackId: track.id })
                  }
                >
                  {track.starred ? t("Unstar") : t("Star")}
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void execute({
                      type: track.removed ? "RESTORE" : "HIDE",
                      trackId: track.id,
                    })
                  }
                >
                  {track.removed ? t("Restore") : t("Hide")}
                </button>
              </div>
              <details>
                <summary>{"" + t("Audio actions") + ""}</summary>
                <div className="track-actions">
                  {saveToAccount &&
                    track.id.startsWith("local:") &&
                    !track.accountOwned &&
                    track.trimEnabled &&
                    track.offline && (
                      <p className="muted" role="status">
                        {t(
                          "Account saving requires untrimmed audio. You can still play, export or share this trimmed voice.",
                        )}
                      </p>
                    )}
                  {saveToAccount &&
                    track.id.startsWith("local:") &&
                    !track.accountOwned &&
                    !track.trimEnabled &&
                    track.offline &&
                    track.originalAvailable && (
                      <button
                        disabled={busy || !accountSavingAvailable}
                        onClick={() => void saveToAccount(track.id)}
                        title={
                          !accountSavingAvailable
                            ? t("Sign in to save this audio to your account.")
                            : undefined
                        }
                      >
                        {t("Save to my account")}
                      </button>
                    )}
                  {track.accountOwned && track.online && !track.offline && (
                    <button
                      disabled={busy}
                      onClick={() => void download(track.id, "voice")}
                    >
                      {"" + t("Save voice on this PC") + ""}
                    </button>
                  )}
                  {track.canExport && (
                    <>
                      {shareTrack && (
                        <button
                          disabled={busy}
                          onClick={() => void shareTrack(track.id, "voice")}
                        >
                          {t("Share voice")}
                        </button>
                      )}
                      <button
                        disabled={busy}
                        onClick={() => void exportTrack(track.id, "voice")}
                      >
                        {"" + t("Export voice") + ""}
                      </button>
                    </>
                  )}
                  {track.originalAvailable && (
                    <>
                      {shareTrack && (
                        <button
                          disabled={busy}
                          onClick={() => void shareTrack(track.id, "original")}
                        >
                          {t("Share original")}
                        </button>
                      )}
                      {track.accountOwned && track.online && (
                        <button
                          disabled={busy}
                          onClick={() => void download(track.id, "original")}
                        >
                          {"" + t("Save original") + ""}
                        </button>
                      )}
                      <button
                        disabled={busy}
                        onClick={() => void exportTrack(track.id, "original")}
                      >
                        {"" + t("Export original") + ""}
                      </button>
                    </>
                  )}
                  {track.canRename && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        setEditing(track.id);
                        setTitle(track.title);
                      }}
                    >
                      {"" + t("Rename") + ""}
                    </button>
                  )}
                  {track.offline && track.accountOwned && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void execute({
                          type: "REMOVE_CACHE",
                          trackId: track.id,
                        })
                      }
                    >
                      {"" + t("Remove downloaded copy") + ""}
                    </button>
                  )}
                  {!track.accountOwned && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        setDeleting({ id: track.id, kind: "local" })
                      }
                    >
                      {"" + t("Delete local result") + ""}
                    </button>
                  )}
                  {track.canDeleteAccount && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        setDeleting({ id: track.id, kind: "account" })
                      }
                    >
                      {"" + t("Delete account item") + ""}
                    </button>
                  )}
                </div>
              </details>
            </div>
          </article>
        ))}
      </div>
      {editing && (
        <form
          className="panel"
          aria-label={t("Rename audio")}
          onSubmit={(event) => {
            event.preventDefault();
            void execute({ type: "RENAME", trackId: editing, title });
            setEditing(undefined);
          }}
        >
          <label>
            {"" + t("Audio title") + ""}
            <input
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
              required
            />
          </label>
          <button disabled={busy || !title.trim()}>
            {"" + t("Save title") + ""}
          </button>
          <button type="button" onClick={() => setEditing(undefined)}>
            {"" + t("Cancel rename") + ""}
          </button>
        </form>
      )}
      {deleting && (
        <ModalDialog
          label={t("Confirm audio deletion")}
          busy={busy}
          onClose={() => setDeleting(undefined)}
        >
          <p>
            {deleting.kind === "account"
              ? t("Delete this item from your MusicMute account?")
              : t(
                  "Delete this processed result from this PC? Your source file is retained.",
                )}
          </p>
          <button
            disabled={busy}
            onClick={() => {
              void execute(
                deleting.kind === "account"
                  ? {
                      type: "DELETE_ACCOUNT",
                      trackId: deleting.id,
                      confirmation: "delete-account-item",
                    }
                  : { type: "DELETE_LOCAL", trackId: deleting.id },
              );
              setDeleting(undefined);
            }}
          >
            {"" + t("Confirm deletion") + ""}
          </button>
          <button
            data-dialog-initial-focus
            disabled={busy}
            onClick={() => setDeleting(undefined)}
          >
            {"" + t("Keep audio") + ""}
          </button>
        </ModalDialog>
      )}
      {view.nextCursor && (
        <button
          disabled={busy || view.accountState !== "live"}
          onClick={() => void nextPage()}
        >
          {"" + t("Load more audio") + ""}
        </button>
      )}
      {history?.state === "ready" && (
        <button disabled={busy} onClick={() => setClear(true)}>
          {"" + t("Clear listening history") + ""}
        </button>
      )}
    </section>
  );
}

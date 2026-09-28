import { Link, useLocation } from "react-router";
import {
  Download,
  ExternalLink,
  Info,
  ListMusic,
  Music2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Repeat2,
  Shuffle,
  SkipBack,
  SkipForward,
  Star,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useSignedIn } from "../auth/AuthProvider";
import { friendlyError, useI18n } from "../i18n";
import { downloadJobArtifact } from "../jobs/artifacts";
import { useLibraryPreferences } from "../library/preferences";
import {
  hasNextTrack,
  LOOP_SECONDS,
  trackTitle,
  type RepeatMode,
} from "./playback";
import { usePlayer } from "./PlayerProvider";

function formatClock(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return `${Math.floor(safe / 60)}:${String(Math.floor(safe % 60)).padStart(2, "0")}`;
}

function Controls({ full = false }: { full?: boolean }) {
  const p = usePlayer();
  const { t, number } = useI18n();
  const rememberedVolume = useRef(p.volume || 1);
  const index = p.queue.findIndex((job) => job.id === p.current?.id);
  const nextDisabled = !hasNextTrack(
    p.queue.length,
    index,
    p.repeat,
    p.shuffle,
  );
  const previousDisabled = index <= 0 && p.time < 3;
  const repeatLabel =
    p.repeat === "one"
      ? t("repeatOne")
      : p.repeat === "all"
        ? t("repeatAll")
        : t("repeat");
  const RepeatIcon = p.repeat === "one" ? Repeat1 : Repeat;
  const knownDuration = p.duration || 0;
  const loopLeft =
    p.loop && knownDuration > 0
      ? `${(p.loop.start / knownDuration) * 100}%`
      : "0%";
  const loopWidth =
    p.loop && knownDuration > 0
      ? `${((p.loop.end - p.loop.start) / knownDuration) * 100}%`
      : "0%";

  function toggleMute() {
    if (p.volume > 0) {
      rememberedVolume.current = p.volume;
      p.setVolume(0);
    } else p.setVolume(rememberedVolume.current || 1);
  }

  return (
    <div className={full ? "player-controls full" : "player-controls"}>
      <div className="transport">
        <button
          type="button"
          className="skip"
          aria-label={t("previous")}
          disabled={previousDisabled}
          onClick={() => void p.previous()}
        >
          <SkipBack className="skip-icon" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="primary play"
          aria-label={p.playing ? t("pause") : t("play")}
          onClick={() => void p.toggle()}
        >
          {p.playing ? (
            <Pause aria-hidden="true" fill="currentColor" />
          ) : (
            <Play aria-hidden="true" fill="currentColor" />
          )}
        </button>
        <button
          type="button"
          className="skip"
          aria-label={t("next")}
          disabled={nextDisabled}
          onClick={() => void p.next()}
        >
          <SkipForward className="skip-icon" aria-hidden="true" />
        </button>
      </div>
      <div className="seek-row">
        <span>{formatClock(p.time)}</span>
        <div className="seek-field">
          {p.loop && (
            <span
              className="seek-loop"
              style={{
                insetInlineStart: loopLeft,
                width: loopWidth,
              }}
            />
          )}
          <input
            aria-label={t("seek")}
            type="range"
            min="0"
            max={knownDuration || 1}
            step="0.1"
            value={Math.min(p.time, knownDuration || 1)}
            onChange={(event) => p.seek(Number(event.target.value))}
          />
        </div>
        <span>{formatClock(knownDuration)}</span>
      </div>
      {full && (
        <>
          <div className="player-toolbar">
            <button
              type="button"
              className="tool"
              aria-pressed={p.shuffle}
              onClick={() => p.setShuffle(!p.shuffle)}
            >
              <Shuffle aria-hidden="true" />
              {t("shuffle")}
            </button>
            <button
              type="button"
              className="tool"
              aria-pressed={p.repeat !== "off"}
              aria-label={repeatLabel}
              onClick={() =>
                p.setRepeat(
                  (
                    { off: "all", all: "one", one: "off" } satisfies Record<
                      RepeatMode,
                      RepeatMode
                    >
                  )[p.repeat],
                )
              }
            >
              <RepeatIcon aria-hidden="true" />
              {repeatLabel}
            </button>
            <button
              type="button"
              className="tool"
              aria-pressed={Boolean(p.loop)}
              disabled={!p.loop && knownDuration <= 0.3}
              onClick={() => p.toggleLoop()}
            >
              <Repeat2 aria-hidden="true" />
              {p.loop ? t("loopPartStop") : t("loopPart")}
            </button>
            {p.loop && (
              <span className="loop-range">
                {formatClock(p.loop.start)}–{formatClock(p.loop.end)}
              </span>
            )}
            <label className="check tool-check">
              <input
                type="checkbox"
                checked={p.autoNext}
                onChange={(event) => p.setAutoNext(event.target.checked)}
              />
              {t("autoNext")}
            </label>
            <label className="tool-select">
              {t("speed")}
              <select
                aria-label={t("speed")}
                value={p.speed}
                onChange={(event) => p.setSpeed(Number(event.target.value))}
              >
                {[0.75, 1, 1.25, 1.5, 2].map((speed) => (
                  <option key={speed} value={speed}>
                    {number(speed)}×
                  </option>
                ))}
              </select>
            </label>
            <div className="volume-control">
              <button
                type="button"
                className="tool icon-only"
                aria-label={p.volume > 0 ? t("mute") : t("unmute")}
                onClick={toggleMute}
              >
                {p.volume > 0 ? (
                  <Volume2 aria-hidden="true" />
                ) : (
                  <VolumeX aria-hidden="true" />
                )}
              </button>
              <input
                aria-label={t("volume")}
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={p.volume}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (next > 0) rememberedVolume.current = next;
                  p.setVolume(next);
                }}
              />
            </div>
          </div>
          <p className="player-hint">{t("playerHint")}</p>
        </>
      )}
    </div>
  );
}

function seekFromPointer(
  event: MouseEvent<HTMLButtonElement>,
  duration: number,
  seek: (time: number) => void,
) {
  if (duration <= 0) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const ratio = Math.min(
    1,
    Math.max(0, (event.clientX - rect.left) / rect.width),
  );
  const rtl = document.documentElement.dir === "rtl";
  seek((rtl ? 1 - ratio : ratio) * duration);
}

export function MiniPlayer() {
  const p = usePlayer();
  const { pathname } = useLocation();
  const { t } = useI18n();
  if (!p.current || pathname === "/player") return null;
  const title = trackTitle(p.current, t("untitledTrack"));
  const progress =
    p.duration > 0 ? Math.min(100, (p.time / p.duration) * 100) : 0;
  return (
    <aside className="mini-player" aria-label={t("player")}>
      <button
        type="button"
        className="mini-progress"
        aria-label={t("seek")}
        onClick={(event) => seekFromPointer(event, p.duration, p.seek)}
      >
        <span style={{ width: `${progress}%` }} />
      </button>
      <div className="mini-cover" aria-hidden="true">
        <Music2 />
      </div>
      <div className="mini-meta">
        <Link to="/player" dir="auto">
          {title}
        </Link>
        <small role={p.error ? "alert" : undefined}>
          {p.error
            ? friendlyError(new Error(p.error), t)
            : p.original
              ? t("inputTrack")
              : t("outputTrack")}
        </small>
      </div>
      <Controls />
      <Link className="mini-open" to="/player" aria-label={t("open")}>
        <ExternalLink aria-hidden="true" />
      </Link>
    </aside>
  );
}

export function PlayerPage() {
  const p = usePlayer();
  const { api, user } = useSignedIn();
  const { t, number } = useI18n();
  const { preferences, toggle } = useLibraryPreferences(user.uid);
  const [actionError, setActionError] = useState("");
  const title = p.current ? trackTitle(p.current, t("untitledTrack")) : "";

  useEffect(() => {
    if (!p.current) return;
    function onKey(event: KeyboardEvent) {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(
            target.tagName,
          ))
      )
        return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === " ") {
        event.preventDefault();
        void p.toggle();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        p.seek(Math.min(p.duration || 0, p.time + (event.shiftKey ? 15 : 5)));
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        p.seek(Math.max(0, p.time - (event.shiftKey ? LOOP_SECONDS : 5)));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        p.setVolume(p.volume + 0.05);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        p.setVolume(p.volume - 0.05);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);

  async function saveOriginal() {
    if (!p.current) return;
    setActionError("");
    try {
      await downloadJobArtifact(api, p.current.id, "input");
    } catch (error) {
      setActionError(friendlyError(error, t));
    }
  }
  return (
    <div className="page-stack player-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{t("result")}</p>
          <h1>{t("player")}</h1>
        </div>
      </header>
      {!p.current ? (
        <div className="empty-state">{t("noTrack")}</div>
      ) : (
        <>
          <div className="player-art">
            <Music2 aria-hidden="true" />
          </div>
          <h2 className="player-title" dir="auto">
            {title}
          </h2>
          <p className="player-subtitle">
            {p.original ? t("inputTrack") : t("outputTrack")}
          </p>
          <div className="player-primary-actions">
            <button
              type="button"
              aria-label={t(
                preferences.favorites.includes(p.current.id)
                  ? "unfavorite"
                  : "favorite",
              )}
              aria-pressed={preferences.favorites.includes(p.current.id)}
              onClick={() => toggle("favorites", p.current!.id)}
            >
              <Star
                aria-hidden="true"
                fill={
                  preferences.favorites.includes(p.current.id)
                    ? "currentColor"
                    : "none"
                }
              />
              {t(
                preferences.favorites.includes(p.current.id)
                  ? "unfavorite"
                  : "favorite",
              )}
            </button>
            {p.current.canDownloadInput && (
              <button type="button" onClick={() => void saveOriginal()}>
                <Download aria-hidden="true" />
                {t("saveOriginal")}
              </button>
            )}
            <Link to={`/jobs/${p.current.id}`} className="button-link">
              <Info aria-hidden="true" />
              {t("details")}
            </Link>
          </div>
          <div
            className="track-selector"
            role="group"
            aria-label={t("trackVersion")}
          >
            <button
              type="button"
              className={!p.original ? "selected" : ""}
              aria-pressed={!p.original}
              onClick={() => void p.selectOriginal(false)}
            >
              {t("outputTrack")}
            </button>
            <button
              type="button"
              className={p.original ? "selected" : ""}
              aria-pressed={p.original}
              disabled={!p.current.canDownloadInput}
              title={
                p.current.canDownloadInput
                  ? undefined
                  : t("originalUnavailable")
              }
              onClick={() => void p.selectOriginal(true)}
            >
              {t("inputTrack")}
            </button>
          </div>
          <Controls full />
          {p.error && (
            <p role="alert" className="notice">
              {friendlyError(new Error(p.error), t)}
            </p>
          )}
          {actionError && (
            <p role="alert" className="notice">
              {actionError}
            </p>
          )}
          <section className="panel queue-panel">
            <h3 className="section-title">
              <ListMusic aria-hidden="true" />
              {t("queue")}
              <span className="queue-count">{number(p.queue.length)}</span>
            </h3>
            <ol className="queue-list">
              {p.queue.map((job, position) => {
                const current = p.current?.id === job.id;
                const label = trackTitle(job, t("untitledTrack"));
                return (
                  <li key={job.id} className={current ? "current" : ""}>
                    <button
                      className="queue-track"
                      type="button"
                      aria-current={current ? "true" : undefined}
                      onClick={() => void p.play(job, p.queue)}
                    >
                      <span className="queue-index">
                        {number(position + 1)}
                      </span>
                      <span className="queue-name" dir="auto">
                        {label}
                      </span>
                      {current && (
                        <span className="queue-now">{t("nowPlaying")}</span>
                      )}
                    </button>
                    {!current && (
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={t("removeFromQueue")}
                        onClick={() => p.removeFromQueue(job.id)}
                      >
                        <X aria-hidden="true" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        </>
      )}
    </div>
  );
}

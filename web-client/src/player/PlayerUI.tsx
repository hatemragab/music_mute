import { Link } from "react-router";
import { friendlyError, useI18n } from "../i18n";
import { usePlayer } from "./PlayerProvider";

function Controls({ full = false }: { full?: boolean }) {
  const p = usePlayer();
  const { t, number } = useI18n();
  const format = (seconds: number) =>
    `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  return (
    <div className={full ? "player-controls full" : "player-controls"}>
      <div className="transport">
        <button
          type="button"
          aria-label={t("previous")}
          onClick={() => void p.previous()}
        >
          ⏮
        </button>
        <button
          type="button"
          className="primary round"
          aria-label={p.playing ? t("pause") : t("play")}
          onClick={() => void p.toggle()}
        >
          {p.playing ? "Ⅱ" : "▶"}
        </button>
        <button
          type="button"
          aria-label={t("next")}
          onClick={() => void p.next()}
        >
          ⏭
        </button>
      </div>
      <div className="seek-row">
        <span>{format(p.time)}</span>
        <input
          aria-label={t("seek")}
          type="range"
          min="0"
          max={p.duration || 1}
          step="0.1"
          value={Math.min(p.time, p.duration || 1)}
          onChange={(event) => p.seek(Number(event.target.value))}
        />
        <span>{format(p.duration)}</span>
      </div>
      {full && (
        <div className="player-options">
          <button
            type="button"
            aria-pressed={p.shuffle}
            onClick={() => p.setShuffle(!p.shuffle)}
          >
            {t("shuffle")}
          </button>
          <button
            type="button"
            aria-pressed={p.repeat}
            onClick={() => p.setRepeat(!p.repeat)}
          >
            {t("repeat")}
          </button>
          <label>
            {t("speed")}{" "}
            <select
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
          <label>
            {t("volume")}
            <input
              aria-label={t("volume")}
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={p.volume}
              onChange={(event) => p.setVolume(Number(event.target.value))}
            />
          </label>
        </div>
      )}
    </div>
  );
}

export function MiniPlayer() {
  const p = usePlayer();
  const { t } = useI18n();
  if (!p.current) return null;
  return (
    <aside className="mini-player" aria-label={t("player")}>
      <div className="mini-cover" aria-hidden="true">
        ♫
      </div>
      <div className="mini-meta">
        <Link to="/player" dir="auto">
          {p.current.displayName || p.current.sourceTitle || p.current.id}
        </Link>
        {p.error && (
          <small role="alert">{friendlyError(new Error(p.error), t)}</small>
        )}
      </div>
      <Controls />
      <Link className="mini-open" to="/player" aria-label={t("open")}>
        ↗
      </Link>
    </aside>
  );
}

export function PlayerPage() {
  const p = usePlayer();
  const { t } = useI18n();
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
            <span aria-hidden="true">♫</span>
          </div>
          <h2 dir="auto">
            {p.current.displayName || p.current.sourceTitle || p.current.id}
          </h2>
          <Controls full />
          {p.error && (
            <p role="alert" className="notice">
              {friendlyError(new Error(p.error), t)}
            </p>
          )}
          <section className="panel">
            <h3>{t("queue")}</h3>
            <ol className="queue-list">
              {p.queue.map((job) => (
                <li key={job.id}>
                  <button
                    type="button"
                    aria-current={p.current?.id === job.id ? "true" : undefined}
                    onClick={() => void p.play(job, p.queue)}
                    dir="auto"
                  >
                    {job.displayName || job.sourceTitle || job.id}
                  </button>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </div>
  );
}

import { t } from "./i18n.js";
import { useEffect, useRef, useState } from "react";
import type {
  PlaybackUiCommand,
  PlaybackView,
} from "../shared/playback-contracts.js";
import type { PlaybackBookmark } from "../shared/listening-contracts.js";

function time(seconds: number): string {
  const safe = Math.floor(Math.max(0, Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}
/** Media events carry the generation of this exact element. Main owns media identity and logical time. */
function PlaybackAudio({
  view,
  execute,
}: {
  view: PlaybackView;
  execute(command: PlaybackUiCommand): Promise<void>;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const alive = useRef(true);
  const event = (
    kind: Extract<PlaybackUiCommand, { type: "MEDIA_EVENT" }>["event"],
  ) => {
    const value = ref.current?.currentTime ?? 0;
    if (alive.current && Number.isFinite(value) && value >= 0 && value <= 7200)
      void execute({
        type: "MEDIA_EVENT",
        generation: view.generation,
        event: kind,
        position: value,
        ...(kind === "seeked" ? { seekRevision: view.seekRevision } : {}),
      });
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    if (view.requestedPlaying)
      void audio.play().catch(() => {
        if (alive.current) event("error");
      });
    else audio.pause();
  }, [view.requestedPlaying, view.seekRevision]);
  useEffect(() => {
    if (ref.current) ref.current.playbackRate = view.rate;
  }, [view.rate]);
  useEffect(() => {
    if (ref.current) ref.current.muted = view.muted;
  }, [view.muted]);
  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    const target = view.volume;
    if (
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
      typeof requestAnimationFrame !== "function"
    ) {
      audio.volume = target;
      return;
    }
    const start = performance.now(),
      initial = audio.volume;
    let frame = 0;
    const step = (now: number) => {
      const fraction = Math.max(0, Math.min(1, (now - start) / 100));
      audio.volume = Math.max(
        0,
        Math.min(1, initial + (target - initial) * fraction),
      );
      if (fraction < 1 && alive.current) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [view.volume]);
  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    const seek = () => {
      if (alive.current) audio.currentTime = view.sourcePosition;
    };
    if (audio.readyState >= 1) seek();
    else audio.addEventListener("loadedmetadata", seek, { once: true });
    return () => audio.removeEventListener("loadedmetadata", seek);
  }, [view.seekRevision]);
  return (
    <audio
      ref={ref}
      src={view.url ?? undefined}
      preload="metadata"
      aria-label={t("MusicMute playback audio")}
      onLoadedMetadata={() => event("loaded")}
      onPlaying={() => event("playing")}
      onPause={() => event("paused")}
      onWaiting={() => event("buffering")}
      onStalled={() => event("buffering")}
      onTimeUpdate={() => event("time")}
      onEnded={() => event("ended")}
      onSeeked={() => event("seeked")}
      onError={() => event("error")}
    />
  );
}
export function PlayerPanel({
  view,
  title,
  execute,
  defaultExpanded,
  expandedChanged,
  tracks,
}: {
  view?: PlaybackView;
  title?: string;
  execute(command: PlaybackUiCommand): Promise<void>;
  defaultExpanded?: boolean;
  expandedChanged?(expanded: boolean): void;
  tracks?: readonly {
    id: string;
    title: string;
    thumbnailDataUrl?: string | null;
  }[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [sleepMinutes, setSleepMinutes] = useState("");
  const normalizedSleep = sleepMinutes
    .trim()
    .replace(/[٠-٩۰-۹]/gu, (digit) =>
      String(digit.charCodeAt(0) - (digit <= "٩" ? 0x660 : 0x6f0)),
    );
  const customMinutes = /^[0-9]{1,3}$/u.test(normalizedSleep)
    ? Number(normalizedSleep)
    : NaN;
  const validSleep =
    Number.isSafeInteger(customMinutes) &&
    customMinutes >= 1 &&
    customMinutes <= 720;
  useEffect(() => {
    if (defaultExpanded !== undefined) setExpanded(defaultExpanded);
  }, [defaultExpanded]);
  if (!view) return null;
  if (!view.trackId)
    return view.listening?.sleepRemainingSeconds !== null &&
      view.listening?.sleepRemainingSeconds !== undefined ? (
      <section className="player-panel" aria-label={t("Sleep timer")}>
        <p role="status">
          {t("Sleep timer · {time} remaining", {
            time: time(view.listening.sleepRemainingSeconds),
          })}
        </p>
        <button onClick={() => void execute({ type: "SLEEP", seconds: 0 })}>
          {"" + t("Cancel sleep timer") + ""}
        </button>
      </section>
    ) : null;
  const available = !!view.url && !["preparing", "error"].includes(view.phase);
  const send = (command: PlaybackUiCommand) => void execute(command);
  return (
    <section
      className="player-panel"
      aria-label={t("Audio player")}
      aria-busy={view.phase === "preparing"}
    >
      {view.url && (
        <PlaybackAudio key={view.generation} view={view} execute={execute} />
      )}
      <div className="player-heading">
        {tracks?.find((track) => track.id === view.trackId)
          ?.thumbnailDataUrl && (
          <img
            className="player-artwork"
            src={
              tracks.find((track) => track.id === view.trackId)!
                .thumbnailDataUrl!
            }
            alt=""
          />
        )}
        <strong>
          <bdi>{title ?? t("Your audio")}</bdi>
        </strong>
        <span role="status">
          {view.phase === "preparing"
            ? t("Preparing playback…")
            : view.phase === "buffering"
              ? t("Buffering…")
              : view.phase === "playing"
                ? t("Playing")
                : view.phase === "error"
                  ? t("Playback needs attention")
                  : t("Paused")}
        </span>
        <button
          aria-expanded={expanded}
          onClick={() => {
            setExpanded(!expanded);
            expandedChanged?.(!expanded);
          }}
        >
          {expanded ? t("Less playback controls") : t("More playback controls")}
        </button>
      </div>
      {view.error && (
        <p role="alert">
          {view.error === "COMPARISON_TIMELINE_UNAVAILABLE"
            ? t(
                "The original and voice timelines could not be verified for comparison.",
              )
            : t(
                "This audio is unavailable. Keep it offline again or choose another item.",
              )}
        </p>
      )}
      {view.timeCoordinate === "voice-output" && (
        <p role="status">
          {t("Voice timeline; original comparison is unavailable.")}
        </p>
      )}
      <div className="player-controls">
        <button
          aria-label={t("Previous track")}
          disabled={!available}
          onClick={() => send({ type: "PREVIOUS" })}
        >
          {"" + t("Previous") + ""}
        </button>
        <button
          className="primary"
          aria-label={
            view.requestedPlaying ? t("Pause playback") : t("Play playback")
          }
          disabled={!available}
          onClick={() =>
            send({ type: view.requestedPlaying ? "PAUSE" : "PLAY" })
          }
        >
          {view.requestedPlaying ? t("Pause") : t("Play")}
        </button>
        <button
          aria-label={t("Next track")}
          disabled={!available || (!view.queue.length && view.repeat === "off")}
          onClick={() => send({ type: "NEXT" })}
        >
          {"" + t("Next") + ""}
        </button>
        <button onClick={() => send({ type: "STOP" })}>
          {"" + t("Stop") + ""}
        </button>
        <button disabled={!available} onClick={() => send({ type: "RESTART" })}>
          {t("Restart")}
        </button>
        <button
          aria-pressed={view.variant === "original"}
          disabled={
            view.phase === "preparing" || view.comparisonAvailable === false
          }
          onClick={() =>
            send({
              type: "SOURCE",
              variant: view.variant === "voice" ? "original" : "voice",
            })
          }
        >
          {view.variant === "voice"
            ? t("Compare original")
            : t("Return to voice")}
        </button>
      </div>
      <label className="player-seek">
        {"" + t("Position ·") + ""}
        {time(view.position)} / {time(view.duration)}
        <input
          type="range"
          min={0}
          max={Math.max(0.1, view.duration)}
          step={0.1}
          value={Math.min(view.duration, view.position)}
          disabled={!available}
          onChange={(event) =>
            send({ type: "SEEK", seconds: Number(event.target.value) })
          }
        />
      </label>
      {expanded && (
        <div className="player-options">
          <label>
            {"" + t("Playback speed") + ""}
            <select
              value={view.rate}
              onChange={(event) =>
                send({ type: "RATE", rate: Number(event.target.value) })
              }
            >
              {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map((rate) => (
                <option key={rate} value={rate}>
                  {rate}×
                </option>
              ))}
            </select>
          </label>
          <label>
            {"" + t("Volume ·") + ""}
            {Math.round(view.volume * 100)}%
            <input
              aria-label={t("Playback volume")}
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(view.volume * 100)}
              onChange={(event) =>
                send({
                  type: "VOLUME",
                  level: Number(event.target.value) / 100,
                })
              }
            />
          </label>
          <button
            aria-pressed={view.muted}
            onClick={() => send({ type: "MUTE" })}
          >
            {view.muted ? t("Unmute") : t("Mute")}
          </button>
          <label>
            {"" + t("Repeat") + ""}
            <select
              value={view.repeat}
              onChange={(event) =>
                send({
                  type: "REPEAT",
                  mode: event.target.value as PlaybackView["repeat"],
                })
              }
            >
              <option value="off">{"" + t("Off") + ""}</option>
              <option value="track">{"" + t("This track") + ""}</option>
              <option value="queue">{"" + t("Queue") + ""}</option>
            </select>
          </label>
          <button
            aria-pressed={view.shuffle}
            onClick={() => send({ type: "SHUFFLE", enabled: !view.shuffle })}
          >
            {"" + t("Shuffle") + ""}
          </button>
          <div>
            <h3>{"" + t("Up Next") + ""}</h3>
            {view.queue.length > 0 && (
              <button
                disabled={view.queueRevision === undefined}
                onClick={() =>
                  view.queueRevision !== undefined &&
                  send({
                    type: "QUEUE_EDIT",
                    action: "clear",
                    generation: view.generation,
                    queueRevision: view.queueRevision,
                  })
                }
              >
                {t("Clear queue")}
              </button>
            )}
            {view.queue.length ? (
              <ol>
                {view.queue.map((id, index) => (
                  <li key={`${id}:${index}`}>
                    {tracks?.find((track) => track.id === id)
                      ?.thumbnailDataUrl && (
                      <img
                        className="queue-artwork"
                        src={
                          tracks.find((track) => track.id === id)!
                            .thumbnailDataUrl!
                        }
                        alt=""
                      />
                    )}
                    <button
                      disabled={view.queueRevision === undefined}
                      onClick={() =>
                        view.queueRevision !== undefined &&
                        send({
                          type: "QUEUE_PLAY",
                          trackId: id,
                          index,
                          generation: view.generation,
                          queueRevision: view.queueRevision,
                        })
                      }
                    >
                      <bdi>
                        {tracks?.find((track) => track.id === id)?.title ??
                          t("Queued audio")}
                      </bdi>
                    </button>
                    <button
                      disabled={view.queueRevision === undefined}
                      aria-label={t("Remove {name} from queue", {
                        name:
                          tracks?.find((track) => track.id === id)?.title ??
                          t("Audio"),
                      })}
                      onClick={() =>
                        view.queueRevision !== undefined &&
                        send({
                          type: "QUEUE_EDIT",
                          action: "remove",
                          trackId: id,
                          index,
                          generation: view.generation,
                          queueRevision: view.queueRevision,
                        })
                      }
                    >
                      {"" + t("Remove") + ""}
                    </button>
                    <button
                      disabled={index === 0 || view.queueRevision === undefined}
                      aria-label={t("Move {name} up", {
                        name:
                          tracks?.find((track) => track.id === id)?.title ??
                          t("Audio"),
                      })}
                      onClick={() =>
                        view.queueRevision !== undefined &&
                        send({
                          type: "QUEUE_EDIT",
                          action: "move",
                          trackId: id,
                          index,
                          to: index - 1,
                          generation: view.generation,
                          queueRevision: view.queueRevision,
                        })
                      }
                    >
                      {t("Move up")}
                    </button>
                    <button
                      disabled={
                        index === view.queue.length - 1 ||
                        view.queueRevision === undefined
                      }
                      aria-label={t("Move {name} down", {
                        name:
                          tracks?.find((track) => track.id === id)?.title ??
                          t("Audio"),
                      })}
                      onClick={() =>
                        view.queueRevision !== undefined &&
                        send({
                          type: "QUEUE_EDIT",
                          action: "move",
                          trackId: id,
                          index,
                          to: index + 1,
                          generation: view.generation,
                          queueRevision: view.queueRevision,
                        })
                      }
                    >
                      {t("Move down")}
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">
                {"" + t("Choose a Library item to build a queue.") + ""}
              </p>
            )}
          </div>
        </div>
      )}
      {expanded && view.listening && (
        <section
          className="listening-controls"
          aria-label={t("Listening controls")}
        >
          <div className="player-controls">
            <label>
              {"" + t("Sleep timer") + ""}
              <select
                value=""
                onChange={(event) =>
                  send({ type: "SLEEP", seconds: Number(event.target.value) })
                }
              >
                <option value="" disabled>
                  {"" + t("Choose duration") + ""}
                </option>
                {[5, 10, 15, 30, 45, 60, 90, 120].map((minutes) => (
                  <option key={minutes} value={minutes * 60}>
                    {t("{minutes} minutes", { minutes })}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("Custom sleep timer (minutes)")}
              <input
                type="text"
                inputMode="numeric"
                maxLength={3}
                value={sleepMinutes}
                aria-invalid={sleepMinutes.trim().length > 0 && !validSleep}
                onChange={(event) => setSleepMinutes(event.target.value)}
              />
            </label>
            <button
              disabled={!validSleep}
              onClick={() =>
                send({ type: "SLEEP", seconds: customMinutes * 60 })
              }
            >
              {t("Set custom sleep timer")}
            </button>
            {sleepMinutes.trim().length > 0 && !validSleep && (
              <p role="alert">
                {t("Enter a whole number of minutes from 1 to 720.")}
              </p>
            )}
            {view.listening.sleepRemainingSeconds !== null && (
              <>
                <p role="status">
                  {t("{time} remaining", {
                    time: time(view.listening.sleepRemainingSeconds),
                  })}
                </p>
                <button onClick={() => send({ type: "SLEEP", seconds: 0 })}>
                  {"" + t("Cancel sleep timer") + ""}
                </button>
              </>
            )}
          </div>
          <div
            className="player-controls"
            role="group"
            aria-label={t("AB loop")}
          >
            <button
              disabled={!available}
              onClick={() => send({ type: "LOOP_START" })}
            >
              {"" + t("Set A") + ""}{" "}
              {view.listening.loopStart !== null
                ? time(view.listening.loopStart)
                : ""}
            </button>
            <button
              disabled={!available || view.listening.loopStart === null}
              onClick={() => send({ type: "LOOP_END" })}
            >
              {"" + t("Set B") + ""}{" "}
              {view.listening.loopEnd !== null
                ? time(view.listening.loopEnd)
                : ""}
            </button>
            <button
              disabled={view.listening.loopStart === null}
              onClick={() => send({ type: "LOOP_CLEAR" })}
            >
              {"" + t("Clear AB loop") + ""}
            </button>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={
                view.listening.skipSilence || view.listening.analyzingSilence
              }
              disabled={!available || view.variant !== "voice"}
              onChange={(event) =>
                send({ type: "SKIP_SILENCE", enabled: event.target.checked })
              }
            />
            {"" + t("Skip quiet parts during voice playback") + ""}
          </label>
          {view.listening.analyzingSilence && (
            <p role="status">{"" + t("Preparing silence skipping…") + ""}</p>
          )}
          {view.listening.error && (
            <p role="alert">
              {view.listening.error === "SILENCE_UNAVAILABLE"
                ? t(
                    "Keep the voice offline before preparing silence skipping. Try again if analysis failed.",
                  )
                : t(
                    "Listening preferences could not be read or saved. An explicit edit will retain a damaged copy before repairing it.",
                  )}
            </p>
          )}
          <h3>{"" + t("Bookmarks") + ""}</h3>
          <button
            disabled={!available}
            onClick={() => send({ type: "BOOKMARK_ADD" })}
          >
            {"" + t("Bookmark this position") + ""}
          </button>
          {view.listening.bookmarks.length ? (
            <ul>
              {view.listening.bookmarks.map((bookmark) => (
                <BookmarkRow
                  key={bookmark.id}
                  bookmark={bookmark}
                  execute={execute}
                />
              ))}
            </ul>
          ) : (
            <p className="muted">
              {"" + t("Save a listening position to return to it later.") + ""}
            </p>
          )}
        </section>
      )}
    </section>
  );
}
function BookmarkRow({
  bookmark,
  execute,
}: {
  bookmark: PlaybackBookmark;
  execute(command: PlaybackUiCommand): Promise<void>;
}) {
  const [title, setTitle] = useState(bookmark.title);
  useEffect(() => setTitle(bookmark.title), [bookmark.title]);
  return (
    <li className="bookmark-row">
      <button
        onClick={() => void execute({ type: "BOOKMARK_SEEK", id: bookmark.id })}
      >
        {time(bookmark.seconds)} · <bdi>{bookmark.title}</bdi>
      </button>
      <label>
        {"" + t("Bookmark name") + ""}
        <input
          value={title}
          maxLength={80}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <button
        disabled={!title.trim() || title === bookmark.title}
        onClick={() =>
          void execute({
            type: "BOOKMARK_RENAME",
            id: bookmark.id,
            title: title.trim(),
          })
        }
      >
        {"" + t("Rename bookmark") + ""}
      </button>
      <button
        onClick={() =>
          void execute({ type: "BOOKMARK_REMOVE", id: bookmark.id })
        }
      >
        {"" + t("Delete bookmark") + ""}
      </button>
    </li>
  );
}

import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type SyntheticEvent,
} from "react";

export interface AudioComparisonCopy {
  tabListLabel: string;
  originalLabel: string;
  originalDescription: string;
  voiceLabel: string;
  voiceDescription: string;
  playerLabel: string;
  switchHint: string;
  unavailable: string;
  exampleNote: string;
}

export interface AudioComparisonProps {
  copy: AudioComparisonCopy;
  isRtl: boolean;
}

type AudioTrack = "original" | "voice";

interface PendingPlayback {
  track: AudioTrack;
  currentTime: number;
  shouldResume: boolean;
}

const AUDIO_TRACKS: readonly AudioTrack[] = ["original", "voice"];

const AUDIO_SOURCES: Record<AudioTrack, string> = {
  original: "/audio/original.webm",
  voice: "/audio/voice-only.mp3",
};

function otherTrack(track: AudioTrack): AudioTrack {
  return track === "original" ? "voice" : "original";
}

function keyboardTarget(
  currentTrack: AudioTrack,
  key: string,
): AudioTrack | null {
  if (key === "ArrowLeft" || key === "ArrowRight") {
    return otherTrack(currentTrack);
  }

  if (key === "Home") return "original";
  if (key === "End") return "voice";
  return null;
}

export function AudioComparison({ copy, isRtl }: AudioComparisonProps) {
  const [activeTrack, setActiveTrack] = useState<AudioTrack>("original");
  const [isUnavailable, setIsUnavailable] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingPlaybackRef = useRef<PendingPlayback | null>(null);
  const tabRefs = useRef<Partial<Record<AudioTrack, HTMLButtonElement>>>({});
  const instanceId = useId();

  const ids = {
    hint: `${instanceId}-audio-hint`,
    note: `${instanceId}-audio-note`,
    error: `${instanceId}-audio-error`,
  };

  const tabId = (track: AudioTrack) => `${instanceId}-${track}-tab`;
  const panelId = (track: AudioTrack) => `${instanceId}-${track}-panel`;
  const descriptionId = (track: AudioTrack) =>
    `${instanceId}-${track}-description`;

  const labelFor = (track: AudioTrack) =>
    track === "original" ? copy.originalLabel : copy.voiceLabel;
  const descriptionFor = (track: AudioTrack) =>
    track === "original" ? copy.originalDescription : copy.voiceDescription;

  const selectTrack = (nextTrack: AudioTrack, moveFocus = false) => {
    if (nextTrack !== activeTrack) {
      const audio = audioRef.current;
      const queuedPlayback = pendingPlaybackRef.current;
      const isWaitingForCurrentTrack = queuedPlayback?.track === activeTrack;
      const currentTime = isWaitingForCurrentTrack
        ? queuedPlayback.currentTime
        : (audio?.currentTime ?? 0);
      const shouldResume = isWaitingForCurrentTrack
        ? queuedPlayback.shouldResume
        : Boolean(audio && !audio.paused && !audio.ended);

      pendingPlaybackRef.current = {
        track: nextTrack,
        currentTime: Number.isFinite(currentTime) ? currentTime : 0,
        shouldResume,
      };

      audio?.pause();
      setIsUnavailable(false);
      setActiveTrack(nextTrack);
    }

    if (moveFocus) tabRefs.current[nextTrack]?.focus();
  };

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentTrack: AudioTrack,
  ) => {
    const nextTrack = keyboardTarget(currentTrack, event.key);
    if (!nextTrack) return;

    event.preventDefault();
    selectTrack(nextTrack, true);
  };

  const restorePlayback = (event: SyntheticEvent<HTMLAudioElement>) => {
    const pendingPlayback = pendingPlaybackRef.current;
    if (!pendingPlayback || pendingPlayback.track !== activeTrack) return;

    const audio = event.currentTarget;
    const duration = audio.duration;
    const targetTime = Number.isFinite(duration)
      ? Math.min(pendingPlayback.currentTime, duration)
      : pendingPlayback.currentTime;

    try {
      audio.currentTime = Math.max(0, targetTime);
    } catch {
      // Native controls remain usable when the browser cannot seek this source.
    }

    pendingPlaybackRef.current = null;
    setIsUnavailable(false);

    if (pendingPlayback.shouldResume) {
      void audio.play().catch(() => {
        // Autoplay policies may require the listener to press play again.
      });
    }
  };

  const describedBy = [
    descriptionId(activeTrack),
    ids.hint,
    ids.note,
    ...(isUnavailable ? [ids.error] : []),
  ].join(" ");

  return (
    <div
      className={`audio-comparison${isRtl ? " audio-comparison--rtl" : ""}`}
      dir={isRtl ? "rtl" : "ltr"}
    >
      <div
        className="audio-comparison__tabs"
        role="tablist"
        aria-label={copy.tabListLabel}
        aria-orientation="horizontal"
      >
        {AUDIO_TRACKS.map((track) => {
          const isActive = activeTrack === track;

          return (
            <button
              className={`audio-comparison__tab${isActive ? " audio-comparison__tab--active" : ""}`}
              id={tabId(track)}
              key={track}
              type="button"
              role="tab"
              aria-controls={panelId(track)}
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              ref={(element) => {
                tabRefs.current[track] = element ?? undefined;
              }}
              onClick={() => selectTrack(track)}
              onKeyDown={(event) => handleTabKeyDown(event, track)}
            >
              {labelFor(track)}
            </button>
          );
        })}
      </div>

      {AUDIO_TRACKS.map((track) => {
        const isActive = activeTrack === track;

        return (
          <div
            className="audio-comparison__panel"
            id={panelId(track)}
            key={track}
            role="tabpanel"
            aria-labelledby={tabId(track)}
            hidden={!isActive}
            tabIndex={0}
          >
            {isActive ? (
              <>
                <div className="audio-comparison__copy">
                  <p className="audio-comparison__player-label">
                    {copy.playerLabel}
                  </p>
                  <h3 className="audio-comparison__track-label">
                    {labelFor(track)}
                  </h3>
                  <p
                    className="audio-comparison__description"
                    id={descriptionId(track)}
                  >
                    {descriptionFor(track)}
                  </p>
                </div>

                <audio
                  className="audio-comparison__player"
                  key={track}
                  ref={audioRef}
                  controls
                  preload="metadata"
                  src={AUDIO_SOURCES[track]}
                  aria-label={`${copy.playerLabel}: ${labelFor(track)}`}
                  aria-describedby={describedBy}
                  onLoadedMetadata={restorePlayback}
                  onError={() => {
                    pendingPlaybackRef.current = null;
                    setIsUnavailable(true);
                  }}
                />

                <p className="audio-comparison__hint" id={ids.hint}>
                  {copy.switchHint}
                </p>
                {isUnavailable ? (
                  <p
                    className="audio-comparison__error"
                    id={ids.error}
                    role="status"
                  >
                    {copy.unavailable}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        );
      })}

      <p className="audio-comparison__note" id={ids.note}>
        {copy.exampleNote}
      </p>
    </div>
  );
}

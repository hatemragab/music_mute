import { t, createLocalizer } from "./i18n";
interface PlaybackWaveformSnapshot {
  visible: boolean;
  vocals: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
}

function timeLabel(seconds: number): string {
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Decorative bars show playback activity; the video's clock owns the timeline. */
export function createPlaybackWaveform() {
  const localizer = createLocalizer();
  const element = document.createElement("div");
  element.className = "musicmute-playback-waveform";
  element.hidden = true;
  const info = document.createElement("div");
  info.className = "musicmute-wave-info";
  const source = document.createElement("span");
  source.className = "musicmute-wave-source";
  source.setAttribute("aria-live", "polite");
  const time = document.createElement("span");
  time.className = "musicmute-wave-time";
  info.append(source, time);
  const track = document.createElement("div");
  track.className = "musicmute-wave-track";
  track.setAttribute("role", "progressbar");
  localizer.attribute(track, "aria-label", () => t("Video position"));
  track.setAttribute("aria-valuemin", "0");
  const heights = [30, 52, 38, 76, 60, 96, 48, 70, 40, 84];
  for (const layer of ["base", "played"]) {
    const bars = document.createElement("div");
    bars.className = `musicmute-wave-bars musicmute-wave-${layer}`;
    bars.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 40; index++) {
      const bar = document.createElement("span");
      bar.className = "musicmute-wave-bar";
      bar.style.height = `${heights[index % heights.length]}%`;
      bar.style.animationDelay = `${-(index * 137) % 1000}ms`;
      bars.append(bar);
    }
    track.append(bars);
  }
  element.append(info, track);
  let previousProgress = "";
  let previousPeriod = "";

  return {
    element,
    dispose: () => localizer.dispose(),
    update(snapshot: PlaybackWaveformSnapshot): void {
      element.hidden = !snapshot.visible;
      element.dataset.playing = String(
        snapshot.visible && snapshot.vocals && snapshot.playing,
      );
      element.dataset.vocals = String(snapshot.vocals);
      if (!snapshot.visible) return;
      const duration =
        Number.isFinite(snapshot.duration) && snapshot.duration > 0
          ? snapshot.duration
          : 0;
      const currentTime =
        duration > 0 && Number.isFinite(snapshot.currentTime)
          ? Math.min(duration, Math.max(0, snapshot.currentTime))
          : 0;
      const label = () =>
        snapshot.vocals ? t("Voice-only") : t("Original sound");
      if (source.textContent !== label()) localizer.text(source, label);
      const elapsed = timeLabel(currentTime);
      const total = duration > 0 ? timeLabel(duration) : "--:--";
      const timeText = `${elapsed} / ${total}`;
      if (time.textContent !== timeText) localizer.text(time, () => timeText);
      if (duration > 0) {
        track.setAttribute("aria-valuemax", String(duration));
        track.setAttribute("aria-valuenow", String(currentTime));
      } else {
        track.removeAttribute("aria-valuemax");
        track.removeAttribute("aria-valuenow");
      }
      localizer.attribute(track, "aria-valuetext", () =>
        duration > 0
          ? t("{0}: {1} of {2}", [label(), elapsed, total])
          : t("{0}: duration unavailable", [label()]),
      );
      const progress = `${duration > 0 ? (currentTime / duration) * 100 : 0}%`;
      if (progress !== previousProgress) {
        element.style.setProperty("--musicmute-wave-progress", progress);
        previousProgress = progress;
      }
      const rate =
        Number.isFinite(snapshot.playbackRate) && snapshot.playbackRate > 0
          ? Math.min(4, Math.max(0.25, snapshot.playbackRate))
          : 1;
      const period = `${1000 / rate}ms`;
      if (period !== previousPeriod) {
        element.style.setProperty("--musicmute-wave-period", period);
        previousPeriod = period;
      }
    },
  };
}

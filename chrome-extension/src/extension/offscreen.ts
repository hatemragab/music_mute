import { isExtensionMessage, type ExtensionMessage } from "./messages";
import { ClockSynchronizer, STALE_CLOCK_MS } from "./sync";
import { emitDiagnostic, installErrorCapture } from "./diagnostics";

installErrorCapture("offscreen");
let audio: HTMLAudioElement | null = null;
let generation = 0;
let synchronizer: ClockSynchronizer | null = null;
let loaded = false;
let lastClockAt = 0;
let playPending = false;
let playAttempt = 0;
let reportedPlaying = false;
let loadToken = 0;
let lastDriftReport = 0;
let requestedPlaying = false;
let bufferTimer: ReturnType<typeof setTimeout> | null = null;
let cancelLoad: (() => void) | null = null;
let removeAudioListeners: (() => void) | null = null;
function clearBufferWait(): void {
  if (bufferTimer) clearTimeout(bufferTimer);
  bufferTimer = null;
}

function notify(message: ExtensionMessage): void {
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}
function reportState(playing: boolean): void {
  if (reportedPlaying === playing) return;
  reportedPlaying = playing;
  notify({ type: "MM_AUDIO_STATE", generation, playing });
}
function pausePlayback(element: HTMLAudioElement): void {
  requestedPlaying = false;
  playAttempt++;
  playPending = false;
  clearBufferWait();
  element.pause();
  reportState(false);
}
function stop(): void {
  loadToken++;
  playAttempt++;
  cancelLoad?.();
  removeAudioListeners?.();
  removeAudioListeners = null;
  clearBufferWait();
  const retiredAudio = audio;
  audio = null;
  synchronizer = null;
  loaded = false;
  playPending = false;
  reportedPlaying = false;
  requestedPlaying = false;
  if (retiredAudio) {
    retiredAudio.pause();
    retiredAudio.removeAttribute("src");
    retiredAudio.load();
    retiredAudio.remove();
  }
}

function isCurrent(
  element: HTMLAudioElement,
  token: number,
  ownerGeneration: number,
): boolean {
  return (
    audio === element && loadToken === token && generation === ownerGeneration
  );
}

function listenToAudio(
  element: HTMLAudioElement,
  token: number,
  ownerGeneration: number,
): () => void {
  const current = () => isCurrent(element, token, ownerGeneration) && loaded;
  const onEnded = () => {
    if (current()) reportState(false);
  };
  const onWaiting = () => {
    if (!current() || bufferTimer) return;
    // A range request after seeking normally emits waiting. Let the media element
    // resume when that short read completes; treat sustained starvation as failure.
    bufferTimer = setTimeout(() => {
      if (!current()) return;
      bufferTimer = null;
      if (requestedPlaying && element.readyState < 3) {
        pausePlayback(element);
        notify({
          type: "MM_AUDIO_ERROR",
          generation: ownerGeneration,
          code: "AUDIO_BUFFER_UNDERRUN",
        });
      }
    }, 2000);
  };
  const onPlayable = () => {
    if (current()) clearBufferWait();
  };
  const onError = () => {
    if (current())
      notify({
        type: "MM_AUDIO_ERROR",
        generation: ownerGeneration,
        code: "AUDIO_DECODE_FAILED",
      });
  };
  element.addEventListener("ended", onEnded);
  element.addEventListener("waiting", onWaiting);
  element.addEventListener("canplay", onPlayable);
  element.addEventListener("playing", onPlayable);
  element.addEventListener("error", onError);
  return () => {
    element.removeEventListener("ended", onEnded);
    element.removeEventListener("waiting", onWaiting);
    element.removeEventListener("canplay", onPlayable);
    element.removeEventListener("playing", onPlayable);
    element.removeEventListener("error", onError);
  };
}

async function load(
  message: Extract<ExtensionMessage, { type: "MM_AUDIO_LOAD" }>,
): Promise<boolean> {
  stop();
  generation = message.generation;
  const token = loadToken;
  let url: URL;
  try {
    url = new URL(message.media.url);
  } catch {
    throw new Error("INVALID_MEDIA_SOURCE");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    message.media.trim_enabled !== false ||
    !Number.isFinite(message.media.duration_seconds)
  )
    throw new Error("INVALID_MEDIA_SOURCE");
  // Retired media events stay on their old element rather than reaching the
  // listeners belonging to a new source on the same element.
  const element = new Audio();
  audio = element;
  document.body.append(element);
  element.crossOrigin = "anonymous";
  element.preload = "auto";
  element.preservesPitch = true;
  removeAudioListeners = listenToAudio(element, token, message.generation);
  synchronizer = new ClockSynchronizer(message.video_id, generation);
  const ready = new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => cleanup(false, new Error("AUDIO_LOAD_TIMEOUT")),
      20_000,
    );
    const onReady = () => cleanup(true);
    const onError = () =>
      cleanup(
        false,
        new Error(
          element.error?.code === 2
            ? "AUDIO_NETWORK_FAILED"
            : element.error?.code === 3
              ? "AUDIO_DECODE_FAILED"
              : element.error?.code === 4
                ? "AUDIO_SOURCE_REJECTED"
                : "AUDIO_LOAD_FAILED",
        ),
      );
    const cancel = () => cleanup(false);
    const cleanup = (playable: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      element.removeEventListener("canplay", onReady);
      element.removeEventListener("error", onError);
      if (cancelLoad === cancel) cancelLoad = null;
      if (!isCurrent(element, token, message.generation)) resolve(false);
      else if (error) reject(error);
      else resolve(playable);
    };
    cancelLoad = cancel;
    element.addEventListener("canplay", onReady);
    element.addEventListener("error", onError);
  });
  try {
    element.src = url.href;
    element.load();
  } catch (error) {
    cancelLoad?.();
    throw error;
  }
  const playable = await ready;
  if (!playable || !isCurrent(element, token, message.generation)) return false;
  if (
    !Number.isFinite(element.duration) ||
    Math.abs(element.duration - message.media.duration_seconds) > 0.5
  )
    throw new Error("AUDIO_DURATION_MISMATCH");
  loaded = true;
  notify({ type: "MM_AUDIO_READY", generation: message.generation });
  return true;
}

async function follow(
  message: Extract<ExtensionMessage, { type: "MM_AUDIO_CLOCK" }>,
): Promise<void> {
  const element = audio;
  if (!loaded || !synchronizer || !element) return;
  const decision = synchronizer.decide(
    message.payload,
    Date.now(),
    element.currentTime,
    element.duration,
    element.seeking,
  );
  if (!decision.accepted) return;
  requestedPlaying = decision.play;
  // Receipt of an old sample must not extend the page's playback lease.
  lastClockAt = Math.min(Date.now(), message.payload.sampled_at_ms);
  element.volume = decision.volume;
  if (element.playbackRate !== decision.rate)
    element.playbackRate = decision.rate;
  if (decision.seek) element.currentTime = decision.target;
  if (!decision.play) {
    pausePlayback(element);
    return;
  }
  if (!decision.seek && Date.now() - lastDriftReport > 5000) {
    lastDriftReport = Date.now();
    emitDiagnostic("playback_drift", undefined, {
      drift_ms: Math.round(decision.drift * 1000),
      playing: true,
    });
  }
  if (!element.paused || playPending) return;
  playPending = true;
  const attempt = ++playAttempt;
  const token = loadToken;
  const ownerGeneration = generation;
  try {
    await element.play();
    if (isCurrent(element, token, ownerGeneration)) {
      if (!requestedPlaying) element.pause();
      else if (attempt === playAttempt && !element.paused) reportState(true);
    } else element.pause();
  } catch {
    if (
      isCurrent(element, token, ownerGeneration) &&
      attempt === playAttempt &&
      requestedPlaying
    )
      notify({
        type: "MM_AUDIO_ERROR",
        generation: ownerGeneration,
        code: "AUDIO_PLAYBACK_BLOCKED",
      });
  } finally {
    if (isCurrent(element, token, ownerGeneration) && attempt === playAttempt)
      playPending = false;
  }
}

setInterval(() => {
  if (audio && requestedPlaying && Date.now() - lastClockAt > STALE_CLOCK_MS) {
    pausePlayback(audio);
    emitDiagnostic("playback_suspended", "PLAYBACK_CLOCK_STALE");
  }
}, 250);

chrome.runtime.onMessage.addListener((value: unknown, sender, sendResponse) => {
  if (
    sender.id !== chrome.runtime.id ||
    sender.tab ||
    sender.url !== `chrome-extension://${chrome.runtime.id}/background.js`
  )
    return;
  if (!isExtensionMessage(value)) {
    sendResponse({ ok: false });
    return;
  }
  const message = value;
  if (message.type === "MM_AUDIO_LOAD") {
    const pending = load(message);
    const token = loadToken;
    void pending.then(
      (ok) => sendResponse({ ok }),
      (error: unknown) => {
        const code =
          error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message)
            ? error.message
            : "AUDIO_LOAD_FAILED";
        if (token === loadToken && generation === message.generation) {
          notify({
            type: "MM_AUDIO_ERROR",
            generation: message.generation,
            code,
          });
          stop();
        }
        sendResponse({ ok: false });
      },
    );
    return true;
  }
  if (message.type === "MM_AUDIO_CLOCK") {
    void follow(message);
    sendResponse({ ok: true });
  }
  if (message.type === "MM_AUDIO_STOP") {
    stop();
    sendResponse({ ok: true });
  }
});

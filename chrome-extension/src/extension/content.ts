import {
  MVP_MAX_DURATION_SECONDS,
  parseYouTubeVideoId,
  isVideoId,
  type MediaClock,
  type JobSnapshot,
} from "../shared/protocol";
import {
  isExtensionMessage,
  isMediaClock,
  type ExtensionMessage,
} from "./messages";
import { installPanelMovement } from "./panel-movement";
import { createPlaybackWaveform } from "./playback-waveform";
import { createPanelSettings } from "./panel-settings";
import { DEFAULT_SETTINGS, type ExtensionSettings } from "./settings";
import {
  VideoEligibility,
  type VideoEligibilitySnapshot,
} from "./video-eligibility";
import {
  emitDiagnostic,
  installErrorCapture,
  isExtensionContextInvalidated,
} from "./diagnostics";

import { failureGuidance } from "./error-guidance";
import { cloudHandoffUrl } from "../shared/app-handoff";
import { isErrorContext, type ErrorContext } from "../shared/error-context";

const removeErrorCapture = installErrorCapture("content");
let invalidated = false;
let clockTimer: ReturnType<typeof setInterval> | null = null;
let cleanupLifecycle: (() => void) | null = null;
let cleanupControls: (() => void) | null = null;
let video: HTMLVideoElement | null = null;
let videoId: string | null = null;
let generation = Date.now();
let sequence = 0;
let mode: "idle" | "preparing" | "ready" = "idle";
let userMuted = false;
let observedMuted = false;
let ownsMute = false;
let tabMuteMode = false;
let hasPlayedVocals = false;
let vocalsPlaying = false;
let saveState: JobSnapshot["save_state"];
let videoTimeline = { currentTime: 0, duration: 0 };
let adSuspended = false;
let adMuteEpoch = 0;
let desiredPlaying = false;
type Preparation = {
  intent: "manual" | "automatic";
  video: HTMLVideoElement;
  id: string;
  source: string;
};
let preparation: Preparation | null = null;
let preparationPausesPending = 0;
let startAccepted = false;
let sessionDuration = 0;
let replacementTimer: ReturnType<typeof setTimeout> | null = null;
let readyDuringReplacement = false;
let buffering = false;
let bufferingStartedAt: number | null = null;
let button: HTMLButtonElement | null = null;
let panel: HTMLDivElement | null = null;
let panelDismissed = false;
let panelPresentation: {
  message: string;
  title: string;
  tone: "preparing" | "ready" | "waiting" | "error";
} | null = null;
let panelMovement: ReturnType<typeof installPanelMovement> | null = null;
let playbackWaveform: ReturnType<typeof createPlaybackWaveform> | null = null;
let status: HTMLSpanElement | null = null;
let audioButton: HTMLButtonElement | null = null;
let stopButton: HTMLButtonElement | null = null;
let pendingStop: Promise<void> | null = null;
let navigationStop: Promise<void> | null = null;
let stopDismissed = false;
let panelTitle: HTMLSpanElement | null = null;
let progressBar: HTMLProgressElement | null = null;
let progressLabel: HTMLSpanElement | null = null;
let setupLink: HTMLAnchorElement | null = null;
let cloudLink: HTMLAnchorElement | null = null;
let errorDetails: HTMLSpanElement | null = null;
let copyError: HTMLButtonElement | null = null;
let lastFailure: {
  code: string;
  context?: ErrorContext;
  timestamp: string;
  generation: number;
} | null = null;
let countdownTimer: ReturnType<typeof setTimeout> | null = null;
function localRetryBlocked(): boolean {
  return (
    mode === "idle" &&
    lastFailure?.generation === generation &&
    (lastFailure.context?.retry_at ?? 0) > Date.now()
  );
}
function clearFailure(): void {
  if (countdownTimer) clearTimeout(countdownTimer);
  countdownTimer = null;
  lastFailure = null;
  if (cloudLink) cloudLink.dataset.primary = "false";
  if (errorDetails) errorDetails.hidden = true;
  if (copyError) copyError.hidden = true;
}
function renderFailure(): void {
  if (
    !lastFailure ||
    invalidated ||
    lastFailure.generation !== generation ||
    mode !== "idle"
  )
    return;
  if (countdownTimer) clearTimeout(countdownTimer);
  countdownTimer = null;
  const { code, context } = lastFailure;
  const guidance = failureGuidance(code, context);
  text(
    guidance.message,
    guidance.title,
    code === "SESSION_STOPPED" ? "ready" : "error",
  );
  if (setupLink) setupLink.hidden = !guidance.openApp;
  if (cloudLink) {
    cloudLink.hidden = !guidance.cloud || !videoId;
    cloudLink.dataset.primary = String(guidance.cloudPrimary);
  }
  if (errorDetails) {
    errorDetails.hidden = code === "SESSION_STOPPED";
    errorDetails.textContent = `${code} · ${context?.stage ?? "operation"} · ${lastFailure.timestamp}`;
  }
  if (copyError) copyError.hidden = code === "SESSION_STOPPED";
  if (context?.retry_at && context.retry_at > Date.now())
    countdownTimer = setTimeout(() => {
      countdownTimer = null;
      renderFailure();
    }, 1000);
}

let cleanupVideo: (() => void) | null = null;
let reconciling = false;
let lastReportedId: string | null = null;
let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let settingsLoaded = false;
let panelSettings: ReturnType<typeof createPanelSettings> | null = null;
const eligibility = new VideoEligibility();

function currentVideoId(): string | null {
  const id = parseYouTubeVideoId(location.href);
  if (id) return id;
  // Enabled solely by build --fixture's localhost content-script match.
  if (location.hostname === "127.0.0.1" && location.pathname === "/watch") {
    const candidate = new URL(location.href).searchParams.get("v");
    return isVideoId(candidate) ? candidate : null;
  }
  return null;
}
function adActive(): boolean {
  return !!document.querySelector(
    ".html5-video-player.ad-showing, .html5-video-player.ad-interrupting",
  );
}
function eligibilitySnapshot(): VideoEligibilitySnapshot | null {
  if (!video || !videoId) return null;
  const watch = video.closest("ytd-watch-flexy");
  const publicDuration = watch?.querySelector<HTMLMetaElement>(
    'meta[itemprop="duration"]',
  )?.content;
  const parts = publicDuration?.match(
    /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/,
  );
  const duration = parts
    ? Number(parts[1] ?? 0) * 3600 +
      Number(parts[2] ?? 0) * 60 +
      Number(parts[3] ?? 0)
    : NaN;
  const liveBadge = document.querySelector<HTMLElement>(".ytp-live-badge");
  return {
    video,
    id: videoId,
    watchMatches:
      currentVideoId() === videoId &&
      watch?.getAttribute("video-id") === videoId &&
      (!parts || Math.abs(duration - video.duration) <= 3),
    publicDurationMatches:
      Number.isFinite(duration) && Math.abs(duration - video.duration) <= 3,
    ad: adActive(),
    live: !!liveBadge && liveBadge.getClientRects().length > 0,
  };
}
function tryAutomaticStart(): void {
  const snapshot = eligibilitySnapshot();
  const canStart =
    snapshot !== null && eligibility.eligible(snapshot, settings);
  if (
    !canStart ||
    !settingsLoaded ||
    invalidated ||
    pendingStop ||
    navigationStop ||
    mode !== "idle"
  )
    return;
  eligibility.markAttempted();
  void start("automatic");
}
function acceptSettings(next: ExtensionSettings): void {
  // Editing automatic playback applies from the next video, without interrupting
  // the video under the settings controls. Restored preferences can apply now.
  if (
    settingsLoaded &&
    (next.autoStartEnabled !== settings.autoStartEnabled ||
      next.maxDurationMinutes !== settings.maxDurationMinutes)
  )
    eligibility.suppress();
  settings = next;
  settingsLoaded = true;
  tryAutomaticStart();
}
function updatePlaybackWaveform(): void {
  const ad = adActive();
  if (video && !ad) {
    videoTimeline = {
      currentTime: video.currentTime,
      duration: video.duration,
    };
  }
  playbackWaveform?.update({
    visible: mode === "ready" || panelPresentation?.title === "Original sound",
    vocals: mode === "ready",
    playing:
      !invalidated &&
      mode === "ready" &&
      vocalsPlaying &&
      !panel?.hidden &&
      !!video &&
      !video.paused &&
      !video.seeking &&
      !video.ended &&
      !buffering &&
      !ad &&
      !userMuted &&
      video.volume > 0,
    currentTime: videoTimeline.currentTime,
    duration: videoTimeline.duration,
    playbackRate: video?.playbackRate ?? 1,
  });
}
function updatePanelVisibility(): void {
  if (panel) panel.hidden = panelDismissed || panelPresentation === null;
  updatePlaybackWaveform();
  button?.setAttribute("aria-expanded", String(!!panel && !panel.hidden));
  if (button && mode !== "idle" && !invalidated) {
    button.title = panel?.hidden
      ? "MusicMute: show controls"
      : "MusicMute: hide controls";
    button.setAttribute("aria-label", button.title);
  }
  panelMovement?.refresh();
}
function hidePanel(): void {
  panelSettings?.close();
  panelDismissed = true;
  updatePanelVisibility();
  button?.focus({ preventScroll: true });
}
function toggleVocalMute(): void {
  if (invalidated || mode !== "ready" || adActive()) return;
  userMuted = !userMuted;
  clock();
}
function updateAudioAction(): void {
  if (cloudLink && !lastFailure)
    cloudLink.hidden = invalidated || !videoId || mode !== "idle";
  if (stopButton) stopButton.disabled = invalidated;
  if (!audioButton) return;
  audioButton.textContent =
    mode === "preparing"
      ? "Cancel"
      : mode === "ready"
        ? "Show original sound"
        : "Remove background music";
  audioButton.disabled =
    invalidated || pendingStop !== null || localRetryBlocked();
}
function text(
  message: string,
  title = mode === "preparing" ? "Preparing vocals" : "Vocals ready",
  tone: "preparing" | "ready" | "waiting" | "error" = mode === "preparing"
    ? "preparing"
    : "ready",
): void {
  panelPresentation = { message, title, tone };
  if (status) status.textContent = message;
  if (panelTitle) panelTitle.textContent = title;
  if (panel) {
    panel.dataset.state = tone;
  }
  updateAudioAction();
  updatePanelVisibility();
}
function progress(completed?: number, total?: number): string {
  const known =
    completed !== undefined &&
    total !== undefined &&
    Number.isFinite(completed) &&
    Number.isFinite(total) &&
    total > 0;
  const percent = known
    ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
    : null;
  if (progressBar) {
    progressBar.hidden = mode !== "preparing";
    if (percent === null) progressBar.removeAttribute("value");
    else progressBar.value = percent;
  }
  if (progressLabel) {
    progressLabel.hidden = percent === null || mode !== "preparing";
    progressLabel.textContent = percent === null ? "" : `${percent}%`;
  }
  return percent === null ? "" : ` ${percent}%`;
}
async function send(message: ExtensionMessage): Promise<{
  ok?: boolean;
  source_muted?: boolean;
  error?: string;
  error_context?: ErrorContext;
  handoff_url?: string;
  processing_provider?: "LOCAL_MACOS" | "ONLINE_MUSICMUTE";
  cloud_confirmation_scope?: string;
}> {
  if (invalidated) return { ok: false, error: "EXTENSION_CONTEXT_INVALIDATED" };
  try {
    const reply: unknown = await chrome.runtime.sendMessage(message);
    return reply && typeof reply === "object"
      ? (reply as {
          ok?: boolean;
          source_muted?: boolean;
          error?: string;
          error_context?: ErrorContext;
          handoff_url?: string;
          processing_provider?: "LOCAL_MACOS" | "ONLINE_MUSICMUTE";
          cloud_confirmation_scope?: string;
        })
      : { ok: false, error: "EXTENSION_CONNECTION_LOST" };
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      retireContext();
      return { ok: false, error: "EXTENSION_CONTEXT_INVALIDATED" };
    }
    return { ok: false, error: "EXTENSION_CONNECTION_LOST" };
  }
}
function restoreMute(): void {
  if (video && ownsMute) video.muted = userMuted;
  ownsMute = false;
}
function releaseAdMute(owner: HTMLVideoElement, epoch: number): void {
  if (
    video !== owner ||
    mode !== "ready" ||
    (!ownsMute && !tabMuteMode) ||
    !adSuspended ||
    adMuteEpoch !== epoch ||
    !adActive()
  )
    return;
  restoreMute();
  text(
    "The ad plays with its original audio. MusicMute resumes when your video returns.",
    "Waiting for the video",
    "waiting",
  );
}
function updateAdMute(ad: boolean): void {
  if (mode !== "ready" || adSuspended === ad) return;
  adSuspended = ad;
  adMuteEpoch++;
  // Reclaim the original track before the next clock can resume vocals.
  if (!ad && video && hasPlayedVocals) {
    ownsMute = true;
    video.muted = true;
    text(
      video.paused
        ? "Vocals ready. Play the video to listen."
        : "Your video has returned. MusicMute is resuming vocals.",
      video.paused ? "Vocals ready" : "Resuming vocals",
      video.paused ? "ready" : "waiting",
    );
  }
}
function teardown(pause = false, restoreOriginal = true): void {
  if (replacementTimer) clearTimeout(replacementTimer);
  replacementTimer = null;
  readyDuringReplacement = false;
  sessionDuration = 0;
  clearFailure();
  if (cloudLink) cloudLink.hidden = true;
  if (pause && video) video.pause();
  if (restoreOriginal) restoreMute();
  tabMuteMode = false;
  hasPlayedVocals = false;
  vocalsPlaying = false;
  saveState = undefined;
  adSuspended = false;
  adMuteEpoch++;
  mode = "idle";
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
  generation = Math.max(Date.now(), generation + 1);
  startAccepted = false;
  preparation = null;
  preparationPausesPending = 0;
  panelPresentation = null;
  if (setupLink) setupLink.hidden = true;
  if (progressBar) progressBar.hidden = true;
  if (progressLabel) progressLabel.hidden = true;
  buffering = false;
  bufferingStartedAt = null;
  button?.setAttribute("aria-pressed", "false");
  if (button) {
    button.title = "MusicMute: remove background music";
    button.setAttribute("aria-label", button.title);
  }
  updatePanelVisibility();
}
function retireContext(): void {
  if (invalidated) return;
  invalidated = true;
  const wasActive = mode !== "idle" || pendingStop !== null;
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
  cleanupVideo?.();
  cleanupVideo = null;
  cleanupControls?.();
  cleanupControls = null;
  cleanupLifecycle?.();
  cleanupLifecycle = null;
  removeErrorCapture();
  teardown(wasActive);
  video = null;
  videoId = null;
  if (button) {
    button.disabled = true;
    button.title = "MusicMute updated. Refresh this YouTube page.";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-disabled", "true");
  }
  if (audioButton) audioButton.hidden = true;
  if (stopButton) stopButton.hidden = true;
  const retiredHandle = panel?.querySelector<HTMLButtonElement>(
    ".musicmute-panel-move",
  );
  const retiredClose = panel?.querySelector<HTMLButtonElement>(
    ".musicmute-panel-close",
  );
  if (retiredHandle) retiredHandle.disabled = true;
  if (retiredClose) retiredClose.disabled = true;
  const retiredSettings = panel?.querySelector<HTMLButtonElement>(
    ".musicmute-panel-settings-button",
  );
  if (retiredSettings) retiredSettings.disabled = true;
  panelDismissed = false;
  text(
    "MusicMute was updated or reloaded. Refresh this YouTube page to reconnect. Original audio restored.",
    "Refresh YouTube",
    "waiting",
  );
}

function resumeOriginal(
  previous: Preparation | null,
  clearedGeneration: number,
  resume: boolean,
): void {
  if (
    !previous ||
    !resume ||
    invalidated ||
    mode !== "idle" ||
    generation !== clearedGeneration ||
    video !== previous.video ||
    videoId !== previous.id ||
    currentVideoId() !== previous.id ||
    video.currentSrc !== previous.source ||
    !video.paused ||
    video.ended ||
    video.seeking ||
    pendingStop ||
    navigationStop ||
    adActive()
  )
    return;
  // A user pause or navigation rejects a pending play; never retry that promise.
  try {
    void Promise.resolve(previous.video.play()).catch(() => undefined);
  } catch {
    // Keep the original track safely paused if the browser refuses playback.
  }
}
function fail(code: string, context?: ErrorContext): void {
  if (invalidated) return;
  // Error frames must not reflect arbitrary page or tool text in the controls.
  if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code))
    code = "PROCESSING_FAILED";
  const previous = preparation;
  const resume =
    mode === "preparing" &&
    previous?.intent === "automatic" &&
    desiredPlaying &&
    [
      "SOURCE_BOT_CHALLENGE",
      "ACQUISITION_RATE_LIMITED",
      "ACQUISITION_COOLDOWN",
      "ACQUISITION_BUSY",
    ].includes(code);
  eligibility.suppress();
  teardown(true);
  const clearedGeneration = generation;
  lastFailure = {
    code,
    ...(context && isErrorContext(context) ? { context } : {}),
    timestamp: new Date().toISOString(),
    generation,
  };
  renderFailure();
  emitDiagnostic("diagnostic_error", code, { stage: "content" });
  resumeOriginal(previous, clearedGeneration, resume);
}
function hasPlayableVideoBuffer(element: HTMLVideoElement): boolean {
  if (element.readyState >= 3) return true;
  if (element.readyState < 2) return false;
  const ranges = element.buffered;
  for (let index = 0; index < ranges.length; index++) {
    if (
      ranges.start(index) <= element.currentTime &&
      ranges.end(index) - element.currentTime >= 0.25
    )
      return true;
  }
  return false;
}
function recoverBufferingFromProgress(): void {
  if (
    buffering &&
    video &&
    bufferingStartedAt !== null &&
    !video.paused &&
    !video.seeking &&
    !video.ended &&
    video.readyState >= 2 &&
    video.currentTime > bufferingStartedAt + 0.01
  ) {
    buffering = false;
    bufferingStartedAt = null;
  }
}
function clock(): MediaClock | undefined {
  recoverBufferingFromProgress();
  updatePlaybackWaveform();
  if (invalidated || !video || !videoId || mode === "idle") return;
  const ad = adActive();
  updateAdMute(ad);
  const owner = video;
  const ownerGeneration = generation;
  const muteEpoch = adMuteEpoch;
  const nextSequence = sequence + 1;
  const payload: MediaClock = {
    video_id: videoId,
    generation,
    sequence: nextSequence,
    current_time: video.currentTime,
    duration_seconds: video.duration,
    playback_rate: video.playbackRate,
    paused: video.paused || replacementTimer !== null,
    seeking: video.seeking,
    ended: video.ended,
    buffering,
    ad_active: ad,
    volume: video.volume,
    user_muted: userMuted,
    sampled_at_ms: Date.now(),
  };
  // YouTube exposes transient NaN/Infinity metadata while reusing its video
  // element during SPA transitions. Do not turn that temporary state into a
  // malformed runtime message and a user-visible session failure.
  if (!isMediaClock(payload)) return;
  sequence = nextSequence;
  void send({ type: "MM_CLOCK", payload }).then((reply) => {
    if (invalidated || video !== owner || generation !== ownerGeneration)
      return;
    if (reply.error && mode !== "idle") fail(reply.error);
    else if (
      reply.ok === false &&
      (mode === "ready" || (mode === "preparing" && startAccepted))
    )
      fail("PLAYBACK_SESSION_LOST");
    // The existing clock acknowledgement arrives after offscreen handles the
    // ad pause. Until then, keep the original muted to avoid overlapping audio.
    else if (reply.ok === true && ad) releaseAdMute(owner, muteEpoch);
    else if (reply.ok === true && reply.source_muted === true && !adActive()) {
      tabMuteMode = true;
      restoreMute();
      observedMuted = owner.muted;
    }
  });
  return payload;
}
async function stopSession(dismiss = false): Promise<void> {
  if (invalidated) return;
  eligibility.suppress();
  if (dismiss) {
    stopDismissed = true;
    panelPresentation = null;
    hidePanel();
  }
  if (pendingStop) return;
  if (mode === "idle") {
    stopDismissed = false;
    hidePanel();
    return;
  }
  stopDismissed = dismiss;
  emitDiagnostic("playback_stopped", "PLAYBACK_USER_STOP", {
    stage: "content",
  });
  const previous = mode;
  const oldGeneration = generation;
  const owner = video;
  // Retire clocks/messages immediately, but keep the original muted until the
  // offscreen player acknowledges Stop so both tracks cannot play together.
  teardown(false, previous !== "ready");
  const clearedGeneration = generation;
  const stopping = Promise.resolve()
    .then(() =>
      send({
        type: previous === "preparing" ? "MM_CANCEL" : "MM_STOP",
        generation: oldGeneration,
      }),
    )
    .then((reply) => {
      if (invalidated || generation !== clearedGeneration || video !== owner)
        return;
      restoreMute();
      if (reply.error) {
        fail(reply.error);
        return;
      }
      if (stopDismissed) {
        panelPresentation = null;
        updatePanelVisibility();
      } else
        text("Use YouTube to pause, seek and adjust volume.", "Original sound");
    })
    .finally(() => {
      if (pendingStop === stopping) {
        pendingStop = null;
        stopDismissed = false;
      }
      updateAudioAction();
      tryAutomaticStart();
    });
  pendingStop = stopping;
  if (dismiss) updateAudioAction();
  else text("Switching back to the video's original sound…", "Switching audio");
  await stopping;
}
async function start(intent: "manual" | "automatic" = "manual"): Promise<void> {
  if (invalidated || pendingStop || mode !== "idle") return;
  if (localRetryBlocked()) {
    renderFailure();
    return;
  }
  if (intent === "manual") eligibility.suppress();
  panelDismissed = false;
  if (!video || !videoId) {
    text(
      "Open a standard YouTube watch video to use MusicMute.",
      "Choose a video",
      "waiting",
    );
    return;
  }
  const snapshot = eligibilitySnapshot();
  if (!snapshot || !eligibility.ready(snapshot)) {
    text(
      "Wait until the video has loaded and ads finish. Live streams and Shorts are not supported.",
      "Waiting for a supported video",
      "waiting",
    );
    return;
  }
  if (video.duration > MVP_MAX_DURATION_SECONDS) {
    text(
      `MusicMute supports videos up to ${MVP_MAX_DURATION_SECONDS / 60} minutes. Choose a shorter video.`,
      "Choose a shorter video",
      "waiting",
    );
    return;
  }
  clearFailure();
  if (cloudLink) cloudLink.hidden = true;
  generation = Math.max(Date.now(), generation + 1);
  sequence = 0;
  userMuted = video.muted;
  desiredPlaying = !video.paused;
  mode = "preparing";
  sessionDuration = video.duration;
  startClockTimer();
  preparation = { intent, video, id: videoId, source: video.currentSrc };
  if (!video.paused) {
    preparationPausesPending++;
    video.pause();
  }
  startAccepted = false;
  button?.setAttribute("aria-pressed", "true");
  if (setupLink) setupLink.hidden = true;
  text(
    "The video is paused while MusicMute starts on this Mac. You can cancel anytime.",
  );
  progress();
  const owner = generation;
  const request: Extract<ExtensionMessage, { type: "MM_START" }> = {
    type: "MM_START",
    generation,
    ...(intent === "automatic" ? { intent } : {}),
    payload: {
      video_id: videoId,
      duration_seconds: video.duration,
      provider: "LOCAL_MACOS",
    },
  };
  let reply = await send(request);
  if (generation !== owner) return;
  if (
    intent === "manual" &&
    reply.error === "CLOUD_CONFIRMATION_REQUIRED" &&
    reply.processing_provider === "ONLINE_MUSICMUTE" &&
    typeof reply.cloud_confirmation_scope === "string" &&
    reply.cloud_confirmation_scope.length === 64 &&
    /^[a-f0-9]{64}$/.test(reply.cloud_confirmation_scope)
  ) {
    const confirmationScope = reply.cloud_confirmation_scope;
    // A manual Start uses the app's saved choice. Keep the account-scope
    // handshake so a changed account or provider cannot redirect this request.
    text(
      "MusicMute cloud is preparing the complete vocals track using your signed-in account and monthly allowance. You can cancel anytime.",
    );
    reply = await send({
      ...request,
      cloud_confirmed: true,
      cloud_confirmation_scope: confirmationScope,
    });
    if (generation !== owner) return;
  }
  if (
    intent === "automatic" &&
    reply.ok === false &&
    reply.error?.startsWith("AUTO_START_")
  ) {
    const previous = preparation;
    const resume = desiredPlaying;
    teardown(true);
    resumeOriginal(previous, generation, resume);
    return;
  }
  if (reply.ok === false)
    fail(reply.error ?? "START_FAILED", reply.error_context);
  else if (reply.ok === true) startAccepted = true;
  clock();
}
function attach(next: HTMLVideoElement, id: string): void {
  cleanupVideo?.();
  video = next;
  videoId = id;
  eligibility.bind(next, id);
  vocalsPlaying = false;
  buffering = false;
  bufferingStartedAt = null;
  videoTimeline = { currentTime: 0, duration: 0 };
  observedMuted = next.muted;
  const events = [
    "play",
    "pause",
    "seeking",
    "seeked",
    "ratechange",
    "volumechange",
    "waiting",
    "stalled",
    "progress",
    "playing",
    "canplay",
    "ended",
    "loadedmetadata",
    "durationchange",
    "timeupdate",
  ] as const;
  const onEvent = (event: Event) => {
    if (mode === "preparing" && event.type === "play") {
      desiredPlaying = true;
      if (video && !video.paused) {
        preparationPausesPending++;
        video.pause();
      }
      return;
    }
    if (mode === "preparing" && event.type === "pause") {
      if (preparationPausesPending > 0) preparationPausesPending--;
      else desiredPlaying = false;
    }
    // `stalled` describes the network, not necessarily a stopped video clock.
    // A real `waiting` event remains authoritative until readiness/progress
    // confirms recovery, even when the network later stalls with data buffered.
    if (
      event.type === "waiting" ||
      (event.type === "stalled" && !hasPlayableVideoBuffer(next))
    ) {
      buffering = true;
      bufferingStartedAt = next.currentTime;
    }
    if (
      ["playing", "canplay"].includes(event.type) ||
      (event.type === "progress" && hasPlayableVideoBuffer(next))
    ) {
      buffering = false;
      bufferingStartedAt = null;
    }
    if (event.type === "seeked") {
      buffering = !hasPlayableVideoBuffer(next);
      bufferingStartedAt = buffering ? next.currentTime : null;
    }
    if (event.type === "volumechange" && video) {
      const muteChanged = observedMuted !== video.muted;
      observedMuted = video.muted;
      if (ownsMute && !video.muted) {
        userMuted = false;
        video.muted = true;
      } else if (muteChanged && !ownsMute && mode !== "idle") {
        userMuted = video.muted;
      }
    }
    if (event.type === "seeking" && mode === "ready")
      emitDiagnostic("playback_seek");
    clock();
    tryAutomaticStart();
  };
  for (const event of events) next.addEventListener(event, onEvent);
  cleanupVideo = () => {
    for (const event of events) next.removeEventListener(event, onEvent);
  };
}
function installControls(player: HTMLElement, controls: Element): void {
  if (controls.querySelector("#musicmute-local-button")) return;
  cleanupControls?.();
  button?.remove();
  button = document.createElement("button");
  button.id = "musicmute-local-button";
  button.className = "ytp-button musicmute-local-button";
  button.type = "button";
  button.setAttribute("aria-label", "MusicMute: remove background music");
  button.setAttribute("aria-pressed", mode === "idle" ? "false" : "true");
  button.setAttribute("aria-controls", "musicmute-local-panel");
  button.setAttribute("aria-expanded", "false");
  button.title = "MusicMute: remove background music";
  const mark =
    '<svg viewBox="0 0 108 108" fill="none" aria-hidden="true"><path d="M24 49v10M84 49v10" stroke="currentColor" stroke-opacity=".24" stroke-width="6" stroke-linecap="round"/><path d="M34 43v22M74 43v22" stroke="currentColor" stroke-opacity=".38" stroke-width="7" stroke-linecap="round"/><path d="M44 36v36M64 36v36" stroke="currentColor" stroke-opacity=".56" stroke-width="8" stroke-linecap="round"/><path d="M54 25v58" stroke="currentColor" stroke-width="12" stroke-linecap="round"/></svg>';
  button.innerHTML = mark;
  const controlButton = button;
  const onStart = (event: Event) => {
    event.stopPropagation();
    if (mode === "idle") void start();
    else {
      panelDismissed = !!panel && !panel.hidden;
      updatePanelVisibility();
    }
  };
  controlButton.addEventListener("click", onStart);
  controls.prepend(button);
  panel?.remove();
  panel = document.createElement("div");
  panel.id = "musicmute-local-panel";
  panel.hidden = true;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "MusicMute audio");
  const header = document.createElement("div");
  header.className = "musicmute-panel-header";
  const moveHandle = document.createElement("button");
  moveHandle.type = "button";
  moveHandle.className = "musicmute-panel-move";
  moveHandle.setAttribute(
    "aria-label",
    "Move MusicMute controls. Use arrow keys to move and Home to reset.",
  );
  moveHandle.title = "Drag to move. Arrow keys move; Home resets.";
  const logo = document.createElement("span");
  logo.className = "musicmute-panel-logo";
  logo.innerHTML = mark;
  const heading = document.createElement("span");
  heading.className = "musicmute-panel-heading";
  const brand = document.createElement("span");
  brand.className = "musicmute-panel-brand";
  brand.textContent = "MusicMute · On this Mac";
  panelTitle = document.createElement("span");
  panelTitle.className = "musicmute-panel-title";
  heading.append(brand, panelTitle);
  moveHandle.append(logo, heading);
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "musicmute-panel-close";
  closeButton.setAttribute("aria-label", "Hide MusicMute controls");
  closeButton.title = "Hide MusicMute controls";
  closeButton.textContent = "×";
  const onClose = () => hidePanel();
  closeButton.addEventListener("click", onClose);
  const localSettings = createPanelSettings(panel, acceptSettings);
  panelSettings = localSettings;
  header.append(moveHandle, localSettings.button, closeButton);
  status = document.createElement("span");
  status.className = "musicmute-panel-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  progressBar = document.createElement("progress");
  progressBar.max = 100;
  progressBar.hidden = true;
  progressBar.setAttribute("aria-label", "Current preparation stage");
  progressLabel = document.createElement("span");
  progressLabel.className = "musicmute-progress-label";
  progressLabel.hidden = true;
  progressLabel.setAttribute("aria-hidden", "true");
  const progressRow = document.createElement("div");
  progressRow.className = "musicmute-progress-row";
  progressRow.append(progressBar, progressLabel);
  playbackWaveform = createPlaybackWaveform();
  const actions = document.createElement("div");
  actions.className = "musicmute-panel-actions";
  audioButton = document.createElement("button");
  audioButton.type = "button";
  audioButton.className = "musicmute-panel-audio-toggle";
  const localAudioButton = audioButton;
  const onAudioToggle = () => {
    if (localAudioButton.disabled) return;
    if (mode === "idle") void start();
    else void stopSession();
  };
  localAudioButton.addEventListener("click", onAudioToggle);
  stopButton = document.createElement("button");
  stopButton.type = "button";
  stopButton.className = "musicmute-panel-stop";
  stopButton.textContent = "Stop";
  stopButton.setAttribute("aria-label", "Stop MusicMute");
  stopButton.title = "Stop MusicMute and close controls";
  const localStopButton = stopButton;
  const onStop = () => {
    if (!localStopButton.disabled) void stopSession(true);
  };
  localStopButton.addEventListener("click", onStop);
  // The video's muted flag belongs to suppression while vocals play. Capture
  // actual YouTube controls before they toggle that flag and lose user intent.
  const onPlayerMute = (event: Event) => {
    const target = event.target as Element | null;
    if (
      mode !== "ready" ||
      !ownsMute ||
      adActive() ||
      !target?.closest?.(".ytp-mute-button")
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleVocalMute();
  };
  const onMuteKey = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (
      event.key.toLowerCase() !== "m" ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.repeat ||
      mode !== "ready" ||
      !ownsMute ||
      adActive() ||
      target?.isContentEditable ||
      target?.closest?.(
        "input, textarea, select, [contenteditable], [role=textbox]",
      )
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleVocalMute();
  };
  player.addEventListener("click", onPlayerMute, true);
  document.addEventListener("keydown", onMuteKey, true);
  setupLink = document.createElement("a");
  setupLink.href = "musicmute-local://setup";
  setupLink.className = "musicmute-setup-link";
  setupLink.textContent = "Open Mac app";
  setupLink.hidden = true;
  cloudLink = document.createElement("a");
  cloudLink.className = "musicmute-cloud-link";
  cloudLink.textContent = "Use MusicMute cloud";
  cloudLink.title =
    "Open MusicMute to review monthly usage and confirm cloud processing. Processing still needs YouTube audio access.";
  cloudLink.href = videoId
    ? cloudHandoffUrl(videoId, video?.duration)
    : "musicmute-local://setup";
  cloudLink.hidden = true;
  const localCloudLink = cloudLink;
  const onCloud = (event: Event) => {
    event.preventDefault();
    if (
      invalidated ||
      !videoId ||
      localCloudLink.getAttribute("aria-disabled") === "true"
    )
      return;
    const id = videoId;
    const duration = video?.duration;
    const currentGeneration = generation;
    localCloudLink.setAttribute("aria-disabled", "true");
    void send({
      type: "MM_CLOUD_HANDOFF",
      video_id: id,
      generation: currentGeneration,
      ...(typeof duration === "number" &&
      Number.isFinite(duration) &&
      duration > 0 &&
      duration <= MVP_MAX_DURATION_SECONDS
        ? { duration_seconds: duration }
        : {}),
    })
      .then((reply) => {
        if (
          invalidated ||
          currentVideoId() !== id ||
          generation !== currentGeneration
        )
          return;
        if (!reply.ok || reply.handoff_url !== cloudHandoffUrl(id, duration)) {
          fail(reply.error ?? "CLOUD_HANDOFF_FAILED", reply.error_context);
          return;
        }
        teardown(false, true);
        text(
          "Continue in MusicMute to review monthly usage and confirm cloud processing. No cloud request has been submitted.",
          "Continue in MusicMute",
          "waiting",
        );
        if (setupLink) setupLink.hidden = false;
        location.href = reply.handoff_url;
      })
      .catch(() => {
        if (!invalidated && currentVideoId() === id)
          fail("CLOUD_HANDOFF_FAILED");
      })
      .finally(() => localCloudLink.setAttribute("aria-disabled", "false"));
  };
  localCloudLink.addEventListener("click", onCloud);
  errorDetails = document.createElement("span");
  errorDetails.className = "musicmute-error-details";
  errorDetails.hidden = true;
  copyError = document.createElement("button");
  copyError.className = "musicmute-copy-error";
  copyError.type = "button";
  copyError.textContent = "Copy error";
  copyError.hidden = true;
  const localCopyError = copyError;
  const onCopyError = () => {
    if (!lastFailure) return;
    const failure = lastFailure;
    const guidance = failureGuidance(failure.code, failure.context);
    const summary = [
      "MusicMute local error",
      failure.timestamp,
      `Code: ${failure.code}`,
      `Stage: ${failure.context?.stage ?? "operation"}`,
      guidance.message,
    ].join("\n");
    void navigator.clipboard.writeText(summary).then(
      () => {
        localCopyError.textContent = "Copied";
      },
      () => {
        localCopyError.textContent = "Copy unavailable";
      },
    );
  };
  localCopyError.addEventListener("click", onCopyError);
  const controlPanel = panel;
  const onPanelClick = (event: Event) => event.stopPropagation();
  const onPanelKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    hidePanel();
  };
  controlPanel.addEventListener("click", onPanelClick);
  controlPanel.addEventListener("keydown", onPanelKey);
  actions.append(cloudLink, setupLink, copyError, audioButton, stopButton);
  controlPanel.append(
    header,
    status,
    errorDetails,
    progressRow,
    playbackWaveform.element,
    localSettings.element,
    actions,
  );
  player.append(controlPanel);
  const movement = installPanelMovement(player, controlPanel, moveHandle);
  panelMovement = movement;
  cleanupControls = () => {
    localCloudLink.removeEventListener("click", onCloud);
    localCopyError.removeEventListener("click", onCopyError);
    localSettings.dispose();
    if (panelSettings === localSettings) panelSettings = null;
    controlButton.removeEventListener("click", onStart);
    localAudioButton.removeEventListener("click", onAudioToggle);
    localStopButton.removeEventListener("click", onStop);
    player.removeEventListener("click", onPlayerMute, true);
    document.removeEventListener("keydown", onMuteKey, true);
    closeButton.removeEventListener("click", onClose);
    controlPanel.removeEventListener("click", onPanelClick);
    controlPanel.removeEventListener("keydown", onPanelKey);
    movement.dispose();
    if (panelMovement === movement) panelMovement = null;
  };
  if (panelPresentation) {
    status.textContent = panelPresentation.message;
    panelTitle.textContent = panelPresentation.title;
    controlPanel.dataset.state = panelPresentation.tone;
  }
  updateAudioAction();
  updatePanelVisibility();
}
function stopForNavigation(pausePrevious = false): void {
  if (mode === "idle") {
    if (lastFailure) teardown(pausePrevious, true);
    if (pendingStop) teardown(pausePrevious, true);
    return;
  }
  const oldGeneration = generation;
  const oldMode = mode;
  emitDiagnostic("playback_stopped", "PLAYBACK_NAVIGATION", {
    stage: "content",
  });
  // Retire old READY replies immediately. A reused player may already be
  // playing the incoming video, so preserve its playback intent here.
  teardown(pausePrevious, true);
  const stopping = send({
    type: oldMode === "preparing" ? "MM_CANCEL" : "MM_STOP",
    generation: oldGeneration,
    reason: "navigation",
  })
    .then(() => undefined)
    .finally(() => {
      if (navigationStop !== stopping) return;
      navigationStop = null;
      tryAutomaticStart();
    });
  navigationStop = stopping;
}
function canRebindVideo(next: HTMLVideoElement): boolean {
  const watch = next.closest("ytd-watch-flexy");
  return (
    !adActive() &&
    watch?.getAttribute("video-id") === videoId &&
    next.readyState >= 1 &&
    !!next.currentSrc &&
    Number.isFinite(next.duration) &&
    Math.abs(next.duration - sessionDuration) <= 2
  );
}
function rebindVideo(next: HTMLVideoElement, id: string): void {
  const playing = vocalsPlaying;
  const resume = readyDuringReplacement && desiredPlaying;
  readyDuringReplacement = false;
  if (replacementTimer) clearTimeout(replacementTimer);
  replacementTimer = null;
  cleanupVideo?.();
  cleanupVideo = null;
  video?.pause();
  restoreMute();
  attach(next, id);
  vocalsPlaying = playing;
  // The new element belongs to the same verified timeline. Keep the user's
  // mute choice, preparation, generation and panel instead of cancelling work.
  if (mode === "preparing") {
    if (preparation)
      preparation = { ...preparation, video: next, source: next.currentSrc };
    preparationPausesPending = 0;
    if (!next.paused) {
      preparationPausesPending++;
      next.pause();
    }
  } else if (hasPlayedVocals) {
    ownsMute = !tabMuteMode;
    next.muted = tabMuteMode ? userMuted : true;
    observedMuted = next.muted;
  }
  emitDiagnostic("stage_completed", undefined, { stage: "player_rebound" });
  if (resume && next.paused) {
    const owner = generation;
    void next.play().catch(() => {
      if (video === next && generation === owner && mode === "ready")
        text("Vocals ready. Press YouTube Play to start.");
    });
  }
  clock();
}
function reconcile(): void {
  if (invalidated) return;
  const id = currentVideoId();
  const next = document.querySelector<HTMLVideoElement>(
    ".html5-video-player video",
  );
  if (id !== videoId || next !== video) {
    if (id && id === videoId && mode !== "idle") {
      if (next && canRebindVideo(next)) rebindVideo(next, id);
      else {
        // YouTube may remove the old element before inserting/loading its
        // replacement. Keep controls and pause the vocal clock for a bounded
        // metadata handoff; never follow an unverified replacement or ad.
        if (!replacementTimer) {
          vocalsPlaying = false;
          replacementTimer = setTimeout(() => {
            replacementTimer = null;
            emitDiagnostic("diagnostic_error", "PLAYBACK_SOURCE_CHANGED", {
              stage: "content",
            });
            stopForNavigation(true);
            scheduleReconcile();
          }, 5000);
          clock();
        }
        return;
      }
    } else {
      stopForNavigation(next !== video);
      if (invalidated) return;
      cleanupVideo?.();
      cleanupVideo = null;
      video = null;
      videoId = null;
      if (next && id) attach(next, id);
      else eligibility.bind(null, id);
    }
  } else if (replacementTimer) {
    clearTimeout(replacementTimer);
    replacementTimer = null;
    clock();
  }
  const player = document.querySelector<HTMLElement>(".html5-video-player");
  const controls = player?.querySelector(".ytp-right-controls");
  if (player && controls && id) installControls(player, controls);
  else {
    cleanupControls?.();
    cleanupControls = null;
    button?.remove();
    panel?.remove();
    button = null;
    panel = null;
    status = null;
    panelTitle = null;
    progressBar = null;
    progressLabel = null;
    setupLink = null;
    cloudLink = null;
    errorDetails = null;
    copyError = null;
    audioButton = null;
    stopButton = null;
    playbackWaveform = null;
  }
  if (id !== lastReportedId) {
    lastReportedId = id;
    generation = Math.max(generation + 1, Date.now());
  }
  updatePlaybackWaveform();
  if (mode === "ready") clock();
  tryAutomaticStart();
}
function scheduleReconcile(): void {
  if (invalidated || reconciling) return;
  reconciling = true;
  queueMicrotask(() => {
    reconciling = false;
    reconcile();
  });
}

function renderPlaybackStatus(): void {
  const saving = saveState === "pending" || saveState === "saving";
  if (!vocalsPlaying) {
    text(
      saving && hasPlayedVocals
        ? "Vocals ready · Saving in background"
        : "Vocals ready. Play the video to listen.",
      "Vocals ready",
    );
    return;
  }
  text(
    saving
      ? "Playing vocals · Saving in background"
      : "Use YouTube to pause, seek and adjust volume.",
    "Voice-only playback",
  );
}
function receiveMessage(
  value: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void = () => {},
): void {
  if (!isExtensionMessage(value) || sender.tab) return;
  const message = value;
  if (
    invalidated ||
    sender.id !== chrome.runtime.id ||
    !("generation" in message) ||
    message.generation !== generation
  )
    return;
  if (message.type === "MM_PAGE_PROBE") {
    sendResponse({ clock: clock() });
    return;
  }
  if (message.type === "MM_JOB") {
    if (mode === "idle") return;
    saveState = message.payload.save_state;
    if (message.payload.state === "FAILED") {
      fail(
        message.payload.error_code ?? "PROCESSING_FAILED",
        message.payload.error_context,
      );
      return;
    }
    if (message.payload.state === "CANCELLED") {
      fail("SESSION_STOPPED");
      return;
    }
    if (message.payload.state !== "READY") {
      const percent = progress(
        message.payload.completed,
        message.payload.total,
      );
      if (message.payload.stage === "account-restore") {
        text(
          `Checking your MusicMute library for saved vocals${percent}. The video stays paused; you can cancel anytime.`,
          "Checking saved vocals",
        );
        return;
      }
      const stage = message.payload.stage
        .replaceAll("_", " ")
        .replaceAll("-", " ");
      text(
        `${stage}${percent} — ${message.payload.provider === "ONLINE_MUSICMUTE" ? "processing with MusicMute cloud" : "processing on this Mac"}. The video stays paused until vocals are ready.`,
        message.payload.state === "DOWNLOADING"
          ? "Getting the audio"
          : message.payload.state === "VALIDATING"
            ? "Checking the vocals"
            : "Separating vocals",
      );
    } else if (mode === "ready" && !adSuspended) {
      renderPlaybackStatus();
    }
  }
  if (message.type === "MM_READY") {
    if (mode === "idle") return;
    if (message.source_muted === true) {
      tabMuteMode = true;
      restoreMute();
      if (video) observedMuted = video.muted;
    }
    const firstReady = mode !== "ready";
    if (firstReady && replacementTimer) readyDuringReplacement = true;
    mode = "ready";
    preparation = null;
    preparationPausesPending = 0;
    progress();
    text("Vocals ready. Play the video to listen.");
    clock();
    if (firstReady && desiredPlaying && video?.paused && !replacementTimer) {
      const owner = video;
      const ownerGeneration = generation;
      void owner.play().catch(() => {
        if (!invalidated && video === owner && generation === ownerGeneration)
          text("Vocals ready. Press YouTube Play to start.");
      });
    }
  }
  if (message.type === "MM_PLAYBACK" && video && mode === "ready") {
    vocalsPlaying = message.playing;
    updateAdMute(adActive());
    if (message.playing) {
      hasPlayedVocals = true;
      if (!adSuspended) {
        ownsMute = !tabMuteMode;
        video.muted = tabMuteMode ? userMuted : true;
        observedMuted = video.muted;
        renderPlaybackStatus();
        emitDiagnostic("playback_started");
      }
      clock();
    } else if (!adSuspended) renderPlaybackStatus();
    updatePlaybackWaveform();
  }
  if (message.type === "MM_ERROR") fail(message.code, message.error_context);
}
chrome.runtime.onMessage.addListener(receiveMessage);
const observer = new MutationObserver((records) => {
  // YouTube mutates comments, recommendations and its own progress UI constantly.
  // Ignore our rendering and unrelated changes instead of rescanning on each one.
  if (
    !records?.length ||
    (video && !video.isConnected) ||
    records.some((record) => {
      const target =
        record.target instanceof Element
          ? record.target
          : record.target.parentElement;
      if (target?.closest("#musicmute-local-panel, #musicmute-local-button"))
        return false;
      if (
        target?.matches("ytd-watch-flexy") ||
        (target?.matches('meta[itemprop="duration"]') &&
          target.closest("ytd-watch-flexy")?.getAttribute("video-id") ===
            videoId) ||
        target?.closest(".html5-video-player, ytd-player")
      )
        return true;
      return (
        record.type === "childList" &&
        [...record.addedNodes].some(
          (node) =>
            node instanceof Element &&
            (node.matches(".html5-video-player") ||
              node.querySelector(".html5-video-player")),
        )
      );
    })
  )
    scheduleReconcile();
});
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["class", "video-id", "content"],
});
const onNavigationStart = () => {
  eligibility.navigationStart();
  stopForNavigation();
};
const onNavigationFinish = () => {
  eligibility.navigationFinish();
  scheduleReconcile();
};
// Capture metadata before YouTube's SPA reconciliation attaches the reused video.
const mediaEvents = [
  "loadstart",
  "emptied",
  "loadedmetadata",
  "durationchange",
];
const onMetadata = (event: Event) => {
  const target = document.querySelector<HTMLVideoElement>(
    ".html5-video-player video",
  );
  if (!target || event.target !== target) return;
  eligibility.observe(event.type, target, adActive());
  scheduleReconcile();
};
for (const event of mediaEvents)
  document.addEventListener(event, onMetadata, true);
document.addEventListener("yt-navigate-start", onNavigationStart);
document.addEventListener("yt-navigate-finish", onNavigationFinish);
document.addEventListener("visibilitychange", scheduleReconcile);
window.addEventListener("popstate", scheduleReconcile);
const onPageHide = () => {
  if (invalidated) return;
  const oldMode = mode;
  const oldGeneration = generation;
  teardown(pendingStop !== null);
  if (oldMode !== "idle")
    void send({
      type: oldMode === "preparing" ? "MM_CANCEL" : "MM_STOP",
      generation: oldGeneration,
      reason: "pagehide",
    });
};
window.addEventListener("pagehide", onPageHide);
cleanupLifecycle = () => {
  observer.disconnect();
  for (const event of mediaEvents)
    document.removeEventListener(event, onMetadata, true);
  document.removeEventListener("yt-navigate-start", onNavigationStart);
  document.removeEventListener("yt-navigate-finish", onNavigationFinish);
  document.removeEventListener("visibilitychange", scheduleReconcile);
  window.removeEventListener("popstate", scheduleReconcile);
  window.removeEventListener("pagehide", onPageHide);
  try {
    chrome.runtime.onMessage.removeListener(receiveMessage);
  } catch {
    // Chrome may already have revoked extension APIs for this retired script.
  }
};
function startClockTimer(): void {
  if (!clockTimer && !invalidated) clockTimer = setInterval(clock, 250);
}
reconcile();

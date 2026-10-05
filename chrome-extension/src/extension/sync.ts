import type { MediaClock } from "../shared/protocol";

export const STALE_CLOCK_MS = 5000;
export const SEEK_DRIFT_SECONDS = 0.75;
const DRIFT_DEADBAND_SECONDS = 0.04;
const MAX_RATE_CORRECTION = 0.03;
const DRIFT_RATE_GAIN = 0.15;
const SUSTAINED_DRIFT_MS = 1000;
const SEEK_COOLDOWN_MS = 1500;
const SEEK_SETTLE_MS = 500;
export interface SyncDecision {
  accepted: boolean;
  play: boolean;
  target: number;
  seek: boolean;
  rate: number;
  volume: number;
  drift: number;
}

/** Media timing only; no page URLs or audio capabilities cross this boundary. */
export class ClockSynchronizer {
  private sequence = -1;
  private previousClock: MediaClock | null = null;
  private alignmentPending = true;
  private explicitAlignmentPending = false;
  private largeDriftSinceMs: number | null = null;
  private largeDriftSign = 0;
  private seekCooldownUntilMs = 0;
  private seekSettleUntilMs = 0;
  constructor(
    private readonly videoId: string,
    private readonly generation: number,
  ) {}

  decide(
    clock: MediaClock,
    nowMs: number,
    audioTime: number,
    duration: number,
    audioSeeking = false,
  ): SyncDecision {
    const reject: SyncDecision = {
      accepted: false,
      play: false,
      target: audioTime,
      seek: false,
      rate: 1,
      volume: 0,
      drift: 0,
    };
    if (
      clock.video_id !== this.videoId ||
      clock.generation !== this.generation ||
      !Number.isInteger(clock.sequence) ||
      clock.sequence <= this.sequence
    )
      return reject;
    const values = [
      clock.current_time,
      clock.duration_seconds,
      clock.playback_rate,
      clock.volume,
      clock.sampled_at_ms,
      nowMs,
      audioTime,
      duration,
    ];
    if (
      !values.every(Number.isFinite) ||
      clock.current_time < 0 ||
      clock.duration_seconds <= 0 ||
      audioTime < 0 ||
      duration <= 0 ||
      clock.playback_rate < 0.25 ||
      clock.playback_rate > 4 ||
      clock.volume < 0 ||
      clock.volume > 1
    )
      return reject;
    this.sequence = clock.sequence;
    const age = nowMs - clock.sampled_at_ms;
    if (age < 0 || age > STALE_CLOCK_MS) {
      this.alignmentPending = true;
      this.largeDriftSinceMs = null;
      return {
        ...reject,
        accepted: true,
        target: audioTime,
        rate: clock.playback_rate,
        volume: clock.user_muted ? 0 : clock.volume,
      };
    }
    const play =
      !clock.paused &&
      !clock.seeking &&
      !clock.ended &&
      !clock.buffering &&
      !clock.ad_active &&
      age >= 0 &&
      age <= STALE_CLOCK_MS;
    const target = Math.min(
      duration,
      Math.max(
        0,
        clock.current_time + (play ? (age / 1000) * clock.playback_rate : 0),
      ),
    );
    const drift = target - audioTime;
    const previous = this.previousClock;
    const previousPlaying =
      previous !== null &&
      !previous.paused &&
      !previous.seeking &&
      !previous.ended &&
      !previous.buffering &&
      !previous.ad_active;
    const sampleElapsed = previous
      ? Math.max(0, clock.sampled_at_ms - previous.sampled_at_ms) / 1000
      : 0;
    // A jump in the source timeline also catches seeks whose DOM event clock
    // was superseded before the background could deliver it.
    const timelineJump =
      previous !== null &&
      !previous.seeking &&
      !clock.seeking &&
      !previous.ad_active &&
      !clock.ad_active &&
      Math.abs(
        clock.current_time -
          (previous.current_time +
            (previousPlaying ? sampleElapsed * previous.playback_rate : 0)),
      ) >= SEEK_DRIFT_SECONDS;
    const explicitAlignment =
      timelineJump || (previous !== null && previous.seeking !== clock.seeking);
    if (explicitAlignment) this.explicitAlignmentPending = true;
    if (
      explicitAlignment ||
      (play && sampleElapsed * 1000 > STALE_CLOCK_MS) ||
      (clock.ended && !previous?.ended) ||
      (play && previous !== null && !previousPlaying) ||
      (play && audioTime >= duration && target < duration)
    )
      this.alignmentPending = true;
    this.previousClock = { ...clock };

    let seek = false;
    const settling = nowMs < this.seekSettleUntilMs;
    if (
      !clock.ad_active &&
      !audioSeeking &&
      (!settling || this.explicitAlignmentPending)
    ) {
      if (this.alignmentPending) {
        this.alignmentPending = false;
        this.explicitAlignmentPending = false;
        seek = Math.abs(drift) > DRIFT_DEADBAND_SECONDS;
      } else if (
        play &&
        target < duration &&
        nowMs >= this.seekCooldownUntilMs &&
        Math.abs(drift) >= SEEK_DRIFT_SECONDS
      ) {
        const sign = Math.sign(drift);
        if (this.largeDriftSinceMs === null || sign !== this.largeDriftSign) {
          this.largeDriftSinceMs = nowMs;
          this.largeDriftSign = sign;
        } else if (nowMs - this.largeDriftSinceMs >= SUSTAINED_DRIFT_MS)
          seek = true;
      } else this.largeDriftSinceMs = null;
    } else this.largeDriftSinceMs = null;
    if (!play) this.largeDriftSinceMs = null;
    if (seek) {
      this.seekSettleUntilMs = nowMs + SEEK_SETTLE_MS;
      this.seekCooldownUntilMs = nowMs + SEEK_COOLDOWN_MS;
      this.largeDriftSinceMs = null;
    }
    // Leave the user-selected rate intact while stopped or settling. Normal
    // drift is corrected gradually, without skipping or repeating syllables.
    const correction =
      play &&
      target < duration &&
      !seek &&
      !audioSeeking &&
      !settling &&
      !this.alignmentPending
        ? Math.abs(drift) <= DRIFT_DEADBAND_SECONDS
          ? 0
          : Math.max(
              -MAX_RATE_CORRECTION,
              Math.min(MAX_RATE_CORRECTION, drift * DRIFT_RATE_GAIN),
            )
        : 0;
    return {
      accepted: true,
      play:
        play &&
        target < duration &&
        !(this.alignmentPending && Math.abs(drift) > DRIFT_DEADBAND_SECONDS),
      target,
      seek,
      rate: Math.max(0.25, Math.min(4, clock.playback_rate * (1 + correction))),
      volume: clock.user_muted ? 0 : clock.volume,
      drift,
    };
  }
}

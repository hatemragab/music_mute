import { describe, expect, it } from "vitest";
import { ClockSynchronizer, STALE_CLOCK_MS } from "../src/extension/sync";
import type { MediaClock } from "../src/shared/protocol";
import { pageJob } from "../src/extension/messages";
const base: MediaClock = {
  video_id: "11111111111",
  generation: 1,
  sequence: 1,
  current_time: 10,
  duration_seconds: 60,
  playback_rate: 1,
  paused: false,
  seeking: false,
  ended: false,
  buffering: false,
  ad_active: false,
  volume: 0.7,
  user_muted: false,
  sampled_at_ms: 1000,
};
const decide = (patch: Partial<MediaClock> = {}, now = 1100, audioTime = 10) =>
  new ClockSynchronizer(base.video_id, 1).decide(
    { ...base, ...patch },
    now,
    audioTime,
    60,
  );
function session(initial: Partial<MediaClock> = {}) {
  const synchronizer = new ClockSynchronizer(base.video_id, 1);
  let sequence = 0;
  return (
    elapsedMs: number,
    audioTime: number,
    patch: Partial<MediaClock> = {},
    audioSeeking = false,
  ) => {
    const rate = patch.playback_rate ?? initial.playback_rate ?? 1;
    const now = 1000 + elapsedMs;
    return synchronizer.decide(
      {
        ...base,
        ...initial,
        current_time: 10 + (elapsedMs / 1000) * rate,
        ...patch,
        sequence: ++sequence,
        sampled_at_ms: now,
      },
      now,
      audioTime,
      initial.duration_seconds ?? 60,
      audioSeeking,
    );
  };
}
describe("synchronized local audio", () => {
  it("never forwards local media capabilities into the YouTube page", () => {
    const snapshot = pageJob({
      job_id: "job",
      video_id: base.video_id,
      provider: "LOCAL_MACOS",
      state: "READY",
      stage: "ready",
      media: {
        url: "http://127.0.0.1:1234/media/job?capability=private",
        duration_seconds: 60,
        trim_enabled: false,
        model_id: "fixture",
      },
    });
    expect(snapshot).not.toHaveProperty("media");
    expect(JSON.stringify(snapshot)).not.toContain("127.0.0.1");
    expect(JSON.stringify(snapshot)).not.toContain("capability");
  });
  it("predicts transport delay at the selected playback rate", () => {
    expect(decide({ playback_rate: 2 }).target).toBeCloseTo(10.2);
    expect(decide({ playback_rate: 2 }).seek).toBe(true);
  });
  it("aligns the first fresh clock once, then lets the audio seek settle", () => {
    const follow = session();
    expect(follow(0, 0).seek).toBe(true);
    const settling = follow(250, 0);
    expect(settling.seek).toBe(false);
    expect(settling.rate).toBe(1);
    expect(follow(500, 10.5).seek).toBe(false);
  });
  it("does not seek an already aligned first clock", () => {
    expect(decide({}, 1000, 10).seek).toBe(false);
  });
  it.each(["paused", "seeking", "ended", "buffering", "ad_active"] as const)(
    "never advances or plays a %s timeline",
    (key) => {
      const result = decide({ [key]: true });
      expect(result.target).toBe(10);
      expect(result.play).toBe(false);
      expect(result.rate).toBe(1);
    },
  );
  it.each(["paused", "seeking", "ended", "buffering", "ad_active"] as const)(
    "immediately pauses a %s timeline during settling",
    (key) => {
      const follow = session();
      follow(0, 0);
      const result = follow(100, 10, { [key]: true });
      expect(result.play).toBe(false);
      expect(result.rate).toBe(1);
    },
  );
  it("tolerates delayed clocks for five seconds, then pauses without extrapolation", () => {
    expect(STALE_CLOCK_MS).toBe(5000);
    expect(decide({}, 3000).play).toBe(true);
    expect(decide({}, 6000).play).toBe(true);
    const stale = decide({}, 6001, 12);
    expect(stale.play).toBe(false);
    expect(stale.target).toBe(12);
    expect(stale.seek).toBe(false);
    expect(stale.rate).toBe(1);
    const future = decide({}, 900, 12);
    expect(future.play).toBe(false);
    expect(future.target).toBe(12);
    expect(future.seek).toBe(false);
  });
  it("realigns after stale-clock silence when a fresh source clock arrives", () => {
    const sync = new ClockSynchronizer(base.video_id, 1);
    sync.decide(base, 1000, 10, 60);
    expect(sync.decide({ ...base, sequence: 2 }, 6001, 15, 60).play).toBe(
      false,
    );
    const recovered = sync.decide(
      { ...base, sequence: 3, sampled_at_ms: 6250, current_time: 15.25 },
      6250,
      15,
      60,
    );
    expect(recovered.play).toBe(true);
    expect(recovered.seek).toBe(true);
    expect(recovered.target).toBe(15.25);
  });
  it("realigns after the watchdog gap even without an intervening stale clock", () => {
    const follow = session();
    follow(0, 10);
    const recovered = follow(5250, 15);
    expect(recovered.play).toBe(true);
    expect(recovered.seek).toBe(true);
    expect(recovered.target).toBe(15.25);
  });
  it("rejects messages from previous videos, generations, and sequences", () => {
    const sync = new ClockSynchronizer(base.video_id, 1);
    expect(sync.decide(base, 1100, 10, 60).accepted).toBe(true);
    expect(sync.decide(base, 1100, 10, 60).accepted).toBe(false);
    expect(
      sync.decide({ ...base, sequence: 2, generation: 2 }, 1100, 10, 60)
        .accepted,
    ).toBe(false);
    expect(
      sync.decide(
        { ...base, sequence: 2, video_id: "22222222222" },
        1100,
        10,
        60,
      ).accepted,
    ).toBe(false);
    expect(sync.decide({ ...base, sequence: 2 }, 1100, 10, 60).accepted).toBe(
      true,
    );
    expect(sync.decide({ ...base, sequence: 1.5 }, 1100, 10, 60).accepted).toBe(
      false,
    );
  });
  it.each([
    { current_time: NaN },
    { current_time: -1 },
    { duration_seconds: 0 },
    { duration_seconds: Infinity },
    { playback_rate: 100 },
    { playback_rate: 0 },
    { volume: 2 },
    { volume: -1 },
    { sampled_at_ms: NaN },
  ])("rejects invalid timing and loudness values %j", (patch) => {
    expect(decide(patch).accepted).toBe(false);
  });
  it("rejects invalid local media timing without consuming the clock sequence", () => {
    const sync = new ClockSynchronizer(base.video_id, 1);
    expect(sync.decide(base, 1000, -1, 60).accepted).toBe(false);
    expect(sync.decide(base, 1000, 10, 0).accepted).toBe(false);
    expect(sync.decide(base, 1000, 10, Infinity).accepted).toBe(false);
    expect(sync.decide(base, NaN, 10, 60).accepted).toBe(false);
    expect(sync.decide(base, 1000, 10, 60).accepted).toBe(true);
  });
  it.each([0.03, -0.03])(
    "keeps drift %ss within the deadband at the base rate",
    (drift) => {
      const follow = session({ playback_rate: 1.5 });
      follow(0, 10);
      const result = follow(250, 10.375 - drift);
      expect(result.seek).toBe(false);
      expect(result.rate).toBe(1.5);
    },
  );
  it.each([0.2, -0.2])(
    "smooths ordinary drift %ss without a hard seek",
    (drift) => {
      const follow = session();
      follow(0, 10);
      const result = follow(250, 10.25 - drift);
      expect(result.seek).toBe(false);
      expect(result.rate).toBeCloseTo(drift > 0 ? 1.03 : 0.97);
    },
  );
  it.each([0.5, 1, 2])(
    "converges both drift directions at a user rate of %sx",
    (rate) => {
      for (const drift of [0.2, -0.2]) {
        const follow = session({ playback_rate: rate, duration_seconds: 120 });
        follow(0, 10);
        let audioTime = 10 + 0.25 * rate - drift;
        for (let elapsedMs = 250; elapsedMs <= 30000; elapsedMs += 250) {
          const result = follow(elapsedMs, audioTime);
          expect(result.seek).toBe(false);
          expect(result.rate).toBeGreaterThanOrEqual(rate * 0.97 - 1e-10);
          expect(result.rate).toBeLessThanOrEqual(rate * 1.03 + 1e-10);
          audioTime += result.rate * 0.25;
          if (elapsedMs === 30000)
            expect(Math.abs(result.drift)).toBeLessThanOrEqual(0.04);
        }
      }
    },
  );
  it("keeps corrected rates within supported media bounds", () => {
    const slow = session({ playback_rate: 0.25 });
    slow(0, 10);
    expect(slow(250, 10.0625 + 0.2).rate).toBe(0.25);
    const fast = session({ playback_rate: 4 });
    fast(0, 10);
    expect(fast(250, 11 - 0.2).rate).toBe(4);
  });
  it("preserves regular source progress through delays and user rate changes", () => {
    const follow = session();
    follow(0, 10);
    expect(follow(2000, 12).seek).toBe(false);
    expect(
      follow(2250, 12.25, { current_time: 12.25, playback_rate: 2 }).seek,
    ).toBe(false);
    const changedRate = follow(2500, 12.75, {
      current_time: 12.75,
      playback_rate: 2,
    });
    expect(changedRate.seek).toBe(false);
    expect(changedRate.rate).toBe(2);
  });
  it.each([1, -1])(
    "does not hard seek for a transient large audio drift of %ss",
    (drift) => {
      const follow = session();
      follow(0, 10);
      expect(follow(250, 10.25 - drift).seek).toBe(false);
      expect(follow(500, 10.5 - drift).seek).toBe(false);
      expect(follow(750, 10.75).seek).toBe(false);
      expect(follow(1250, 11.25 - drift).seek).toBe(false);
    },
  );
  it.each([1, -1])(
    "hard realigns a sustained large drift of %ss once after one second",
    (drift) => {
      const follow = session();
      follow(0, 10);
      for (const elapsedMs of [250, 500, 750, 1000])
        expect(follow(elapsedMs, 10 + elapsedMs / 1000 - drift).seek).toBe(
          false,
        );
      expect(follow(1250, 11.25 - drift).seek).toBe(true);
      expect(follow(1500, 10.5, {}, true).seek).toBe(false);
      for (const elapsedMs of [1750, 2250, 2500, 2750, 3250])
        expect(follow(elapsedMs, 10 + elapsedMs / 1000 - drift).seek).toBe(
          false,
        );
      expect(follow(3750, 13.75 - drift).seek).toBe(true);
    },
  );
  it("restarts sustained-drift timing when its direction changes", () => {
    const follow = session();
    follow(0, 10);
    expect(follow(250, 9.25).seek).toBe(false);
    expect(follow(750, 11.75).seek).toBe(false);
    expect(follow(1250, 12.25).seek).toBe(false);
    expect(follow(1750, 12.75).seek).toBe(true);
  });
  it("aligns a seeking edge once and realigns the completed seek", () => {
    const follow = session();
    follow(0, 10);
    const seeking = follow(250, 10.25, { seeking: true, current_time: 20 });
    expect(seeking.seek).toBe(true);
    expect(seeking.play).toBe(false);
    expect(seeking.target).toBe(20);
    expect(follow(500, 20, { seeking: true, current_time: 22 }).seek).toBe(
      false,
    );
    expect(follow(750, 20, { seeking: true, current_time: 24 }).seek).toBe(
      false,
    );
    const seeked = follow(1000, 20, { current_time: 24 });
    expect(seeked.seek).toBe(true);
    expect(seeked.play).toBe(true);
    expect(seeked.target).toBe(24);
  });
  it("detects a source timeline jump when the seeking-event clock was skipped", () => {
    const follow = session();
    follow(0, 10);
    const seeked = follow(250, 10.25, { current_time: 30 });
    expect(seeked.seek).toBe(true);
    expect(seeked.target).toBe(30);
    expect(follow(500, 30.25, { current_time: 30.25 }).seek).toBe(false);
  });
  it("defers initial alignment while local audio is seeking", () => {
    const follow = session();
    const busy = follow(0, 0, {}, true);
    expect(busy.seek).toBe(false);
    expect(busy.play).toBe(false);
    expect(busy.rate).toBe(1);
    expect(follow(250, 0, {}, true).seek).toBe(false);
    expect(follow(500, 0).seek).toBe(true);
  });
  it("retains a completed user seek until local seeking finishes", () => {
    const follow = session();
    follow(0, 10);
    expect(follow(250, 10.25, { seeking: true, current_time: 20 }).seek).toBe(
      true,
    );
    const busy = follow(500, 20, { current_time: 30 }, true);
    expect(busy.seek).toBe(false);
    expect(busy.play).toBe(false);
    const waiting = follow(625, 20, { current_time: 30.125 }, true);
    expect(waiting.seek).toBe(false);
    expect(waiting.play).toBe(false);
    expect(waiting.rate).toBe(1);
    expect(follow(750, 20, { current_time: 30.25 }).seek).toBe(true);
  });
  it("lets a distinct explicit seek preempt settling when local audio is ready", () => {
    const follow = session();
    expect(follow(0, 0).seek).toBe(true);
    const seeking = follow(100, 10, { current_time: 20, seeking: true });
    expect(seeking.seek).toBe(true);
    expect(seeking.play).toBe(false);
    expect(follow(200, 20, { current_time: 20, seeking: true }).seek).toBe(
      false,
    );
    const seeked = follow(300, 20, { current_time: 30 });
    expect(seeked.seek).toBe(true);
    expect(seeked.play).toBe(true);
    expect(seeked.target).toBe(30);
  });
  it.each(["paused", "buffering", "ad_active"] as const)(
    "aligns resumed playback after %s without repeatedly seeking during the stop",
    (key) => {
      const follow = session();
      follow(0, 10);
      const stopped = follow(250, 10.2, { [key]: true, current_time: 10.25 });
      expect(stopped.play).toBe(false);
      expect(stopped.seek).toBe(false);
      expect(
        follow(30000, 10.2, { [key]: true, current_time: 10.25 }).seek,
      ).toBe(false);
      const resumed = follow(30250, 10.2, { current_time: 10.5 });
      expect(resumed.play).toBe(true);
      expect(resumed.seek).toBe(true);
      expect(resumed.target).toBe(10.5);
    },
  );
  it("does not align replacement audio to the ad timeline", () => {
    const follow = session();
    expect(follow(0, 0, { ad_active: true, current_time: 30 }).seek).toBe(
      false,
    );
    expect(follow(250, 0, { ad_active: true, current_time: 30.25 }).seek).toBe(
      false,
    );
    const content = follow(500, 0, { current_time: 10 });
    expect(content.seek).toBe(true);
    expect(content.target).toBe(10);
  });
  it("aligns a replay after audio ended even if its source clocks were unchanged", () => {
    const sync = new ClockSynchronizer(base.video_id, 1);
    sync.decide({ ...base, current_time: 0 }, 1000, 0, 60);
    const replay = sync.decide(
      { ...base, sequence: 2, current_time: 0, sampled_at_ms: 1250 },
      1250,
      60,
      60,
    );
    expect(replay.play).toBe(true);
    expect(replay.seek).toBe(true);
    expect(replay.target).toBe(0);
    const immediateSeek = sync.decide(
      {
        ...base,
        sequence: 3,
        current_time: 4,
        seeking: true,
        sampled_at_ms: 1250,
      },
      1250,
      0,
      60,
    );
    expect(immediateSeek.play).toBe(false);
    expect(immediateSeek.seek).toBe(true);
    expect(immediateSeek.target).toBe(4);
  });
  it("respects user mute, volume, and end of media", () => {
    expect(decide({ user_muted: true }).volume).toBe(0);
    expect(decide().volume).toBe(0.7);
    expect(decide({ current_time: 59.9, playback_rate: 4 }, 1100).target).toBe(
      60,
    );
    expect(decide({ current_time: 59.9, playback_rate: 4 }, 1100).play).toBe(
      false,
    );
    expect(decide({ current_time: 59.9, playback_rate: 4 }, 1100).rate).toBe(4);
    const follow = session();
    follow(0, 10);
    const ended = follow(250, 10.25, { ended: true, current_time: 60 });
    expect(ended.play).toBe(false);
    expect(ended.seek).toBe(true);
    expect(ended.target).toBe(60);
    expect(follow(1000, 60, { ended: true, current_time: 60 }).seek).toBe(
      false,
    );
  });
});

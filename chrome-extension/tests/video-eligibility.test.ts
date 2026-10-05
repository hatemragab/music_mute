import { describe, expect, it } from "vitest";
import {
  VideoEligibility,
  type VideoEligibilitySnapshot,
} from "../src/extension/video-eligibility";
import {
  DEFAULT_SETTINGS,
  type ExtensionSettings,
} from "../src/extension/settings";

interface MediaFixture {
  duration: number;
  currentSrc: string;
  readyState: number;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
}
function media(patch: Partial<MediaFixture> = {}): MediaFixture {
  return {
    duration: 120,
    currentSrc: "blob:synthetic-main-video-1",
    readyState: 4,
    paused: false,
    ended: false,
    seeking: false,
    ...patch,
  };
}
function element(video: MediaFixture): HTMLVideoElement {
  return video as HTMLVideoElement;
}
function snapshot(
  video: MediaFixture,
  patch: Partial<VideoEligibilitySnapshot> = {},
): VideoEligibilitySnapshot {
  return {
    video: element(video),
    id: "abcdefghijk",
    watchMatches: true,
    publicDurationMatches: true,
    ad: false,
    live: false,
    ...patch,
  };
}
const enabled: ExtensionSettings = {
  ...DEFAULT_SETTINGS,
  autoStartEnabled: true,
};
function bound(video = media()) {
  const eligibility = new VideoEligibility();
  eligibility.bind(element(video), "abcdefghijk");
  return { eligibility, video };
}
function nextVideo(
  eligibility: VideoEligibility,
  video: MediaFixture,
  id = "11111111111",
): VideoEligibilitySnapshot {
  eligibility.navigationStart();
  eligibility.bind(element(video), id);
  eligibility.navigationFinish();
  return snapshot(video, { id });
}

describe("local YouTube video eligibility", () => {
  it("accepts a loaded matching initial video strictly shorter than the setting", () => {
    const { eligibility, video } = bound(media({ duration: 1199.99 }));
    expect(eligibility.eligible(snapshot(video), enabled)).toBe(true);
  });

  it.each([
    ["paused", { paused: true }],
    ["ended", { ended: true }],
    ["seeking", { seeking: true }],
    ["metadata unavailable", { readyState: 0 }],
    ["unknown duration", { duration: NaN }],
    ["unbounded duration", { duration: Infinity }],
    ["zero duration", { duration: 0 }],
    ["negative duration", { duration: -1 }],
    ["exact threshold", { duration: 1200 }],
    ["over threshold", { duration: 1200.01 }],
    ["beyond processing ceiling", { duration: 1201 }],
  ] as [string, Partial<MediaFixture>][])(
    "refuses %s without altering the media element",
    (_label, patch) => {
      const { eligibility, video } = bound(media(patch));
      const before = { ...video };
      expect(eligibility.eligible(snapshot(video), enabled)).toBe(false);
      expect(video).toEqual(before);
    },
  );

  it.each([
    ["live stream", { live: true }],
    ["advertisement", { ad: true }],
    ["stale watch identity", { watchMatches: false }],
    ["other bound video id", { id: "11111111111" }],
  ] as [string, Partial<VideoEligibilitySnapshot>][])(
    "refuses %s",
    (_label, patch) => {
      const { eligibility, video } = bound();
      expect(eligibility.eligible(snapshot(video, patch), enabled)).toBe(false);
    },
  );

  it("defaults to enabled and respects opt-out and the selected limit within the processing ceiling", () => {
    const { eligibility, video } = bound(media({ duration: 61 }));
    expect(eligibility.eligible(snapshot(video), DEFAULT_SETTINGS)).toBe(true);
    expect(
      eligibility.eligible(snapshot(video), {
        ...DEFAULT_SETTINGS,
        autoStartEnabled: false,
      }),
    ).toBe(false);
    expect(
      eligibility.eligible(snapshot(video), {
        ...enabled,
        maxDurationMinutes: 1,
      }),
    ).toBe(false);
    video.duration = 59;
    expect(
      eligibility.eligible(snapshot(video), {
        ...enabled,
        maxDurationMinutes: 1,
      }),
    ).toBe(true);
    video.duration = 1200;
    expect(
      eligibility.eligible(snapshot(video), {
        ...enabled,
        maxDurationMinutes: 20,
      }),
    ).toBe(false);
  });

  it("allows just one marked attempt per video visit, including repeated metadata events", () => {
    const { eligibility, video } = bound();
    expect(eligibility.eligible(snapshot(video), enabled)).toBe(true);
    eligibility.markAttempted();
    eligibility.observe("loadedmetadata", element(video), false);
    eligibility.observe("durationchange", element(video), false);
    eligibility.bind(element(video), "abcdefghijk");
    expect(eligibility.eligible(snapshot(video), enabled)).toBe(false);
    const next = nextVideo(eligibility, video);
    video.currentSrc = "blob:synthetic-main-video-2";
    eligibility.observe("loadedmetadata", element(video), false);
    expect(eligibility.eligible(next, enabled)).toBe(true);
  });

  it("keeps explicit suppression for the same video but permits the next video", () => {
    const { eligibility, video } = bound();
    eligibility.suppress();
    expect(eligibility.eligible(snapshot(video), enabled)).toBe(false);
    eligibility.observe("loadedmetadata", element(video), false);
    eligibility.bind(element(video), "abcdefghijk");
    expect(eligibility.eligible(snapshot(video), enabled)).toBe(false);
    const next = nextVideo(eligibility, video);
    video.currentSrc = "blob:synthetic-main-video-2";
    expect(eligibility.eligible(next, enabled)).toBe(true);
  });

  it.each(["markAttempted", "suppress"] as const)(
    "allows fresh navigation back to the same video after %s",
    (prevent) => {
      const { eligibility, video } = bound();
      expect(eligibility.eligible(snapshot(video), enabled)).toBe(true);
      eligibility[prevent]();
      expect(eligibility.eligible(snapshot(video), enabled)).toBe(false);
      eligibility.navigationStart();
      eligibility.bind(element(video), "abcdefghijk");
      eligibility.navigationFinish();
      // Resetting this visit does not make the prior media fresh.
      expect(eligibility.eligible(snapshot(video), enabled)).toBe(false);
      eligibility.observe("loadedmetadata", element(video), false);
      expect(eligibility.eligible(snapshot(video), enabled)).toBe(true);
    },
  );

  it("refuses every snapshot while YouTube navigation is in progress", () => {
    const { eligibility, video } = bound();
    expect(eligibility.eligible(snapshot(video), enabled)).toBe(true);
    eligibility.navigationStart();
    video.currentSrc = "blob:synthetic-main-video-2";
    eligibility.observe("loadedmetadata", element(video), false);
    eligibility.bind(element(video), "11111111111");
    const next = snapshot(video, { id: "11111111111" });
    expect(eligibility.eligible(next, enabled)).toBe(false);
    eligibility.navigationFinish();
    expect(eligibility.eligible(next, enabled)).toBe(true);
  });

  it("does not reuse the old SPA duration until fresh main metadata arrives", () => {
    const { eligibility, video } = bound();
    eligibility.observe("loadedmetadata", element(video), false);
    expect(eligibility.eligible(snapshot(video), enabled)).toBe(true);
    const next = nextVideo(eligibility, video);
    // A new watch id/public duration alone can coincide with the old source.
    expect(eligibility.eligible(next, enabled)).toBe(false);
    expect(eligibility.eligible(next, enabled)).toBe(false);
    eligibility.observe("loadedmetadata", element(video), false);
    expect(eligibility.eligible(next, enabled)).toBe(true);
  });

  it("accepts a changed SPA source only with matching public duration when no metadata event was seen", () => {
    const { eligibility, video } = bound();
    expect(eligibility.eligible(snapshot(video), enabled)).toBe(true);
    const next = nextVideo(eligibility, video);
    video.currentSrc = "blob:synthetic-main-video-2";
    video.duration = 180;
    expect(
      eligibility.eligible(
        {
          ...next,
          publicDurationMatches: false,
        },
        enabled,
      ),
    ).toBe(false);
    expect(eligibility.eligible(next, enabled)).toBe(true);
  });

  it("retains main metadata captured before the SPA's new video is bound", () => {
    const { eligibility, video } = bound();
    expect(eligibility.eligible(snapshot(video), enabled)).toBe(true);
    eligibility.navigationStart();
    video.currentSrc = "blob:synthetic-main-video-2";
    video.duration = 180;
    eligibility.observe("loadedmetadata", element(video), false);
    eligibility.bind(element(video), "11111111111");
    eligibility.navigationFinish();
    expect(
      eligibility.eligible(
        snapshot(video, {
          id: "11111111111",
          publicDurationMatches: false,
        }),
        enabled,
      ),
    ).toBe(true);
  });

  it("retains fresh next-video metadata before bind even without a navigation-start event", () => {
    const { eligibility, video } = bound();
    eligibility.observe("loadedmetadata", element(video), false);
    expect(eligibility.eligible(snapshot(video), enabled)).toBe(true);
    eligibility.markAttempted();
    // Media can change before YouTube publishes its route/video-id boundary.
    video.currentSrc = "blob:synthetic-main-video-2";
    video.duration = 180;
    eligibility.observe("loadedmetadata", element(video), false);
    expect(
      eligibility.eligible(
        snapshot(video, {
          publicDurationMatches: false,
        }),
        enabled,
      ),
    ).toBe(false);
    eligibility.bind(element(video), "11111111111");
    expect(
      eligibility.eligible(
        snapshot(video, {
          id: "11111111111",
          publicDurationMatches: false,
        }),
        enabled,
      ),
    ).toBe(true);
  });

  it("preserves an ad source captured before the first player bind", () => {
    const eligibility = new VideoEligibility();
    const video = media({
      duration: 15,
      currentSrc: "blob:synthetic-advertisement",
    });
    eligibility.observe("loadedmetadata", element(video), true);
    eligibility.bind(element(video), "abcdefghijk");
    // An ad class disappearing is insufficient evidence of main media.
    eligibility.observe("loadedmetadata", element(video), false);
    expect(
      eligibility.eligible(
        snapshot(video, {
          publicDurationMatches: false,
        }),
        enabled,
      ),
    ).toBe(false);
    video.currentSrc = "blob:synthetic-main-video-1";
    video.duration = 120;
    eligibility.observe("loadedmetadata", element(video), false);
    expect(eligibility.eligible(snapshot(video), enabled)).toBe(true);
  });

  it("never accepts an advertisement's duration after the ad flag is removed", () => {
    const { eligibility, video } = bound();
    eligibility.observe("loadedmetadata", element(video), false);
    expect(eligibility.eligible(snapshot(video), enabled)).toBe(true);
    video.currentSrc = "blob:synthetic-advertisement";
    video.duration = 15;
    eligibility.observe("loadedmetadata", element(video), true);
    expect(eligibility.eligible(snapshot(video, { ad: true }), enabled)).toBe(
      false,
    );
    const adRemoved = snapshot(video, { publicDurationMatches: false });
    expect(eligibility.eligible(adRemoved, enabled)).toBe(false);
    eligibility.observe("loadedmetadata", element(video), false);
    expect(eligibility.eligible(adRemoved, enabled)).toBe(false);
    video.currentSrc = "blob:synthetic-main-video-1";
    video.duration = 120;
    eligibility.observe("loadedmetadata", element(video), false);
    expect(eligibility.eligible(snapshot(video), enabled)).toBe(true);
  });

  it("tracks an advertisement loaded after its ad flag first appeared", () => {
    const { eligibility, video } = bound();
    eligibility.observe("loadedmetadata", element(video), false);
    expect(eligibility.eligible(snapshot(video), enabled)).toBe(true);
    // YouTube can add its ad class before replacing the media source.
    expect(eligibility.eligible(snapshot(video, { ad: true }), enabled)).toBe(
      false,
    );
    video.currentSrc = "blob:synthetic-advertisement";
    video.duration = 15;
    eligibility.observe("loadedmetadata", element(video), true);
    expect(eligibility.eligible(snapshot(video, { ad: true }), enabled)).toBe(
      false,
    );
    const adRemoved = snapshot(video, { publicDurationMatches: false });
    eligibility.observe("durationchange", element(video), false);
    expect(eligibility.eligible(adRemoved, enabled)).toBe(false);
    video.currentSrc = "blob:synthetic-main-video-1";
    video.duration = 120;
    eligibility.observe("loadedmetadata", element(video), false);
    expect(eligibility.eligible(snapshot(video), enabled)).toBe(true);
  });

  it("invalidates metadata evidence when the player is emptied or starts a new load", () => {
    for (const event of ["emptied", "loadstart"]) {
      const { eligibility, video } = bound();
      expect(eligibility.eligible(snapshot(video), enabled)).toBe(true);
      const next = nextVideo(eligibility, video);
      eligibility.observe("loadedmetadata", element(video), false);
      eligibility.observe(event, element(video), false);
      expect(eligibility.eligible(next, enabled)).toBe(false);
      eligibility.observe("loadedmetadata", element(video), false);
      expect(eligibility.eligible(next, enabled)).toBe(true);
    }
  });

  it("does not count nonmetadata, ad or invalid metadata events as freshness", () => {
    const { eligibility, video } = bound();
    expect(eligibility.eligible(snapshot(video), enabled)).toBe(true);
    const next = nextVideo(eligibility, video);
    eligibility.observe("timeupdate", element(video), false);
    eligibility.observe("loadedmetadata", element(video), true);
    expect(eligibility.eligible(next, enabled)).toBe(false);
    video.readyState = 0;
    eligibility.observe("loadedmetadata", element(video), false);
    video.readyState = 4;
    video.duration = Infinity;
    eligibility.observe("durationchange", element(video), false);
    video.duration = 120;
    expect(eligibility.eligible(next, enabled)).toBe(false);
  });

  it("can use a new loaded main video element while rejecting the retired element", () => {
    const { eligibility, video } = bound();
    expect(eligibility.eligible(snapshot(video), enabled)).toBe(true);
    eligibility.markAttempted();
    const replacement = media({ currentSrc: "blob:synthetic-main-video-2" });
    const next = nextVideo(eligibility, replacement);
    expect(eligibility.eligible(next, enabled)).toBe(true);
    expect(
      eligibility.eligible(
        snapshot(video, {
          id: "11111111111",
        }),
        enabled,
      ),
    ).toBe(false);
  });

  it("preserves attempt and suppression when only the same video's element is replaced", () => {
    for (const prevent of ["markAttempted", "suppress"] as const) {
      const { eligibility, video } = bound();
      expect(eligibility.eligible(snapshot(video), enabled)).toBe(true);
      eligibility[prevent]();
      const replacement = media({ currentSrc: "blob:synthetic-replacement" });
      eligibility.bind(element(replacement), "abcdefghijk");
      expect(eligibility.eligible(snapshot(replacement), enabled)).toBe(false);
    }
  });
});

import { expect, it, vi } from "vitest";
import {
  PlaybackController,
  type PlaybackSource,
  type PlaybackSourcePort,
} from "../src/main/player/controller.js";
import { PlaybackTimeline } from "../src/main/player/timeline.js";
import { parsePlaybackCommand } from "../src/shared/playback-contracts.js";
import { parseDesktopCommand } from "../src/shared/contracts.js";
function source(extra: Partial<PlaybackSource> = {}): PlaybackSource {
  return {
    url: `http://127.0.0.1:12345/media/00000000-0000-4000-8000-000000000001?capability=${"a".repeat(43)}`,
    originalDuration: 10,
    sourceDuration: 10,
    trimmed: false,
    release: vi.fn(async () => {}),
    ...extra,
  };
}
function fixture(
  listening?: ConstructorParameters<typeof PlaybackController>[3],
) {
  const opened: PlaybackSource[] = [];
  const sources = {
    open: vi.fn(async () => {
      const value = source();
      opened.push(value);
      return value;
    }),
  };
  const accounting = {
    begin: vi.fn(async () => {}),
    pulse: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
  };
  return {
    player: new PlaybackController(sources, accounting, () => 0.7, listening),
    sources,
    accounting,
    opened,
  };
}
it("retires account playback and queued identities before blocked accounting can finish", async () => {
  const f = fixture(),
    accountSource = source({ accountOwned: true });
  f.sources.open.mockResolvedValue(accountSource);
  await f.player.playFromLibrary("account:one", [
    "account:one",
    "account:two",
    "guest:three",
  ]);
  await event(f.player, "playing");
  let finish!: () => void;
  f.accounting.end.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const retiring = f.player.invalidateOwner((id) => id.startsWith("account:"));
  expect(f.player.view()).toMatchObject({
    trackId: null,
    url: null,
    phase: "idle",
    queue: ["guest:three"],
  });
  expect(accountSource.release).not.toHaveBeenCalled();
  let settled = false;
  void retiring.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  finish();
  await retiring;
  expect(accountSource.release).toHaveBeenCalledOnce();
  await f.player.dispose();
});
async function event(
  player: PlaybackController,
  kind:
    "loaded" | "playing" | "paused" | "buffering" | "time" | "ended" | "error",
  position = 0,
) {
  return player.execute({
    type: "MEDIA_EVENT",
    generation: player.view().generation,
    event: kind,
    position,
  });
}
it("starts immediately and freezes only the following visible Library order", async () => {
  const h = fixture(),
    loading = h.player.playFromLibrary("b", ["a", "b", "c", "d"]);
  expect(h.player.view()).toMatchObject({
    trackId: "b",
    phase: "preparing",
    queue: ["c", "d"],
  });
  await loading;
  await h.player.execute({ type: "NEXT" });
  expect(h.player.view().trackId).toBe("c");
  expect(h.player.view().queue).toEqual(["d"]);
  await expect(h.player.playFromLibrary("hidden", ["a", "b"])).rejects.toThrow(
    "MEDIA_UNAVAILABLE",
  );
  await h.player.dispose();
});
it.each([
  {
    phase: "buffering",
    repeat: "off",
    shuffle: false,
    target: "two",
    queue: ["three"],
  },
  {
    phase: "playing",
    repeat: "off",
    shuffle: true,
    target: "three",
    queue: ["two"],
  },
  {
    phase: "paused",
    repeat: "queue",
    shuffle: false,
    target: "two",
    queue: ["three", "one"],
  },
] as const)(
  "does not consume another Next while the first source is preparing ($phase, repeat=$repeat, shuffle=$shuffle)",
  async (scenario) => {
    let resolve!: (value: PlaybackSource) => void,
      signal: AbortSignal | undefined;
    const first = source(),
      next = source(),
      open = vi.fn<PlaybackSourcePort["open"]>(
        async (id, _variant, selectedSignal) => {
          if (id === "one") return first;
          if (id !== scenario.target) throw new Error("UNEXPECTED_NEXT");
          signal = selectedSignal;
          return await new Promise<PlaybackSource>((done) => {
            resolve = done;
          });
        },
      ),
      accounting = {
        begin: vi.fn(async () => {}),
        pulse: vi.fn(async () => {}),
        end: vi.fn(async () => {}),
      },
      player = new PlaybackController({ open }, accounting, () => 0.7);
    await player.execute({ type: "LOAD", trackId: "one" });
    if (scenario.phase !== "buffering") await event(player, "playing");
    if (scenario.phase === "paused") await player.execute({ type: "PAUSE" });
    await player.execute({ type: "QUEUE", ids: ["two", "three"] });
    await player.execute({ type: "REPEAT", mode: scenario.repeat });
    await player.execute({ type: "SHUFFLE", enabled: scenario.shuffle });
    const oldGeneration = player.view().generation,
      starts = accounting.begin.mock.calls.length,
      loading = player.execute({ type: "NEXT" });
    await vi.waitFor(() => expect(resolve).toBeDefined());
    const pending = player.view();
    expect(pending).toMatchObject({
      phase: "preparing",
      trackId: scenario.target,
      queue: scenario.queue,
    });
    await player.execute({ type: "NEXT" });
    await player.execute({
      type: "MEDIA_EVENT",
      generation: oldGeneration,
      event: "ended",
      position: 10,
    });
    expect(player.view()).toEqual(pending);
    expect(signal?.aborted).toBe(false);
    expect(open).toHaveBeenCalledTimes(2);
    expect(first.release).toHaveBeenCalledOnce();
    expect(next.release).not.toHaveBeenCalled();
    expect(accounting.begin).toHaveBeenCalledTimes(starts);
    resolve(next);
    await loading;
    expect(player.view()).toMatchObject({
      phase: "buffering",
      trackId: scenario.target,
      queue: scenario.queue,
    });
    expect(accounting.begin).toHaveBeenCalledTimes(starts);
    await event(player, "playing");
    expect(accounting.begin).toHaveBeenCalledTimes(starts + 1);
    await player.dispose();
    expect(next.release).toHaveBeenCalledOnce();
  },
);
it("keeps the original timeline across trimmed voice switches and clamps cuts without proportional remapping", () => {
  const timeline = new PlaybackTimeline(10, true, [
    [44100, 3 * 44100],
    [5 * 44100, 9 * 44100],
  ]);
  expect(timeline.outputDuration).toBe(6);
  expect(timeline.toOriginal(0)).toBe(1);
  expect(timeline.toOriginal(2)).toBe(5);
  expect(timeline.toOutput(4)).toBe(2);
  expect(timeline.toOriginal(99)).toBe(9);
  expect(timeline.toOutput(10)).toBe(6);
  expect(() => new PlaybackTimeline(10, true)).toThrow(
    "COMPARISON_TIMELINE_UNAVAILABLE",
  );
  expect(
    () =>
      new PlaybackTimeline(10, true, [
        [0, 44100],
        [100, 200],
      ]),
  ).toThrow();
});
it("counts AB repeats only after the matching actual seek completes and preserves markers across comparison", async () => {
  const f = fixture({
    store: {
      read: async () => null,
      write: async () => {},
      quarantine: async () => {},
    },
    owner: () => ({ key: "local", fence: "guest" }),
  });
  await f.player.execute({ type: "LOAD", trackId: "one" });
  await event(f.player, "playing");
  await event(f.player, "time", 1);
  await f.player.execute({ type: "LOOP_START" });
  await event(f.player, "time", 4);
  await f.player.execute({ type: "LOOP_END" });
  await event(f.player, "time", 4.1);
  const revision = f.player.view().seekRevision;
  expect(f.accounting.begin).toHaveBeenCalledOnce();
  expect(f.accounting.end).not.toHaveBeenCalled();
  await event(f.player, "time", 4.2);
  expect(f.player.view().seekRevision).toBe(revision);
  await f.player.execute({
    type: "MEDIA_EVENT",
    generation: f.player.view().generation,
    event: "seeked",
    position: 1,
    seekRevision: revision - 1,
  });
  expect(f.accounting.begin).toHaveBeenCalledOnce();
  await f.player.execute({
    type: "MEDIA_EVENT",
    generation: f.player.view().generation,
    event: "seeked",
    position: 1,
    seekRevision: revision,
  });
  expect(f.accounting.begin).toHaveBeenCalledTimes(2);
  expect(f.accounting.end).toHaveBeenCalledOnce();
  await f.player.execute({
    type: "MEDIA_EVENT",
    generation: f.player.view().generation,
    event: "seeked",
    position: 1,
    seekRevision: revision,
  });
  expect(f.accounting.begin).toHaveBeenCalledTimes(2);
  await f.player.execute({ type: "SOURCE", variant: "original" });
  expect(f.player.view().listening).toMatchObject({ loopStart: 1, loopEnd: 4 });
  await f.player.dispose();
});
it("starts accounting only from actual playing and ignores buffering, seek and variant switches as new plays", async () => {
  const f = fixture();
  await f.player.execute({ type: "LOAD", trackId: "local:one" });
  expect(f.accounting.begin).not.toHaveBeenCalled();
  await event(f.player, "buffering");
  await event(f.player, "playing");
  await f.player.execute({ type: "SEEK", seconds: 4 });
  await f.player.execute({ type: "SOURCE", variant: "original" });
  expect(f.player.view().position).toBe(4);
  await event(f.player, "playing");
  await event(f.player, "time", 5);
  expect(f.accounting.begin).toHaveBeenCalledOnce();
  expect(f.accounting.pulse).toHaveBeenCalledOnce();
  await f.player.execute({ type: "STOP" });
  expect(f.accounting.end).toHaveBeenCalledOnce();
  expect(f.opened[0]!.release).toHaveBeenCalledOnce();
  expect(f.opened[1]!.release).toHaveBeenCalledOnce();
});
it("restores audible volume after zero-volume mute while keeping rate bounded", async () => {
  const f = fixture();
  await f.player.execute({ type: "VOLUME", level: 0.37 });
  await f.player.execute({ type: "VOLUME", level: 0 });
  expect(f.player.view().muted).toBe(true);
  await f.player.execute({ type: "MUTE" });
  expect(f.player.view()).toMatchObject({ volume: 0.37, muted: false });
  await expect(f.player.execute({ type: "RATE", rate: 99 })).rejects.toThrow(
    "INVALID_REQUEST",
  );
});
it("uses visible queue order, controlled shuffle and repeat without adding source-switch entries", async () => {
  const f = fixture();
  await f.player.execute({ type: "LOAD", trackId: "one" });
  await f.player.execute({
    type: "QUEUE",
    ids: ["two", "three", "four"],
  });
  await f.player.execute({ type: "SHUFFLE", enabled: true });
  await f.player.execute({ type: "REPEAT", mode: "queue" });
  await f.player.execute({ type: "NEXT" });
  expect(f.player.view()).toMatchObject({
    trackId: "four",
    queue: ["two", "three", "one"],
  });
  await f.player.execute({ type: "SHUFFLE", enabled: false });
  await event(f.player, "playing");
  await event(f.player, "ended", 10);
  expect(f.player.view()).toMatchObject({
    trackId: "two",
    queue: ["three", "one", "four"],
  });
});
it("track repeat resets position and creates accounting only when playback really resumes", async () => {
  const f = fixture();
  await f.player.execute({ type: "LOAD", trackId: "one" });
  await event(f.player, "playing");
  await f.player.execute({ type: "REPEAT", mode: "track" });
  await event(f.player, "ended", 10);
  expect(f.player.view()).toMatchObject({
    trackId: "one",
    position: 0,
    requestedPlaying: true,
  });
  expect(f.accounting.end).toHaveBeenCalledOnce();
  expect(f.accounting.begin).toHaveBeenCalledOnce();
  await event(f.player, "ended", 10);
  expect(f.accounting.end).toHaveBeenCalledOnce();
  await event(f.player, "playing");
  expect(f.accounting.begin).toHaveBeenCalledTimes(2);
});
it("late media events and late source publication cannot revive stopped playback or leak a pin", async () => {
  const f = fixture();
  let resolve!: (value: PlaybackSource) => void;
  f.sources.open = vi.fn(
    () =>
      new Promise<PlaybackSource>((done) => {
        resolve = done;
      }),
  );
  const pending = f.player.execute({ type: "LOAD", trackId: "one" });
  await vi.waitFor(() => expect(resolve).toBeDefined());
  const generation = f.player.view().generation;
  await f.player.stop();
  const late = source();
  resolve(late);
  await pending;
  expect(late.release).toHaveBeenCalledOnce();
  await f.player.execute({
    type: "MEDIA_EVENT",
    generation,
    event: "playing",
    position: 0,
  });
  expect(f.player.view().phase).toBe("idle");
});
it("retains sleep selected while playback is preparing through Ready and same-track comparison, then cancels on another track", async () => {
  const f = fixture({
    store: {
      read: async () => null,
      write: async () => {},
      quarantine: async () => {},
    },
    owner: () => ({ key: "local", fence: "guest" }),
    clock: {
      wall: () => 100000,
      monotonic: () => 0,
      set: () => Symbol("sleep"),
      clear: () => {},
    },
  });
  let ready!: (value: PlaybackSource) => void;
  f.sources.open.mockImplementationOnce(
    () =>
      new Promise<PlaybackSource>((resolve) => {
        ready = resolve;
      }),
  );
  const loading = f.player.execute({ type: "LOAD", trackId: "one" });
  await vi.waitFor(() => expect(ready).toBeDefined());
  await f.player.execute({ type: "SLEEP", seconds: 60 });
  expect(f.player.view().listening?.sleepRemainingSeconds).toBe(60);
  ready(source());
  await loading;
  expect(f.player.view().listening?.sleepRemainingSeconds).toBe(60);
  await f.player.execute({ type: "SOURCE", variant: "original" });
  await f.player.execute({ type: "RESTART" });
  expect(f.player.view().listening?.sleepRemainingSeconds).toBe(60);
  await f.player.execute({ type: "LOAD", trackId: "two" });
  expect(f.player.view().listening?.sleepRemainingSeconds).toBeNull();
  await f.player.dispose();
});
it("does not apply an old time event to a new track's AB loop after delayed actual accounting", async () => {
  const f = fixture({
    store: {
      read: async () => null,
      write: async () => {},
      quarantine: async () => {},
    },
    owner: () => ({ key: "local", fence: "guest" }),
  });
  await f.player.execute({ type: "LOAD", trackId: "one" });
  await event(f.player, "playing");
  let release!: () => void;
  f.accounting.pulse.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const delayed = event(f.player, "time", 8);
  await vi.waitFor(() => expect(release).toBeDefined());
  await f.player.execute({ type: "LOAD", trackId: "two" });
  await event(f.player, "playing");
  await f.player.execute({ type: "SEEK", seconds: 1 });
  await f.player.execute({ type: "LOOP_START" });
  await f.player.execute({ type: "SEEK", seconds: 4 });
  await f.player.execute({ type: "LOOP_END" });
  const snapshot = f.player.view();
  release();
  await delayed;
  expect(f.player.view()).toMatchObject({
    trackId: "two",
    generation: snapshot.generation,
    position: 4,
    seekRevision: snapshot.seekRevision,
    listening: { loopStart: 1, loopEnd: 4 },
  });
  expect(f.accounting.begin).toHaveBeenCalledTimes(2);
  await f.player.dispose();
});
it("fences a matched old repeat seek across delayed accounting retirement before a new track is ready", async () => {
  const f = fixture({
    store: {
      read: async () => null,
      write: async () => {},
      quarantine: async () => {},
    },
    owner: () => ({ key: "local", fence: "guest" }),
  });
  await f.player.execute({ type: "LOAD", trackId: "one" });
  await event(f.player, "playing");
  await f.player.execute({ type: "SEEK", seconds: 1 });
  await f.player.execute({ type: "LOOP_START" });
  await f.player.execute({ type: "SEEK", seconds: 4 });
  await f.player.execute({ type: "LOOP_END" });
  await event(f.player, "time", 4.1);
  const old = f.player.view();
  let release!: () => void;
  f.accounting.end.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const delayed = f.player.execute({
    type: "MEDIA_EVENT",
    event: "seeked",
    generation: old.generation,
    seekRevision: old.seekRevision,
    position: 1,
  });
  await vi.waitFor(() => expect(release).toBeDefined());
  await f.player.execute({ type: "LOAD", trackId: "two" });
  await event(f.player, "playing");
  await f.player.execute({ type: "LOOP_START" });
  await f.player.execute({ type: "SEEK", seconds: 0.5 });
  await f.player.execute({ type: "LOOP_END" });
  const snapshot = f.player.view();
  release();
  await delayed;
  expect(f.player.view()).toMatchObject({
    trackId: "two",
    generation: snapshot.generation,
    position: 0.5,
    seekRevision: snapshot.seekRevision,
    listening: { loopStart: 0, loopEnd: 0.5 },
  });
  expect(f.accounting.begin).toHaveBeenCalledTimes(2);
  await f.player.dispose();
});
it("aborts old silence analysis as a source replacement starts and cannot publish its late failure onto the replacement", async () => {
  const f = fixture({
    store: {
      read: async () => null,
      write: async () => {},
      quarantine: async () => {},
    },
    owner: () => ({ key: "local", fence: "guest" }),
  });
  let fail!: (error: Error) => void,
    signal: AbortSignal | undefined,
    ready!: (value: PlaybackSource) => void;
  const voice = source({
    analyzeSilence: async (selectedSignal) => {
      signal = selectedSignal;
      return new Promise((_yes, no) => {
        fail = no;
      });
    },
  });
  f.sources.open.mockResolvedValueOnce(voice).mockImplementationOnce(
    () =>
      new Promise<PlaybackSource>((resolve) => {
        ready = resolve;
      }),
  );
  await f.player.execute({ type: "LOAD", trackId: "one" });
  const analyzing = f.player.execute({ type: "SKIP_SILENCE", enabled: true });
  await vi.waitFor(() => expect(fail).toBeDefined());
  const replacing = f.player.execute({ type: "SOURCE", variant: "original" });
  expect(signal?.aborted).toBe(true);
  await vi.waitFor(() => expect(ready).toBeDefined());
  expect(voice.release).toHaveBeenCalledOnce();
  fail(new Error("old analysis failed after cancellation"));
  await analyzing;
  expect(f.player.view().listening).toMatchObject({
    skipSilence: false,
    analyzingSilence: false,
    error: null,
  });
  ready(source());
  await replacing;
  expect(f.player.view()).toMatchObject({
    variant: "original",
    phase: "buffering",
    listening: { error: null, skipSilence: false },
  });
  await f.player.dispose();
});
it("keeps actual guest source bookmarks in the local owner partition through account changes", async () => {
  let owner = { key: "account:a", fence: "generation:a" };
  const store = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => {}),
      quarantine: vi.fn(async () => {}),
    },
    f = fixture({
      store,
      owner: () => owner,
      guestOwner: () => ({ key: "local", fence: "guest" }),
    });
  f.sources.open.mockImplementation(async () =>
    source({ accountOwned: false }),
  );
  await f.player.execute({ type: "LOAD", trackId: "local:one" });
  await f.player.execute({ type: "SEEK", seconds: 2 });
  await f.player.execute({ type: "BOOKMARK_ADD" });
  const bookmark = f.player.view().listening!.bookmarks[0]!;
  owner = { key: "account:b", fence: "generation:b" };
  f.player.refreshListeningOwner();
  expect(f.player.view().listening!.bookmarks).toEqual([bookmark]);
  expect(store.read).toHaveBeenCalledTimes(1);
  expect(store.read).toHaveBeenCalledWith("local", "local:one");
  expect(store.write).toHaveBeenCalledWith(
    "local",
    "local:one",
    expect.objectContaining({ owner: "local", bookmarks: [bookmark] }),
  );
  await f.player.dispose();
});
it("rejects arbitrary media URLs and inconsistent duration maps with exact pin cleanup", async () => {
  for (const invalid of [
    source({ url: "file:///C:/private.mp3" }),
    source({ sourceDuration: 6 }),
    source({ trimmed: true, sourceDuration: 0 }),
  ]) {
    const f = fixture();
    f.sources.open = vi.fn(async () => invalid);
    await f.player.execute({ type: "LOAD", trackId: "one" });
    expect(f.player.view().phase).toBe("error");
    expect(invalid.release).toHaveBeenCalledOnce();
  }
});
it("account loss revokes account media but keeps offline local audio and local queue entries", async () => {
  const f = fixture();
  await f.player.execute({ type: "LOAD", trackId: "local:one" });
  await f.player.execute({
    type: "QUEUE",
    ids: ["account:two", "local:three"],
  });
  await f.player.invalidateOwner((id) => id.startsWith("account:"));
  expect(f.player.view()).toMatchObject({
    trackId: "local:one",
    queue: ["local:three"],
  });
  f.sources.open = vi.fn(async () => source({ accountOwned: true }));
  await f.player.execute({ type: "LOAD", trackId: "account:two" });
  await f.player.invalidateOwner();
  expect(f.player.view().phase).toBe("idle");
});
it("accepts only bounded commands with exact keys, finite values and media generations", () => {
  for (const command of [
    { type: "LOAD", trackId: "C:\\secret" },
    { type: "QUEUE", ids: Array.from({ length: 1001 }, () => "one") },
    { type: "VOLUME", level: NaN },
    { type: "SEEK", seconds: -1 },
    { type: "PLAY", path: "secret" },
    { type: "MEDIA_EVENT", generation: "old", event: "playing", position: 0 },
  ])
    expect(() => parsePlaybackCommand(command)).toThrow("INVALID_REQUEST");
});
it("plays standalone trimmed voice in verified output time while refusing an unavailable original conversion", async () => {
  const f = fixture(),
    value = source({
      trimmed: true,
      sourceDuration: 6,
      voiceDuration: 6,
      timelineIdentity: "a".repeat(64),
    });
  f.sources.open = vi.fn(async () => value);
  await f.player.execute({ type: "LOAD", trackId: "one" });
  expect(f.player.view()).toMatchObject({
    duration: 6,
    timeCoordinate: "voice-output",
    comparisonAvailable: false,
  });
  await event(f.player, "playing");
  await event(f.player, "time", 4);
  expect(f.player.view().position).toBe(4);
  await f.player.execute({ type: "SEEK", seconds: 2 });
  expect(f.player.view().sourcePosition).toBe(2);
  await f.player.execute({ type: "SOURCE", variant: "original" });
  expect(f.player.view()).toMatchObject({
    phase: "playing",
    variant: "voice",
    url: value.url,
    error: "COMPARISON_TIMELINE_UNAVAILABLE",
  });
  expect(f.sources.open).toHaveBeenCalledOnce();
  await f.player.dispose();
  expect(value.release).toHaveBeenCalledOnce();
});
it("plays direct original independently when the trimmed voice duration/map is absent", async () => {
  const f = fixture();
  f.sources.open = vi.fn(async () =>
    source({ trimmed: true, voiceDuration: null }),
  );
  await f.player.playFromLibrary("one", ["one", "two"], "original");
  expect(f.player.view()).toMatchObject({
    variant: "original",
    duration: 10,
    timeCoordinate: "original",
    comparisonAvailable: false,
  });
  await f.player.execute({ type: "SOURCE", variant: "voice" });
  expect(f.player.view().variant).toBe("original");
  await f.player.dispose();
});
it("Restart seeks without forcing paused playback or adding another play count", async () => {
  const f = fixture();
  await f.player.execute({ type: "LOAD", trackId: "one" });
  await event(f.player, "playing");
  await event(f.player, "time", 5);
  await f.player.execute({ type: "PAUSE" });
  await f.player.execute({ type: "RESTART" });
  expect(f.player.view()).toMatchObject({
    position: 0,
    requestedPlaying: false,
    phase: "paused",
  });
  expect(f.accounting.begin).toHaveBeenCalledOnce();
  expect(f.accounting.end).not.toHaveBeenCalled();
  await f.player.dispose();
});
it("manual Next retains track repeat and only counts an actual resumed play", async () => {
  const f = fixture();
  await f.player.execute({ type: "LOAD", trackId: "one" });
  await event(f.player, "playing");
  await f.player.execute({ type: "QUEUE", ids: ["two"] });
  await f.player.execute({ type: "REPEAT", mode: "track" });
  await f.player.execute({ type: "NEXT" });
  expect(f.player.view()).toMatchObject({
    trackId: "one",
    position: 0,
    queue: ["two"],
    phase: "buffering",
  });
  expect(f.accounting.begin).toHaveBeenCalledOnce();
  await event(f.player, "playing");
  expect(f.accounting.begin).toHaveBeenCalledTimes(2);
  await f.player.dispose();
});
it("Next retains the original variant where available and selects voice for a missing original", async () => {
  const f = fixture();
  Object.assign(f.sources, {
    available: (id: string, variant: string) =>
      id !== "three" || variant !== "original",
  });
  await f.player.execute({ type: "LOAD", trackId: "one" });
  await f.player.execute({ type: "SOURCE", variant: "original" });
  await f.player.execute({ type: "QUEUE", ids: ["two", "three"] });
  await f.player.execute({ type: "NEXT" });
  expect(f.player.view()).toMatchObject({
    trackId: "two",
    variant: "original",
  });
  await f.player.execute({ type: "NEXT" });
  expect(f.player.view()).toMatchObject({ trackId: "three", variant: "voice" });
  await f.player.dispose();
});
it("queued Play consumes just the selected repeated occurrence, defaults to voice and rejects old generations", async () => {
  const f = fixture();
  await f.player.execute({ type: "LOAD", trackId: "one" });
  await f.player.execute({ type: "SOURCE", variant: "original" });
  await f.player.execute({ type: "QUEUE", ids: ["a", "b", "a"] });
  const generation = f.player.view().generation;
  const queueRevision = f.player.view().queueRevision!;
  await f.player.execute({
    type: "QUEUE_PLAY",
    generation,
    queueRevision,
    index: 2,
    trackId: "a",
  });
  expect(f.player.view()).toMatchObject({
    trackId: "a",
    variant: "voice",
    queue: ["a", "b"],
  });
  await expect(
    f.player.execute({
      type: "QUEUE_PLAY",
      generation,
      queueRevision,
      index: 0,
      trackId: "a",
    }),
  ).rejects.toThrow("INVALID_REQUEST");
  await f.player.dispose();
});
it("rejects a stale queue occurrence even when its index and duplicate track still match", async () => {
  const f = fixture();
  await f.player.execute({ type: "LOAD", trackId: "playing" });
  await f.player.execute({ type: "QUEUE", ids: ["a", "b", "a", "c"] });
  const old = f.player.view(),
    fence = { generation: old.generation, queueRevision: old.queueRevision! };
  await f.player.execute({
    type: "QUEUE_EDIT",
    action: "move",
    index: 0,
    to: 2,
    trackId: "a",
    ...fence,
  });
  expect(f.player.view().queue).toEqual(["b", "a", "a", "c"]);
  await expect(
    f.player.execute({
      type: "QUEUE_EDIT",
      action: "remove",
      index: 2,
      trackId: "a",
      ...fence,
    }),
  ).rejects.toThrow("INVALID_REQUEST");
  await expect(
    f.player.execute({ type: "QUEUE_PLAY", index: 2, trackId: "a", ...fence }),
  ).rejects.toThrow("INVALID_REQUEST");
  expect(f.player.view()).toMatchObject({
    trackId: "playing",
    generation: old.generation,
    queue: ["b", "a", "a", "c"],
  });
  await f.player.dispose();
});
it("inserts Play next and appends atomically, then clears only upcoming audio without restarting playback", async () => {
  const f = fixture();
  await f.player.execute({ type: "LOAD", trackId: "playing" });
  await event(f.player, "playing");
  const edit = async (action: "append" | "insert-next", trackId: string) => {
    const view = f.player.view();
    await f.player.execute({
      type: "QUEUE_EDIT",
      action,
      trackId,
      generation: view.generation,
      queueRevision: view.queueRevision!,
    });
  };
  await edit("append", "last");
  await edit("insert-next", "next");
  expect(f.player.view().queue).toEqual(["next", "last"]);
  const before = f.player.view();
  await f.player.execute({
    type: "QUEUE_EDIT",
    action: "clear",
    generation: before.generation,
    queueRevision: before.queueRevision!,
  });
  expect(f.player.view()).toMatchObject({
    trackId: "playing",
    phase: "playing",
    generation: before.generation,
    queue: [],
  });
  expect(f.accounting.begin).toHaveBeenCalledOnce();
  await f.player.dispose();
});
it("rejects unfenced renderer queue replacement and malformed queue edits at the actual desktop boundary", () => {
  const generation = "00000000-0000-4000-8000-000000000001";
  for (const command of [
    { type: "QUEUE", ids: ["a"] },
    { type: "QUEUE_PLAY", generation, index: 0, trackId: "a" },
    {
      type: "QUEUE_EDIT",
      action: "remove",
      generation,
      queueRevision: -1,
      index: 0,
      trackId: "a",
    },
    {
      type: "QUEUE_EDIT",
      action: "clear",
      generation,
      queueRevision: 0,
      ids: [],
    },
  ])
    expect(() => parseDesktopCommand({ type: "PLAYBACK", command })).toThrow(
      "INVALID_REQUEST",
    );
});
it("checks current Library scope before queue intake and rejects account playback after its scope was revoked", async () => {
  const f = fixture();
  let allowed = true;
  Object.assign(f.sources, {
    canQueue: (id: string) => id === "guest" || (id === "account" && allowed),
  });
  await f.player.execute({ type: "LOAD", trackId: "guest" });
  const view = f.player.view();
  await f.player.execute({
    type: "QUEUE_EDIT",
    action: "append",
    trackId: "account",
    generation: view.generation,
    queueRevision: view.queueRevision!,
  });
  allowed = false;
  const current = f.player.view();
  await expect(
    f.player.execute({
      type: "QUEUE_PLAY",
      index: 0,
      trackId: "account",
      generation: current.generation,
      queueRevision: current.queueRevision!,
    }),
  ).rejects.toThrow("INVALID_REQUEST");
  await expect(
    f.player.execute({
      type: "QUEUE_EDIT",
      action: "insert-next",
      trackId: "unknown",
      generation: current.generation,
      queueRevision: current.queueRevision!,
    }),
  ).rejects.toThrow("MEDIA_UNAVAILABLE");
  expect(f.player.view()).toMatchObject({
    trackId: "guest",
    queue: ["account"],
  });
  await f.player.dispose();
});
it("stores standalone voice markers under an explicit artifact identity rather than pretending they are original time", async () => {
  const writes: unknown[][] = [],
    store = {
      read: async () => null,
      write: async (...args: unknown[]) => {
        writes.push(args);
      },
      quarantine: async () => {},
    },
    f = fixture({
      store,
      owner: () => ({ key: "owner", fence: "generation" }),
    });
  f.sources.open = vi.fn(async () =>
    source({
      trimmed: true,
      sourceDuration: 6,
      voiceDuration: 6,
      timelineIdentity: "a".repeat(64),
    }),
  );
  await f.player.execute({ type: "LOAD", trackId: "one" });
  await event(f.player, "playing");
  await event(f.player, "time", 4);
  await f.player.execute({ type: "BOOKMARK_ADD" });
  expect(writes[0]![1]).toMatch(/^voice:[a-f0-9]{64}$/u);
  expect(writes[0]![2]).toMatchObject({
    trackId: writes[0]![1],
    bookmarks: [expect.objectContaining({ seconds: 4 })],
  });
  await f.player.dispose();
});
it("checks sleep expiry before natural end can advance a queued track", async () => {
  let wall = 1000;
  const store = {
      read: async () => null,
      write: async () => {},
      quarantine: async () => {},
    },
    clock = {
      wall: () => wall,
      monotonic: () => wall,
      set: () => 1,
      clear: () => {},
    },
    f = fixture({
      store,
      owner: () => ({ key: "guest", fence: "guest" }),
      clock,
    });
  await f.player.execute({ type: "LOAD", trackId: "one" });
  await event(f.player, "playing");
  await f.player.execute({ type: "QUEUE", ids: ["two"] });
  await f.player.execute({ type: "SLEEP", seconds: 30 });
  wall += 31000;
  await event(f.player, "ended", 10);
  expect(f.player.view()).toMatchObject({
    trackId: "one",
    requestedPlaying: false,
    phase: "paused",
    queue: ["two"],
  });
  expect(f.sources.open).toHaveBeenCalledOnce();
  await f.player.dispose();
});
it("ends the old AB accounting on exact seek acknowledgement and counts only playback resumed after buffering", async () => {
  const store = {
      read: async () => null,
      write: async () => {},
      quarantine: async () => {},
    },
    f = fixture({ store, owner: () => ({ key: "guest", fence: "guest" }) });
  await f.player.execute({ type: "LOAD", trackId: "one" });
  await event(f.player, "playing");
  await event(f.player, "time", 1);
  await f.player.execute({ type: "LOOP_START" });
  await event(f.player, "time", 4);
  await f.player.execute({ type: "LOOP_END" });
  await event(f.player, "time", 4.1);
  await event(f.player, "buffering");
  await f.player.execute({
    type: "MEDIA_EVENT",
    generation: f.player.view().generation,
    event: "seeked",
    position: 1,
    seekRevision: f.player.view().seekRevision,
  });
  expect(f.accounting.end).toHaveBeenCalledOnce();
  expect(f.accounting.begin).toHaveBeenCalledOnce();
  await event(f.player, "playing");
  expect(f.accounting.begin).toHaveBeenCalledTimes(2);
  await f.player.dispose();
});
it("keeps a newer manual seek when an old same-source time event resumes after accounting", async () => {
  const f = fixture({
    store: {
      read: async () => null,
      write: async () => {},
      quarantine: async () => {},
    },
    owner: () => ({ key: "local", fence: "guest" }),
  });
  await f.player.execute({ type: "LOAD", trackId: "one" });
  await event(f.player, "playing");
  await event(f.player, "time", 1);
  await f.player.execute({ type: "LOOP_START" });
  await event(f.player, "time", 4);
  await f.player.execute({ type: "LOOP_END" });
  let release!: () => void;
  f.accounting.pulse.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const old = event(f.player, "time", 4.5);
  await vi.waitFor(() => expect(release).toBeDefined());
  await f.player.execute({ type: "SEEK", seconds: 2 });
  const next = f.player.view();
  release();
  await old;
  expect(f.player.view()).toMatchObject({
    generation: next.generation,
    position: 2,
    seekRevision: next.seekRevision,
  });
  expect(f.accounting.begin).toHaveBeenCalledOnce();
  await f.player.dispose();
});
it("does not count an old matched AB acknowledgement after a newer same-source seek", async () => {
  const f = fixture({
    store: {
      read: async () => null,
      write: async () => {},
      quarantine: async () => {},
    },
    owner: () => ({ key: "local", fence: "guest" }),
  });
  await f.player.execute({ type: "LOAD", trackId: "one" });
  await event(f.player, "playing");
  await event(f.player, "time", 1);
  await f.player.execute({ type: "LOOP_START" });
  await event(f.player, "time", 4);
  await f.player.execute({ type: "LOOP_END" });
  await event(f.player, "time", 4.5);
  let release!: () => void;
  f.accounting.end.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const prior = f.player.view();
  const old = f.player.execute({
    type: "MEDIA_EVENT",
    generation: prior.generation,
    event: "seeked",
    position: 1,
    seekRevision: prior.seekRevision,
  });
  await vi.waitFor(() => expect(release).toBeDefined());
  await f.player.execute({ type: "SEEK", seconds: 2 });
  const next = f.player.view();
  release();
  await old;
  expect(f.player.view()).toMatchObject({
    generation: next.generation,
    position: 2,
    seekRevision: next.seekRevision,
  });
  expect(f.accounting.begin).toHaveBeenCalledOnce();
  await f.player.dispose();
});
it("maps quiet output across retained cuts at variable rate without altering source identity or repeat accounting", async () => {
  const f = fixture({
    store: {
      read: async () => null,
      write: async () => {},
      quarantine: async () => {},
    },
    owner: () => ({ key: "local", fence: "guest" }),
  });
  const verified = source({
    sourceDuration: 6,
    trimmed: true,
    timelineIdentity: "a".repeat(64),
    comparisonRanges: [
      [44100, 3 * 44100],
      [5 * 44100, 9 * 44100],
    ],
    analyzeSilence: async () => [{ start: 0.5, end: 2.5 }],
  });
  const identity = structuredClone({
    timelineIdentity: verified.timelineIdentity,
    ranges: verified.comparisonRanges,
    duration: verified.sourceDuration,
    trimmed: verified.trimmed,
  });
  f.sources.open.mockResolvedValue(verified);
  await f.player.execute({ type: "LOAD", trackId: "one" });
  await event(f.player, "playing");
  await f.player.execute({ type: "RATE", rate: 2 });
  await f.player.execute({ type: "SKIP_SILENCE", enabled: true });
  await event(f.player, "time", 2.1);
  expect(f.player.view()).toMatchObject({
    rate: 2,
    sourcePosition: 2.5,
    position: 5.5,
    timeCoordinate: "original",
    listening: { skipSilence: true },
  });
  expect({
    timelineIdentity: verified.timelineIdentity,
    ranges: verified.comparisonRanges,
    duration: verified.sourceDuration,
    trimmed: verified.trimmed,
  }).toEqual(identity);
  expect(f.accounting.begin).toHaveBeenCalledOnce();
  await f.player.dispose();
});
it("rejects an old seek acknowledgement before it can trigger current silence skipping", async () => {
  const f = fixture({
    store: {
      read: async () => null,
      write: async () => {},
      quarantine: async () => {},
    },
    owner: () => ({ key: "local", fence: "guest" }),
  });
  f.sources.open.mockResolvedValue(
    source({ analyzeSilence: async () => [{ start: 2, end: 8 }] }),
  );
  await f.player.execute({ type: "LOAD", trackId: "one" });
  await event(f.player, "playing");
  await f.player.execute({ type: "SKIP_SILENCE", enabled: true });
  await f.player.execute({ type: "SEEK", seconds: 1 });
  const current = f.player.view();
  await f.player.execute({
    type: "MEDIA_EVENT",
    generation: current.generation,
    event: "seeked",
    position: 3,
    seekRevision: current.seekRevision - 1,
  });
  expect(f.player.view()).toMatchObject({
    position: 1,
    seekRevision: current.seekRevision,
    listening: { skipSilence: true },
  });
  expect(f.accounting.begin).toHaveBeenCalledOnce();
  await f.player.dispose();
});
it("restores exact output markers after a missing map becomes verified without reinterpreting them as original time", async () => {
  const values = new Map<string, unknown>(),
    f = fixture({
      store: {
        read: async (owner, track) => values.get(`${owner}/${track}`) ?? null,
        write: async (owner, track, row) => {
          values.set(`${owner}/${track}`, structuredClone(row));
        },
        quarantine: async () => {},
      },
      owner: () => ({ key: "local", fence: "guest" }),
    });
  const standalone = source({
    sourceDuration: 6,
    trimmed: true,
    timelineIdentity: "b".repeat(64),
  });
  f.sources.open.mockResolvedValue(standalone);
  await f.player.execute({ type: "LOAD", trackId: "one" });
  await f.player.execute({ type: "SEEK", seconds: 3 });
  await f.player.execute({ type: "BOOKMARK_ADD" });
  const saved = structuredClone(f.player.view().listening!.bookmarks);
  const key = [...values.keys()][0]!;
  expect(key).toMatch(/^local\/voice:[a-f0-9]{64}$/u);
  await f.player.execute({ type: "LOOP_START" });
  await f.player.execute({ type: "SEEK", seconds: 5 });
  await f.player.execute({ type: "LOOP_END" });
  await f.player.execute({ type: "SLEEP", seconds: 60 });
  f.sources.open.mockResolvedValue(
    source({
      sourceDuration: 6,
      trimmed: true,
      timelineIdentity: "b".repeat(64),
      comparisonRanges: [
        [0, 2 * 44100],
        [4 * 44100, 8 * 44100],
      ],
    }),
  );
  await f.player.execute({ type: "LOAD", trackId: "one" });
  await vi.waitFor(() =>
    expect(f.player.view().timeCoordinate).toBe("original"),
  );
  expect(f.player.view().listening).toMatchObject({
    bookmarks: [],
    loopStart: null,
    loopEnd: null,
    sleepRemainingSeconds: 60,
  });
  expect(values.get(key)).toMatchObject({ bookmarks: saved });
  f.sources.open.mockResolvedValue(
    source({
      sourceDuration: 6,
      trimmed: true,
      timelineIdentity: "b".repeat(64),
    }),
  );
  await f.player.execute({ type: "LOAD", trackId: "one" });
  await vi.waitFor(() =>
    expect(f.player.view().listening?.bookmarks).toEqual(saved),
  );
  expect(f.player.view()).toMatchObject({
    timeCoordinate: "voice-output",
    listening: { bookmarks: saved, sleepRemainingSeconds: 60 },
  });
  await f.player.execute({ type: "BOOKMARK_SEEK", id: saved[0]!.id });
  expect(f.player.view().sourcePosition).toBe(3);
  await f.player.dispose();
});

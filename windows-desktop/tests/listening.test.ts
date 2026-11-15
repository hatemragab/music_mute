import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  AdvancedListening,
  type BookmarkStore,
  type ListeningClock,
  type ListeningContext,
} from "../src/main/player/listening.js";
import {
  analyzeFloatPcm,
  validateSilenceRanges,
} from "../src/main/player/silence-analysis.js";
import { parsePlaybackCommand } from "../src/shared/playback-contracts.js";
function fixture(raw: unknown = null) {
  let wall = 100000,
    mono = 0;
  const timers = new Map<number, () => void>();
  let next = 0;
  const clock: ListeningClock = {
    wall: () => wall,
    monotonic: () => mono,
    set: (callback) => {
      timers.set(++next, callback);
      return next;
    },
    clear: (handle) => {
      timers.delete(handle as number);
    },
  };
  const values = new Map<string, unknown>();
  const store: BookmarkStore = {
    read: vi.fn(async (owner, id) => values.get(`${owner}/${id}`) ?? raw),
    write: vi.fn(async (owner, id, record) => {
      values.set(`${owner}/${id}`, structuredClone(record));
    }),
    quarantine: vi.fn(async () => {}),
  };
  const port = {
    pause: vi.fn(),
    seek: vi.fn(),
    repeatAt: vi.fn(async () => {}),
    analyze: vi.fn(async (_signal: AbortSignal) => [{ start: 2, end: 8 }]),
  };
  const listening = new AdvancedListening(port, store, clock);
  const context: ListeningContext = {
    trackId: "local:one",
    generation: randomUUID(),
    ownerKey: "local",
    ownerFence: "guest",
    duration: 20,
    position: 1,
    variant: "voice",
    playing: true,
  };
  return {
    listening,
    port,
    store,
    context,
    values,
    advance: (seconds: number) => {
      wall += seconds * 1000;
      mono += seconds * 1000;
    },
    wall: (value: number) => {
      wall = value;
    },
    fire: () => {
      const scheduled = Array.from(timers.values());
      timers.clear();
      for (const callback of scheduled) {
        callback();
      }
    },
  };
}
it("expires across OS sleep and never extends a timer after a wall clock reversal", async () => {
  const f = fixture();
  await f.listening.bind(f.context);
  await f.listening.execute({ type: "SLEEP", seconds: 60 });
  f.advance(20);
  f.fire();
  expect(f.listening.view().sleepRemainingSeconds).toBe(40);
  f.wall(50000);
  f.fire();
  expect(f.listening.view().sleepRemainingSeconds).toBe(40);
  f.advance(41);
  f.listening.resume();
  expect(f.port.pause).toHaveBeenCalledOnce();
  expect(f.listening.view().sleepRemainingSeconds).toBeNull();
  f.listening.resume();
  expect(f.port.pause).toHaveBeenCalledOnce();
  await f.listening.dispose();
});
it("uses wall-clock forward jumps to expire and supports explicit cancellation", async () => {
  const f = fixture();
  await f.listening.execute({ type: "SLEEP", seconds: 30 });
  await f.listening.execute({ type: "SLEEP", seconds: 0 });
  f.advance(60);
  f.fire();
  expect(f.port.pause).not.toHaveBeenCalled();
  await f.listening.execute({ type: "SLEEP", seconds: 30 });
  f.wall(1000000);
  f.fire();
  expect(f.port.pause).toHaveBeenCalledOnce();
});
it("gives sleep expiry priority over AB and silence skips", async () => {
  const f = fixture();
  await f.listening.bind(f.context);
  await f.listening.execute({ type: "LOOP_START" });
  await f.listening.bind({ ...f.context, position: 5 });
  await f.listening.execute({ type: "LOOP_END" });
  await f.listening.execute({ type: "SKIP_SILENCE", enabled: true });
  await f.listening.execute({ type: "SLEEP", seconds: 1 });
  f.advance(2);
  await f.listening.position(6, true);
  expect(f.port.pause).toHaveBeenCalledOnce();
  expect(f.port.repeatAt).not.toHaveBeenCalled();
  expect(f.port.seek).not.toHaveBeenCalled();
});
it("rejects short loops and serializes repeated boundary events while a seek is pending", async () => {
  const f = fixture();
  await f.listening.bind(f.context);
  await f.listening.execute({ type: "LOOP_START" });
  await f.listening.bind({ ...f.context, position: 1.05 });
  await f.listening.execute({ type: "LOOP_END" });
  expect(f.listening.view().loopEnd).toBeNull();
  await f.listening.bind({ ...f.context, position: 5 });
  await f.listening.execute({ type: "LOOP_END" });
  let done!: () => void;
  f.port.repeatAt.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        done = resolve;
      }),
  );
  const first = f.listening.position(5, true);
  await f.listening.position(6, true);
  expect(f.port.repeatAt).toHaveBeenCalledOnce();
  done();
  await first;
  await f.listening.execute({ type: "LOOP_CLEAR" });
  expect(f.listening.view()).toMatchObject({ loopStart: null, loopEnd: null });
});
it("persists, renames and removes bounded logical bookmarks across voice/original switches", async () => {
  const f = fixture();
  await f.listening.bind(f.context);
  await f.listening.execute({ type: "BOOKMARK_ADD" });
  await f.listening.bind({
    ...f.context,
    generation: randomUUID(),
    variant: "original",
    position: 1.2,
  });
  await f.listening.execute({ type: "BOOKMARK_ADD" });
  expect(f.listening.view().bookmarks).toHaveLength(1);
  const id = f.listening.view().bookmarks[0]!.id;
  await f.listening.execute({ type: "BOOKMARK_RENAME", id, title: "Verse" });
  await f.listening.execute({ type: "BOOKMARK_SEEK", id });
  expect(f.port.seek).toHaveBeenCalledWith(1);
  expect(f.listening.view().bookmarks[0]!.title).toBe("Verse");
  await f.listening.execute({ type: "BOOKMARK_REMOVE", id });
  expect(f.listening.view().bookmarks).toEqual([]);
});
it("serializes bookmark writes without losing a concurrent rename/add", async () => {
  const f = fixture();
  await f.listening.bind(f.context);
  await f.listening.execute({ type: "BOOKMARK_ADD" });
  const id = f.listening.view().bookmarks[0]!.id;
  await f.listening.bind({ ...f.context, position: 4 });
  await Promise.all([
    f.listening.execute({ type: "BOOKMARK_RENAME", id, title: "Intro" }),
    f.listening.execute({ type: "BOOKMARK_ADD" }),
  ]);
  expect(f.listening.view().bookmarks.map((value) => value.title)).toEqual([
    "Intro",
    "Bookmark 2",
  ]);
});
it.each(["BOOKMARK_ADD", "LOOP_START", "SKIP_SILENCE"] as const)(
  "fences a %s command captured before a delayed preference read across track/owner changes",
  async (type) => {
    const f = fixture();
    let read!: (value: unknown) => void;
    f.store.read = vi.fn(
      async () =>
        new Promise<unknown>((resolve) => {
          read = resolve;
        }),
    );
    const binding = f.listening.bind(f.context),
      command = f.listening.execute(
        type === "SKIP_SILENCE" ? { type, enabled: true } : { type },
      );
    f.store.read = vi.fn(async () => null);
    await f.listening.bind({
      ...f.context,
      trackId: "local:next",
      generation: randomUUID(),
      ownerKey: "other",
      ownerFence: "next",
    });
    read(null);
    await binding;
    await command;
    expect(f.store.write).not.toHaveBeenCalled();
    expect(f.port.analyze).not.toHaveBeenCalled();
    expect(f.listening.view()).toMatchObject({
      bookmarks: [],
      loopStart: null,
      skipSilence: false,
    });
    await f.listening.dispose();
  },
);
it("captures a bookmark's accepted logical position before preference IO rather than the later media position", async () => {
  const f = fixture();
  let read!: (value: unknown) => void;
  f.store.read = vi.fn(
    async () =>
      new Promise<unknown>((resolve) => {
        read = resolve;
      }),
  );
  const binding = f.listening.bind(f.context),
    command = f.listening.execute({ type: "BOOKMARK_ADD" });
  await f.listening.position(8, true);
  read(null);
  await binding;
  await command;
  expect(f.listening.view().bookmarks[0]?.seconds).toBe(1);
  await f.listening.dispose();
});
it("retires old analysis at requested media generation change before the replacement source is ready", async () => {
  const f = fixture();
  await f.listening.bind(f.context);
  let reject!: (error: Error) => void, signal: AbortSignal | undefined;
  f.port.analyze = vi.fn(async (signalValue: AbortSignal) => {
    signal = signalValue;
    return new Promise<{ start: number; end: number }[]>((_yes, no) => {
      reject = no;
    });
  });
  const analyzing = f.listening.execute({
    type: "SKIP_SILENCE",
    enabled: true,
  });
  await vi.waitFor(() => expect(reject).toBeDefined());
  f.listening.selectTrack(f.context.trackId, randomUUID());
  expect(signal?.aborted).toBe(true);
  reject(new Error("old helper stopped"));
  await analyzing;
  expect(f.listening.view()).toMatchObject({
    error: null,
    skipSilence: false,
    analyzingSilence: false,
  });
  await f.listening.dispose();
});
it("fences delayed bookmark reads and analysis after an account generation changes", async () => {
  const f = fixture();
  let read!: (value: unknown) => void;
  f.store.read = vi.fn(
    () =>
      new Promise((resolve) => {
        read = resolve;
      }),
  );
  const old = f.listening.bind(f.context);
  await vi.waitFor(() => expect(read).toBeDefined());
  f.store.read = vi.fn(async () => null);
  await f.listening.bind({
    ...f.context,
    ownerKey: "other",
    ownerFence: "new",
  });
  read({
    version: 1,
    owner: "local",
    trackId: "local:one",
    bookmarks: [{ id: randomUUID(), seconds: 3, title: "Secret" }],
  });
  await old;
  expect(f.listening.view().bookmarks).toEqual([]);
  let analyze!: (value: { start: number; end: number }[]) => void;
  f.port.analyze.mockImplementation(
    () =>
      new Promise((resolve) => {
        analyze = resolve;
      }),
  );
  const pending = f.listening.execute({ type: "SKIP_SILENCE", enabled: true });
  await vi.waitFor(() => expect(analyze).toBeDefined());
  await f.listening.bind({
    ...f.context,
    ownerKey: "third",
    ownerFence: "next",
  });
  analyze([{ start: 2, end: 8 }]);
  await pending;
  expect(f.listening.view().skipSilence).toBe(false);
});
it("retains a damaged preference before an explicit bookmark edit repairs it", async () => {
  const f = fixture({ version: 99 });
  await f.listening.bind(f.context);
  expect(f.listening.view().error).toBe("PREFERENCES_UNAVAILABLE");
  expect(f.store.write).not.toHaveBeenCalled();
  await f.listening.execute({ type: "BOOKMARK_ADD" });
  expect(f.store.quarantine).toHaveBeenCalledOnce();
  expect(f.listening.view().error).toBeNull();
});
it("skips voice silence in logical time and clips to AB end; original playback remains unchanged", async () => {
  const f = fixture();
  await f.listening.bind(f.context);
  await f.listening.execute({ type: "LOOP_START" });
  await f.listening.bind({ ...f.context, position: 6 });
  await f.listening.execute({ type: "LOOP_END" });
  await f.listening.execute({ type: "SKIP_SILENCE", enabled: true });
  await f.listening.position(3, true);
  expect(f.port.seek).toHaveBeenCalledWith(6);
  await f.listening.bind({
    ...f.context,
    generation: randomUUID(),
    variant: "original",
  });
  await f.listening.execute({ type: "SKIP_SILENCE", enabled: true });
  expect(f.listening.view().skipSilence).toBe(false);
  expect(f.listening.view().error).toBe("SILENCE_UNAVAILABLE");
});
async function* pcm(samples: number[], split = 13): AsyncIterable<Uint8Array> {
  const bytes = Buffer.alloc(samples.length * 4);
  samples.forEach((sample, i) => bytes.writeFloatLE(sample, i * 4));
  for (let offset = 0; offset < bytes.length; offset += split)
    yield bytes.subarray(offset, offset + split);
}
it("streams chunk-split PCM with the macOS 1024-frame RMS and 60ms edge padding", async () => {
  const samples = [
    ...Array<number>(8192).fill(0),
    ...Array<number>(8192).fill(0.1),
  ];
  const result = await analyzeFloatPcm(
    pcm(samples),
    { sampleRate: 8192, channels: 1 },
    new AbortController().signal,
  );
  expect(result).toEqual({ duration: 2, ranges: [{ start: 0.06, end: 0.94 }] });
});
it("handles all-silent and all-audible media without unbounded allocation", async () => {
  expect(
    (
      await analyzeFloatPcm(
        pcm(Array<number>(8000).fill(0), 1024),
        { sampleRate: 8000, channels: 1 },
        new AbortController().signal,
      )
    ).ranges,
  ).toEqual([{ start: 0.06, end: 0.94 }]);
  expect(
    (
      await analyzeFloatPcm(
        pcm(Array<number>(8000).fill(0.01), 1024),
        { sampleRate: 8000, channels: 1 },
        new AbortController().signal,
      )
    ).ranges,
  ).toEqual([]);
});
it("rejects malformed, oversized-duration, nonfinite and cancelled PCM", async () => {
  const signal = new AbortController().signal;
  await expect(
    analyzeFloatPcm(pcm([NaN]), { sampleRate: 8000, channels: 1 }, signal),
  ).rejects.toThrow("SILENCE_UNAVAILABLE");
  await expect(
    analyzeFloatPcm(pcm([0.1]), { sampleRate: 8000, channels: 2 }, signal),
  ).rejects.toThrow("SILENCE_UNAVAILABLE");
  await expect(
    analyzeFloatPcm(
      pcm(Array<number>(9000).fill(0), 1024),
      { sampleRate: 8000, channels: 1, maxSeconds: 1 },
      signal,
    ),
  ).rejects.toThrow("SILENCE_UNAVAILABLE");
  const abort = new AbortController();
  abort.abort();
  await expect(
    analyzeFloatPcm(pcm([0]), { sampleRate: 8000, channels: 1 }, abort.signal),
  ).rejects.toThrow();
});
it("validates wire commands and silence boundaries strictly", () => {
  expect(parsePlaybackCommand({ type: "SLEEP", seconds: 1800 })).toEqual({
    type: "SLEEP",
    seconds: 1800,
  });
  expect(() => parsePlaybackCommand({ type: "SLEEP", seconds: -1 })).toThrow();
  expect(() =>
    parsePlaybackCommand({
      type: "BOOKMARK_RENAME",
      id: randomUUID(),
      title: "\n",
    }),
  ).toThrow();
  expect(() => validateSilenceRanges([{ start: 3, end: 2 }], 10)).toThrow();
  expect(() =>
    validateSilenceRanges(
      [
        { start: 0, end: 2 },
        { start: 1, end: 3 },
      ],
      10,
    ),
  ).toThrow();
});
it("saves the silence preference and prevents a pending enable from overruling a later disable", async () => {
  const f = fixture();
  await f.listening.bind(f.context);
  let write!: () => void;
  const firstWrite = f.store.write;
  f.store.write = vi.fn(
    (owner, id, record) =>
      new Promise<void>((resolve) => {
        write = async () => {
          await firstWrite(owner, id, record);
          resolve();
        };
      }),
  );
  const enabled = f.listening.execute({ type: "SKIP_SILENCE", enabled: true });
  await vi.waitFor(() => expect(write).toBeDefined());
  f.store.write = firstWrite;
  const disabled = f.listening.execute({
    type: "SKIP_SILENCE",
    enabled: false,
  });
  write();
  await Promise.all([enabled, disabled]);
  expect(f.port.analyze).not.toHaveBeenCalled();
  expect(f.values.get("local/local:one")).toMatchObject({
    skipSilencePreferred: false,
  });
  await f.listening.execute({ type: "SKIP_SILENCE", enabled: true });
  expect(f.values.get("local/local:one")).toMatchObject({
    skipSilencePreferred: true,
  });
});
it("cancels sleep on a different-track start and preserves it for the same track/source switch", async () => {
  const f = fixture();
  await f.listening.bind(f.context);
  await f.listening.execute({ type: "SLEEP", seconds: 60 });
  await f.listening.bind({
    ...f.context,
    generation: randomUUID(),
    variant: "original",
  });
  expect(f.listening.view().sleepRemainingSeconds).toBe(60);
  await f.listening.bind({
    ...f.context,
    trackId: "local:other",
    generation: randomUUID(),
  });
  expect(f.listening.view().sleepRemainingSeconds).toBeNull();
  f.advance(100);
  f.fire();
  expect(f.port.pause).not.toHaveBeenCalled();
  await f.listening.dispose();
});
it("keeps output-artifact bookmarks distinct from original coordinates while retaining a same-song sleep timer", async () => {
  const f = fixture();
  await f.listening.bind({
    ...f.context,
    bookmarkTrackId: "voice:artifact-one",
  });
  await f.listening.execute({ type: "BOOKMARK_ADD" });
  expect(f.store.write).toHaveBeenCalledWith(
    "local",
    "voice:artifact-one",
    expect.objectContaining({ trackId: "voice:artifact-one" }),
  );
  await f.listening.execute({ type: "SLEEP", seconds: 60 });
  await f.listening.bind({
    ...f.context,
    generation: randomUUID(),
    bookmarkTrackId: "voice:artifact-two",
  });
  expect(f.listening.view().bookmarks).toEqual([]);
  expect(f.listening.view().sleepRemainingSeconds).toBe(60);
  await f.listening.bind({ ...f.context, generation: randomUUID() });
  expect(f.listening.view().bookmarks).toEqual([]);
  await f.listening.dispose();
});
it("clears a failed silence analysis only after a successful explicit preference disable", async () => {
  const f = fixture();
  await f.listening.bind(f.context);
  f.port.analyze.mockRejectedValueOnce(new Error("OFFLINE_ANALYSIS_FAILED"));
  await f.listening.execute({ type: "SKIP_SILENCE", enabled: true });
  expect(f.listening.view().error).toBe("SILENCE_UNAVAILABLE");
  const write = f.store.write;
  f.store.write = vi.fn(async () => {
    throw new Error("VAULT_WRITE_FAILED");
  });
  await f.listening.execute({ type: "SKIP_SILENCE", enabled: false });
  expect(f.listening.view().error).toBe("PREFERENCES_UNAVAILABLE");
  f.store.write = write;
  await f.listening.execute({ type: "SKIP_SILENCE", enabled: false });
  expect(f.listening.view()).toMatchObject({
    error: null,
    skipSilence: false,
    analyzingSilence: false,
  });
  expect(f.values.get("local/local:one")).toMatchObject({
    skipSilencePreferred: false,
  });
  await f.listening.dispose();
});
it("keeps all 100 bookmarks, enforces half-second duplicates and preserves 80-unit Arabic rename/navigation", async () => {
  const bookmarks = Array.from({ length: 99 }, (_, seconds) => ({
    id: randomUUID(),
    seconds,
    title: "ص".repeat(80),
  }));
  const f = fixture({
    version: 1,
    owner: "local",
    trackId: "local:one",
    bookmarks,
  });
  await f.listening.bind({ ...f.context, duration: 120, position: 98.49 });
  await f.listening.execute({ type: "BOOKMARK_ADD" });
  expect(f.listening.view().bookmarks).toHaveLength(99);
  expect(f.store.write).not.toHaveBeenCalled();
  await f.listening.bind({ ...f.context, duration: 120, position: 98.5 });
  await f.listening.execute({ type: "BOOKMARK_ADD" });
  expect(f.listening.view().bookmarks).toHaveLength(100);
  await f.listening.bind({ ...f.context, duration: 120, position: 110 });
  await f.listening.execute({ type: "BOOKMARK_ADD" });
  expect(f.listening.view().bookmarks).toHaveLength(100);
  expect(f.store.write).toHaveBeenCalledOnce();
  const id = f.listening.view().bookmarks[99]!.id;
  await f.listening.execute({
    type: "BOOKMARK_RENAME",
    id,
    title: "ق".repeat(80),
  });
  await f.listening.execute({ type: "BOOKMARK_SEEK", id });
  expect(f.port.seek).toHaveBeenCalledWith(98.5);
  expect(f.listening.view().bookmarks[99]!.title).toBe("ق".repeat(80));
  await f.listening.dispose();
});
it("bounds PCM formats, per-chunk allocation, partial bytes and decoded range count", async () => {
  const signal = new AbortController().signal;
  for (const format of [
    { sampleRate: 7999, channels: 1 },
    { sampleRate: 192001, channels: 1 },
    { sampleRate: 8000, channels: 0 },
    { sampleRate: 8000, channels: 3 },
    { sampleRate: 8000, channels: 1, maxSeconds: 7201 },
  ])
    await expect(analyzeFloatPcm(pcm([0]), format, signal)).rejects.toThrow(
      "SILENCE_UNAVAILABLE",
    );
  async function* bytes(value: Buffer) {
    yield value;
  }
  for (const data of [
    Buffer.alloc(0),
    Buffer.alloc(3),
    Buffer.alloc(1024 ** 2 + 1),
  ])
    await expect(
      analyzeFloatPcm(bytes(data), { sampleRate: 8000, channels: 1 }, signal),
    ).rejects.toThrow("SILENCE_UNAVAILABLE");
  expect(() =>
    validateSilenceRanges(
      Array.from({ length: 10001 }, (_, i) => ({
        start: i / 100,
        end: (i + 0.5) / 100,
      })),
      200,
    ),
  ).toThrow("SILENCE_UNAVAILABLE");
});
it("honors the quiet-run boundary and includes both stereo channels in RMS", async () => {
  const signal = new AbortController().signal;
  expect(
    (
      await analyzeFloatPcm(
        pcm(Array<number>(3 * 1024).fill(0)),
        { sampleRate: 10240, channels: 1 },
        signal,
      )
    ).ranges,
  ).toEqual([]);
  expect(
    (
      await analyzeFloatPcm(
        pcm(Array<number>(4 * 1024).fill(0)),
        { sampleRate: 10240, channels: 1 },
        signal,
      )
    ).ranges,
  ).toEqual([{ start: 0.06, end: 0.34 }]);
  const stereo = Array.from({ length: 16000 }, (_, i) =>
    i % 2 === 0 ? 0 : 0.1,
  );
  expect(
    (
      await analyzeFloatPcm(
        pcm(stereo),
        { sampleRate: 8000, channels: 2 },
        signal,
      )
    ).ranges,
  ).toEqual([]);
  for (const sampleRate of [8000, 192000])
    expect(
      (await analyzeFloatPcm(pcm([0, 0]), { sampleRate, channels: 2 }, signal))
        .duration,
    ).toBe(1 / sampleRate);
});
it("retires sleep ownership at dispose even if a retained resume or media callback arrives", async () => {
  const f = fixture();
  await f.listening.bind(f.context);
  await f.listening.execute({ type: "SLEEP", seconds: 30 });
  await f.listening.dispose();
  f.advance(60);
  f.fire();
  f.listening.resume();
  await f.listening.position(20, true);
  expect(f.port.pause).not.toHaveBeenCalled();
  expect(f.port.repeatAt).not.toHaveBeenCalled();
  expect(f.port.seek).not.toHaveBeenCalled();
});
it("rejects inverted/end-of-media AB markers and permits a fresh loop after manual seek", async () => {
  const f = fixture();
  await f.listening.bind({ ...f.context, position: 19.95 });
  await f.listening.execute({ type: "LOOP_START" });
  await f.listening.bind({ ...f.context, position: 20 });
  await f.listening.execute({ type: "LOOP_END" });
  expect(f.listening.view().loopEnd).toBeNull();
  await f.listening.bind({ ...f.context, position: 10 });
  await f.listening.execute({ type: "LOOP_END" });
  expect(f.listening.view().loopEnd).toBeNull();
  await f.listening.bind({ ...f.context, position: 2 });
  await f.listening.execute({ type: "LOOP_START" });
  await f.listening.bind({ ...f.context, position: 5 });
  await f.listening.execute({ type: "LOOP_END" });
  await f.listening.position(5, true);
  await f.listening.position(5, true);
  expect(f.port.repeatAt).toHaveBeenCalledOnce();
  f.listening.manualSeek();
  await f.listening.position(3, true);
  await f.listening.position(5, true);
  expect(f.port.repeatAt).toHaveBeenCalledTimes(2);
  await f.listening.dispose();
});

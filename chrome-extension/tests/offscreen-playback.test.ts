import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionMessage } from "../src/extension/messages";
import type { MediaClock } from "../src/shared/protocol";

const extensionId = "musicmute-test-extension";
const sender: chrome.runtime.MessageSender = {
  id: extensionId,
  url: `chrome-extension://${extensionId}/background.js`,
};
type MessageHandler = (
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
  respond: (response: unknown) => void,
) => unknown;
type Listener = EventListenerOrEventListenerObject;
let handler: MessageHandler | undefined;
let elements: MockAudio[];
let attached: MockAudio[];
const runtimeSend = vi.fn<(message: ExtensionMessage) => Promise<unknown>>();

class MockAudio extends EventTarget {
  src = "";
  crossOrigin = "";
  preload = "";
  duration = 20;
  private time = 0;
  seekWrites: number[] = [];
  get currentTime(): number {
    return this.time;
  }
  set currentTime(value: number) {
    this.time = value;
    this.seekWrites.push(value);
  }
  playbackRate = 1;
  preservesPitch = false;
  seeking = false;
  volume = 1;
  paused = true;
  readyState = 4;
  error: { code: number } | null = null;
  listeners = new Map<string, Set<Listener>>();
  pause = vi.fn(() => {
    this.paused = true;
  });
  play = vi.fn(async () => {
    this.paused = false;
  });
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = "";
  });
  remove = vi.fn(() => {
    attached = attached.filter((element) => element !== this);
  });
  constructor() {
    super();
    elements.push(this);
  }
  override addEventListener(
    type: string,
    listener: Listener | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    if (listener) {
      const listeners = this.listeners.get(type) ?? new Set<Listener>();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    super.addEventListener(type, listener, options);
  }
  override removeEventListener(
    type: string,
    listener: Listener | null,
    options?: EventListenerOptions | boolean,
  ): void {
    if (listener) this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  emit(type: string): void {
    this.dispatchEvent(new Event(type));
  }
  listenerCount(): number {
    return [...this.listeners.values()].reduce(
      (total, listeners) => total + listeners.size,
      0,
    );
  }
}

function pending() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function request(message: ExtensionMessage) {
  const response = vi.fn<(response: unknown) => void>();
  if (!handler) throw new Error("Offscreen listener not installed");
  const result = handler(message, sender, response);
  return { result, response };
}
function load(generation = 1) {
  return request({
    type: "MM_AUDIO_LOAD",
    generation,
    video_id: "abcdefghijk",
    media: {
      url: `http://127.0.0.1:12345/audio/${generation}`,
      duration_seconds: 20,
      trim_enabled: false,
      model_id: "test-model",
    },
  });
}
function clock(generation = 1, values: Partial<MediaClock> = {}): void {
  expect(
    request({
      type: "MM_AUDIO_CLOCK",
      payload: {
        video_id: "abcdefghijk",
        generation,
        sequence: 1,
        current_time: 0,
        duration_seconds: 20,
        playback_rate: 1,
        paused: false,
        seeking: false,
        ended: false,
        buffering: false,
        ad_active: false,
        volume: 1,
        user_muted: false,
        sampled_at_ms: Date.now(),
        ...values,
      },
    }).response,
  ).toHaveBeenCalledWith({ ok: true });
}
async function flush(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}
async function ready(generation = 1): Promise<MockAudio> {
  const request = load(generation);
  const element = elements.at(-1)!;
  element.emit("canplay");
  await flush();
  expect(request.response).toHaveBeenCalledOnce();
  expect(request.response).toHaveBeenCalledWith({ ok: true });
  return element;
}
function notifications(type: ExtensionMessage["type"]) {
  return runtimeSend.mock.calls
    .map(([message]) => message)
    .filter((message) => message.type === type);
}
function invoke(listener: Listener, element: MockAudio, type: string): void {
  const event = new Event(type);
  if (typeof listener === "function") listener.call(element, event);
  else listener.handleEvent(event);
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  handler = undefined;
  elements = [];
  attached = [];
  runtimeSend.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("Audio", MockAudio);
  vi.stubGlobal("document", {
    body: { append: (element: MockAudio) => attached.push(element) },
  });
  vi.stubGlobal("chrome", {
    runtime: {
      id: extensionId,
      sendMessage: runtimeSend,
      onMessage: {
        addListener: (callback: MessageHandler) => {
          handler = callback;
        },
      },
    },
  });
  await import("../src/extension/offscreen");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("offscreen loading and playback through the actual message handler", () => {
  it("silences a missing clock, then realigns and resumes only on a fresh owned sample", async () => {
    const audio = await ready();
    clock(1, { current_time: 2 });
    await flush();
    expect(audio.paused).toBe(false);
    await vi.advanceTimersByTimeAsync(6000);
    expect(audio.paused).toBe(true);
    clock(1, {
      sequence: 2,
      current_time: 8,
      sampled_at_ms: Date.now() - 6000,
    });
    await flush();
    expect(audio.paused).toBe(true);
    clock(1, { sequence: 3, current_time: 8 });
    await flush();
    expect(audio.currentTime).toBe(8);
    expect(audio.paused).toBe(false);
    expect(notifications("MM_AUDIO_STATE")).toEqual([
      { type: "MM_AUDIO_STATE", generation: 1, playing: true },
      { type: "MM_AUDIO_STATE", generation: 1, playing: false },
      { type: "MM_AUDIO_STATE", generation: 1, playing: true },
    ]);
  });
  it("settles a stopped load immediately and removes its timer, listeners and element", async () => {
    const first = load();
    const element = elements[0]!;
    expect(first.result).toBe(true);
    expect(element.crossOrigin).toBe("anonymous");
    expect(element.preload).toBe("auto");
    expect(element.preservesPitch).toBe(true);
    expect(element.listenerCount()).toBe(7);
    expect(vi.getTimerCount()).toBe(2);
    expect(request({ type: "MM_AUDIO_STOP" }).response).toHaveBeenCalledWith({
      ok: true,
    });
    await flush();
    expect(first.response).toHaveBeenCalledOnce();
    expect(first.response).toHaveBeenCalledWith({ ok: false });
    expect(element.listenerCount()).toBe(0);
    expect(element.src).toBe("");
    expect(attached).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
    element.emit("canplay");
    element.emit("error");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(notifications("MM_AUDIO_READY")).toHaveLength(0);
    expect(notifications("MM_AUDIO_ERROR")).toHaveLength(0);
    expect(first.response).toHaveBeenCalledOnce();
  });

  it("supersedes a pending load without letting retired events settle or fail the new load", async () => {
    const first = load();
    const retired = elements[0]!;
    const oldReady = [...retired.listeners.get("canplay")!];
    const oldError = [...retired.listeners.get("error")!];
    const second = load(2);
    const current = elements[1]!;
    await flush();
    expect(first.response).toHaveBeenCalledWith({ ok: false });
    expect(retired.listenerCount()).toBe(0);
    expect(attached).toEqual([current]);
    for (const listener of oldReady) invoke(listener, retired, "canplay");
    retired.error = { code: 2 };
    for (const listener of oldError) invoke(listener, retired, "error");
    retired.emit("canplay");
    retired.emit("error");
    await flush();
    expect(second.response).not.toHaveBeenCalled();
    expect(notifications("MM_AUDIO_ERROR")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(2);
    current.emit("canplay");
    await flush();
    expect(second.response).toHaveBeenCalledWith({ ok: true });
    expect(notifications("MM_AUDIO_READY")).toEqual([
      { type: "MM_AUDIO_READY", generation: 2 },
    ]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("fences ready continuation after canplay when Stop happens before its microtask", async () => {
    const first = load();
    elements[0]!.emit("canplay");
    request({ type: "MM_AUDIO_STOP" });
    await flush();
    expect(first.response).toHaveBeenCalledWith({ ok: false });
    expect(notifications("MM_AUDIO_READY")).toHaveLength(0);
    expect(notifications("MM_AUDIO_ERROR")).toHaveLength(0);
  });

  it("does not report a retired load rejection against its replacement", async () => {
    const first = load();
    const retired = elements[0]!;
    retired.error = { code: 3 };
    retired.emit("error");
    const second = load(2);
    await flush();
    expect(first.response).toHaveBeenCalledWith({ ok: false });
    expect(notifications("MM_AUDIO_ERROR")).toHaveLength(0);
    expect(second.response).not.toHaveBeenCalled();
    elements[1]!.emit("canplay");
    await flush();
    expect(second.response).toHaveBeenCalledWith({ ok: true });
  });

  it.each([
    [2, "AUDIO_NETWORK_FAILED"],
    [3, "AUDIO_DECODE_FAILED"],
    [4, "AUDIO_SOURCE_REJECTED"],
    [1, "AUDIO_LOAD_FAILED"],
  ])(
    "reports current load error %i only for its generation",
    async (code, expected) => {
      const current = load(7);
      const element = elements[0]!;
      element.error = { code };
      element.emit("error");
      await flush();
      expect(current.response).toHaveBeenCalledOnce();
      expect(current.response).toHaveBeenCalledWith({ ok: false });
      expect(notifications("MM_AUDIO_ERROR")).toEqual([
        { type: "MM_AUDIO_ERROR", generation: 7, code: expected },
      ]);
      expect(element.listenerCount()).toBe(0);
      expect(attached).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(1);
    },
  );

  it("bounds a current load timeout and lets a successor become ready", async () => {
    const current = load(7);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(current.response).toHaveBeenCalledWith({ ok: false });
    expect(notifications("MM_AUDIO_ERROR")).toEqual([
      { type: "MM_AUDIO_ERROR", generation: 7, code: "AUDIO_LOAD_TIMEOUT" },
    ]);
    expect(elements[0]!.listenerCount()).toBe(0);
    await ready(8);
    expect(notifications("MM_AUDIO_READY")).toEqual([
      { type: "MM_AUDIO_READY", generation: 8 },
    ]);
  });

  it("keeps duration validation and current generation errors", async () => {
    const current = load(7);
    elements[0]!.duration = 21;
    elements[0]!.emit("canplay");
    await flush();
    expect(current.response).toHaveBeenCalledWith({ ok: false });
    expect(notifications("MM_AUDIO_READY")).toHaveLength(0);
    expect(notifications("MM_AUDIO_ERROR")).toEqual([
      {
        type: "MM_AUDIO_ERROR",
        generation: 7,
        code: "AUDIO_DURATION_MISMATCH",
      },
    ]);
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a retired play promise that later %ss and leaves the successor pending play alone",
    async (completion) => {
      const retired = await ready();
      const oldPlay = pending();
      retired.play.mockReturnValueOnce(oldPlay.promise);
      clock();
      const oldEvents = new Map(
        [...retired.listeners].map(([type, listeners]) => [
          type,
          [...listeners],
        ]),
      );
      const current = await ready(2);
      const currentPlay = pending();
      current.play.mockReturnValueOnce(currentPlay.promise);
      clock(2);
      if (completion === "resolve") {
        retired.paused = false;
        oldPlay.resolve();
      } else oldPlay.reject(new Error("old playback failure"));
      for (const [type, listeners] of oldEvents)
        for (const listener of listeners) invoke(listener, retired, type);
      await flush();
      expect(notifications("MM_AUDIO_ERROR")).toHaveLength(0);
      expect(notifications("MM_AUDIO_STATE")).toHaveLength(0);
      expect(retired.paused).toBe(true);
      clock(2, { sequence: 2 });
      expect(current.play).toHaveBeenCalledOnce();
      current.paused = false;
      currentPlay.resolve();
      await flush();
      expect(notifications("MM_AUDIO_STATE")).toEqual([
        { type: "MM_AUDIO_STATE", generation: 2, playing: true },
      ]);
    },
  );

  it("realigns a browser-delayed audio start to the next fresh source clock", async () => {
    const element = await ready();
    const play = pending();
    element.play.mockReturnValueOnce(play.promise);
    clock(1, { current_time: 0 });
    await vi.advanceTimersByTimeAsync(600);
    element.paused = false;
    play.resolve();
    await flush();
    element.seekWrites = [];
    clock(1, { sequence: 2, current_time: 0.6, sampled_at_ms: Date.now() });
    await flush();
    expect(element.seekWrites).toEqual([0.6]);
    expect(element.play).toHaveBeenCalledOnce();
  });

  it("does not report late playing when a fresh paused/ad clock supersedes the request", async () => {
    const element = await ready();
    const play = pending();
    element.play.mockReturnValueOnce(play.promise);
    clock();
    clock(1, { sequence: 2, ad_active: true });
    element.paused = false;
    play.resolve();
    await flush();
    expect(element.paused).toBe(true);
    expect(notifications("MM_AUDIO_STATE")).toHaveLength(0);
    expect(notifications("MM_AUDIO_ERROR")).toHaveLength(0);
    clock(1, { sequence: 3 });
    await flush();
    expect(notifications("MM_AUDIO_STATE")).toEqual([
      { type: "MM_AUDIO_STATE", generation: 1, playing: true },
    ]);
  });

  it("reports a current blocked play only for the owning generation", async () => {
    const element = await ready(7);
    element.play.mockRejectedValueOnce(new Error("autoplay rejected"));
    clock(7);
    await flush();
    expect(notifications("MM_AUDIO_ERROR")).toEqual([
      {
        type: "MM_AUDIO_ERROR",
        generation: 7,
        code: "AUDIO_PLAYBACK_BLOCKED",
      },
    ]);
    expect(notifications("MM_AUDIO_STATE")).toHaveLength(0);
  });

  it("corrects small running drift through speed without jumping the audio position", async () => {
    const element = await ready();
    clock();
    await flush();
    await vi.advanceTimersByTimeAsync(250);
    element.currentTime = 0.25;
    element.seekWrites = [];
    clock(1, { sequence: 2, current_time: 0.42 });
    await flush();
    expect(element.seekWrites).toEqual([]);
    expect(element.playbackRate).toBeGreaterThan(1);
    expect(element.playbackRate).toBeLessThanOrEqual(1.03);
    expect(element.paused).toBe(false);
    expect(element.play).toHaveBeenCalledOnce();
  });

  it.each([0.2, -0.2])(
    "converges a %s second offset across repeated clocks without seeks or pauses",
    async (offset) => {
      const element = await ready();
      element.currentTime = 2;
      clock(1, { current_time: 2 });
      await flush();
      element.currentTime -= offset;
      const hardSeeks: number[] = [];
      for (let index = 1; index <= 48; index++) {
        await vi.advanceTimersByTimeAsync(250);
        // Model continuous audio movement at the controller's selected rate.
        element.currentTime += 0.25 * element.playbackRate;
        element.seekWrites = [];
        clock(1, { sequence: index + 1, current_time: 2 + index * 0.25 });
        await flush();
        hardSeeks.push(...element.seekWrites);
        expect(element.paused).toBe(false);
      }
      expect(hardSeeks).toEqual([]);
      expect(Math.abs(14 - element.currentTime)).toBeLessThan(0.06);
      expect(element.play).toHaveBeenCalledOnce();
      expect(notifications("MM_AUDIO_ERROR")).toHaveLength(0);
    },
  );

  it("leaves an in-flight audio seek alone and aligns once it finishes", async () => {
    const element = await ready();
    element.seeking = true;
    clock(1, { current_time: 4 });
    await flush();
    expect(element.seekWrites).toEqual([]);
    element.seeking = false;
    clock(1, { sequence: 2, current_time: 4 });
    await flush();
    expect(element.seekWrites).toEqual([4]);
  });

  it("tolerates a short clock gap and delayed sample, then pauses bounded clock loss", async () => {
    const element = await ready();
    clock();
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(element.paused).toBe(false);
    element.currentTime = 2;
    element.seekWrites = [];
    clock(1, { sequence: 2, current_time: 0, sampled_at_ms: 10_000 });
    await flush();
    expect(element.paused).toBe(false);
    expect(element.seekWrites).toEqual([]);
    await vi.advanceTimersByTimeAsync(3250);
    expect(element.paused).toBe(true);
    expect(notifications("MM_AUDIO_STATE")).toEqual([
      { type: "MM_AUDIO_STATE", generation: 1, playing: true },
      { type: "MM_AUDIO_STATE", generation: 1, playing: false },
    ]);
    clock(1, { sequence: 3, current_time: 5.25 });
    await flush();
    expect(element.paused).toBe(false);
    expect(element.play).toHaveBeenCalledTimes(2);
  });

  it.each(["resolve", "reject"] as const)(
    "ignores an interrupted play that later %ss after pause and resume",
    async (completion) => {
      const element = await ready();
      const interrupted = pending();
      const resumed = pending();
      element.play.mockReturnValueOnce(interrupted.promise);
      clock();
      clock(1, { sequence: 2, paused: true });
      element.play.mockReturnValueOnce(resumed.promise);
      clock(1, { sequence: 3 });
      expect(element.play).toHaveBeenCalledTimes(2);
      if (completion === "resolve") interrupted.resolve();
      else interrupted.reject(new Error("interrupted play"));
      await flush();
      clock(1, { sequence: 4 });
      expect(element.play).toHaveBeenCalledTimes(2);
      expect(notifications("MM_AUDIO_ERROR")).toHaveLength(0);
      expect(notifications("MM_AUDIO_STATE")).toHaveLength(0);
      element.paused = false;
      resumed.resolve();
      await flush();
      expect(notifications("MM_AUDIO_STATE")).toEqual([
        { type: "MM_AUDIO_STATE", generation: 1, playing: true },
      ]);
    },
  );

  it("expires a pending play on clock loss without letting its completion resume vocals", async () => {
    const element = await ready();
    const interrupted = pending();
    element.play.mockReturnValueOnce(interrupted.promise);
    clock();
    await vi.advanceTimersByTimeAsync(5250);
    element.paused = false;
    interrupted.resolve();
    await flush();
    expect(element.paused).toBe(true);
    expect(notifications("MM_AUDIO_STATE")).toHaveLength(0);
    clock(1, { sequence: 2 });
    await flush();
    expect(element.play).toHaveBeenCalledTimes(2);
    expect(element.paused).toBe(false);
  });

  it("keeps normal ended, seek and replay clocks scoped to the current element", async () => {
    const element = await ready();
    clock();
    await flush();
    element.paused = true;
    element.currentTime = 20;
    element.emit("ended");
    clock(1, { sequence: 2, current_time: 0 });
    await flush();
    expect(element.currentTime).toBe(0);
    expect(element.play).toHaveBeenCalledTimes(2);
    expect(notifications("MM_AUDIO_STATE")).toEqual([
      { type: "MM_AUDIO_STATE", generation: 1, playing: true },
      { type: "MM_AUDIO_STATE", generation: 1, playing: false },
      { type: "MM_AUDIO_STATE", generation: 1, playing: true },
    ]);
    clock(1, { sequence: 3, current_time: 4, seeking: true });
    expect(element.currentTime).toBe(4);
    expect(element.paused).toBe(true);
  });

  it("does not let retired playable events clear the current buffer failure timer", async () => {
    const retired = await ready();
    const retiredCanPlay = [...retired.listeners.get("canplay")!];
    const current = await ready(2);
    clock(2);
    await flush();
    current.readyState = 2;
    current.emit("waiting");
    for (const listener of retiredCanPlay) invoke(listener, retired, "canplay");
    // Keep the video clock fresh while the media range stalls.
    await vi.advanceTimersByTimeAsync(1000);
    clock(2, { sequence: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(notifications("MM_AUDIO_ERROR")).toEqual([
      { type: "MM_AUDIO_ERROR", generation: 2, code: "AUDIO_BUFFER_UNDERRUN" },
    ]);
    expect(current.paused).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMediaClock, type ExtensionMessage } from "../src/extension/messages";

class ElementFixture extends EventTarget {
  id = "";
  className = "";
  type = "";
  title = "";
  href = "";
  innerHTML = "";
  textContent = "";
  content = "";
  hidden = false;
  disabled = false;
  checked = false;
  max = 0;
  value = 0;
  clientWidth = 640;
  clientHeight = 360;
  offsetWidth = 304;
  offsetHeight = 160;
  focused = false;
  focusOptions: FocusOptions | undefined;
  captures = new Set<number>();
  style = {
    left: "",
    top: "",
    right: "",
    bottom: "",
    height: "",
    animationDelay: "",
    properties: new Map<string, string>(),
    setProperty(name: string, value: string) {
      this.properties.set(name, value);
    },
    removeProperty(name: "left" | "top" | "right" | "bottom") {
      this[name] = "";
    },
  };
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: ElementFixture[] = [];
  parent: ElementFixture | null = null;
  append(...children: ElementFixture[]): void {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }
  prepend(child: ElementFixture): void {
    child.parent = this;
    this.children.unshift(child);
  }
  remove(): void {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (child) => child !== this,
      );
    this.parent = null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  closest(selector: string): ElementFixture | null {
    if (selector === "ytd-watch-flexy" && this.attributes.has("video-id"))
      return this;
    return this.parent?.closest(selector) ?? null;
  }
  matches(selector: string): boolean {
    if (selector === "ytd-watch-flexy") return this.attributes.has("video-id");
    if (selector === 'meta[itemprop="duration"]')
      return this.attributes.get("itemprop") === "duration";
    return selector.startsWith(".")
      ? this.className.split(" ").includes(selector.slice(1))
      : `#${this.id}` === selector;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  querySelector(selector: string): ElementFixture | null {
    for (const child of this.children) {
      if (
        `#${child.id}` === selector ||
        (selector === 'meta[itemprop="duration"]' && child.matches(selector)) ||
        (selector.startsWith(".") &&
          child.className.split(" ").includes(selector.slice(1)))
      )
        return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  click(): void {
    this.dispatchEvent(new Event("click"));
  }
  focus(options?: FocusOptions): void {
    this.focused = true;
    this.focusOptions = options;
  }
  getBoundingClientRect(): DOMRect {
    const isPanel = this.id === "musicmute-local-panel";
    const left = isPanel
      ? this.style.left
        ? parseFloat(this.style.left)
        : (this.parent?.clientWidth ?? 640) - this.offsetWidth - 12
      : 0;
    const top = isPanel ? parseFloat(this.style.top || "12") : 0;
    const width = isPanel ? this.offsetWidth : this.clientWidth;
    const height = isPanel ? this.offsetHeight : this.clientHeight;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON() {},
    };
  }
  setPointerCapture(id: number): void {
    this.captures.add(id);
  }
  hasPointerCapture(id: number): boolean {
    return this.captures.has(id);
  }
  releasePointerCapture(id: number): void {
    this.captures.delete(id);
  }
}

class VideoFixture extends ElementFixture {
  private mutedValue = false;
  muteWrites = 0;
  currentTime = 2;
  duration = 19;
  readyState = 4;
  bufferedRanges: [number, number][] = [];
  currentSrc = "blob:main-video";
  playbackRate = 1;
  volume = 0.8;
  paused = false;
  seeking = false;
  ended = false;
  get buffered(): TimeRanges {
    const ranges = this.bufferedRanges;
    return {
      length: ranges.length,
      start: (index) => ranges[index]?.[0] ?? NaN,
      end: (index) => ranges[index]?.[1] ?? NaN,
    };
  }
  get muted(): boolean {
    return this.mutedValue;
  }
  set muted(value: boolean) {
    this.muteWrites++;
    if (value === this.mutedValue) return;
    this.mutedValue = value;
    queueMicrotask(() => this.dispatchEvent(new Event("volumechange")));
  }
  pause(): void {
    this.paused = true;
  }
  async play(): Promise<void> {
    this.paused = false;
  }
}

const extensionId = "musicmute-test-extension";
const runtimeSend = vi.fn<(message: ExtensionMessage) => Promise<unknown>>();
type MessageHandler = (
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
) => unknown;
let video: VideoFixture;
let player: ElementFixture;
let controls: ElementFixture;
let watch: ElementFixture;
let documentEvents: Map<string, Set<EventListener>>;
let storageData: Record<string, unknown>;
let storageListeners: Set<
  (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
>;
let messageHandler: MessageHandler;
let mutation: (records?: MutationRecord[]) => void;
let disconnectObserver: ReturnType<typeof vi.fn>;
let resizeObservers: {
  callback: () => void;
  disconnect: ReturnType<typeof vi.fn>;
}[];
let ad = false;
let deferAdClocks = false;
let deferStarts = false;
let clockReply: { ok?: boolean; error?: string };
let heldClocks: (() => void)[];
let heldStarts: ((reply: { ok: boolean; error?: string }) => void)[];
let windowEvents: Map<string, () => void>;
let sent: ExtensionMessage[];
let clockMute: { ad: boolean; muted: boolean }[];

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}
function documentEvent(name: string, target?: ElementFixture): void {
  const event = new Event(name);
  if (target) Object.defineProperty(event, "target", { value: target });
  for (const listener of documentEvents.get(name) ?? []) listener(event);
}
function waveform(): ElementFixture {
  const button = controls.querySelector("#musicmute-local-button");
  if (!button) throw new Error("MusicMute control not installed");
  return button;
}
function panel(): ElementFixture {
  const found = player.children.find(
    (child) => child.id === "musicmute-local-panel",
  );
  if (!found) throw new Error("MusicMute panel not installed");
  return found;
}
function panelControl(className: string): ElementFixture {
  const found = panel().querySelector(`.${className}`);
  if (!found) throw new Error("MusicMute panel control not installed");
  return found;
}
function switchAudio(): void {
  panelControl("musicmute-panel-audio-toggle").click();
}
function stopMusicMute(): void {
  panelControl("musicmute-panel-stop").click();
}
function pointer(
  target: ElementFixture,
  type: string,
  x: number,
  y: number,
  id = 1,
): Event {
  const event = Object.assign(new Event(type, { cancelable: true }), {
    pointerId: id,
    clientX: x,
    clientY: y,
    button: 0,
    isPrimary: true,
  });
  target.dispatchEvent(event);
  return event;
}
function key(target: ElementFixture, value: string): Event {
  const event = Object.assign(new Event("keydown", { cancelable: true }), {
    key: value,
    shiftKey: false,
  });
  target.dispatchEvent(event);
  return event;
}
function generation(): number {
  const start = sent.findLast((message) => message.type === "MM_START");
  if (start?.type !== "MM_START") throw new Error("No start request");
  return start.generation;
}
function latestClock(): Extract<ExtensionMessage, { type: "MM_CLOCK" }> {
  const clock = sent.findLast((message) => message.type === "MM_CLOCK");
  if (clock?.type !== "MM_CLOCK") throw new Error("No clock sent");
  return clock;
}
function playback(playing: boolean): void {
  messageHandler(
    { type: "MM_PLAYBACK", generation: generation(), playing },
    { id: extensionId },
  );
}
async function begin(originalMuted = false): Promise<void> {
  video.muted = originalMuted;
  await flush();
  waveform().click();
  await flush();
  messageHandler(
    { type: "MM_READY", generation: generation() },
    { id: extensionId },
  );
  playback(true);
  await flush();
  expect(video.muted).toBe(true);
}
async function changeAd(active: boolean): Promise<void> {
  ad = active;
  mutation();
  await flush();
}
async function releaseClocks(): Promise<void> {
  for (const release of heldClocks.splice(0)) release();
  await flush();
}

async function contentFixture(
  options: {
    stored?: Record<string, unknown>;
    paused?: boolean;
    readyState?: number;
    storageReadFails?: boolean;
  } = {},
): Promise<void> {
  vi.resetModules();
  vi.useFakeTimers();
  vi.clearAllTimers();
  video = new VideoFixture();
  video.paused = options.paused ?? false;
  video.readyState = options.readyState ?? 4;
  player = new ElementFixture();
  controls = new ElementFixture();
  watch = new ElementFixture();
  watch.setAttribute("video-id", "jNQXAC9IVRw");
  watch.append(player);
  player.append(video);
  const queryPlayer = player.querySelector.bind(player);
  player.querySelector = (selector) =>
    selector === ".ytp-right-controls" ? controls : queryPlayer(selector);
  ad = false;
  deferAdClocks = false;
  deferStarts = false;
  clockReply = { ok: true };
  heldClocks = [];
  heldStarts = [];
  windowEvents = new Map();
  documentEvents = new Map();
  storageData = options.stored ?? {
    "musicmute.settings.v1": { version: 1 },
    "musicmute.settings.v1.autoStartEnabled": false,
  };
  storageListeners = new Set();
  disconnectObserver = vi.fn();
  resizeObservers = [];
  sent = [];
  clockMute = [];
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("removeEventListener", vi.fn());
  vi.stubGlobal("Element", ElementFixture);
  vi.stubGlobal("window", {
    confirm: vi.fn(() => false),
    addEventListener: vi.fn((event: string, callback: () => void) => {
      windowEvents.set(event, callback);
    }),
    removeEventListener: vi.fn((event: string, callback: () => void) => {
      if (windowEvents.get(event) === callback) windowEvents.delete(event);
    }),
  });
  vi.stubGlobal("location", {
    href: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    hostname: "www.youtube.com",
    pathname: "/watch",
  });
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: (records?: MutationRecord[]) => void) {
        mutation = callback;
      }
      observe(): void {}
      disconnect = disconnectObserver;
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect = vi.fn();
      constructor(callback: () => void) {
        resizeObservers.push({ callback, disconnect: this.disconnect });
      }
      observe(): void {}
    },
  );
  vi.stubGlobal("document", {
    documentElement: new ElementFixture(),
    visibilityState: "visible",
    addEventListener: vi.fn((name: string, listener: EventListener) => {
      if (!documentEvents.has(name)) documentEvents.set(name, new Set());
      documentEvents.get(name)!.add(listener);
    }),
    removeEventListener: vi.fn((name: string, listener: EventListener) =>
      documentEvents.get(name)?.delete(listener),
    ),
    createElement: () => new ElementFixture(),
    querySelector: (selector: string) => {
      if (selector === ".html5-video-player video") return video;
      if (selector === ".html5-video-player") return player;
      if (selector.includes(".ad-showing")) return ad ? player : null;
      return null;
    },
  });
  runtimeSend.mockReset().mockImplementation((message) => {
    sent.push(message);
    if (message.type === "MM_START" && deferStarts)
      return new Promise((resolve) => heldStarts.push(resolve));
    if (message.type === "MM_CLOCK") {
      clockMute.push({ ad: message.payload.ad_active, muted: video.muted });
      if (deferAdClocks && message.payload.ad_active)
        return new Promise((resolve) => {
          heldClocks.push(() => resolve(clockReply));
        });
      return Promise.resolve(clockReply);
    }
    return Promise.resolve({ ok: true });
  });
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async () => {
          if (options.storageReadFails) throw new Error("Storage unavailable");
          return { ...storageData };
        },
        set: async (updates: Record<string, unknown>) => {
          const changes: Record<string, chrome.storage.StorageChange> = {};
          for (const [key, value] of Object.entries(updates)) {
            changes[key] = { oldValue: storageData[key], newValue: value };
            storageData[key] = value;
          }
          for (const listener of storageListeners) listener(changes, "local");
        },
      },
      onChanged: {
        addListener: (
          listener: typeof storageListeners extends Set<infer T> ? T : never,
        ) => storageListeners.add(listener),
        removeListener: (
          listener: typeof storageListeners extends Set<infer T> ? T : never,
        ) => storageListeners.delete(listener),
      },
    },
    runtime: {
      id: extensionId,
      onMessage: {
        addListener: (callback: MessageHandler) => {
          messageHandler = callback;
        },
        removeListener: vi.fn(),
      },
      sendMessage: runtimeSend,
    },
  });
  await import("../src/extension/content");
  await flush();
}
beforeEach(() => contentFixture());

describe("saved cloud choice through the content handler", () => {
  function requestCloud(
    scope: unknown = "a".repeat(64),
    retryError?: string,
  ): void {
    const send = runtimeSend.getMockImplementation()!;
    runtimeSend.mockImplementation((message) => {
      if (message.type === "MM_START" && !message.cloud_confirmed) {
        sent.push(message);
        return Promise.resolve({
          ok: false,
          error: "CLOUD_CONFIRMATION_REQUIRED",
          processing_provider: "ONLINE_MUSICMUTE",
          cloud_confirmation_scope: scope,
        });
      }
      if (message.type === "MM_START" && retryError) {
        sent.push(message);
        return Promise.resolve({ ok: false, error: retryError });
      }
      return send(message);
    });
  }
  it("starts the saved cloud choice directly without a confirmation dialog", async () => {
    requestCloud();
    vi.mocked(window.confirm).mockImplementation(() => {
      throw new Error("Cloud Start must not show a browser dialog");
    });
    waveform().click();
    await flush();
    expect(window.confirm).not.toHaveBeenCalled();
    const starts = sent.filter((message) => message.type === "MM_START");
    expect(starts).toHaveLength(2);
    expect(starts[0]!.cloud_confirmed).toBeUndefined();
    expect(starts[1]!.cloud_confirmed).toBe(true);
    expect(starts[1]!.cloud_confirmation_scope).toBe("a".repeat(64));
    expect(starts[1]!.payload.provider).toBe("LOCAL_MACOS");
    expect(starts[1]!.generation).toBe(starts[0]!.generation);
    expect(video.paused).toBe(true);
    messageHandler(
      {
        type: "MM_JOB",
        generation: generation(),
        payload: {
          job_id: "11111111-1111-4111-8111-111111111111",
          video_id: "jNQXAC9IVRw",
          provider: "ONLINE_MUSICMUTE",
          state: "PROCESSING",
          stage: "processing",
        },
      },
      { id: extensionId },
    );
    expect(panelControl("musicmute-panel-status").textContent).toContain(
      "processing with MusicMute cloud",
    );
  });

  it("replaces the saved-choice wait with the actual account-cache stage", async () => {
    waveform().click();
    await flush();
    expect(panelControl("musicmute-panel-status").textContent).toContain(
      "starts on this Mac",
    );
    messageHandler(
      {
        type: "MM_JOB",
        generation: generation(),
        payload: {
          job_id: "11111111-1111-4111-8111-111111111111",
          video_id: "jNQXAC9IVRw",
          provider: "LOCAL_MACOS",
          state: "DOWNLOADING",
          stage: "account-restore",
        },
      },
      { id: extensionId },
    );
    expect(panelControl("musicmute-panel-title").textContent).toBe(
      "Checking saved vocals",
    );
    expect(panelControl("musicmute-panel-status").textContent).toContain(
      "MusicMute library for saved vocals",
    );
    expect(panelControl("musicmute-panel-status").textContent).not.toContain(
      "saved processing choice",
    );
  });
  it("still refuses an account change during the saved-choice handshake", async () => {
    requestCloud("a".repeat(64), "ACCOUNT_CHANGED");
    const { saveSettings } = await import("../src/extension/settings");
    await saveSettings({ autoStartEnabled: true, maxDurationMinutes: 10 });
    await flush();
    waveform().click();
    await flush();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(sent.filter((message) => message.type === "MM_START")).toHaveLength(
      2,
    );
    expect(video.paused).toBe(true);
    expect(video.muted).toBe(false);
    expect(waveform().getAttribute("aria-pressed")).toBe("false");
    mutation();
    documentEvent("play", video);
    documentEvent("durationchange", video);
    await flush();
    expect(sent.filter((message) => message.type === "MM_START")).toHaveLength(
      2,
    );
  });
  it.each([null, "a".repeat(63), "g".repeat(64), "a".repeat(65)])(
    "never submits cloud work with an invalid account scope %j",
    async (scope) => {
      requestCloud(scope);
      waveform().click();
      await flush();
      expect(window.confirm).not.toHaveBeenCalled();
      const starts = sent.filter((message) => message.type === "MM_START");
      expect(starts).toHaveLength(1);
      expect(starts[0]!.cloud_confirmed).toBeUndefined();
      expect(waveform().getAttribute("aria-pressed")).toBe("false");
    },
  );
  it("never prompts or sends confirmed cloud intent after automatic admission is refused", async () => {
    const send = runtimeSend.getMockImplementation()!;
    runtimeSend.mockImplementation((message) => {
      if (message.type === "MM_START") {
        sent.push(message);
        return Promise.resolve({
          ok: false,
          error: "AUTO_START_CLOUD_CONFIRMATION_REQUIRED",
        });
      }
      return send(message);
    });
    const { saveSettings } = await import("../src/extension/settings");
    await saveSettings({ autoStartEnabled: true, maxDurationMinutes: 10 });
    await flush();
    documentEvent("yt-navigate-start");
    location.href = "https://www.youtube.com/watch?v=BaW_jenozKc";
    watch.setAttribute("video-id", "BaW_jenozKc");
    video.currentSrc = "blob:next-main-video";
    documentEvent("loadedmetadata", video);
    documentEvent("yt-navigate-finish");
    await flush();
    expect(sent.filter((message) => message.type === "MM_START")).toHaveLength(
      1,
    );
    mutation();
    documentEvent("play", video);
    documentEvent("durationchange", video);
    await flush();
    expect(sent.filter((message) => message.type === "MM_START")).toHaveLength(
      1,
    );
    expect(window.confirm).not.toHaveBeenCalled();
    expect(
      sent
        .filter((message) => message.type === "MM_START")
        .every((message) => !message.cloud_confirmed),
    ).toBe(true);
    expect(video.paused).toBe(false);
    expect(video.muted).toBe(false);
  });
});

describe("saved settings and automatic playback through the content handler", () => {
  async function enableAuto(): Promise<void> {
    const { saveSettings } = await import("../src/extension/settings");
    await saveSettings({ autoStartEnabled: true, maxDurationMinutes: 10 });
    await flush();
  }
  async function navigate(
    duration = 120,
    fresh = true,
    playing = true,
  ): Promise<void> {
    documentEvent("yt-navigate-start");
    location.href = "https://www.youtube.com/watch?v=BaW_jenozKc";
    watch.setAttribute("video-id", "BaW_jenozKc");
    video.duration = duration;
    video.paused = !playing;
    if (fresh) {
      video.currentSrc = "blob:next-main-video";
      documentEvent("loadedmetadata", video);
    }
    documentEvent("yt-navigate-finish");
    await flush();
  }
  function starts(): Extract<ExtensionMessage, { type: "MM_START" }>[] {
    return sent.filter((message) => message.type === "MM_START");
  }

  it("automatically starts a loaded video on a clean page and resumes with vocals", async () => {
    await contentFixture({ stored: {} });
    expect(starts()).toHaveLength(1);
    expect(starts()[0]).toMatchObject({
      intent: "automatic",
      payload: { video_id: "jNQXAC9IVRw", duration_seconds: 19 },
    });
    expect(video.paused).toBe(true);
    messageHandler(
      { type: "MM_READY", generation: generation() },
      { id: extensionId },
    );
    await flush();
    playback(true);
    await flush();
    expect(video.paused).toBe(false);
    expect(video.muted).toBe(true);
    mutation();
    video.dispatchEvent(new Event("timeupdate"));
    await flush();
    expect(starts()).toHaveLength(1);
  });

  it.each([false, true])(
    "restores saved auto-start %s after refreshing the page",
    async (enabled) => {
      const saved = {
        "musicmute.settings.v1": { version: 1 },
        "musicmute.settings.v1.autoStartEnabled": enabled,
      };
      await contentFixture({ stored: saved });
      expect(starts()).toHaveLength(enabled ? 1 : 0);
      windowEvents.get("pagehide")!();
      await flush();
      await contentFixture({ stored: saved });
      expect(starts()).toHaveLength(enabled ? 1 : 0);
      expect(video.paused).toBe(enabled);
    },
  );

  it("waits for metadata when the page refresh loads before its video", async () => {
    await contentFixture({ stored: {}, readyState: 0 });
    expect(starts()).toHaveLength(0);
    video.readyState = 4;
    documentEvent("loadedmetadata", video);
    await flush();
    expect(starts()).toHaveLength(1);
  });

  it("keeps a refreshed paused video paused until YouTube Play", async () => {
    await contentFixture({ stored: {}, paused: true });
    expect(starts()).toHaveLength(0);
    expect(video.paused).toBe(true);
    await video.play();
    video.dispatchEvent(new Event("play"));
    await flush();
    expect(starts()).toHaveLength(1);
  });

  it("keeps auto-start off when restored settings cannot be read", async () => {
    await contentFixture({ stored: {}, storageReadFails: true });
    mutation();
    video.dispatchEvent(new Event("play"));
    documentEvent("loadedmetadata", video);
    await flush();
    expect(starts()).toHaveLength(0);
    expect(video.paused).toBe(false);
  });

  it("starts after late watch-duration metadata changes without another media event", async () => {
    await contentFixture({ stored: {}, readyState: 0 });
    const metadata = new ElementFixture();
    metadata.setAttribute("itemprop", "duration");
    metadata.content = "PT5M";
    watch.append(metadata);
    video.readyState = 4;
    documentEvent("loadedmetadata", video);
    await flush();
    expect(starts()).toHaveLength(0);
    metadata.content = "PT19S";
    mutation([
      { type: "attributes", target: metadata } as unknown as MutationRecord,
    ]);
    await flush();
    expect(starts()).toHaveLength(1);
  });

  it.each(["prior attempt", "Stop"])(
    "starts a fresh visit to the same video after %s while rejecting stale media",
    async (previous) => {
      await contentFixture({ stored: {} });
      expect(starts()).toHaveLength(1);
      if (previous === "Stop") {
        stopMusicMute();
        await flush();
      }
      documentEvent("yt-navigate-start");
      video.paused = false;
      documentEvent("yt-navigate-finish");
      await flush();
      expect(starts()).toHaveLength(1);
      video.currentSrc = "blob:fresh-visit-same-video";
      documentEvent("loadedmetadata", video);
      await flush();
      expect(starts()).toHaveLength(2);
      expect(starts()[1]).toMatchObject({
        intent: "automatic",
        payload: { video_id: "jNQXAC9IVRw" },
      });
    },
  );

  it("adds a gear before Close and applies saved background transparency", async () => {
    waveform().click();
    await flush();
    const gear = panelControl("musicmute-panel-settings-button");
    const header = panelControl("musicmute-panel-header");
    expect(header.children.indexOf(gear)).toBe(
      header.children.indexOf(panelControl("musicmute-panel-close")) - 1,
    );
    gear.click();
    expect(panelControl("musicmute-panel-settings").hidden).toBe(false);
    const { saveSettings } = await import("../src/extension/settings");
    await saveSettings({ transparencyPercent: 45 });
    await flush();
    expect(panel().style.properties.get("--musicmute-panel-alpha")).toBe(
      "0.55",
    );
  });

  it("enables from the next video, pauses once and resumes when the complete vocals track is ready", async () => {
    await enableAuto();
    expect(starts()).toHaveLength(0);
    await navigate();
    expect(starts()).toHaveLength(1);
    expect(starts()[0]).toMatchObject({
      intent: "automatic",
      payload: { video_id: "BaW_jenozKc", duration_seconds: 120 },
    });
    expect(video.paused).toBe(true);
    mutation();
    documentEvent("durationchange", video);
    await flush();
    expect(starts()).toHaveLength(1);
    messageHandler(
      { type: "MM_READY", generation: generation() },
      { id: extensionId },
    );
    await flush();
    expect(video.paused).toBe(false);
  });

  it.each([600, 601, Infinity, NaN, 0])(
    "skips duration %s without starting acquisition",
    async (duration) => {
      await enableAuto();
      await navigate(duration);
      expect(starts()).toHaveLength(0);
      expect(video.paused).toBe(false);
    },
  );

  it("waits for fresh metadata on a reused SPA player and preserves metadata received before reconciliation", async () => {
    await enableAuto();
    await navigate(120, false);
    expect(starts()).toHaveLength(0);
    video.currentSrc = "blob:next-main-video";
    documentEvent("loadedmetadata", video);
    await flush();
    expect(starts()).toHaveLength(1);
  });

  it("hands off active vocals to an already-playing next video without losing playback intent", async () => {
    await enableAuto();
    await begin();
    await navigate();
    expect(starts()).toHaveLength(2);
    expect(starts()[1]).toMatchObject({ intent: "automatic" });
    expect(video.paused).toBe(true);
    expect(video.muted).toBe(false);
    expect(sent.some((message) => message.type === "MM_STOP")).toBe(true);
    messageHandler(
      { type: "MM_READY", generation: generation() },
      { id: extensionId },
    );
    await flush();
    expect(video.paused).toBe(false);
  });

  it("fences an old READY reply immediately when navigation starts", async () => {
    waveform().click();
    await flush();
    const oldGeneration = generation();
    documentEvent("yt-navigate-start");
    messageHandler(
      { type: "MM_READY", generation: oldGeneration },
      { id: extensionId },
    );
    await flush();
    expect(video.paused).toBe(true);
    expect(
      sent.some(
        (message) =>
          message.type === "MM_CANCEL" && message.generation === oldGeneration,
      ),
    ).toBe(true);
  });

  it("does not use an ad's duration when the ad class disappears", async () => {
    await enableAuto();
    ad = true;
    await navigate(20);
    expect(starts()).toHaveLength(0);
    ad = false;
    documentEvent("loadedmetadata", video);
    mutation();
    await flush();
    expect(starts()).toHaveLength(0);
    video.currentSrc = "blob:main-after-ad";
    video.duration = 120;
    documentEvent("loadedmetadata", video);
    await flush();
    expect(starts()).toHaveLength(1);
  });

  it("restores original playback when automatic admission is denied by another tab", async () => {
    await enableAuto();
    deferStarts = true;
    await navigate();
    expect(video.paused).toBe(true);
    heldStarts.shift()?.({ ok: false, error: "AUTO_START_BUSY" });
    await flush();
    expect(video.paused).toBe(false);
    expect(video.muted).toBe(false);
    expect(panel().hidden).toBe(true);
    video.dispatchEvent(new Event("play"));
    mutation();
    await flush();
    expect(starts()).toHaveLength(1);
  });

  it.each(
    [
      "SOURCE_BOT_CHALLENGE",
      "ACQUISITION_RATE_LIMITED",
      "ACQUISITION_COOLDOWN",
      "ACQUISITION_BUSY",
    ].flatMap((code) =>
      [false, true].flatMap((muted) =>
        ["reply", "message"].map((delivery) => ({ code, muted, delivery })),
      ),
    ),
  )(
    "restores automatic original playback on $code via $delivery with mute $muted and suppresses repeat starts",
    async ({ code, muted, delivery }) => {
      await enableAuto();
      video.muted = muted;
      await flush();
      deferStarts = delivery === "reply";
      await navigate();
      const retired = generation();
      if (delivery === "reply")
        heldStarts.shift()?.({ ok: false, error: code });
      else
        messageHandler(
          { type: "MM_ERROR", generation: retired, code },
          { id: extensionId },
        );
      await flush();
      expect(video.paused).toBe(false);
      expect(video.muted).toBe(muted);
      expect(panel().dataset.state).toBe("error");
      expect(panelControl("musicmute-panel-status").textContent).not.toContain(
        "waveform to retry",
      );
      video.dispatchEvent(new Event("play"));
      mutation();
      await flush();
      expect(starts()).toHaveLength(1);
      expect(storageData).toMatchObject({
        "musicmute.settings.v1.autoStartEnabled": true,
        "musicmute.settings.v1.maxDurationMinutes": 10,
      });
      messageHandler(
        { type: "MM_READY", generation: retired },
        { id: extensionId },
      );
      await flush();
      expect(video.muted).toBe(muted);
    },
  );

  it.each(["pause", "ad", "ended", "seeking", "source", "url"])(
    "keeps automatic original playback paused on a refusal after %s",
    async (constraint) => {
      await enableAuto();
      const play = vi.spyOn(video, "play");
      await navigate();
      if (constraint === "pause") {
        video.dispatchEvent(new Event("pause")); // MusicMute's initial pause.
        video.dispatchEvent(new Event("pause")); // A later user pause.
      }
      if (constraint === "ad") ad = true;
      if (constraint === "ended") video.ended = true;
      if (constraint === "seeking") video.seeking = true;
      if (constraint === "source") video.currentSrc = "blob:different-source";
      if (constraint === "url")
        location.href = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
      messageHandler(
        {
          type: "MM_ERROR",
          generation: generation(),
          code: "SOURCE_BOT_CHALLENGE",
        },
        { id: extensionId },
      );
      await flush();
      expect(play).not.toHaveBeenCalled();
      expect(video.paused).toBe(true);
      expect(video.muted).toBe(false);
    },
  );

  it.each(["throw", "reject"])(
    "contains a browser play %s after automatic refusal without retrying",
    async (failure) => {
      await enableAuto();
      await navigate();
      const play = vi.spyOn(video, "play").mockImplementation(() => {
        if (failure === "throw") throw new Error("Playback refused");
        return Promise.reject(new Error("Playback refused"));
      });
      messageHandler(
        {
          type: "MM_ERROR",
          generation: generation(),
          code: "ACQUISITION_COOLDOWN",
        },
        { id: extensionId },
      );
      await flush();
      expect(play).toHaveBeenCalledTimes(1);
      expect(video.paused).toBe(true);
      mutation();
      await flush();
      expect(starts()).toHaveLength(1);
      expect(play).toHaveBeenCalledTimes(1);
    },
  );

  it("does not mistake queued preparation pauses for a user's later pause", async () => {
    await enableAuto();
    await navigate();
    video.paused = false;
    video.dispatchEvent(new Event("play"));
    expect(video.paused).toBe(true);
    video.dispatchEvent(new Event("pause"));
    video.dispatchEvent(new Event("pause"));
    messageHandler(
      {
        type: "MM_ERROR",
        generation: generation(),
        code: "SOURCE_BOT_CHALLENGE",
      },
      { id: extensionId },
    );
    await flush();
    expect(video.paused).toBe(false);
  });

  it("restores automatic original playback for a terminal job failure", async () => {
    await enableAuto();
    await navigate();
    messageHandler(
      {
        type: "MM_JOB",
        generation: generation(),
        payload: {
          job_id: "00000000-0000-4000-8000-000000000001",
          video_id: "BaW_jenozKc",
          provider: "LOCAL_MACOS",
          state: "FAILED",
          stage: "metadata",
          error_code: "SOURCE_BOT_CHALLENGE",
        },
      },
      { id: extensionId },
    );
    await flush();
    expect(video.paused).toBe(false);
    expect(video.muted).toBe(false);
    expect(panelControl("musicmute-panel-title").textContent).toBe(
      "YouTube access paused",
    );
  });

  it.each([
    "OUTBOX_BUSY",
    "ENOENT",
    "SOURCE_HTTP_FORBIDDEN",
    "SOURCE_TOKEN_REQUIRED",
    "ACQUISITION_STATE_INVALID",
    "SOURCE_TRANSFER_INCOMPLETE",
    "SOURCE_TRANSFER_EMPTY",
    "SOURCE_TLS_FAILED",
    "ACQUISITION_STORAGE_FAILED",
    "SOURCE_POSTPROCESSING_FAILED",
    "DOWNLOADER_ARGUMENTS_INVALID",
    "DOWNLOADER_ISOLATION_REQUIRED",
  ])("keeps automatic playback safely paused for %s", async (code) => {
    await enableAuto();
    await navigate();
    messageHandler(
      { type: "MM_ERROR", generation: generation(), code },
      { id: extensionId },
    );
    await flush();
    expect(video.paused).toBe(true);
    expect(video.muted).toBe(false);
  });

  it("ignores a refused START after navigation retires its generation", async () => {
    await enableAuto();
    deferStarts = true;
    await navigate();
    const play = vi.spyOn(video, "play");
    documentEvent("yt-navigate-start");
    heldStarts.shift()?.({ ok: false, error: "ACQUISITION_COOLDOWN" });
    await flush();
    expect(play).not.toHaveBeenCalled();
  });

  it("honors Stop on this visit and allows manual restart from the icon", async () => {
    await enableAuto();
    await navigate();
    stopMusicMute();
    await flush();
    video.paused = false;
    video.dispatchEvent(new Event("play"));
    mutation();
    await flush();
    expect(starts()).toHaveLength(1);
    expect(panel().hidden).toBe(true);
    waveform().click();
    await flush();
    expect(starts()).toHaveLength(2);
    expect(starts()[1]).not.toHaveProperty("intent");
  });

  it("automatically prepares and resumes a playing next video while the tab stays hidden", async () => {
    await enableAuto();
    Object.assign(document, { visibilityState: "hidden" });
    await navigate();
    expect(starts()).toHaveLength(1);
    expect(starts()[0]).toMatchObject({ intent: "automatic" });
    expect(video.paused).toBe(true);
    expect(document.visibilityState).toBe("hidden");
    messageHandler(
      { type: "MM_READY", generation: generation() },
      { id: extensionId },
    );
    await flush();
    expect(video.paused).toBe(false);
    expect(document.visibilityState).toBe("hidden");
    documentEvent("visibilitychange");
    mutation();
    await flush();
    expect(starts()).toHaveLength(1);
  });

  it("keeps a paused background video paused until its playback starts", async () => {
    await enableAuto();
    Object.assign(document, { visibilityState: "hidden" });
    await navigate(120, true, false);
    expect(starts()).toHaveLength(0);
    expect(video.paused).toBe(true);
    video.paused = false;
    video.dispatchEvent(new Event("play"));
    await flush();
    expect(starts()).toHaveLength(1);
  });

  it("still skips a video at the duration limit while the tab is hidden", async () => {
    await enableAuto();
    Object.assign(document, { visibilityState: "hidden" });
    await navigate(600);
    expect(starts()).toHaveLength(0);
    expect(video.paused).toBe(false);
  });
});

describe("safe acquisition failure guidance through the content handler", () => {
  it("updates the persisted cooldown deadline locally without polling or retrying", async () => {
    waveform().click();
    await flush();
    const context = {
      stage: "metadata",
      block_reason: "ACQUISITION_RATE_LIMITED",
      retry_at: Date.now() + 61_000,
    } as const;
    messageHandler(
      {
        type: "MM_ERROR",
        generation: generation(),
        code: "ACQUISITION_COOLDOWN",
        error_context: context,
      },
      { id: extensionId },
    );
    expect(panelControl("musicmute-panel-status").textContent).toContain(
      "1:01",
    );
    const sends = sent.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(panelControl("musicmute-panel-status").textContent).toContain(
      "0:59",
    );
    expect(sent).toHaveLength(sends);
    panelControl("musicmute-panel-close").click();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(panel().hidden).toBe(true);
    expect(panelControl("musicmute-panel-status").textContent).toContain(
      "YouTube can still refuse",
    );
    expect(sent.filter((message) => message.type === "MM_START")).toHaveLength(
      1,
    );
  });
  it("copies only the fixed code, failed stage and guidance", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
    waveform().click();
    await flush();
    messageHandler(
      {
        type: "MM_ERROR",
        generation: generation(),
        code: "SOURCE_TOKEN_REQUIRED",
        error_context: { stage: "metadata", http_status: 403 },
      },
      { id: extensionId },
    );
    panelControl("musicmute-copy-error").click();
    await flush();
    expect(copy).toHaveBeenCalledOnce();
    const report = copy.mock.calls[0]![0] as string;
    expect(report).toContain("Stage: metadata");
    expect(report).toContain("SOURCE_TOKEN_REQUIRED");
    expect(report).not.toMatch(/https:|jNQXAC9IVRw|cookie=|secret/);
  });
  it("opens cloud review only after an explicit click and a canonical background reply", async () => {
    waveform().click();
    await flush();
    messageHandler(
      {
        type: "MM_ERROR",
        generation: generation(),
        code: "SOURCE_BOT_CHALLENGE",
      },
      { id: extensionId },
    );
    expect(sent.some((message) => message.type === "MM_CLOUD_HANDOFF")).toBe(
      false,
    );
    const send = runtimeSend.getMockImplementation()!;
    runtimeSend.mockImplementation((message) =>
      message.type === "MM_CLOUD_HANDOFF"
        ? (sent.push(message),
          Promise.resolve({
            ok: true,
            handoff_url:
              "musicmute-local://cloud?video_id=jNQXAC9IVRw&duration_seconds=19",
          }))
        : send(message),
    );
    panelControl("musicmute-cloud-link").click();
    await flush();
    expect(
      sent.filter((message) => message.type === "MM_CLOUD_HANDOFF"),
    ).toHaveLength(1);
    expect(location.href).toBe(
      "musicmute-local://cloud?video_id=jNQXAC9IVRw&duration_seconds=19",
    );
    expect(panelControl("musicmute-panel-status").textContent).toContain(
      "No cloud request has been submitted",
    );
    expect(panelControl("musicmute-panel-status").textContent).toContain(
      "review monthly usage and confirm cloud processing",
    );
    expect(panelControl("musicmute-panel-status").textContent).not.toContain(
      "choose an account",
    );
    expect(video.muted).toBe(false);
  });
  it("offers tool repair for unavailable audio without suggesting cloud will fix acquisition", async () => {
    waveform().click();
    await flush();
    messageHandler(
      {
        type: "MM_ERROR",
        generation: generation(),
        code: "SOURCE_AUDIO_FORMAT_UNAVAILABLE",
        error_context: { stage: "metadata" },
      },
      { id: extensionId },
    );
    await flush();
    expect(panelControl("musicmute-panel-title").textContent).toBe(
      "YouTube audio unavailable",
    );
    expect(panelControl("musicmute-panel-status").textContent).toContain(
      "Signing in to MusicMute does not change YouTube download access",
    );
    expect(panelControl("musicmute-setup-link").hidden).toBe(false);
    expect(panelControl("musicmute-cloud-link").hidden).toBe(true);
    expect(sent.some((message) => message.type === "MM_CLOUD_HANDOFF")).toBe(
      false,
    );
    expect(video.muted).toBe(false);
  });
  it("explains that cooldown also protects an interrupted uncertain download", async () => {
    waveform().click();
    await flush();
    messageHandler(
      {
        type: "MM_ERROR",
        generation: generation(),
        code: "ACQUISITION_COOLDOWN",
      },
      { id: extensionId },
    );
    await flush();
    expect(panelControl("musicmute-panel-title").textContent).toBe(
      "YouTube access paused",
    );
    const message = panelControl("musicmute-panel-status").textContent;
    expect(message).toContain(
      "bot check, request limit or interrupted download",
    );
    expect(message).toContain("15-minute cooldown");
    expect(message).not.toContain("waveform to retry");
    expect(video.paused).toBe(true);
    expect(video.muted).toBe(false);
  });

  it.each([
    ["OUTBOX_BUSY", "Local save busy", "local save is still finishing"],
    [
      "ENOENT",
      "Local file missing",
      "Open the MusicMute extension and select Check again",
    ],
    ["SOURCE_BOT_CHALLENGE", "YouTube access paused", "bot check"],
    ["ACQUISITION_RATE_LIMITED", "YouTube request limit", "15 minutes"],
    ["ACQUISITION_COOLDOWN", "YouTube access paused", "cooldown"],
    ["ACQUISITION_BUSY", "Another download is active", "in progress"],
    [
      "SOURCE_TOKEN_REQUIRED",
      "YouTube playback token required",
      "playback token",
    ],
    [
      "SOURCE_HTTP_UNAUTHORIZED",
      "YouTube authentication required",
      "Chrome cookies",
    ],
    [
      "SOURCE_AUTH_REQUIRED",
      "YouTube authentication required",
      "Chrome cookies",
    ],
    ["SOURCE_HTTP_FORBIDDEN", "YouTube refused the audio", "HTTP 403"],
    ["SOURCE_AGE_RESTRICTED", "Age-restricted video", "age verification"],
    ["SOURCE_ACCESS_RESTRICTED", "Restricted video", "private, members-only"],
    ["ACQUISITION_NETWORK_FAILED", "Audio connection failed", "connection"],
    [
      "SOURCE_TRANSFER_INCOMPLETE",
      "Audio download incomplete",
      "No vocals result was created",
    ],
    [
      "SOURCE_TRANSFER_EMPTY",
      "No audio downloaded",
      "No vocals result was created",
    ],
    [
      "SOURCE_TLS_FAILED",
      "Secure audio connection failed",
      "establish or verify the audio server's secure connection",
    ],
    ["ACQUISITION_STORAGE_FAILED", "Audio storage failed", "free disk space"],
    [
      "SOURCE_POSTPROCESSING_FAILED",
      "Audio preparation failed",
      "Open the MusicMute app and check diagnostics",
    ],
    [
      "DOWNLOADER_ARGUMENTS_INVALID",
      "Downloader settings rejected",
      "Open the MusicMute app and check diagnostics",
    ],
    [
      "DOWNLOADER_ISOLATION_REQUIRED",
      "Guest download safety check failed",
      "guest isolation could not be verified",
    ],
    [
      "ACQUISITION_STATE_INVALID",
      "Download safety check failed",
      "local download state",
    ],
    [
      "SOURCE_CHALLENGE_FAILED",
      "YouTube challenge failed",
      "playback challenge",
    ],
    [
      "SOURCE_AUDIO_FORMAT_UNAVAILABLE",
      "YouTube audio unavailable",
      "supported audio",
    ],
    ["SOURCE_UNAVAILABLE", "Video unavailable", "unavailable"],
  ])(
    "explains manual %s and keeps original playback paused",
    async (code, title, guidance) => {
      waveform().click();
      await flush();
      messageHandler(
        { type: "MM_ERROR", generation: generation(), code },
        { id: extensionId },
      );
      await flush();
      expect(video.paused).toBe(true);
      expect(video.muted).toBe(false);
      expect(panelControl("musicmute-panel-title").textContent).toBe(title);
      const message = panelControl("musicmute-panel-status").textContent;
      expect(message).toContain(guidance);
      expect(message).not.toContain("waveform to retry");
      expect(message).not.toContain("account blocked");
      expect(message).not.toMatch(
        /disable.*(?:TLS|SSL|certificate)|no-check-certificate/i,
      );
    },
  );

  it("never reflects arbitrary error text or URLs into controls or diagnostics", async () => {
    waveform().click();
    await flush();
    const privateText =
      "https://example.com/private?token=secret account@example.com";
    messageHandler(
      { type: "MM_ERROR", generation: generation(), code: privateText },
      { id: extensionId },
    );
    await flush();
    expect(panelControl("musicmute-panel-status").textContent).toContain(
      "video is paused",
    );
    expect(panelControl("musicmute-panel-status").textContent).not.toContain(
      privateText,
    );
    expect(JSON.stringify(sent)).not.toContain(privateText);
  });
});

describe("background saving through the actual content handler", () => {
  function saveState(
    state: "pending" | "saving" | "saved",
    owner = generation(),
  ) {
    messageHandler(
      {
        type: "MM_JOB",
        generation: owner,
        payload: {
          job_id: "11111111-1111-4111-8111-111111111111",
          video_id: "jNQXAC9IVRw",
          provider: "LOCAL_MACOS",
          state: "READY",
          stage: "ready",
          save_state: state,
        },
      },
      { id: extensionId },
    );
  }
  it("shows saving during playback and clears it on a committed snapshot without changing playback", async () => {
    await begin();
    const owner = generation();
    const requests = sent.filter((message) =>
      ["MM_START", "MM_STOP", "MM_CANCEL"].includes(message.type),
    ).length;
    for (const state of ["pending", "saving"] as const) {
      saveState(state);
      expect(panelControl("musicmute-panel-status").textContent).toBe(
        "Playing vocals · Saving in background",
      );
      expect(video.paused).toBe(false);
      expect(video.muted).toBe(true);
      expect(generation()).toBe(owner);
    }
    saveState("saved");
    expect(panelControl("musicmute-panel-status").textContent).toBe(
      "Use YouTube to pause, seek and adjust volume.",
    );
    expect(
      sent.filter((message) =>
        ["MM_START", "MM_STOP", "MM_CANCEL"].includes(message.type),
      ),
    ).toHaveLength(requests);
  });
  it("does not claim playback started for a prepared pending save", async () => {
    waveform().click();
    await flush();
    saveState("pending");
    messageHandler(
      { type: "MM_READY", generation: generation() },
      { id: extensionId },
    );
    expect(panelControl("musicmute-panel-status").textContent).toBe(
      "Vocals ready. Play the video to listen.",
    );
    playback(true);
    expect(panelControl("musicmute-panel-status").textContent).toBe(
      "Playing vocals · Saving in background",
    );
  });
  it("clears saving when a committed snapshot arrives after the user pauses", async () => {
    await begin();
    saveState("saving");
    video.pause();
    playback(false);
    expect(panelControl("musicmute-panel-status").textContent).toBe(
      "Vocals ready · Saving in background",
    );
    const owner = generation();
    const requests = sent.filter((message) =>
      ["MM_START", "MM_STOP", "MM_CANCEL"].includes(message.type),
    ).length;
    saveState("saved");
    expect(panelControl("musicmute-panel-status").textContent).toBe(
      "Vocals ready. Play the video to listen.",
    );
    expect(panelControl("musicmute-panel-title").textContent).toBe(
      "Vocals ready",
    );
    expect(video.paused).toBe(true);
    expect(video.muted).toBe(true);
    expect(generation()).toBe(owner);
    expect(
      sent.filter((message) =>
        ["MM_START", "MM_STOP", "MM_CANCEL"].includes(message.type),
      ),
    ).toHaveLength(requests);
  });
  it("preserves ad guidance while saving snapshots update", async () => {
    await begin();
    saveState("saving");
    await changeAd(true);
    playback(false);
    const guidance = panelControl("musicmute-panel-status").textContent;
    const heading = panelControl("musicmute-panel-title").textContent;
    expect(guidance).toContain("The ad plays with its original audio");
    saveState("saved");
    expect(panelControl("musicmute-panel-status").textContent).toBe(guidance);
    expect(panelControl("musicmute-panel-title").textContent).toBe(heading);
  });
  it("ignores retired save updates and resets saving on the next session", async () => {
    await begin();
    const retired = generation();
    saveState("pending");
    stopMusicMute();
    await flush();
    await begin();
    saveState("saving", retired);
    expect(panelControl("musicmute-panel-status").textContent).toBe(
      "Use YouTube to pause, seek and adjust volume.",
    );
  });
});

describe("playback waveform through the actual content handler", () => {
  function wave(): ElementFixture {
    return panelControl("musicmute-playback-waveform");
  }
  function waveTime(): string {
    return panelControl("musicmute-wave-time").textContent;
  }
  function waveProgress(): string | undefined {
    return wave().style.properties.get("--musicmute-wave-progress");
  }
  function videoEvent(name: string): void {
    video.dispatchEvent(new Event(name));
  }

  it("waits for actual vocals playback, then stops and resumes with the audio acknowledgement", async () => {
    expect(wave().hidden).toBe(true);
    waveform().click();
    await flush();
    expect(wave().hidden).toBe(true);
    messageHandler(
      { type: "MM_READY", generation: generation() },
      { id: extensionId },
    );
    await flush();
    expect(wave().hidden).toBe(false);
    expect(wave().dataset.playing).toBe("false");
    playback(true);
    await flush();
    expect(video.muted).toBe(true);
    expect(wave().dataset.playing).toBe("true");
    expect(panelControl("musicmute-wave-source").textContent).toBe(
      "Voice-only",
    );
    playback(false);
    expect(video.paused).toBe(false);
    expect(wave().dataset.playing).toBe("false");
    playback(true);
    expect(wave().dataset.playing).toBe("true");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("freezes immediately on pause, seek, buffering and end while keeping the video position", async () => {
    await begin();
    video.currentTime = 9.5;
    video.paused = true;
    videoEvent("pause");
    expect(wave().dataset.playing).toBe("false");
    expect(waveTime()).toBe("0:09 / 0:19");
    expect(waveProgress()).toBe("50%");
    playback(false);
    video.paused = false;
    videoEvent("play");
    expect(wave().dataset.playing).toBe("false");
    playback(true);
    expect(wave().dataset.playing).toBe("true");
    video.seeking = true;
    videoEvent("seeking");
    expect(wave().dataset.playing).toBe("false");
    video.seeking = false;
    videoEvent("seeked");
    expect(wave().dataset.playing).toBe("true");
    for (const bufferingEvent of ["waiting", "stalled"]) {
      video.readyState = 2;
      videoEvent(bufferingEvent);
      expect(wave().dataset.playing).toBe("false");
      video.readyState = 4;
      videoEvent("canplay");
      expect(wave().dataset.playing).toBe("true");
    }
    video.ended = true;
    video.currentTime = 19;
    videoEvent("ended");
    expect(wave().dataset.playing).toBe("false");
    expect(waveProgress()).toBe("100%");
  });

  it.each([
    { readyState: 4, ranges: [] },
    { readyState: 2, ranges: [[0, 3]] },
  ])(
    "keeps vocals playing on a network stall with usable video data: %j",
    async ({ readyState, ranges }) => {
      await begin();
      video.readyState = readyState;
      video.bufferedRanges = ranges as [number, number][];
      videoEvent("stalled");
      expect(latestClock().payload.buffering).toBe(false);
      expect(video.paused).toBe(false);
      expect(wave().dataset.playing).toBe("true");
      await vi.advanceTimersByTimeAsync(750);
      expect(latestClock().payload.buffering).toBe(false);
      expect(wave().dataset.playing).toBe("true");
    },
  );

  it.each([
    { readyState: 1, ranges: [[0, 19]] },
    { readyState: 2, ranges: [] },
    { readyState: 2, ranges: [[0, 2.05]] },
    { readyState: 2, ranges: [[3, 19]] },
  ])(
    "suspends vocals on a network stall without playable data: %j",
    async ({ readyState, ranges }) => {
      await begin();
      video.readyState = readyState;
      video.bufferedRanges = ranges as [number, number][];
      videoEvent("stalled");
      expect(latestClock().payload.buffering).toBe(true);
      expect(wave().dataset.playing).toBe("false");
      await vi.advanceTimersByTimeAsync(750);
      expect(latestClock().payload.buffering).toBe(true);
    },
  );

  it("honors waiting even with buffered data until readiness or playback recovers", async () => {
    await begin();
    videoEvent("waiting");
    expect(latestClock().payload.buffering).toBe(true);
    videoEvent("stalled");
    await vi.advanceTimersByTimeAsync(250);
    expect(latestClock().payload.buffering).toBe(true);
    expect(wave().dataset.playing).toBe("false");
    videoEvent("progress");
    expect(latestClock().payload.buffering).toBe(false);
    expect(wave().dataset.playing).toBe("true");
  });

  it.each(["waiting", "stalled"])(
    "recovers %s from advancing video time without a canplay event",
    async (event) => {
      await begin();
      video.readyState = 2;
      videoEvent(event);
      videoEvent("timeupdate");
      expect(latestClock().payload.buffering).toBe(true);
      video.currentTime -= 0.5;
      videoEvent("timeupdate");
      expect(latestClock().payload.buffering).toBe(true);
      video.currentTime = 2.5;
      videoEvent("timeupdate");
      expect(latestClock().payload.buffering).toBe(false);
      expect(wave().dataset.playing).toBe("true");
    },
  );

  it("recovers a stalled flag from periodic clock progress without another media event", async () => {
    await begin();
    video.readyState = 2;
    videoEvent("stalled");
    video.currentTime = 2.5;
    await vi.advanceTimersByTimeAsync(250);
    expect(latestClock().payload.buffering).toBe(false);
    expect(wave().dataset.playing).toBe("true");
  });

  it("recovers readiness from downloaded data without canplay or advancing time", async () => {
    await begin();
    video.readyState = 2;
    videoEvent("stalled");
    videoEvent("progress");
    expect(latestClock().payload.buffering).toBe(true);
    video.bufferedRanges = [[0, 3]];
    videoEvent("progress");
    expect(latestClock().payload.buffering).toBe(false);
    expect(wave().dataset.playing).toBe("true");
  });

  it.each(["paused", "seeking", "ended"] as const)(
    "does not mistake %s position changes for resumed playback",
    async (state) => {
      await begin();
      video.readyState = 2;
      videoEvent("waiting");
      video[state] = true;
      video.currentTime = 3;
      videoEvent("timeupdate");
      expect(latestClock().payload.buffering).toBe(true);
      expect(latestClock().payload[state]).toBe(true);
      expect(wave().dataset.playing).toBe("false");
    },
  );

  it("keeps seeking into unready data suspended until readiness returns", async () => {
    await begin();
    video.seeking = true;
    videoEvent("seeking");
    video.currentTime = 10;
    video.readyState = 1;
    video.seeking = false;
    videoEvent("seeked");
    expect(latestClock().payload.buffering).toBe(true);
    expect(wave().dataset.playing).toBe("false");
    video.readyState = 4;
    videoEvent("progress");
    expect(latestClock().payload.buffering).toBe(false);
    expect(wave().dataset.playing).toBe("true");
  });

  it("resets buffering on replacement and detaches the old video events", async () => {
    await begin();
    video.readyState = 2;
    videoEvent("waiting");
    const previous = video;
    video = new VideoFixture();
    player.append(video);
    mutation();
    await flush();
    await begin();
    expect(latestClock().payload.buffering).toBe(false);
    const clocks = sent.filter((message) => message.type === "MM_CLOCK").length;
    previous.dispatchEvent(new Event("waiting"));
    previous.dispatchEvent(new Event("progress"));
    await flush();
    expect(sent.filter((message) => message.type === "MM_CLOCK")).toHaveLength(
      clocks,
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(latestClock().payload.buffering).toBe(false);
    expect(wave().dataset.playing).toBe("true");
  });

  it("keeps original sound static while its full-video timeline advances without new runtime reads", async () => {
    video.duration = 125;
    await begin();
    switchAudio();
    await flush();
    expect(wave().hidden).toBe(false);
    expect(wave().dataset.vocals).toBe("false");
    expect(wave().dataset.playing).toBe("false");
    expect(panelControl("musicmute-wave-source").textContent).toBe(
      "Original sound",
    );
    const requests = sent.length;
    video.currentTime = 62.5;
    videoEvent("timeupdate");
    expect(waveTime()).toBe("1:02 / 2:05");
    expect(waveProgress()).toBe("50%");
    video.currentTime = 75;
    videoEvent("timeupdate");
    await vi.advanceTimersByTimeAsync(250);
    expect(waveProgress()).toBe("60%");
    expect(wave().dataset.playing).toBe("false");
    expect(sent).toHaveLength(requests);
    expect(vi.getTimerCount()).toBe(0);
    const track = panelControl("musicmute-wave-track");
    expect(track.attributes.get("role")).toBe("progressbar");
    expect(track.attributes.get("aria-valuenow")).toBe("75");
    expect(track.attributes.get("aria-valuemax")).toBe("125");
    expect(track.attributes.get("aria-valuetext")).toBe(
      "Original sound: 1:15 of 2:05",
    );
    expect(
      panelControl("musicmute-wave-time").attributes.has("aria-live"),
    ).toBe(false);
    for (const layer of track.children)
      expect(layer.attributes.get("aria-hidden")).toBe("true");
  });

  it("follows seeks, duration changes and playback rate and clamps incomplete media metadata", async () => {
    await begin();
    video.duration = 120;
    video.currentTime = 30;
    video.playbackRate = 2;
    videoEvent("ratechange");
    expect(waveTime()).toBe("0:30 / 2:00");
    expect(waveProgress()).toBe("25%");
    expect(wave().style.properties.get("--musicmute-wave-period")).toBe(
      "500ms",
    );
    video.currentTime = 500;
    videoEvent("timeupdate");
    expect(waveProgress()).toBe("100%");
    video.currentTime = -2;
    videoEvent("timeupdate");
    expect(waveProgress()).toBe("0%");
    video.currentTime = NaN;
    videoEvent("timeupdate");
    expect(waveTime()).toBe("0:00 / 2:00");
    for (const duration of [0, NaN, Infinity, -1]) {
      video.duration = duration;
      videoEvent("loadedmetadata");
      expect(waveTime()).toBe("0:00 / --:--");
      expect(waveProgress()).toBe("0%");
      expect(
        panelControl("musicmute-wave-track").attributes.has("aria-valuenow"),
      ).toBe(false);
    }
    video.playbackRate = NaN;
    videoEvent("ratechange");
    expect(wave().style.properties.get("--musicmute-wave-period")).toBe(
      "1000ms",
    );
  });

  it("holds the main video timeline throughout an ad and resumes only with vocals playback", async () => {
    video.duration = 120;
    video.currentTime = 60;
    await begin();
    expect(waveTime()).toBe("1:00 / 2:00");
    ad = true;
    video.duration = 10;
    video.currentTime = 1;
    mutation();
    await flush();
    expect(wave().dataset.playing).toBe("false");
    expect(waveTime()).toBe("1:00 / 2:00");
    playback(false);
    video.currentTime = 5;
    videoEvent("timeupdate");
    expect(waveProgress()).toBe("50%");
    video.duration = 120;
    video.currentTime = 61;
    await changeAd(false);
    expect(wave().dataset.playing).toBe("false");
    expect(waveTime()).toBe("1:01 / 2:00");
    playback(true);
    expect(wave().dataset.playing).toBe("true");
  });

  it("uses the user's mute preference and volume instead of the muted original video", async () => {
    await begin();
    expect(video.muted).toBe(true);
    expect(wave().dataset.playing).toBe("true");
    video.volume = 0;
    videoEvent("volumechange");
    expect(wave().dataset.playing).toBe("false");
    video.volume = 0.8;
    videoEvent("volumechange");
    expect(wave().dataset.playing).toBe("true");
    await changeAd(true);
    video.muted = true;
    await flush();
    await changeAd(false);
    playback(true);
    expect(wave().dataset.playing).toBe("false");
    video.muted = false;
    await flush();
    expect(video.muted).toBe(true);
    expect(wave().dataset.playing).toBe("true");
  });

  it("freezes when hidden and restores activity and position after reopening or remounting", async () => {
    await begin();
    panelControl("musicmute-panel-close").click();
    expect(wave().dataset.playing).toBe("false");
    video.currentTime = 9.5;
    waveform().click();
    expect(waveProgress()).toBe("50%");
    expect(wave().dataset.playing).toBe("true");
    waveform().remove();
    mutation();
    await flush();
    expect(wave().dataset.playing).toBe("true");
    expect(waveProgress()).toBe("50%");
    expect(sent.filter((message) => message.type === "MM_START")).toHaveLength(
      1,
    );
  });

  it.each(["stop", "error", "navigation", "invalidation"] as const)(
    "retires waveform playback on %s and ignores a late playing acknowledgement",
    async (ending) => {
      await begin();
      const retired = generation();
      const previousWave = wave();
      if (ending === "stop") stopMusicMute();
      if (ending === "error")
        messageHandler(
          {
            type: "MM_ERROR",
            generation: retired,
            code: "AUDIO_DECODE_FAILED",
          },
          { id: extensionId },
        );
      if (ending === "navigation") {
        video = new VideoFixture();
        video.duration = 90;
        video.currentTime = 3;
        player.append(video);
        mutation();
      }
      if (ending === "invalidation") {
        runtimeSend.mockImplementation(() => {
          throw new Error("Extension context invalidated.");
        });
        videoEvent("timeupdate");
      }
      await flush();
      messageHandler(
        { type: "MM_PLAYBACK", generation: retired, playing: true },
        { id: extensionId },
      );
      await flush();
      expect(previousWave.dataset.playing).toBe("false");
      expect(wave().hidden).toBe(true);
      expect(wave().dataset.playing).toBe("false");
      if (ending === "navigation") {
        await begin();
        expect(waveTime()).toBe("0:03 / 1:30");
      }
    },
  );
});

describe("extension invalidation through the actual content handler", () => {
  function statusMessage(): string | undefined {
    return player.children
      .find((child) => child.id === "musicmute-local-panel")
      ?.children.find((child) => child.className === "musicmute-panel-status")
      ?.textContent;
  }
  function invalidateMessaging(mode: "throw" | "reject"): void {
    runtimeSend.mockImplementation(() => {
      const error = new Error("Extension context invalidated.");
      if (mode === "throw") throw error;
      return Promise.reject(error);
    });
  }

  it.each([
    ["throw", false],
    ["throw", true],
    ["reject", false],
    ["reject", true],
  ] as const)(
    "retires %s invalidation and restores original mute %s without continued work",
    async (failureMode, muted) => {
      await begin(muted);
      const retiredGeneration = generation();
      const retiredPagehide = windowEvents.get("pagehide")!;
      const play = vi.spyOn(video, "play");
      invalidateMessaging(failureMode);
      mutation();
      expect(() => video.dispatchEvent(new Event("timeupdate"))).not.toThrow();
      await flush();
      expect(video.paused).toBe(true);
      expect(video.muted).toBe(muted);
      expect(waveform().disabled).toBe(true);
      expect(waveform().attributes.get("aria-pressed")).toBe("false");
      expect(waveform().attributes.get("aria-disabled")).toBe("true");
      expect(statusMessage()).toContain("Refresh this YouTube page");
      expect(statusMessage()).not.toContain("finish setup");
      expect(disconnectObserver).toHaveBeenCalledOnce();
      expect(document.removeEventListener).toHaveBeenCalledWith(
        "yt-navigate-finish",
        expect.any(Function),
      );
      expect(windowEvents.has("popstate")).toBe(false);
      expect(windowEvents.has("pagehide")).toBe(false);
      expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalledWith(
        messageHandler,
      );
      expect(globalThis.removeEventListener).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      const attempts = runtimeSend.mock.calls.length;
      mutation();
      retiredPagehide();
      waveform().click();
      video.dispatchEvent(new Event("timeupdate"));
      video.dispatchEvent(new Event("volumechange"));
      messageHandler(
        { type: "MM_READY", generation: retiredGeneration },
        { id: extensionId },
      );
      messageHandler(
        { type: "MM_PLAYBACK", generation: retiredGeneration, playing: true },
        { id: extensionId },
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await flush();
      expect(runtimeSend.mock.calls).toHaveLength(attempts);
      expect(play).not.toHaveBeenCalled();
      expect(video.muted).toBe(muted);
      expect(statusMessage()).toContain("Refresh this YouTube page");
    },
  );

  it("replaces orphaned preparing status when the first clock discovers invalidation", async () => {
    const sending = runtimeSend.getMockImplementation()!;
    runtimeSend.mockImplementation((message) => {
      if (message.type === "MM_CLOCK")
        throw new Error("Extension context invalidated");
      return sending(message);
    });
    waveform().click();
    await flush();
    expect(video.paused).toBe(true);
    expect(video.muted).toBe(false);
    expect(statusMessage()).toContain("Refresh this YouTube page");
    expect(statusMessage()).not.toContain("prepares the complete vocals");
    expect(waveform().disabled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not overwrite the refresh instruction after an invalidated Stop", async () => {
    await begin();
    expect(video.paused).toBe(false);
    invalidateMessaging("throw");
    switchAudio();
    await flush();
    expect(video.paused).toBe(true);
    expect(video.muted).toBe(false);
    expect(statusMessage()).toContain("Refresh this YouTube page");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["throw", "reject"] as const)(
    "allows retry after a transient messaging %s instead of retiring the page",
    async (failureMode) => {
      await begin();
      const retired = generation();
      runtimeSend.mockImplementationOnce(() => {
        const error = new Error(
          "Could not establish connection. Receiving end does not exist.",
        );
        if (failureMode === "throw") throw error;
        return Promise.reject(error);
      });
      expect(() => video.dispatchEvent(new Event("timeupdate"))).not.toThrow();
      await flush();
      expect(video.muted).toBe(false);
      expect(waveform().disabled).toBe(false);
      expect(statusMessage()).toContain(
        "lost the MusicMute extension connection",
      );
      expect(statusMessage()).not.toContain("Refresh");
      expect(disconnectObserver).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      waveform().click();
      await flush();
      expect(generation()).toBeGreaterThan(retired);
      messageHandler(
        { type: "MM_READY", generation: generation() },
        { id: extensionId },
      );
      playback(true);
      await flush();
      expect(video.muted).toBe(true);
      expect(waveform().attributes.get("aria-pressed")).toBe("true");
    },
  );
});

describe("movable, dismissible panel through the actual content handler", () => {
  function controlsSent(): ExtensionMessage[] {
    return sent.filter((message) => message.type !== "MM_CLOCK");
  }

  it("toggles active preparation controls and preserves dismissal through progress, READY and playback", async () => {
    expect(panel().hidden).toBe(true);
    waveform().click();
    await flush();
    const owner = generation();
    expect(panel().hidden).toBe(false);
    expect(waveform().attributes.get("aria-expanded")).toBe("true");
    expect(panelControl("musicmute-panel-audio-toggle").textContent).toBe(
      "Cancel",
    );
    const pause = vi.spyOn(video, "pause");
    const requests = controlsSent();
    waveform().click();
    expect(panel().hidden).toBe(true);
    expect(waveform().attributes.get("aria-pressed")).toBe("true");
    expect(waveform().attributes.get("aria-expanded")).toBe("false");
    messageHandler(
      {
        type: "MM_JOB",
        generation: owner,
        payload: {
          job_id: "test-job",
          video_id: "jNQXAC9IVRw",
          provider: "LOCAL_MACOS",
          state: "PROCESSING",
          stage: "separation",
          completed: 4,
          total: 10,
        },
      },
      { id: extensionId },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(panel().hidden).toBe(true);
    expect(panelControl("musicmute-panel-status").textContent).toContain("40%");
    expect(latestClock().payload.generation).toBe(owner);
    expect(controlsSent()).toEqual(requests);
    expect(pause).not.toHaveBeenCalled();
    messageHandler(
      { type: "MM_READY", generation: owner },
      { id: extensionId },
    );
    playback(true);
    await flush();
    expect(panel().hidden).toBe(true);
    expect(video.paused).toBe(false);
    expect(video.muted).toBe(true);
    expect(panelControl("musicmute-panel-audio-toggle").textContent).toBe(
      "Show original sound",
    );
    waveform().click();
    expect(panel().hidden).toBe(false);
    expect(panelControl("musicmute-panel-status").textContent).toBe(
      "Use YouTube to pause, seek and adjust volume.",
    );
    expect(generation()).toBe(owner);
    expect(sent.filter((message) => message.type === "MM_START")).toHaveLength(
      1,
    );
    expect(
      sent.some((message) => ["MM_STOP", "MM_CANCEL"].includes(message.type)),
    ).toBe(false);
  });

  it("closes ready controls without changing playback, mute, ownership or clocks", async () => {
    await begin();
    const owner = generation();
    const writes = video.muteWrites;
    const pause = vi.spyOn(video, "pause");
    const close = panelControl("musicmute-panel-close");
    expect(close.attributes.get("aria-label")).toBe("Hide MusicMute controls");
    close.click();
    expect(panel().hidden).toBe(true);
    expect(waveform().focused).toBe(true);
    expect(video.muteWrites).toBe(writes);
    await vi.advanceTimersByTimeAsync(1000);
    expect(video.muteWrites).toBe(writes);
    playback(true);
    await flush();
    expect(panel().hidden).toBe(true);
    expect(video.paused).toBe(false);
    expect(video.muted).toBe(true);
    expect(pause).not.toHaveBeenCalled();
    expect(latestClock().payload.generation).toBe(owner);
    expect(
      sent.some((message) => ["MM_STOP", "MM_CANCEL"].includes(message.type)),
    ).toBe(false);
    waveform().click();
    expect(panel().hidden).toBe(false);
    switchAudio();
    await flush();
    expect(sent).toContainEqual({ type: "MM_STOP", generation: owner });
    expect(video.muted).toBe(false);
  });

  it("handles Escape inside the panel and restores focus to the waveform", async () => {
    await begin();
    const owner = generation();
    const event = key(panel(), "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(panel().hidden).toBe(true);
    expect(waveform().focused).toBe(true);
    expect(waveform().focusOptions).toEqual({ preventScroll: true });
    expect(latestClock().payload.generation).toBe(owner);
    expect(video.paused).toBe(false);
    expect(video.muted).toBe(true);
    expect(
      sent.some((message) => ["MM_STOP", "MM_CANCEL"].includes(message.type)),
    ).toBe(false);
  });

  it("reopens a dismissed failed session when a fresh preparation starts", async () => {
    await begin();
    const previous = generation();
    panelControl("musicmute-panel-close").click();
    messageHandler(
      { type: "MM_ERROR", code: "AUDIO_DECODE_FAILED", generation: previous },
      { id: extensionId },
    );
    expect(panel().hidden).toBe(true);
    waveform().click();
    await flush();
    expect(panel().hidden).toBe(false);
    expect(generation()).toBeGreaterThan(previous);
    expect(panelControl("musicmute-panel-audio-toggle").textContent).toBe(
      "Cancel",
    );
  });

  it("waits for vocals to stop before restoring original audio or accepting another start", async () => {
    await begin();
    const sending = runtimeSend.getMockImplementation()!;
    let completeStop: ((reply: { ok: boolean }) => void) | undefined;
    runtimeSend.mockImplementation((message) => {
      if (message.type === "MM_STOP") {
        sent.push(message);
        return new Promise((resolve) => {
          completeStop = resolve;
        });
      }
      return sending(message);
    });
    const previous = generation();
    switchAudio();
    await flush();
    expect(video.muted).toBe(true);
    expect(panelControl("musicmute-panel-audio-toggle").disabled).toBe(true);
    expect(panel().hidden).toBe(false);
    expect(panelControl("musicmute-panel-title").textContent).toBe(
      "Switching audio",
    );
    switchAudio();
    waveform().click();
    await flush();
    expect(generation()).toBe(previous);
    expect(sent.filter((message) => message.type === "MM_START")).toHaveLength(
      1,
    );
    expect(sent.filter((message) => message.type === "MM_STOP")).toHaveLength(
      1,
    );
    completeStop!({ ok: true });
    await flush();
    expect(video.muted).toBe(false);
    expect(video.paused).toBe(false);
    expect(panelControl("musicmute-panel-audio-toggle").disabled).toBe(false);
    expect(panelControl("musicmute-panel-audio-toggle").textContent).toBe(
      "Remove background music",
    );
    expect(panelControl("musicmute-panel-title").textContent).toBe(
      "Original sound",
    );
    switchAudio();
    await flush();
    const successor = generation();
    expect(successor).toBeGreaterThan(previous);
    expect(panel().hidden).toBe(false);
    expect(panelControl("musicmute-panel-title").textContent).toBe(
      "Preparing vocals",
    );
    expect(panelControl("musicmute-panel-audio-toggle").textContent).toBe(
      "Cancel",
    );
    expect(latestClock().payload.generation).toBe(successor);
    expect(waveform().attributes.get("aria-pressed")).toBe("true");
  });

  it("moves and clamps the header with pointer capture, cancels dragging on hide and resets with Home", async () => {
    await begin();
    const handle = panelControl("musicmute-panel-move");
    expect(pointer(handle, "pointerdown", 330, 20).defaultPrevented).toBe(true);
    expect(handle.captures.has(1)).toBe(true);
    pointer(handle, "pointermove", 1500, 1500);
    expect(panel().style.left).toBe("336px");
    expect(panel().style.top).toBe("200px");
    expect(panel().dataset.positioned).toBe("true");
    panelControl("musicmute-panel-close").click();
    expect(handle.captures.size).toBe(0);
    const location = { ...panel().style };
    pointer(handle, "pointermove", -1000, -1000);
    expect(panel().style).toEqual(location);
    waveform().click();
    key(handle, "Home");
    expect(panel().style.left).toBe("");
    expect(panel().style.top).toBe("");
    expect(panel().style.right).toBe("");
    expect(panel().style.bottom).toBe("");
    expect(panel().dataset.positioned).toBeUndefined();
    key(handle, "ArrowLeft");
    expect(panel().style.left).toBe("316px");
    expect(panel().style.top).toBe("12px");
    expect(video.paused).toBe(false);
    expect(video.muted).toBe(true);
  });

  it("reclamps moved controls after player resize and reopening", async () => {
    await begin();
    const handle = panelControl("musicmute-panel-move");
    key(handle, "ArrowRight");
    expect(panel().style.left).toBe("332px");
    player.clientWidth = 400;
    player.clientHeight = 180;
    resizeObservers[0]!.callback();
    expect(panel().style.left).toBe("96px");
    expect(panel().style.top).toBe("12px");
    panelControl("musicmute-panel-close").click();
    player.clientWidth = 310;
    player.clientHeight = 160;
    resizeObservers[0]!.callback();
    waveform().click();
    expect(panel().style.left).toBe("6px");
    expect(panel().style.top).toBe("0px");
  });

  it("preserves hidden latest status while remounting controls and disposes the old movement handlers", async () => {
    await begin();
    const previousPanel = panel();
    const previousHandle = panelControl("musicmute-panel-move");
    const previousClose = panelControl("musicmute-panel-close");
    pointer(previousHandle, "pointerdown", 330, 20);
    previousClose.click();
    waveform().remove();
    mutation();
    await flush();
    expect(panel()).not.toBe(previousPanel);
    expect(panel().hidden).toBe(true);
    expect(resizeObservers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(previousHandle.captures.size).toBe(0);
    const previousStyle = { ...previousPanel.style };
    pointer(previousHandle, "pointermove", -1000, -1000);
    key(previousHandle, "ArrowLeft");
    expect(previousPanel.style).toEqual(previousStyle);
    waveform().click();
    expect(panel().hidden).toBe(false);
    expect(panelControl("musicmute-panel-status").textContent).toBe(
      "Use YouTube to pause, seek and adjust volume.",
    );
    previousClose.click();
    expect(panel().hidden).toBe(false);
    expect(sent.filter((message) => message.type === "MM_START")).toHaveLength(
      1,
    );
  });

  it("releases capture and movement observers when the native extension context is invalidated", async () => {
    await begin();
    const handle = panelControl("musicmute-panel-move");
    pointer(handle, "pointerdown", 330, 20);
    runtimeSend.mockImplementation(() => {
      throw new Error("Extension context invalidated.");
    });
    video.dispatchEvent(new Event("timeupdate"));
    await flush();
    expect(handle.captures.size).toBe(0);
    expect(resizeObservers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(handle.disabled).toBe(true);
    expect(panelControl("musicmute-panel-close").disabled).toBe(true);
    expect(panel().hidden).toBe(false);
    const location = { ...panel().style };
    pointer(handle, "pointermove", -1000, -1000);
    key(handle, "ArrowLeft");
    resizeObservers[0]!.callback();
    expect(panel().style).toEqual(location);
    expect(video.muted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows a single actionable invalidation notice even when the panel was dismissed", async () => {
    await begin();
    const owner = generation();
    panelControl("musicmute-panel-close").click();
    expect(panel().hidden).toBe(true);
    runtimeSend.mockRejectedValue(new Error("Extension context invalidated."));
    video.dispatchEvent(new Event("timeupdate"));
    await flush();
    expect(panel().hidden).toBe(false);
    expect(panelControl("musicmute-panel-status").textContent).toContain(
      "Refresh this YouTube page",
    );
    const attempts = runtimeSend.mock.calls.length;
    messageHandler(
      { type: "MM_READY", generation: owner },
      { id: extensionId },
    );
    playback(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtimeSend.mock.calls).toHaveLength(attempts);
    expect(panelControl("musicmute-panel-status").textContent).toContain(
      "Refresh this YouTube page",
    );
    expect(waveform().disabled).toBe(true);
    expect(video.muted).toBe(false);
    expect(video.paused).toBe(true);
  });
});

describe("playback audio toggle", () => {
  it("uses the audio toggle to switch to original sound and back to voice-only playback", async () => {
    await begin();
    const actions = panelControl("musicmute-panel-actions");
    expect(
      actions.children.filter(
        (child) => child.type === "button" && !child.hidden,
      ),
    ).toHaveLength(2);
    expect(panelControl("musicmute-panel-audio-toggle").textContent).toBe(
      "Show original sound",
    );
    const previous = generation();
    switchAudio();
    await flush();
    expect(video.muted).toBe(false);
    expect(video.paused).toBe(false);
    expect(panelControl("musicmute-panel-audio-toggle").textContent).toBe(
      "Remove background music",
    );
    expect(panelControl("musicmute-panel-title").textContent).toBe(
      "Original sound",
    );
    expect(waveform().attributes.get("aria-pressed")).toBe("false");
    switchAudio();
    await flush();
    const successor = generation();
    expect(successor).toBeGreaterThan(previous);
    expect(sent.filter((message) => message.type === "MM_START")).toHaveLength(
      2,
    );
    expect(panelControl("musicmute-panel-audio-toggle").textContent).toBe(
      "Cancel",
    );
    expect(video.paused).toBe(true);
    messageHandler(
      { type: "MM_READY", generation: previous },
      { id: extensionId },
    );
    messageHandler(
      { type: "MM_PLAYBACK", generation: previous, playing: true },
      { id: extensionId },
    );
    await flush();
    expect(video.muted).toBe(false);
    expect(video.paused).toBe(true);
    messageHandler(
      { type: "MM_READY", generation: successor },
      { id: extensionId },
    );
    playback(true);
    await flush();
    expect(video.muted).toBe(true);
    expect(video.paused).toBe(false);
    expect(panelControl("musicmute-panel-audio-toggle").textContent).toBe(
      "Show original sound",
    );
  });

  it.each([false, true])(
    "preserves a paused video and original mute %s when selecting original sound",
    async (muted) => {
      await begin(muted);
      video.pause();
      switchAudio();
      await flush();
      expect(video.paused).toBe(true);
      expect(video.muted).toBe(muted);
      expect(panelControl("musicmute-panel-audio-toggle").textContent).toBe(
        "Remove background music",
      );
    },
  );

  it("restores the old video's mute during navigation and ignores delayed stop completion", async () => {
    await begin();
    const sending = runtimeSend.getMockImplementation()!;
    let completeStop: ((reply: { ok: boolean }) => void) | undefined;
    runtimeSend.mockImplementation((message) => {
      if (message.type === "MM_STOP") {
        sent.push(message);
        return new Promise((resolve) => {
          completeStop = resolve;
        });
      }
      return sending(message);
    });
    switchAudio();
    await flush();
    const previous = video;
    video = new VideoFixture();
    video.muted = true;
    mutation();
    await flush();
    expect(previous.muted).toBe(false);
    expect(previous.paused).toBe(true);
    expect(video.muted).toBe(true);
    const writes = video.muteWrites;
    completeStop!({ ok: true });
    await flush();
    expect(video.muteWrites).toBe(writes);
    expect(panel().hidden).toBe(true);
    expect(panelControl("musicmute-panel-audio-toggle").disabled).toBe(false);
  });

  it.each(["throw", "reject"] as const)(
    "safely retires a context invalidated by a %s during the original sound switch",
    async (failureMode) => {
      await begin();
      const sending = runtimeSend.getMockImplementation()!;
      runtimeSend.mockImplementation((message) => {
        if (message.type === "MM_STOP") {
          const error = new Error("Extension context invalidated.");
          if (failureMode === "throw") throw error;
          return Promise.reject(error);
        }
        return sending(message);
      });
      switchAudio();
      await flush();
      expect(video.paused).toBe(true);
      expect(video.muted).toBe(false);
      expect(waveform().disabled).toBe(true);
      expect(panelControl("musicmute-panel-audio-toggle").hidden).toBe(true);
      expect(panelControl("musicmute-panel-audio-toggle").disabled).toBe(true);
      expect(panelControl("musicmute-panel-stop").hidden).toBe(true);
      expect(panelControl("musicmute-panel-stop").disabled).toBe(true);
      expect(panelControl("musicmute-panel-title").textContent).toBe(
        "Refresh YouTube",
      );
    },
  );
});

describe("Stop MusicMute and dismiss controls", () => {
  it.each([
    ["preparing", false],
    ["preparing", true],
    ["ready", false],
    ["ready", true],
    ["original", false],
    ["original", true],
  ] as const)(
    "stops %s with original mute %s and restarts from the waveform",
    async (state, muted) => {
      if (state === "preparing") {
        video.muted = muted;
        await flush();
        waveform().click();
        await flush();
      } else {
        await begin(muted);
        if (state === "original") {
          switchAudio();
          await flush();
        }
      }
      const owner = generation();
      const previousCommands = sent.filter((message) =>
        ["MM_STOP", "MM_CANCEL"].includes(message.type),
      ).length;
      const stop = panelControl("musicmute-panel-stop");
      expect(stop.textContent).toBe("Stop");
      expect(stop.attributes.get("aria-label")).toBe("Stop MusicMute");
      stopMusicMute();
      expect(panel().hidden).toBe(true);
      expect(waveform().attributes.get("aria-pressed")).toBe("false");
      expect(waveform().attributes.get("aria-expanded")).toBe("false");
      expect(waveform().focused).toBe(true);
      await flush();
      expect(video.muted).toBe(muted);
      if (state !== "original")
        expect(sent).toContainEqual({
          type: state === "preparing" ? "MM_CANCEL" : "MM_STOP",
          generation: owner,
        });
      else
        expect(
          sent.filter((message) =>
            ["MM_STOP", "MM_CANCEL"].includes(message.type),
          ),
        ).toHaveLength(previousCommands);
      messageHandler(
        { type: "MM_READY", generation: owner },
        { id: extensionId },
      );
      messageHandler(
        { type: "MM_PLAYBACK", generation: owner, playing: true },
        { id: extensionId },
      );
      const clockCount = sent.filter(
        (message) => message.type === "MM_CLOCK",
      ).length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(panel().hidden).toBe(true);
      expect(video.muted).toBe(muted);
      expect(
        sent.filter((message) => message.type === "MM_CLOCK"),
      ).toHaveLength(clockCount);
      waveform().click();
      await flush();
      expect(panel().hidden).toBe(false);
      expect(generation()).toBeGreaterThan(owner);
      expect(panelControl("musicmute-panel-audio-toggle").textContent).toBe(
        "Cancel",
      );
      messageHandler(
        { type: "MM_READY", generation: generation() },
        { id: extensionId },
      );
      playback(true);
      await flush();
      expect(panel().hidden).toBe(false);
      expect(video.muted).toBe(true);
    },
  );

  it.each([false, true])(
    "keeps Stop dismissal through a delayed %s sound switch acknowledgement",
    async (switching) => {
      await begin();
      const sending = runtimeSend.getMockImplementation()!;
      let completeStop: ((reply: { ok: boolean }) => void) | undefined;
      runtimeSend.mockImplementation((message) => {
        if (message.type === "MM_STOP") {
          sent.push(message);
          return new Promise((resolve) => {
            completeStop = resolve;
          });
        }
        return sending(message);
      });
      if (switching) {
        switchAudio();
        await flush();
        expect(panelControl("musicmute-panel-audio-toggle").disabled).toBe(
          true,
        );
        expect(panelControl("musicmute-panel-stop").disabled).toBe(false);
      }
      stopMusicMute();
      await flush();
      expect(panel().hidden).toBe(true);
      expect(video.muted).toBe(true);
      stopMusicMute();
      waveform().click();
      await flush();
      expect(sent.filter((message) => message.type === "MM_STOP")).toHaveLength(
        1,
      );
      expect(
        sent.filter((message) => message.type === "MM_START"),
      ).toHaveLength(1);
      completeStop!({ ok: true });
      await flush();
      expect(video.muted).toBe(false);
      expect(panel().hidden).toBe(true);
      waveform().remove();
      mutation();
      await flush();
      expect(panel().hidden).toBe(true);
      waveform().click();
      await flush();
      expect(panel().hidden).toBe(false);
      expect(
        sent.filter((message) => message.type === "MM_START"),
      ).toHaveLength(2);
    },
  );

  it("keeps the dialog hidden after a Stop transport failure and permits icon retry", async () => {
    await begin();
    const sending = runtimeSend.getMockImplementation()!;
    runtimeSend.mockImplementation((message) =>
      message.type === "MM_STOP"
        ? Promise.resolve({ ok: false, error: "EXTENSION_CONNECTION_LOST" })
        : sending(message),
    );
    stopMusicMute();
    await flush();
    expect(panel().hidden).toBe(true);
    expect(video.muted).toBe(false);
    expect(video.paused).toBe(true);
    expect(waveform().attributes.get("aria-pressed")).toBe("false");
    waveform().click();
    await flush();
    expect(panel().hidden).toBe(false);
    expect(panelControl("musicmute-panel-audio-toggle").textContent).toBe(
      "Cancel",
    );
  });

  it("does not let a removed Stop control affect a remounted active session", async () => {
    await begin();
    const previousStop = panelControl("musicmute-panel-stop");
    waveform().remove();
    mutation();
    await flush();
    expect(panelControl("musicmute-panel-stop")).not.toBe(previousStop);
    previousStop.click();
    await flush();
    expect(panel().hidden).toBe(false);
    expect(video.muted).toBe(true);
    expect(
      sent.some((message) => ["MM_STOP", "MM_CANCEL"].includes(message.type)),
    ).toBe(false);
  });
});

describe("retired playback sessions through the actual content handler", () => {
  it.each([false, true])(
    "ignores READY and PLAYBACK after Stop with original mute %s",
    async (muted) => {
      await begin(muted);
      const retired = generation();
      switchAudio();
      await flush();
      video.paused = true;
      const play = vi.spyOn(video, "play");
      messageHandler(
        { type: "MM_READY", generation: retired },
        { id: extensionId },
      );
      messageHandler(
        { type: "MM_PLAYBACK", generation: retired, playing: true },
        { id: extensionId },
      );
      await flush();
      expect(play).not.toHaveBeenCalled();
      expect(video.paused).toBe(true);
      expect(video.muted).toBe(muted);
      expect(waveform().attributes.get("aria-pressed")).toBe("false");
      expect(sent).toContainEqual({ type: "MM_STOP", generation: retired });
    },
  );

  it("ignores READY after Cancel and lets a new generation prepare normally", async () => {
    waveform().click();
    await flush();
    const retired = generation();
    switchAudio();
    await flush();
    const play = vi.spyOn(video, "play");
    messageHandler(
      { type: "MM_READY", generation: retired },
      { id: extensionId },
    );
    await flush();
    expect(play).not.toHaveBeenCalled();
    expect(waveform().attributes.get("aria-pressed")).toBe("false");
    expect(sent).toContainEqual({ type: "MM_CANCEL", generation: retired });
    waveform().click();
    await flush();
    expect(generation()).toBeGreaterThan(retired);
    messageHandler(
      { type: "MM_READY", generation: generation() },
      { id: extensionId },
    );
    playback(true);
    await flush();
    expect(video.muted).toBe(true);
    expect(waveform().attributes.get("aria-pressed")).toBe("true");
  });

  it.each(["preparing", "ready"])(
    "fences READY after a same-ID video element replacement while %s",
    async (state) => {
      if (state === "ready") await begin();
      else {
        waveform().click();
        await flush();
      }
      const retired = generation();
      const previous = video;
      video = new VideoFixture();
      video.muted = true;
      video.paused = true;
      const play = vi.spyOn(video, "play");
      mutation();
      await flush();
      messageHandler(
        { type: "MM_READY", generation: retired },
        { id: extensionId },
      );
      messageHandler(
        { type: "MM_PLAYBACK", generation: retired, playing: true },
        { id: extensionId },
      );
      await flush();
      expect(previous.muted).toBe(false);
      expect(video.muted).toBe(true);
      expect(play).not.toHaveBeenCalled();
      expect(waveform().attributes.get("aria-pressed")).toBe("false");
      expect(sent).toContainEqual({
        type: state === "ready" ? "MM_STOP" : "MM_CANCEL",
        generation: retired,
        reason: "navigation",
      });
    },
  );

  it("fences READY after pagehide and preserves the retired stop generation", async () => {
    await begin();
    const retired = generation();
    windowEvents.get("pagehide")?.();
    await flush();
    video.paused = true;
    messageHandler(
      { type: "MM_READY", generation: retired },
      { id: extensionId },
    );
    await flush();
    expect(video.paused).toBe(true);
    expect(video.muted).toBe(false);
    expect(sent).toContainEqual({
      type: "MM_STOP",
      generation: retired,
      reason: "pagehide",
    });
    expect(waveform().attributes.get("aria-pressed")).toBe("false");
  });

  it.each([false, true])(
    "restores original mute %s when background ownership is lost",
    async (muted) => {
      await begin(muted);
      clockReply = { ok: false };
      video.dispatchEvent(new Event("timeupdate"));
      await flush();
      expect(video.paused).toBe(true);
      expect(video.muted).toBe(muted);
      expect(waveform().attributes.get("aria-pressed")).toBe("false");
      const panel = player.children.find(
        (child) => child.id === "musicmute-local-panel",
      );
      expect(
        panel?.children.find(
          (child) => child.className === "musicmute-panel-status",
        )?.textContent,
      ).toContain("Original audio restored");
    },
  );

  it("does not mistake a pending START handoff for lost ownership", async () => {
    deferStarts = true;
    clockReply = { ok: false };
    waveform().click();
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(waveform().attributes.get("aria-pressed")).toBe("true");
    expect(sent.some((message) => message.type === "MM_CANCEL")).toBe(false);
    clockReply = { ok: true };
    for (const resolve of heldStarts.splice(0)) resolve({ ok: true });
    await flush();
    messageHandler(
      { type: "MM_READY", generation: generation() },
      { id: extensionId },
    );
    playback(true);
    await flush();
    expect(video.muted).toBe(true);
  });

  it("skips transient invalid media clocks while START is pending and resumes the sequence", async () => {
    deferStarts = true;
    const sending = runtimeSend.getMockImplementation()!;
    runtimeSend.mockImplementation((message) => {
      if (message.type === "MM_CLOCK" && !isMediaClock(message.payload)) {
        sent.push(message);
        return Promise.resolve({ ok: false, error: "INVALID_MESSAGE" });
      }
      return sending(message);
    });
    waveform().click();
    await flush();

    video.currentTime = NaN;
    video.duration = Infinity;
    video.playbackRate = NaN;
    video.dispatchEvent(new Event("durationchange"));
    await flush();
    await vi.advanceTimersByTimeAsync(250);

    expect(sent.filter((message) => message.type === "MM_CLOCK")).toHaveLength(
      0,
    );
    expect(panel().dataset.state).toBe("preparing");
    expect(panelControl("musicmute-panel-title").textContent).toBe(
      "Preparing vocals",
    );
    expect(waveform().attributes.get("aria-pressed")).toBe("true");

    video.currentTime = 3;
    video.duration = 19;
    video.playbackRate = 1;
    video.dispatchEvent(new Event("loadedmetadata"));
    await flush();

    expect(latestClock().payload.sequence).toBe(1);
    expect(isMediaClock(latestClock().payload)).toBe(true);
    expect(panel().dataset.state).toBe("preparing");
    expect(panelControl("musicmute-panel-status").textContent).not.toContain(
      "INVALID_MESSAGE",
    );

    for (const resolve of heldStarts.splice(0)) resolve({ ok: true });
    await flush();
  });

  it("fails safely on ownership loss after START acceptance during preparation", async () => {
    waveform().click();
    await flush();
    clockReply = { ok: false };
    await vi.advanceTimersByTimeAsync(250);
    expect(waveform().attributes.get("aria-pressed")).toBe("false");
    expect(video.muted).toBe(false);
    expect(video.paused).toBe(true);
  });

  it.each([false, true])(
    "preserves a mute change from %s during preparation through playback and Stop",
    async (muted) => {
      video.muted = muted;
      await flush();
      waveform().click();
      await flush();
      video.muted = !muted;
      await flush();
      expect(latestClock().payload.user_muted).toBe(!muted);
      messageHandler(
        { type: "MM_READY", generation: generation() },
        { id: extensionId },
      );
      playback(true);
      await flush();
      expect(latestClock().payload.user_muted).toBe(!muted);
      switchAudio();
      await flush();
      expect(video.muted).toBe(!muted);
    },
  );

  it("keeps YouTube's mute preference when only volume changes before first playback", async () => {
    waveform().click();
    await flush();
    messageHandler(
      { type: "MM_READY", generation: generation() },
      { id: extensionId },
    );
    video.muted = true;
    await flush();
    video.volume = 0.4;
    video.dispatchEvent(new Event("volumechange"));
    await flush();
    expect(latestClock().payload.user_muted).toBe(true);
    expect(latestClock().payload.volume).toBe(0.4);
    playback(true);
    await flush();
    switchAudio();
    await flush();
    expect(video.muted).toBe(true);
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("original audio ownership during ads in the actual content handler", () => {
  it("keeps original audio muted until the ad pause is acknowledged, then remutes before resuming vocals", async () => {
    await begin();
    deferAdClocks = true;
    await changeAd(true);
    expect(video.muted).toBe(true);
    expect(clockMute.at(-1)).toEqual({ ad: true, muted: true });
    await releaseClocks();
    expect(video.muted).toBe(false);
    expect(
      player.children.find((child) => child.id === "musicmute-local-panel")
        ?.dataset.state,
    ).toBe("waiting");
    await changeAd(false);
    expect(clockMute.at(-1)).toEqual({ ad: false, muted: true });
    playback(true);
    await flush();
    expect(video.muted).toBe(true);
    switchAudio();
    await flush();
    expect(video.muted).toBe(false);
  });

  it("does not mistake an older paused notification for the current ad clock acknowledgement", async () => {
    await begin();
    deferAdClocks = true;
    await changeAd(true);
    playback(false);
    await flush();
    expect(video.muted).toBe(true);
    await releaseClocks();
    expect(video.muted).toBe(false);
  });

  it("does not release mute for ordinary pause or buffering", async () => {
    await begin();
    playback(false);
    video.dispatchEvent(new Event("waiting"));
    await flush();
    expect(video.muted).toBe(true);
    expect(clockMute.at(-1)).toEqual({ ad: false, muted: true });
    switchAudio();
    await flush();
    expect(video.muted).toBe(false);
  });

  it("preserves a previously muted original through ads and stop", async () => {
    await begin(true);
    await changeAd(true);
    expect(video.muted).toBe(true);
    await changeAd(false);
    switchAudio();
    await flush();
    expect(video.muted).toBe(true);
  });

  it.each([false, true])(
    "preserves a manual ad mute change from %s through the next playback and stop",
    async (originalMuted) => {
      await begin(originalMuted);
      await changeAd(true);
      expect(video.muted).toBe(originalMuted);
      video.muted = !originalMuted;
      await flush();
      await changeAd(false);
      playback(true);
      await flush();
      expect(video.muted).toBe(true);
      switchAudio();
      await flush();
      expect(video.muted).toBe(!originalMuted);
    },
  );

  it("preserves a manual ad mute change when playback fails", async () => {
    await begin();
    await changeAd(true);
    video.muted = true;
    await flush();
    await changeAd(false);
    messageHandler(
      {
        type: "MM_ERROR",
        code: "AUDIO_DECODE_FAILED",
        generation: generation(),
      },
      { id: extensionId },
    );
    await flush();
    expect(video.muted).toBe(true);
    expect(video.paused).toBe(true);
  });

  it("ignores a delayed ad acknowledgement after the main video returns", async () => {
    await begin();
    deferAdClocks = true;
    await changeAd(true);
    await changeAd(false);
    await releaseClocks();
    expect(video.muted).toBe(true);
  });

  it("does not release a second ad from the first ad's delayed acknowledgement", async () => {
    await begin();
    deferAdClocks = true;
    await changeAd(true);
    const firstAdClocks = heldClocks.splice(0);
    await changeAd(false);
    await changeAd(true);
    for (const release of firstAdClocks) release();
    await flush();
    expect(video.muted).toBe(true);
    await releaseClocks();
    expect(video.muted).toBe(false);
  });

  it("restores the ready guidance when the ad ends with the video paused", async () => {
    await begin();
    await changeAd(true);
    video.paused = true;
    await changeAd(false);
    const panel = player.children.find(
      (child) => child.id === "musicmute-local-panel",
    );
    expect(panel?.dataset.state).toBe("ready");
    expect(
      panel?.children.find(
        (child) => child.className === "musicmute-panel-status",
      )?.textContent,
    ).toContain("Play the video");
    expect(video.muted).toBe(true);
  });

  it("retains the existing original mute recovery after a manual main-video unmute", async () => {
    await begin(true);
    video.muted = false;
    await flush();
    expect(video.muted).toBe(true);
    switchAudio();
    await flush();
    expect(video.muted).toBe(false);
  });

  it("ignores delayed ad acknowledgements and playback after stop", async () => {
    await begin();
    deferAdClocks = true;
    await changeAd(true);
    switchAudio();
    await flush();
    expect(video.muted).toBe(false);
    video.muted = true;
    await releaseClocks();
    playback(true);
    await flush();
    expect(video.muted).toBe(true);
    expect(waveform().attributes.get("aria-pressed")).toBe("false");
  });

  it("does not let an old ad acknowledgement change a replacement video's mute preference", async () => {
    await begin();
    deferAdClocks = true;
    await changeAd(true);
    const previous = video;
    video = new VideoFixture();
    video.muted = true;
    mutation();
    await flush();
    await releaseClocks();
    expect(previous.muted).toBe(false);
    expect(video.muted).toBe(true);
    expect(waveform().attributes.get("aria-pressed")).toBe("false");
  });

  it("does not remute an ad on a delayed playing notification", async () => {
    await begin();
    await changeAd(true);
    expect(video.muted).toBe(false);
    playback(true);
    await flush();
    expect(video.muted).toBe(false);
  });

  it("does not rewrite mute or status on every ad clock", async () => {
    await begin();
    await changeAd(true);
    const writes = video.muteWrites;
    await vi.advanceTimersByTimeAsync(1000);
    expect(video.muted).toBe(false);
    expect(video.muteWrites).toBe(writes);
  });
});

describe("production user controls and manual navigation", () => {
  it("handles YouTube's mute button before the forced muted flag loses intent", async () => {
    await begin();
    const target = new ElementFixture();
    target.closest = (selector) =>
      selector === ".ytp-mute-button" ? target : null;
    for (const expected of [true, false, true]) {
      const event = new Event("click", { cancelable: true });
      Object.defineProperty(event, "target", { value: target });
      player.dispatchEvent(event);
      await flush();
      expect(event.defaultPrevented).toBe(true);
      expect(latestClock().payload.user_muted).toBe(expected);
      expect(video.muted).toBe(true);
    }
  });
  it("handles M outside text inputs, retaining native ad mute behavior", async () => {
    await begin();
    const dispatch = (patch: Record<string, unknown> = {}) => {
      const { target, ...keys } = patch;
      const event = Object.assign(new Event("keydown", { cancelable: true }), {
        key: "m",
        ...keys,
      });
      if (target) Object.defineProperty(event, "target", { value: target });
      for (const listener of documentEvents.get("keydown") ?? [])
        listener(event);
      return event;
    };
    expect(dispatch().defaultPrevented).toBe(true);
    expect(latestClock().payload.user_muted).toBe(true);
    expect(dispatch({ ctrlKey: true }).defaultPrevented).toBe(false);
    const input = new ElementFixture();
    input.closest = () => input;
    expect(dispatch({ target: input }).defaultPrevented).toBe(false);
    await changeAd(true);
    expect(dispatch().defaultPrevented).toBe(false);
  });
  it("waits for fresh incoming metadata on manual start", async () => {
    documentEvent("yt-navigate-start");
    location.href = "https://www.youtube.com/watch?v=BaW_jenozKc";
    watch.setAttribute("video-id", "BaW_jenozKc");
    documentEvent("yt-navigate-finish");
    await flush();
    waveform().click();
    await flush();
    expect(sent.filter((m) => m.type === "MM_START")).toHaveLength(0);
    video.currentSrc = "blob:next-main-video";
    documentEvent("loadedmetadata", video);
    await flush();
    waveform().click();
    await flush();
    expect(sent.filter((m) => m.type === "MM_START")).toHaveLength(1);
  });
  it("has no periodic clock while idle or after Stop", async () => {
    expect(vi.getTimerCount()).toBe(0);
    await begin();
    expect(vi.getTimerCount()).toBe(1);
    stopMusicMute();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });
});

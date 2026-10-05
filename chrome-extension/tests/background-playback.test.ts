import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  JobSnapshot,
  MediaClock,
  NativeCommand,
  NativeReply,
  NativeCapability,
} from "../src/shared/protocol";
import type {
  ExtensionMessage,
  ExtensionStatus,
} from "../src/extension/messages";
import { SETTINGS_KEY } from "../src/extension/settings";

const extensionId = "musicmute-test-extension";
type MessageHandler = (
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
  respond: (response: unknown) => void,
) => unknown;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}
function mockPort() {
  const messages: ((reply: unknown) => void)[] = [];
  const disconnects: (() => void)[] = [];
  const posted: NativeCommand[] = [];
  let acknowledgeCancel = true;
  let acknowledgeStatus = true;
  let current: JobSnapshot | null = null;
  const port = {
    onMessage: {
      addListener: (callback: (reply: unknown) => void) =>
        messages.push(callback),
    },
    onDisconnect: {
      addListener: (callback: () => void) => disconnects.push(callback),
    },
    postMessage: (command: NativeCommand) => {
      posted.push(command);
      if (command.type === "STATUS" && acknowledgeStatus)
        void Promise.resolve().then(() => {
          for (const callback of messages)
            callback({
              protocol_version: 1,
              request_id: command.request_id,
              type: "JOB",
              payload: current,
            } satisfies NativeReply);
        });
      if (command.type === "CANCEL" && acknowledgeCancel)
        void Promise.resolve().then(() => {
          current = null;
          for (const callback of messages)
            callback({
              protocol_version: 1,
              request_id: command.request_id,
              type: "JOB",
              payload: null,
            } satisfies NativeReply);
        });
    },
    disconnect: vi.fn(() => {
      for (const callback of disconnects) callback();
    }),
  } as unknown as chrome.runtime.Port;
  return {
    port,
    posted,
    holdCancelReply() {
      acknowledgeCancel = false;
    },
    holdStatusReply() {
      acknowledgeStatus = false;
    },
    current: () => current,
    emit(reply: NativeReply) {
      if (reply.type === "JOB") current = reply.payload;
      for (const callback of messages) callback(reply);
    },
    disconnect() {
      for (const callback of disconnects) callback();
    },
  };
}
let listener: MessageHandler;
let onTabRemoved: ((tabId: number) => void) | undefined;
let ports: ReturnType<typeof mockPort>[];
let stored: Record<string, unknown>;
const runtimeSend = vi.fn<(message: ExtensionMessage) => Promise<unknown>>();
const hasDocument = vi.fn<() => Promise<boolean>>();
const getTab = vi.fn<(tabId: number) => Promise<chrome.tabs.Tab>>();
function sender(tabId: number, videoId: string): chrome.runtime.MessageSender {
  return {
    id: extensionId,
    tab: { id: tabId, active: true } as chrome.tabs.Tab,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}
const offscreenSender = {
  id: extensionId,
  url: `chrome-extension://${extensionId}/offscreen.html`,
};
function request(
  message: ExtensionMessage,
  from: chrome.runtime.MessageSender = offscreenSender,
): Promise<unknown> {
  return new Promise((resolve) => {
    expect(listener(message, from, resolve)).toBe(true);
  });
}
async function flush(): Promise<void> {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}
async function start(
  tabId: number,
  generation: number,
  videoId = "abcdefghijk",
  from = sender(tabId, videoId),
  capabilities: NativeCapability[] = [],
): Promise<JobSnapshot> {
  const result = request(
    {
      type: "MM_START",
      generation,
      payload: {
        video_id: videoId,
        duration_seconds: 19,
        provider: "LOCAL_MACOS",
      },
    },
    from,
  );
  await flush();
  const port = ports.at(-1)!;
  const hello = port.posted.findLast((command) => command.type === "HELLO");
  if (!port.posted.some((command) => command.type === "START")) {
    expect(hello).toBeDefined();
    port.emit({
      protocol_version: 1,
      request_id: hello!.request_id,
      type: "HELLO",
      payload: {
        ready: true,
        version: "0.1.0",
        platform: "darwin",
        arch: "arm64",
        max_duration_seconds: 900,
        ...(capabilities.length
          ? {
              capabilities: capabilities.filter(
                (capability) => capability !== "background_publication_v1",
              ),
              ...(capabilities.includes("background_publication_v1")
                ? { background_publication_supported: true }
                : {}),
            }
          : {}),
      },
    });
    await flush();
    if (capabilities.length) {
      const negotiated = port.posted.findLast(
        (command) => command.type === "HELLO",
      )!;
      expect(negotiated.payload).toEqual({ capabilities });
      port.emit({
        protocol_version: 1,
        request_id: negotiated.request_id,
        type: "HELLO",
        payload: {
          ready: true,
          version: "0.1.0",
          platform: "darwin",
          arch: "arm64",
          max_duration_seconds: 900,
          capabilities,
          ...(capabilities.includes("background_publication_v1")
            ? { background_publication_supported: true }
            : {}),
        },
      });
      await flush();
    }
  }
  const command = port.posted.findLast((command) => command.type === "START");
  expect(command?.type).toBe("START");
  const snapshot: JobSnapshot = {
    job_id: crypto.randomUUID(),
    video_id: videoId,
    provider: "LOCAL_MACOS",
    state: "READY",
    stage: "ready",
    media: {
      url: "http://127.0.0.1:12345/media/fixture?capability=private-fixture",
      duration_seconds: 19,
      trim_enabled: false,
      model_id: "fixture",
    },
  };
  port.emit({
    protocol_version: 1,
    request_id: command!.request_id,
    type: "JOB",
    payload: snapshot,
  });
  expect(await result).toEqual({ ok: true });
  await flush();
  return snapshot;
}
function clock(generation: number, videoId = "abcdefghijk"): MediaClock {
  return {
    video_id: videoId,
    generation,
    sequence: 1,
    current_time: 2,
    duration_seconds: 19,
    playback_rate: 1,
    paused: false,
    seeking: false,
    ended: false,
    buffering: false,
    ad_active: false,
    volume: 0.8,
    user_muted: false,
    sampled_at_ms: Date.now(),
  };
}
function loadedGenerations(): number[] {
  return runtimeSend.mock.calls.flatMap(([message]) =>
    message.type === "MM_AUDIO_LOAD" ? [message.generation] : [],
  );
}
function stoppedAudioCount(): number {
  return runtimeSend.mock.calls.filter(
    ([message]) => message.type === "MM_AUDIO_STOP",
  ).length;
}
function errors(): unknown[] {
  return (
    (stored.musicmute_local_errors ?? []) as {
      code?: string;
      severity?: string;
    }[]
  )
    .filter((event) => event.severity === "error")
    .map((event) => event.code);
}
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  ports = [];
  stored = {};
  onTabRemoved = undefined;
  runtimeSend.mockReset().mockResolvedValue({ ok: true });
  hasDocument.mockReset().mockResolvedValue(true);
  getTab.mockReset().mockImplementation(
    async (tabId) =>
      ({
        id: tabId,
        active: true,
      }) as chrome.tabs.Tab,
  );
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("chrome", {
    runtime: {
      id: extensionId,
      getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
      connectNative: vi.fn(() => {
        const port = mockPort();
        ports.push(port);
        return port.port;
      }),
      onMessage: {
        addListener: (callback: MessageHandler) => {
          listener = callback;
        },
      },
      sendMessage: runtimeSend,
    },
    offscreen: {
      hasDocument,
      createDocument: vi.fn(async () => undefined),
      Reason: { AUDIO_PLAYBACK: "AUDIO_PLAYBACK" },
    },
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) =>
          Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).map((key) => [
              key,
              stored[key],
            ]),
          ),
        ),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(stored, values);
        }),
      },
    },
    tabs: {
      get: getTab,
      sendMessage: vi.fn(async () => undefined),
      onRemoved: {
        addListener: vi.fn((callback: (tabId: number) => void) => {
          onTabRemoved = callback;
        }),
      },
    },
  });
  await import("../src/extension/background");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function enableAutoStart(maxDurationMinutes = 10): void {
  Object.assign(stored, {
    [SETTINGS_KEY]: { version: 1 },
    [`${SETTINGS_KEY}.autoStartEnabled`]: true,
    [`${SETTINGS_KEY}.maxDurationMinutes`]: maxDurationMinutes,
  });
}
function automaticStart(
  tabId = 17,
  generation = 1,
  durationSeconds = 19,
  videoId = "abcdefghijk",
  from = sender(tabId, videoId),
): Promise<unknown> {
  return request(
    {
      type: "MM_START",
      generation,
      intent: "automatic",
      payload: {
        video_id: videoId,
        duration_seconds: durationSeconds,
        provider: "LOCAL_MACOS",
      },
    },
    from,
  );
}
function documentSender(documentId: string, generationVideo = "abcdefghijk") {
  return {
    ...sender(17, generationVideo),
    documentId,
    documentLifecycle: "active",
  } satisfies chrome.runtime.MessageSender;
}
function manualStart(generation: number, from: chrome.runtime.MessageSender) {
  return request(
    {
      type: "MM_START",
      intent: "manual",
      generation,
      payload: {
        video_id: "abcdefghijk",
        duration_seconds: 19,
        provider: "LOCAL_MACOS",
      },
    },
    from,
  );
}
async function completeAdmission(
  result: Promise<unknown>,
  videoId = "abcdefghijk",
  state: JobSnapshot["state"] = "DOWNLOADING",
): Promise<JobSnapshot> {
  await flush();
  const port = ports.at(-1)!;
  if (
    port.posted.at(-1)?.type === "STATUS" &&
    port.current()?.state === "READY"
  ) {
    expect(await result).toEqual({ ok: true });
    return port.current()!;
  }
  const hello = port.posted.findLast((command) => command.type === "HELLO");
  if (!port.posted.some((command) => command.type === "START")) {
    expect(hello).toBeDefined();
    port.emit({
      protocol_version: 1,
      request_id: hello!.request_id,
      type: "HELLO",
      payload: {
        ready: true,
        version: "0.1.0",
        platform: "darwin",
        arch: "arm64",
        max_duration_seconds: 900,
      },
    });
    await flush();
  }
  const command = port.posted.findLast((command) => command.type === "START");
  expect(command?.type).toBe("START");
  const snapshot: JobSnapshot = {
    job_id: crypto.randomUUID(),
    video_id: videoId,
    provider: "LOCAL_MACOS",
    state,
    stage: state.toLowerCase(),
  };
  port.emit({
    protocol_version: 1,
    request_id: command!.request_id,
    type: "JOB",
    payload: snapshot,
  });
  expect(await result).toEqual({ ok: true });
  await flush();
  return snapshot;
}

describe("bounded local reload reuse", () => {
  it.each([false, true])(
    "reuses READY on the same port after pagehide (stop settled=%s)",
    async (settled) => {
      enableAutoStart();
      const oldPage = documentSender("old"),
        next = documentSender("next");
      const snapshot = await start(17, 1, "abcdefghijk", oldPage);
      const port = ports[0]!;
      const silence = deferred<unknown>();
      runtimeSend.mockImplementationOnce(() => silence.promise);
      const stopped = request(
        { type: "MM_STOP", generation: 1, reason: "pagehide" },
        oldPage,
      );
      if (settled) {
        silence.resolve({ ok: true });
        await stopped;
      }
      const resumed = automaticStart(17, 2, 19, "abcdefghijk", next);
      await flush();
      if (!settled) {
        expect(
          port.posted.filter((item) => item.type === "STATUS"),
        ).toHaveLength(0);
        silence.resolve({ ok: true });
      }
      expect(await resumed).toEqual({ ok: true });
      expect(await stopped).toEqual({ ok: true });
      expect(ports).toHaveLength(1);
      expect(port.port.disconnect).not.toHaveBeenCalled();
      expect(port.posted.filter((item) => item.type === "START")).toHaveLength(
        1,
      );
      expect(port.posted.filter((item) => item.type === "CANCEL")).toHaveLength(
        0,
      );
      expect(port.posted.filter((item) => item.type === "HELLO")).toHaveLength(
        1,
      );
      expect(loadedGenerations()).toEqual([1, 2]);
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        17,
        expect.objectContaining({
          type: "MM_JOB",
          generation: 2,
          payload: expect.objectContaining({ job_id: snapshot.job_id }),
        }),
        { documentId: "next" },
      );
      expect(
        await request({ type: "MM_CLOCK", payload: clock(2) }, next),
      ).toEqual({ ok: true });
      for (const type of ["MM_STOP", "MM_CANCEL"] as const)
        expect(await request({ type, generation: 1 }, oldPage)).toEqual({
          ok: false,
        });
      expect(
        await request({ type: "MM_CLOCK", payload: clock(1) }, oldPage),
      ).toEqual({ ok: false });
      expect(await automaticStart(17, 3, 19, "abcdefghijk", oldPage)).toEqual({
        ok: false,
        error: "AUTO_START_BUSY",
      });
      await vi.advanceTimersByTimeAsync(5001);
      expect(port.port.disconnect).not.toHaveBeenCalled();
    },
  );

  it("rebinds same-document SPA generations repeatedly within the grace period", async () => {
    enableAutoStart();
    const page = documentSender("same");
    await start(17, 1, "abcdefghijk", page);
    for (const generation of [2, 3, 4]) {
      await request(
        { type: "MM_STOP", generation: generation - 1, reason: "navigation" },
        page,
      );
      expect(
        await automaticStart(17, generation, 19, "abcdefghijk", page),
      ).toEqual({ ok: true });
    }
    expect(ports).toHaveLength(1);
    expect(
      ports[0]!.posted.filter((item) => item.type === "START"),
    ).toHaveLength(1);
    expect(
      ports[0]!.posted.filter((item) => item.type === "CANCEL"),
    ).toHaveLength(0);
    expect(loadedGenerations()).toEqual([1, 2, 3, 4]);
  });

  it("rejects inactive successor documents without consuming the retained grant", async () => {
    enableAutoStart();
    const oldPage = documentSender("old");
    await start(17, 1, "abcdefghijk", oldPage);
    await request(
      { type: "MM_STOP", generation: 1, reason: "pagehide" },
      oldPage,
    );
    expect(
      await automaticStart(17, 2, 19, "abcdefghijk", {
        ...documentSender("next"),
        documentLifecycle: "cached",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await automaticStart(17, 2, 19, "abcdefghijk", documentSender("next")),
    ).toEqual({ ok: true });
    expect(
      ports[0]!.posted.filter((item) => item.type === "START"),
    ).toHaveLength(1);
  });

  it("expires once and opens a new port for a later request", async () => {
    enableAutoStart();
    const oldPage = documentSender("old");
    const snapshot = await start(17, 1, "abcdefghijk", oldPage);
    const port = ports[0]!;
    await request(
      { type: "MM_STOP", generation: 1, reason: "pagehide" },
      oldPage,
    );
    await vi.advanceTimersByTimeAsync(4999);
    expect(port.port.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(port.posted.filter((item) => item.type === "CANCEL")).toEqual([
      expect.objectContaining({ payload: { job_id: snapshot.job_id } }),
    ]);
    expect(port.port.disconnect).toHaveBeenCalledTimes(1);
    await completeAdmission(
      automaticStart(17, 2, 19, "abcdefghijk", documentSender("next")),
    );
    expect(ports).toHaveLength(2);
  });

  it.each(["video", "duration"])(
    "releases the old grant before START for a different %s",
    async (difference) => {
      enableAutoStart();
      const oldPage = documentSender("old");
      await start(17, 1, "abcdefghijk", oldPage);
      const port = ports[0]!;
      await request(
        { type: "MM_STOP", generation: 1, reason: "pagehide" },
        oldPage,
      );
      port.holdCancelReply();
      const video = difference === "video" ? "11111111111" : "abcdefghijk";
      const next = documentSender("next", video);
      const resumed = automaticStart(
        17,
        2,
        difference === "duration" ? 22 : 19,
        video,
        next,
      );
      await flush();
      expect(port.posted.filter((item) => item.type === "START")).toHaveLength(
        1,
      );
      const cancel = port.posted.findLast((item) => item.type === "CANCEL")!;
      expect(cancel).toBeDefined();
      port.emit({
        protocol_version: 1,
        request_id: cancel.request_id,
        type: "JOB",
        payload: null,
      });
      await completeAdmission(resumed, video);
      expect(ports).toHaveLength(1);
      expect(
        port.posted
          .filter((item) => ["START", "CANCEL"].includes(item.type))
          .map((item) => item.type),
      ).toEqual(["START", "CANCEL", "START"]);
    },
  );

  it("cancels in-progress pagehide work while keeping its port available", async () => {
    enableAutoStart();
    const oldPage = documentSender("old");
    const snapshot = await completeAdmission(
      automaticStart(17, 1, 19, "abcdefghijk", oldPage),
    );
    const port = ports[0]!;
    await request(
      { type: "MM_CANCEL", generation: 1, reason: "pagehide" },
      oldPage,
    );
    expect(port.posted).toContainEqual(
      expect.objectContaining({
        type: "CANCEL",
        payload: { job_id: snapshot.job_id },
      }),
    );
    expect(port.port.disconnect).not.toHaveBeenCalled();
    await completeAdmission(
      automaticStart(17, 2, 19, "abcdefghijk", documentSender("next")),
    );
    expect(ports).toHaveLength(1);
  });

  it("rejects another automatic tab and releases on tab closure", async () => {
    enableAutoStart();
    const oldPage = documentSender("old");
    await start(17, 1, "abcdefghijk", oldPage);
    await request(
      { type: "MM_STOP", generation: 1, reason: "pagehide" },
      oldPage,
    );
    expect(await automaticStart(18, 2)).toEqual({
      ok: false,
      error: "AUTO_START_BUSY",
    });
    onTabRemoved!(17);
    await flush();
    expect(ports[0]!.port.disconnect).toHaveBeenCalledTimes(1);
  });

  it("allows explicit Cancel during grace to release immediately", async () => {
    const oldPage = documentSender("old");
    await start(17, 1, "abcdefghijk", oldPage);
    await request(
      { type: "MM_STOP", generation: 1, reason: "pagehide" },
      oldPage,
    );
    expect(
      await request({ type: "MM_CANCEL", generation: 1 }, oldPage),
    ).toEqual({ ok: true });
    expect(ports[0]!.port.disconnect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5001);
    expect(
      ports[0]!.posted.filter((item) => item.type === "CANCEL"),
    ).toHaveLength(1);
  });

  it("does not reuse a lost native grant", async () => {
    enableAutoStart();
    const oldPage = documentSender("old");
    await start(17, 1, "abcdefghijk", oldPage);
    const port = ports[0]!;
    await request(
      { type: "MM_STOP", generation: 1, reason: "pagehide" },
      oldPage,
    );
    port.holdStatusReply();
    const resumed = automaticStart(
      17,
      2,
      19,
      "abcdefghijk",
      documentSender("next"),
    );
    await flush();
    const status = port.posted.findLast((item) => item.type === "STATUS")!;
    port.emit({
      protocol_version: 1,
      request_id: status.request_id,
      type: "JOB",
      payload: null,
    });
    await completeAdmission(resumed);
    expect(port.posted.filter((item) => item.type === "START")).toHaveLength(2);
    expect(loadedGenerations()).toEqual([1]);
  });

  it("fails closed on a changed processing choice during native reattachment", async () => {
    enableAutoStart();
    const oldPage = documentSender("old");
    await start(17, 1, "abcdefghijk", oldPage);
    const port = ports[0]!;
    await request(
      { type: "MM_STOP", generation: 1, reason: "pagehide" },
      oldPage,
    );
    port.holdStatusReply();
    const resumed = automaticStart(
      17,
      2,
      19,
      "abcdefghijk",
      documentSender("next"),
    );
    await flush();
    const status = port.posted.findLast((item) => item.type === "STATUS")!;
    port.emit({
      protocol_version: 1,
      request_id: status.request_id,
      type: "ERROR",
      payload: { error_code: "PROCESSING_SELECTION_CHANGED" },
    });
    expect(await resumed).toMatchObject({
      ok: false,
      error: "PROCESSING_SELECTION_CHANGED",
    });
    expect(port.posted.filter((item) => item.type === "START")).toHaveLength(1);
    expect(loadedGenerations()).toEqual([1]);
  });

  it("releases a retained grant on native failure without reopening it", async () => {
    const oldPage = documentSender("old");
    await start(17, 1, "abcdefghijk", oldPage);
    await request(
      { type: "MM_STOP", generation: 1, reason: "pagehide" },
      oldPage,
    );
    ports[0]!.disconnect();
    await flush();
    await vi.advanceTimersByTimeAsync(5001);
    expect(ports).toHaveLength(1);
  });
});

describe("automatic admission through the actual background handler", () => {
  it("admits a fresh eligible video and projects only the native start fields", async () => {
    enableAutoStart();
    await completeAdmission(automaticStart());
    const command = ports[0]!.posted.findLast(
      (command) => command.type === "START",
    );
    expect(command?.payload).toEqual({
      video_id: "abcdefghijk",
      duration_seconds: 19,
      provider: "LOCAL_MACOS",
    });
    expect(stoppedAudioCount()).toBe(0);
    expect(chrome.tabs.get).toHaveBeenCalledExactlyOnceWith(17);
    expect(errors()).toEqual([]);
  });

  it.each([
    ["disabled preference", 19, false, false],
    ["exact threshold", 600, true, false],
    ["longer duration", 601, true, false],
  ])(
    "refuses %s without native, offscreen or Stop activity",
    async (_label, duration, enabled, activeTab) => {
      if (enabled) enableAutoStart();
      const from = sender(17, "abcdefghijk");
      from.tab!.active = activeTab;
      expect(
        await automaticStart(17, 1, duration, "abcdefghijk", from),
      ).toEqual({
        ok: false,
        error: "AUTO_START_INELIGIBLE",
      });
      expect(ports).toEqual([]);
      expect(runtimeSend).not.toHaveBeenCalled();
      expect(chrome.offscreen.hasDocument).not.toHaveBeenCalled();
      expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
      expect(errors()).toEqual([]);
    },
  );

  it.each([
    ["inactive sender", false, true],
    ["inactive current tab", true, false],
    ["inactive sender and current tab", false, false],
  ])("admits an eligible %s", async (_label, senderActive, currentActive) => {
    enableAutoStart();
    getTab.mockResolvedValueOnce({
      id: 17,
      active: currentActive,
    } as chrome.tabs.Tab);
    const from = sender(17, "abcdefghijk");
    from.tab!.active = senderActive;
    await completeAdmission(automaticStart(17, 1, 19, "abcdefghijk", from));
    expect(stoppedAudioCount()).toBe(0);
    expect(errors()).toEqual([]);
  });

  it("admits a tab switched away while its settings were loading", async () => {
    enableAutoStart();
    const settings = deferred<Record<string, unknown>>();
    vi.mocked(chrome.storage.local.get).mockImplementationOnce(
      () => settings.promise,
    );
    const result = automaticStart();
    getTab.mockResolvedValueOnce({
      id: 17,
      active: false,
    } as chrome.tabs.Tab);
    settings.resolve({ ...stored });
    await completeAdmission(result);
    expect(stoppedAudioCount()).toBe(0);
  });

  it("refuses a removed tab and releases its reservation without native work", async () => {
    enableAutoStart();
    getTab.mockRejectedValueOnce(new Error("No tab with this id"));
    expect(await automaticStart()).toEqual({
      ok: false,
      error: "AUTO_START_UNAVAILABLE",
    });
    expect(ports).toEqual([]);
    expect(runtimeSend).not.toHaveBeenCalled();
    await completeAdmission(
      automaticStart(18, 2, 19, "11111111111"),
      "11111111111",
    );
  });

  it.each([undefined, { id: 18, active: false }])(
    "refuses an absent or mismatched tab response %j",
    async (tab) => {
      enableAutoStart();
      getTab.mockResolvedValueOnce(tab as chrome.tabs.Tab);
      expect(await automaticStart()).toEqual({
        ok: false,
        error: "AUTO_START_UNAVAILABLE",
      });
      expect(ports).toEqual([]);
      expect(runtimeSend).not.toHaveBeenCalled();
    },
  );

  it("retires an automatic reservation when Chrome removes the tab during settings loading", async () => {
    enableAutoStart();
    const settings = deferred<Record<string, unknown>>();
    vi.mocked(chrome.storage.local.get).mockImplementationOnce(
      () => settings.promise,
    );
    const result = automaticStart();
    expect(onTabRemoved).toBeDefined();
    onTabRemoved!(17);
    await flush();
    settings.resolve({ ...stored });
    expect(await result).toEqual({ ok: false, error: "SESSION_STOPPED" });
    expect(ports).toEqual([]);
    await completeAdmission(
      automaticStart(18, 2, 19, "11111111111"),
      "11111111111",
    );
  });

  it.each([null, true, "automatic-other", {}, ["automatic"]])(
    "rejects malformed intent %j before admission",
    async (intent) => {
      enableAutoStart();
      expect(
        await request(
          {
            type: "MM_START",
            generation: 1,
            intent,
            payload: {
              video_id: "abcdefghijk",
              duration_seconds: 19,
              provider: "LOCAL_MACOS",
            },
          } as ExtensionMessage,
          sender(17, "abcdefghijk"),
        ),
      ).toEqual({ ok: false, error: "UNSUPPORTED_VIDEO" });
      expect(ports).toEqual([]);
      expect(runtimeSend).not.toHaveBeenCalled();
    },
  );

  it("reserves admission synchronously so simultaneous automatic tabs have one winner", async () => {
    enableAutoStart();
    const settings = deferred<Record<string, unknown>>();
    vi.mocked(chrome.storage.local.get).mockImplementationOnce(
      () => settings.promise,
    );
    const first = automaticStart();
    expect(await automaticStart(18, 2, 19, "11111111111")).toEqual({
      ok: false,
      error: "AUTO_START_BUSY",
    });
    expect(ports).toEqual([]);
    expect(runtimeSend).not.toHaveBeenCalled();
    settings.resolve({ ...stored });
    await completeAdmission(first);
    expect(
      ports[0]!.posted.filter((command) => command.type === "START"),
    ).toHaveLength(1);
    expect(stoppedAudioCount()).toBe(0);
  });

  it("protects the same and another tab's preparing and playing owner", async () => {
    enableAutoStart();
    const snapshot = await completeAdmission(automaticStart());
    const port = ports[0]!;
    const command = port.posted.findLast(
      (command) => command.type === "START",
    )!;
    const nativeCount = port.posted.length;
    for (const tabId of [17, 18])
      expect(await automaticStart(tabId, 2)).toEqual({
        ok: false,
        error: "AUTO_START_BUSY",
      });
    expect(port.posted).toHaveLength(nativeCount);
    expect(runtimeSend).not.toHaveBeenCalled();
    port.emit({
      protocol_version: 1,
      request_id: command.request_id,
      type: "JOB",
      payload: {
        ...snapshot,
        state: "READY",
        stage: "ready",
        media: {
          url: "http://127.0.0.1:12345/media/fixture?capability=private-fixture",
          duration_seconds: 19,
          trim_enabled: false,
          model_id: "fixture",
        },
      },
    });
    await flush();
    runtimeSend.mockClear();
    expect(await automaticStart(18, 3)).toEqual({
      ok: false,
      error: "AUTO_START_BUSY",
    });
    expect(runtimeSend).not.toHaveBeenCalled();
    expect(port.posted).toHaveLength(nativeCount);
    expect(
      await request(
        { type: "MM_CLOCK", payload: clock(1) },
        sender(17, "abcdefghijk"),
      ),
    ).toEqual({ ok: true });
  });

  it("does not let a background automatic request replace another tab's playback", async () => {
    enableAutoStart();
    await start(17, 1);
    runtimeSend.mockClear();
    getTab.mockClear();
    const nativeCount = ports[0]!.posted.length;
    const from = sender(18, "11111111111");
    from.tab!.active = false;
    expect(await automaticStart(18, 2, 19, "11111111111", from)).toEqual({
      ok: false,
      error: "AUTO_START_BUSY",
    });
    expect(getTab).not.toHaveBeenCalled();
    expect(runtimeSend).not.toHaveBeenCalled();
    expect(ports[0]!.posted).toHaveLength(nativeCount);
    expect(
      await request(
        { type: "MM_CLOCK", payload: clock(1) },
        sender(17, "abcdefghijk"),
      ),
    ).toEqual({ ok: true });
  });

  it("releases a failed settings reservation so the next eligible visit can start", async () => {
    enableAutoStart();
    vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(
      new Error("unavailable"),
    );
    expect(await automaticStart()).toEqual({
      ok: false,
      error: "AUTO_START_UNAVAILABLE",
    });
    expect(ports).toEqual([]);
    expect(runtimeSend).not.toHaveBeenCalled();
    await completeAdmission(
      automaticStart(18, 2, 19, "11111111111"),
      "11111111111",
    );
  });

  it("lets manual takeover retire an automatic settings read without overwriting its successor", async () => {
    enableAutoStart();
    const settings = deferred<Record<string, unknown>>();
    vi.mocked(chrome.storage.local.get).mockImplementationOnce(
      () => settings.promise,
    );
    const first = automaticStart();
    await start(18, 2, "11111111111");
    settings.resolve({ ...stored });
    expect(await first).toEqual({ ok: false, error: "SESSION_STOPPED" });
    expect(
      ports[0]!.posted.filter((command) => command.type === "START"),
    ).toHaveLength(1);
    expect(
      await request(
        { type: "MM_CLOCK", payload: clock(2, "11111111111") },
        sender(18, "11111111111"),
      ),
    ).toEqual({ ok: true });
    expect(errors()).toEqual([]);
  });

  it("allows Stop during pending admission and never sends a retired native Start", async () => {
    enableAutoStart();
    const settings = deferred<Record<string, unknown>>();
    vi.mocked(chrome.storage.local.get).mockImplementationOnce(
      () => settings.promise,
    );
    const first = automaticStart();
    expect(
      await request(
        { type: "MM_STOP", generation: 1 },
        sender(17, "abcdefghijk"),
      ),
    ).toEqual({ ok: true });
    settings.resolve({ ...stored });
    expect(await first).toEqual({ ok: false, error: "SESSION_STOPPED" });
    expect(ports).toEqual([]);
    await completeAdmission(
      automaticStart(18, 2, 19, "11111111111"),
      "11111111111",
    );
  });

  it("protects a Stop handoff until the vocals player acknowledges silence", async () => {
    enableAutoStart();
    await start(17, 1);
    const stopping = deferred<unknown>();
    runtimeSend.mockImplementationOnce(() => stopping.promise);
    const stopped = request(
      { type: "MM_STOP", generation: 1 },
      sender(17, "abcdefghijk"),
    );
    const nativeCount = ports[0]!.posted.length;
    expect(await automaticStart(18, 2, 19, "11111111111")).toEqual({
      ok: false,
      error: "AUTO_START_BUSY",
    });
    expect(ports[0]!.posted).toHaveLength(nativeCount);
    expect(stoppedAudioCount()).toBe(2);
    stopping.resolve({ ok: true });
    expect(await stopped).toEqual({ ok: true });
    await completeAdmission(
      automaticStart(18, 2, 19, "11111111111"),
      "11111111111",
    );
  });

  it("admits a refreshed document after pagehide's pending silence and native cancellation", async () => {
    enableAutoStart();
    const oldPage = documentSender("old-document");
    const newPage = documentSender("new-document");
    const snapshot = await start(17, 1, "abcdefghijk", oldPage);
    const port = ports[0]!;
    port.holdCancelReply();
    const silence = deferred<unknown>();
    runtimeSend.mockImplementationOnce(() => silence.promise);
    const stopped = request({ type: "MM_STOP", generation: 1 }, oldPage);
    const refreshed = automaticStart(17, 2, 19, "abcdefghijk", newPage);
    await flush();
    expect(
      port.posted.filter((command) => command.type === "START"),
    ).toHaveLength(1);
    expect(await automaticStart(18, 3)).toEqual({
      ok: false,
      error: "AUTO_START_BUSY",
    });
    silence.resolve({ ok: true });
    await flush();
    const cancellation = port.posted.findLast(
      (command) => command.type === "CANCEL",
    )!;
    expect(cancellation.payload).toEqual({ job_id: snapshot.job_id });
    expect(
      port.posted.filter((command) => command.type === "START"),
    ).toHaveLength(1);
    port.emit({
      protocol_version: 1,
      request_id: cancellation.request_id,
      type: "JOB",
      payload: null,
    });
    expect(await stopped).toEqual({ ok: true });
    await completeAdmission(refreshed);
    expect(
      port.posted.filter((command) => command.type === "START"),
    ).toHaveLength(2);
    expect(errors()).toEqual([]);
  });

  it("retires an old document that did not send pagehide before admitting its refresh", async () => {
    enableAutoStart();
    const oldPage = documentSender("old-document");
    const newPage = documentSender("new-document");
    const snapshot = await start(17, 1, "abcdefghijk", oldPage);
    const silence = deferred<unknown>();
    runtimeSend.mockImplementationOnce(() => silence.promise);
    const refreshed = automaticStart(17, 2, 19, "abcdefghijk", newPage);
    await flush();
    for (const type of ["MM_STOP", "MM_CANCEL"] as const)
      expect(await request({ type, generation: 1 }, oldPage)).toEqual({
        ok: false,
      });
    expect(
      await request({ type: "MM_CLOCK", payload: clock(1) }, oldPage),
    ).toEqual({ ok: false });
    expect(await automaticStart(17, 3, 19, "abcdefghijk", oldPage)).toEqual({
      ok: false,
      error: "AUTO_START_BUSY",
    });
    expect(await automaticStart(17, 2, 19, "abcdefghijk", newPage)).toEqual({
      ok: false,
      error: "AUTO_START_BUSY",
    });
    silence.resolve({ ok: true });
    await completeAdmission(refreshed);
    expect(ports[0]!.posted).not.toContainEqual(
      expect.objectContaining({
        type: "CANCEL",
        payload: { job_id: snapshot.job_id },
      }),
    );
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      17,
      { type: "MM_ERROR", code: "SESSION_STOPPED", generation: 1 },
      { documentId: "old-document" },
    );
    expect(
      await request({ type: "MM_CLOCK", payload: clock(2) }, newPage),
    ).toEqual({ ok: true });
  });

  it("waits for an old native Start reply and revokes its job before starting the refreshed page", async () => {
    enableAutoStart();
    const oldPage = documentSender("old-document");
    const oldStart = automaticStart(17, 1, 19, "abcdefghijk", oldPage);
    await flush();
    const port = ports[0]!;
    const hello = port.posted.findLast((command) => command.type === "HELLO")!;
    port.emit({
      protocol_version: 1,
      request_id: hello.request_id,
      type: "HELLO",
      payload: {
        ready: true,
        version: "0.1.0",
        platform: "darwin",
        arch: "arm64",
        max_duration_seconds: 900,
      },
    });
    await flush();
    const command = port.posted.findLast((item) => item.type === "START")!;
    const refreshed = automaticStart(
      17,
      2,
      19,
      "abcdefghijk",
      documentSender("new-document"),
    );
    await flush();
    expect(port.posted.filter((item) => item.type === "START")).toHaveLength(1);
    const oldJob: JobSnapshot = {
      job_id: crypto.randomUUID(),
      video_id: "abcdefghijk",
      provider: "LOCAL_MACOS",
      state: "DOWNLOADING",
      stage: "downloading",
    };
    port.emit({
      protocol_version: 1,
      request_id: command.request_id,
      type: "JOB",
      payload: oldJob,
    });
    await oldStart;
    await completeAdmission(refreshed);
    const operations = port.posted.filter(
      (item) => item.type === "START" || item.type === "CANCEL",
    );
    expect(operations.map((item) => item.type)).toEqual([
      "START",
      "CANCEL",
      "START",
    ]);
    expect(operations[1]!.payload).toEqual({ job_id: oldJob.job_id });
  });

  it.each(["MM_STOP", "MM_CANCEL"] as const)(
    "allows %s to cancel a refresh waiting for old-page cleanup",
    async (type) => {
      enableAutoStart();
      const oldPage = documentSender("old-document");
      const newPage = documentSender("new-document");
      await start(17, 1, "abcdefghijk", oldPage);
      const silence = deferred<unknown>();
      runtimeSend.mockImplementationOnce(() => silence.promise);
      const stopped = request({ type: "MM_STOP", generation: 1 }, oldPage);
      const refreshed = automaticStart(17, 2, 19, "abcdefghijk", newPage);
      expect(await request({ type, generation: 2 }, newPage)).toEqual({
        ok: true,
      });
      silence.resolve({ ok: true });
      expect(await stopped).toEqual({ ok: true });
      expect(await refreshed).toEqual({ ok: false, error: "SESSION_STOPPED" });
      expect(
        ports[0]!.posted.filter((command) => command.type === "START"),
      ).toHaveLength(1);
      await completeAdmission(automaticStart(18, 3));
    },
  );

  it("keeps only the newest refreshed reservation through an old Stop handoff", async () => {
    enableAutoStart();
    const oldPage = documentSender("old-document");
    const middlePage = documentSender("middle-document");
    const newestPage = documentSender("newest-document");
    await start(17, 1, "abcdefghijk", oldPage);
    const silence = deferred<unknown>();
    runtimeSend.mockImplementationOnce(() => silence.promise);
    const stopped = request({ type: "MM_STOP", generation: 1 }, oldPage);
    const middle = automaticStart(17, 2, 19, "abcdefghijk", middlePage);
    const newest = automaticStart(17, 3, 19, "abcdefghijk", newestPage);
    await flush();
    expect(await automaticStart(17, 4, 19, "abcdefghijk", middlePage)).toEqual({
      ok: false,
      error: "AUTO_START_BUSY",
    });
    expect(await automaticStart(18, 4)).toEqual({
      ok: false,
      error: "AUTO_START_BUSY",
    });
    silence.resolve({ ok: true });
    expect(await stopped).toEqual({ ok: true });
    expect(await middle).toEqual({ ok: false, error: "SESSION_STOPPED" });
    await completeAdmission(newest);
    expect(
      ports[0]!.posted.filter((command) => command.type === "START"),
    ).toHaveLength(2);
    expect(
      await request({ type: "MM_CLOCK", payload: clock(3) }, newestPage),
    ).toEqual({ ok: true });
  });

  it.each(["cached", "prerender", "pending_deletion"] as const)(
    "refuses a refreshed document with Chrome lifecycle %s",
    async (documentLifecycle) => {
      enableAutoStart();
      await start(17, 1, "abcdefghijk", documentSender("old-document"));
      runtimeSend.mockClear();
      expect(
        await automaticStart(17, 2, 19, "abcdefghijk", {
          ...documentSender("new-document"),
          documentLifecycle,
        }),
      ).toEqual({ ok: false, error: "AUTO_START_BUSY" });
      expect(
        await manualStart(2, {
          ...documentSender("new-document"),
          documentLifecycle,
        }),
      ).toEqual({ ok: false, error: "SESSION_STOPPED" });
      expect(runtimeSend).not.toHaveBeenCalled();
    },
  );

  it("refuses a document refresh older than the current generation", async () => {
    enableAutoStart();
    await start(17, 2, "abcdefghijk", documentSender("current-document"));
    runtimeSend.mockClear();
    expect(
      await automaticStart(
        17,
        1,
        19,
        "abcdefghijk",
        documentSender("delayed-document"),
      ),
    ).toEqual({ ok: false, error: "AUTO_START_BUSY" });
    expect(await manualStart(1, documentSender("delayed-document"))).toEqual({
      ok: false,
      error: "SESSION_STOPPED",
    });
    expect(runtimeSend).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rejects stale manual Start without poisoning the current document (new auto-start disabled=%s)",
    async (disabled) => {
      enableAutoStart();
      const oldPage = documentSender("old-document");
      const newPage = documentSender("new-document");
      await start(17, 1, "abcdefghijk", oldPage);
      if (disabled) stored[`${SETTINGS_KEY}.autoStartEnabled`] = false;
      const refreshed = automaticStart(17, 2, 19, "abcdefghijk", newPage);
      if (disabled)
        expect(await refreshed).toEqual({
          ok: false,
          error: "AUTO_START_INELIGIBLE",
        });
      else await completeAdmission(refreshed);
      runtimeSend.mockClear();
      const commandCount = ports.flatMap((port) => port.posted).length;
      // Even a higher generation cannot make a retired Chrome document current.
      expect(await manualStart(3, oldPage)).toEqual({
        ok: false,
        error: "SESSION_STOPPED",
      });
      expect(runtimeSend).not.toHaveBeenCalled();
      expect(ports.flatMap((port) => port.posted)).toHaveLength(commandCount);
      if (!disabled)
        expect(
          await request({ type: "MM_STOP", generation: 2 }, newPage),
        ).toEqual({ ok: true });
      enableAutoStart();
      await completeAdmission(
        automaticStart(17, 3, 19, "abcdefghijk", newPage),
      );
      expect(
        await request({ type: "MM_CLOCK", payload: clock(3) }, newPage),
      ).toEqual({ ok: true });
      expect(errors()).toEqual([]);
    },
  );

  it("allows a refresh within the same timestamp while distinguishing documents", async () => {
    enableAutoStart();
    await start(17, 1, "abcdefghijk", documentSender("old-document"));
    await completeAdmission(
      automaticStart(17, 1, 19, "abcdefghijk", documentSender("new-document")),
    );
    expect(
      ports[0]!.posted.filter((command) => command.type === "START"),
    ).toHaveLength(1);
  });

  it.each(["MM_STOP", "MM_CANCEL"] as const)(
    "admits the next SPA video in the same Chrome document after %s",
    async (type) => {
      enableAutoStart();
      const oldPage = documentSender("same-document");
      await start(17, 1, "abcdefghijk", oldPage);
      expect(await request({ type, generation: 1 }, oldPage)).toEqual({
        ok: true,
      });
      const nextPage = documentSender("same-document", "11111111111");
      getTab.mockResolvedValueOnce({
        id: 17,
        url: nextPage.url,
      } as chrome.tabs.Tab);
      await completeAdmission(
        automaticStart(17, 2, 19, "11111111111", nextPage),
        "11111111111",
      );
      expect(
        ports
          .flatMap((port) => port.posted)
          .filter((command) => command.type === "START"),
      ).toHaveLength(2);
      expect(
        await request(
          { type: "MM_CLOCK", payload: clock(2, "11111111111") },
          nextPage,
        ),
      ).toEqual({ ok: true });
      expect(errors()).toEqual([]);
    },
  );

  it("rejects an old document after its pagehide stop completed before refresh admission", async () => {
    enableAutoStart();
    const oldPage = documentSender("old-document");
    await start(17, 1, "abcdefghijk", oldPage);
    await request({ type: "MM_STOP", generation: 1 }, oldPage);
    const settings = deferred<Record<string, unknown>>();
    vi.mocked(chrome.storage.local.get).mockImplementationOnce(
      () => settings.promise,
    );
    const refreshed = automaticStart(
      17,
      2,
      19,
      "abcdefghijk",
      documentSender("new-document"),
    );
    await flush();
    expect(await automaticStart(17, 3, 19, "abcdefghijk", oldPage)).toEqual({
      ok: false,
      error: "AUTO_START_BUSY",
    });
    settings.resolve({ ...stored });
    await completeAdmission(refreshed);
  });

  it("cannot replace a manual successor while its Stop acknowledgement is pending", async () => {
    enableAutoStart();
    await start(17, 1);
    const stopping = deferred<unknown>();
    runtimeSend.mockImplementationOnce(() => stopping.promise);
    const manual = request(
      {
        type: "MM_START",
        generation: 2,
        intent: "manual",
        payload: {
          video_id: "11111111111",
          duration_seconds: 19,
          provider: "LOCAL_MACOS",
        },
      },
      sender(18, "11111111111"),
    );
    expect(await automaticStart(19, 3, 19, "22222222222")).toEqual({
      ok: false,
      error: "AUTO_START_BUSY",
    });
    stopping.resolve({ ok: true });
    await completeAdmission(manual, "11111111111");
    const starts = ports[0]!.posted.filter(
      (command) => command.type === "START",
    );
    expect(starts).toHaveLength(2);
    expect(starts[1]!.payload).toEqual({
      video_id: "11111111111",
      duration_seconds: 19,
      provider: "LOCAL_MACOS",
    });
  });

  it("never starts retired automatic work after its HELLO returns to a manual successor", async () => {
    enableAutoStart();
    const automatic = automaticStart();
    await flush();
    const port = ports[0]!;
    const retiredHello = port.posted.findLast(
      (command) => command.type === "HELLO",
    )!;
    const manual = request(
      {
        type: "MM_START",
        generation: 2,
        payload: {
          video_id: "11111111111",
          duration_seconds: 19,
          provider: "LOCAL_MACOS",
        },
      },
      sender(18, "11111111111"),
    );
    await flush();
    port.emit({
      protocol_version: 1,
      request_id: retiredHello.request_id,
      type: "HELLO",
      payload: {
        ready: true,
        version: "0.1.0",
        platform: "darwin",
        arch: "arm64",
        max_duration_seconds: 900,
      },
    });
    expect(await automatic).toEqual({ ok: false, error: "SESSION_STOPPED" });
    await completeAdmission(manual, "11111111111");
    expect(
      port.posted.filter((command) => command.type === "START"),
    ).toHaveLength(1);
    expect(errors()).toEqual([]);
  });

  it("releases a rejected native Start so another eligible tab can be admitted", async () => {
    enableAutoStart();
    const first = automaticStart();
    await flush();
    const port = ports[0]!;
    const hello = port.posted.findLast((command) => command.type === "HELLO")!;
    port.emit({
      protocol_version: 1,
      request_id: hello.request_id,
      type: "HELLO",
      payload: {
        ready: true,
        version: "0.1.0",
        platform: "darwin",
        arch: "arm64",
        max_duration_seconds: 900,
      },
    });
    await flush();
    const command = port.posted.findLast(
      (command) => command.type === "START",
    )!;
    port.emit({
      protocol_version: 1,
      request_id: command.request_id,
      type: "ERROR",
      payload: { error_code: "DOWNLOAD_FAILED" },
    });
    expect(await first).toEqual({ ok: false, error: "DOWNLOAD_FAILED" });
    await completeAdmission(
      automaticStart(18, 2, 19, "11111111111"),
      "11111111111",
    );
    expect(
      ports
        .flatMap((item) => item.posted)
        .filter((command) => command.type === "START"),
    ).toHaveLength(2);
  });

  it.each(["FAILED", "CANCELLED"] as const)(
    "releases an automatic owner when its native job is %s",
    async (state) => {
      enableAutoStart();
      await completeAdmission(automaticStart(), "abcdefghijk", state);
      const second = automaticStart(18, 2, 19, "11111111111");
      await completeAdmission(second, "11111111111");
      expect(
        ports
          .flatMap((item) => item.posted)
          .filter((command) => command.type === "START"),
      ).toHaveLength(2);
      expect(stoppedAudioCount()).toBe(1);
    },
  );
});

describe("playback ownership through the actual background handler", () => {
  it.each([
    { automatic: false, paused: false },
    { automatic: false, paused: true },
    { automatic: true, paused: false },
    { automatic: true, paused: true },
  ])(
    "waits for silence before restoring a cancelled READY session (automatic=$automatic, paused=$paused)",
    async ({ automatic, paused }) => {
      let snapshot: JobSnapshot;
      if (automatic) {
        enableAutoStart();
        snapshot = await completeAdmission(automaticStart());
        snapshot = {
          ...snapshot,
          state: "READY",
          stage: "ready",
          media: {
            url: "http://127.0.0.1:12345/media/fixture?capability=private-fixture",
            duration_seconds: 19,
            trim_enabled: false,
            model_id: "fixture",
          },
        };
        ports[0]!.emit({
          protocol_version: 1,
          request_id: ports[0]!.posted.findLast(
            (command) => command.type === "START",
          )!.request_id,
          type: "JOB",
          payload: snapshot,
        });
        await flush();
      } else snapshot = await start(17, 1);
      await request(
        { type: "MM_CLOCK", payload: { ...clock(1), paused } },
        sender(17, snapshot.video_id),
      );
      await request({
        type: "MM_AUDIO_STATE",
        generation: 1,
        playing: !paused,
      });
      const port = ports[0]!;
      const command = port.posted.findLast(
        (command) => command.type === "START",
      )!;
      const cancellation: NativeReply = {
        protocol_version: 1,
        request_id: command.request_id,
        type: "JOB",
        payload: {
          job_id: snapshot.job_id,
          video_id: snapshot.video_id,
          provider: "LOCAL_MACOS",
          state: "CANCELLED",
          stage: "cancelled",
        },
      };
      const silence = deferred<unknown>();
      runtimeSend.mockImplementationOnce(() => silence.promise);
      const stops = stoppedAudioCount();
      vi.mocked(chrome.tabs.sendMessage).mockClear();
      port.emit(cancellation);
      port.emit(cancellation);
      await flush();
      expect(stoppedAudioCount()).toBe(stops + 1);
      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
      expect(
        port.posted.filter((command) => command.type === "CANCEL"),
      ).toEqual([]);
      expect(await automaticStart(18, 2, 19, "11111111111")).toEqual({
        ok: false,
        error: "AUTO_START_BUSY",
      });
      await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
      await request({ type: "MM_AUDIO_READY", generation: 1 });
      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
      silence.resolve({ ok: true });
      await flush();
      expect(chrome.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(17, {
        type: "MM_ERROR",
        code: "SESSION_STOPPED",
        generation: 1,
      });
      expect(
        ((await request({ type: "MM_STATUS" })) as ExtensionStatus).job,
      ).toBeNull();
      expect(
        port.posted.filter((command) => command.type === "CANCEL"),
      ).toEqual([]);
      port.emit(cancellation);
      await flush();
      expect(stoppedAudioCount()).toBe(stops + 1);
      expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    },
  );

  it("fences a cancelled session's delayed acknowledgement and snapshots from a manual successor", async () => {
    const retired = await start(17, 1);
    const port = ports[0]!;
    const retiredRequest = port.posted.findLast(
      (command) => command.type === "START",
    )!.request_id;
    const silence = deferred<unknown>();
    runtimeSend.mockImplementationOnce(() => silence.promise);
    const cancellation: NativeReply = {
      protocol_version: 1,
      request_id: retiredRequest,
      type: "JOB",
      payload: {
        job_id: retired.job_id,
        video_id: retired.video_id,
        provider: "LOCAL_MACOS",
        state: "CANCELLED",
        stage: "cancelled",
      },
    };
    port.emit(cancellation);
    await flush();
    const successor = await start(17, 2, "11111111111");
    const stops = stoppedAudioCount();
    vi.mocked(chrome.tabs.sendMessage).mockClear();
    port.emit(cancellation);
    port.emit({
      protocol_version: 1,
      request_id: retiredRequest,
      type: "JOB",
      payload: retired,
    });
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    await flush();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    silence.resolve({ ok: true });
    await flush();
    expect(stoppedAudioCount()).toBe(stops);
    expect(loadedGenerations()).toEqual([1, 2]);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(17, {
      type: "MM_ERROR",
      code: "SESSION_STOPPED",
      generation: 1,
    });
    expect(
      ((await request({ type: "MM_STATUS" })) as ExtensionStatus).job?.job_id,
    ).toBe(successor.job_id);
    expect(
      await request(
        { type: "MM_CLOCK", payload: clock(2, "11111111111") },
        sender(17, "11111111111"),
      ),
    ).toEqual({ ok: true });
    expect(port.posted.filter((command) => command.type === "CANCEL")).toEqual(
      [],
    );
  });

  it.each(["MM_STOP", "MM_CANCEL"] as const)(
    "%s releases the captured READY job only after offscreen silence and awaits native cleanup",
    async (type) => {
      const snapshot = await start(17, 1);
      const port = ports[0]!;
      port.holdCancelReply();
      const silence = deferred<unknown>();
      runtimeSend.mockImplementationOnce(() => silence.promise);
      vi.mocked(chrome.tabs.sendMessage).mockClear();
      const result = request(
        { type, generation: 1 },
        sender(17, "abcdefghijk"),
      );
      const settled = vi.fn();
      void result.then(settled);
      await flush();
      expect(
        port.posted.filter((command) => command.type === "CANCEL"),
      ).toEqual([]);
      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
      silence.resolve({ ok: true });
      await flush();
      const cancellations = port.posted.filter(
        (command) => command.type === "CANCEL",
      );
      expect(cancellations).toHaveLength(1);
      expect(cancellations[0]?.payload).toEqual({ job_id: snapshot.job_id });
      expect(chrome.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(17, {
        type: "MM_ERROR",
        code: "SESSION_STOPPED",
        generation: 1,
      });
      expect(settled).not.toHaveBeenCalled();
      port.emit({
        protocol_version: 1,
        request_id: cancellations[0]!.request_id,
        type: "JOB",
        payload: null,
      });
      expect(await result).toEqual({ ok: true });
      expect(
        await request({ type, generation: 1 }, sender(17, "abcdefghijk")),
      ).toEqual({ ok: false });
      expect(
        port.posted.filter((command) => command.type === "CANCEL"),
      ).toHaveLength(1);
    },
  );

  it.each(["MM_STOP", "MM_CANCEL"] as const)(
    "%s preserves preparing Stop semantics while cancellation still reaches the native job",
    async (type) => {
      enableAutoStart();
      const snapshot = await completeAdmission(automaticStart());
      expect(
        await request({ type, generation: 1 }, sender(17, "abcdefghijk")),
      ).toEqual({ ok: true });
      const cancellations = ports[0]!.posted.filter(
        (command) => command.type === "CANCEL",
      );
      expect(cancellations).toHaveLength(type === "MM_CANCEL" ? 1 : 0);
      if (type === "MM_CANCEL")
        expect(cancellations[0]?.payload).toEqual({ job_id: snapshot.job_id });
    },
  );

  it("refuses Stop from another tab or retired generation without releasing the current grant", async () => {
    await start(17, 2);
    const stopCount = stoppedAudioCount();
    for (const [tabId, generation] of [
      [18, 2],
      [17, 1],
    ] as const)
      expect(
        await request(
          { type: "MM_STOP", generation },
          sender(tabId, "abcdefghijk"),
        ),
      ).toEqual({ ok: false });
    expect(stoppedAudioCount()).toBe(stopCount);
    expect(
      ports[0]!.posted.filter((command) => command.type === "CANCEL"),
    ).toEqual([]);
    expect(
      await request(
        { type: "MM_CLOCK", payload: clock(2) },
        sender(17, "abcdefghijk"),
      ),
    ).toEqual({ ok: true });
  });

  it("keeps a late Stop bound to its retired READY job while a manual successor owns playback", async () => {
    const retired = await start(17, 1);
    const silence = deferred<unknown>();
    runtimeSend.mockImplementationOnce(() => silence.promise);
    const stopped = request(
      { type: "MM_STOP", generation: 1 },
      sender(17, "abcdefghijk"),
    );
    await flush();
    const successor = await start(18, 2, "11111111111");
    silence.resolve({ ok: true });
    expect(await stopped).toEqual({ ok: true });
    const cancellations = ports[0]!.posted.filter(
      (command) => command.type === "CANCEL",
    );
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]?.payload).toEqual({ job_id: retired.job_id });
    expect(cancellations[0]?.payload).not.toEqual({ job_id: successor.job_id });
    expect(
      await request(
        { type: "MM_CLOCK", payload: clock(2, "11111111111") },
        sender(18, "11111111111"),
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    "cookies",
    "cookies_from_browser",
    "headers",
    "authorization",
    "visitor_data",
    "po_token",
    "username",
    "password",
  ])(
    "rejects browser-supplied %s before connecting to the native downloader",
    async (field) => {
      const result = await request(
        {
          type: "MM_START",
          generation: 1,
          payload: {
            video_id: "abcdefghijk",
            duration_seconds: 19,
            provider: "LOCAL_MACOS",
            [field]: "synthetic-account-canary",
          },
        } as ExtensionMessage,
        sender(1, "abcdefghijk"),
      );
      expect(result).toEqual({ ok: false, error: "UNSUPPORTED_VIDEO" });
      expect(chrome.runtime.connectNative).not.toHaveBeenCalled();
      expect(ports).toHaveLength(0);
    },
  );

  it("hands a pending canplay load to the successor through both actual handlers", async () => {
    const background = listener;
    const elements: TestAudio[] = [];
    let attached: TestAudio[] = [];
    class TestAudio extends EventTarget {
      src = "";
      crossOrigin = "";
      preload = "";
      duration = 19;
      currentTime = 0;
      playbackRate = 1;
      volume = 1;
      paused = true;
      readyState = 4;
      error = null;
      pause = vi.fn(() => {
        this.paused = true;
      });
      play = vi.fn(async () => {
        this.paused = false;
      });
      load = vi.fn();
      removeAttribute(name: string): void {
        if (name === "src") this.src = "";
      }
      remove(): void {
        attached = attached.filter((element) => element !== this);
      }
      constructor() {
        super();
        elements.push(this);
      }
    }
    vi.stubGlobal("Audio", TestAudio);
    vi.stubGlobal("document", {
      body: { append: (element: TestAudio) => attached.push(element) },
    });
    await import("../src/extension/offscreen");
    const offscreen = listener;
    listener = background;
    const deliver = (handler: MessageHandler, message: ExtensionMessage) =>
      new Promise((resolve) => {
        handler(
          message,
          handler === offscreen
            ? {
                ...offscreenSender,
                url: `chrome-extension://${extensionId}/background.js`,
              }
            : offscreenSender,
          resolve,
        );
      });
    runtimeSend.mockImplementation((message) =>
      deliver(
        ["MM_AUDIO_LOAD", "MM_AUDIO_CLOCK", "MM_AUDIO_STOP"].includes(
          message.type,
        )
          ? offscreen
          : background,
        message,
      ),
    );
    await start(17, 1);
    const retired = elements[0]!;
    await start(18, 2, "11111111111");
    const current = elements[1]!;
    expect(elements).toHaveLength(2);
    expect(attached).toEqual([current]);
    retired.dispatchEvent(new Event("canplay"));
    retired.dispatchEvent(new Event("error"));
    await flush();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(18, {
      type: "MM_READY",
      generation: 2,
    });
    current.dispatchEvent(new Event("canplay"));
    await flush();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(18, {
      type: "MM_READY",
      generation: 2,
    });
    expect(
      await request(
        { type: "MM_CLOCK", payload: clock(2, "11111111111") },
        sender(18, "11111111111"),
      ),
    ).toEqual({ ok: true });
    await flush();
    expect(current.paused).toBe(false);
    expect(retired.paused).toBe(true);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(18, {
      type: "MM_PLAYBACK",
      generation: 2,
      playing: true,
    });
    expect(errors()).toEqual([]);
    await request(
      { type: "MM_STOP", generation: 2 },
      sender(18, "11111111111"),
    );
    expect(attached).toEqual([]);
  });

  it("loads the successor after a retired load acknowledgement settles", async () => {
    const oldLoad = deferred<unknown>();
    runtimeSend.mockImplementation(async (message) =>
      message.type === "MM_AUDIO_LOAD" && message.generation === 11
        ? oldLoad.promise
        : { ok: true },
    );
    await start(17, 11);
    await start(18, 12, "11111111111");
    expect(loadedGenerations()).toEqual([11]);
    await request({ type: "MM_AUDIO_READY", generation: 11 });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(18, {
      type: "MM_READY",
      generation: 11,
    });
    oldLoad.resolve({ ok: false });
    await flush();
    expect(loadedGenerations()).toEqual([11, 12]);
    await request({ type: "MM_AUDIO_READY", generation: 12 });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(18, {
      type: "MM_READY",
      generation: 12,
    });
    const response = await request(
      { type: "MM_CLOCK", payload: clock(12, "11111111111") },
      sender(18, "11111111111"),
    );
    expect(response).toEqual({ ok: true });
    expect(errors()).toEqual([]);
  });

  it("skips a queued retired successor without letting its finalizer clear the latest load", async () => {
    const oldLoad = deferred<unknown>();
    const newestLoad = deferred<unknown>();
    runtimeSend.mockImplementation(async (message) => {
      if (message.type === "MM_AUDIO_LOAD" && message.generation === 21)
        return oldLoad.promise;
      if (message.type === "MM_AUDIO_LOAD" && message.generation === 23)
        return newestLoad.promise;
      return { ok: true };
    });
    await start(17, 21);
    await start(18, 22, "11111111111");
    const newest = await start(19, 23, "22222222222");
    oldLoad.resolve({ ok: false });
    await flush();
    expect(loadedGenerations()).toEqual([21, 23]);
    const command = ports[0]!.posted.findLast(
      (command) => command.type === "START",
    )!;
    ports[0]!.emit({
      protocol_version: 1,
      request_id: command.request_id,
      type: "JOB",
      payload: newest,
    });
    await flush();
    expect(loadedGenerations()).toEqual([21, 23]);
    newestLoad.resolve({ ok: true });
    await flush();
    await request({ type: "MM_AUDIO_STATE", generation: 23, playing: true });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(19, {
      type: "MM_PLAYBACK",
      generation: 23,
      playing: true,
    });
    expect(errors()).toEqual([]);
  });

  it("fails the current owner when its load explicitly refuses readiness", async () => {
    runtimeSend.mockImplementation(async (message) =>
      message.type === "MM_AUDIO_LOAD" ? { ok: false } : { ok: true },
    );
    await start(17, 31);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(17, {
      type: "MM_ERROR",
      generation: 31,
      code: "AUDIO_LOAD_FAILED",
    });
    expect(errors()).toEqual(["AUDIO_LOAD_FAILED"]);
    expect(
      await request(
        { type: "MM_CLOCK", payload: clock(31) },
        sender(17, "abcdefghijk"),
      ),
    ).toEqual({ ok: false });
  });

  it.each(["clock", "context query"])(
    "ignores a retired %s rejection after another tab owns playback",
    async (operation) => {
      await start(17, 41);
      const oldClock = deferred<unknown>();
      if (operation === "clock") {
        runtimeSend.mockImplementation(async (message) =>
          message.type === "MM_AUDIO_CLOCK" && message.payload.generation === 41
            ? oldClock.promise
            : { ok: true },
        );
      } else
        hasDocument.mockImplementationOnce(
          async () => (await oldClock.promise) as boolean,
        );
      const pending = request(
        { type: "MM_CLOCK", payload: clock(41) },
        sender(17, "abcdefghijk"),
      );
      await flush();
      await start(18, 42, "11111111111");
      const stops = stoppedAudioCount();
      oldClock.reject(new Error("retired context unavailable"));
      expect(await pending).toEqual({ ok: false });
      await flush();
      expect(stoppedAudioCount()).toBe(stops);
      expect(errors()).toEqual([]);
      await request({ type: "MM_AUDIO_STATE", generation: 42, playing: true });
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(18, {
        type: "MM_PLAYBACK",
        generation: 42,
        playing: true,
      });
      expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(18, {
        type: "MM_ERROR",
        generation: 42,
        code: "AUDIO_CONTEXT_LOST",
      });
    },
  );

  it("preserves the actionable current clock failure in both page and acknowledgement", async () => {
    await start(17, 51);
    runtimeSend.mockImplementation(async (message) => {
      if (message.type === "MM_AUDIO_CLOCK")
        throw new Error("receiving context unavailable");
      return { ok: true };
    });
    expect(
      await request(
        { type: "MM_CLOCK", payload: clock(51) },
        sender(17, "abcdefghijk"),
      ),
    ).toEqual({ ok: false, error: "AUDIO_CONTEXT_LOST" });
    await flush();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(17, {
      type: "MM_ERROR",
      generation: 51,
      code: "AUDIO_CONTEXT_LOST",
    });
    expect(errors()).toEqual(["AUDIO_CONTEXT_LOST"]);
    expect(loadedGenerations()).toEqual([51, 51]);
    expect(
      runtimeSend.mock.calls.filter(
        ([message]) => message.type === "MM_AUDIO_CLOCK",
      ),
    ).toHaveLength(2);
  });

  it("joins resume clocks while a recreated document is visible before its listener is ready", async () => {
    await start(17, 52);
    runtimeSend.mockClear();
    const creation = deferred<void>();
    vi.mocked(chrome.offscreen.createDocument).mockImplementationOnce(
      () => creation.promise,
    );
    hasDocument
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    let listenerReady = false;
    runtimeSend.mockImplementation(async (message) => {
      if (message.type === "MM_AUDIO_CLOCK" && !listenerReady)
        throw new Error("receiving context unavailable");
      return { ok: true };
    });
    const resume = request(
      { type: "MM_CLOCK", payload: { ...clock(52), sequence: 2 } },
      sender(17, "abcdefghijk"),
    );
    await flush();
    expect(chrome.offscreen.createDocument).toHaveBeenCalledOnce();
    const latest = { ...clock(52), sequence: 3, paused: true, current_time: 7 };
    const concurrent = request(
      { type: "MM_CLOCK", payload: latest },
      sender(17, "abcdefghijk"),
    );
    await flush();
    expect(runtimeSend).not.toHaveBeenCalled();
    listenerReady = true;
    creation.resolve();
    expect(await Promise.all([resume, concurrent])).toEqual([
      { ok: true },
      { ok: true },
    ]);
    expect(loadedGenerations()).toEqual([52]);
    expect(runtimeSend).toHaveBeenCalledWith({
      type: "MM_AUDIO_CLOCK",
      payload: latest,
    });
    expect(errors()).toEqual([]);
  });

  it("joins a load started during a document query and never sends its stale clock", async () => {
    await start(17, 53);
    runtimeSend.mockClear();
    const query = deferred<boolean>();
    const ready = deferred<unknown>();
    hasDocument
      .mockImplementationOnce(() => query.promise)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    runtimeSend.mockImplementation(async (message) =>
      message.type === "MM_AUDIO_LOAD" ? ready.promise : { ok: true },
    );
    const older = request(
      { type: "MM_CLOCK", payload: { ...clock(53), sequence: 2 } },
      sender(17, "abcdefghijk"),
    );
    await flush();
    const latest = { ...clock(53), sequence: 3, current_time: 7 };
    const newer = request(
      { type: "MM_CLOCK", payload: latest },
      sender(17, "abcdefghijk"),
    );
    await flush();
    expect(loadedGenerations()).toEqual([53]);
    query.resolve(true);
    await flush();
    expect(
      runtimeSend.mock.calls.some(
        ([message]) => message.type === "MM_AUDIO_CLOCK",
      ),
    ).toBe(false);
    ready.resolve({ ok: true });
    expect(await Promise.all([older, newer])).toEqual([
      { ok: true },
      { ok: true },
    ]);
    const clocks = runtimeSend.mock.calls.flatMap(([message]) =>
      message.type === "MM_AUDIO_CLOCK" ? [message.payload] : [],
    );
    expect(clocks).toEqual([latest]);
    expect(errors()).toEqual([]);
  });

  it("reloads once after a clock transport failure and reports only sanitized recovery observations", async () => {
    await start(17, 54);
    runtimeSend.mockClear();
    let clocks = 0;
    runtimeSend.mockImplementation(async (message) => {
      if (message.type === "MM_AUDIO_CLOCK" && ++clocks === 1)
        throw new Error("private browser diagnostic text");
      return { ok: true };
    });
    expect(
      await request(
        { type: "MM_CLOCK", payload: clock(54) },
        sender(17, "abcdefghijk"),
      ),
    ).toEqual({ ok: true });
    await flush();
    expect(loadedGenerations()).toEqual([54]);
    expect(clocks).toBe(2);
    expect(errors()).toEqual([]);
    const observations = ports[0]!.posted.flatMap((command) =>
      command.type === "EVENT" && command.payload.code === "AUDIO_CONTEXT_LOST"
        ? [command.payload]
        : [],
    );
    expect(observations).toEqual([
      {
        component: "extension",
        severity: "warning",
        event: "diagnostic_error",
        code: "AUDIO_CONTEXT_LOST",
        metrics: { stage: "playback", generation: 54, passed: false },
      },
      {
        component: "extension",
        severity: "info",
        event: "diagnostic_error",
        code: "AUDIO_CONTEXT_LOST",
        metrics: { stage: "playback", generation: 54, passed: true },
      },
    ]);
    expect(JSON.stringify(stored)).not.toContain(
      "private browser diagnostic text",
    );
    expect(
      ports[0]!.posted.filter((command) => command.type === "START"),
    ).toHaveLength(1);
  });

  it("does not let a joined recovery failure stop a successor owner", async () => {
    await start(17, 55);
    runtimeSend.mockClear();
    const retiredLoad = deferred<unknown>();
    hasDocument.mockResolvedValueOnce(false);
    runtimeSend.mockImplementation(async (message) =>
      message.type === "MM_AUDIO_LOAD" && message.generation === 55
        ? retiredLoad.promise
        : { ok: true },
    );
    const retired = request(
      { type: "MM_CLOCK", payload: clock(55) },
      sender(17, "abcdefghijk"),
    );
    await flush();
    const joined = request(
      { type: "MM_CLOCK", payload: { ...clock(55), sequence: 2 } },
      sender(17, "abcdefghijk"),
    );
    await flush();
    await start(18, 56, "11111111111");
    const stops = stoppedAudioCount();
    retiredLoad.reject(new Error("retired load unavailable"));
    expect(await Promise.all([retired, joined])).toEqual([
      { ok: false },
      { ok: false },
    ]);
    await flush();
    expect(loadedGenerations()).toEqual([55, 56]);
    expect(stoppedAudioCount()).toBe(stops);
    expect(errors()).toEqual([]);
    await request({ type: "MM_AUDIO_STATE", generation: 56, playing: true });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(18, {
      type: "MM_PLAYBACK",
      generation: 56,
      playing: true,
    });
  });

  it("reloads the same owner when the offscreen context disappears", async () => {
    await start(17, 61);
    hasDocument.mockResolvedValueOnce(false);
    expect(
      await request(
        { type: "MM_CLOCK", payload: clock(61) },
        sender(17, "abcdefghijk"),
      ),
    ).toEqual({ ok: true });
    expect(loadedGenerations()).toEqual([61, 61]);
    expect(runtimeSend).toHaveBeenCalledWith({
      type: "MM_AUDIO_CLOCK",
      payload: clock(61),
    });
    expect(errors()).toEqual([]);
  });

  it("stops ready playback on helper disconnect and ignores delayed audio state", async () => {
    await start(17, 71);
    const stops = stoppedAudioCount();
    ports[0]!.disconnect();
    await flush();
    expect(stoppedAudioCount()).toBe(stops + 1);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(17, {
      type: "MM_ERROR",
      generation: 71,
      code: "COMPANION_DISCONNECTED",
    });
    vi.mocked(chrome.tabs.sendMessage).mockClear();
    await request({ type: "MM_AUDIO_STATE", generation: 71, playing: true });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(errors()).toEqual(["COMPANION_DISCONNECTED"]);
  });

  it("reports absent ownership for clocks after background state is lost", async () => {
    expect(
      await request(
        { type: "MM_CLOCK", payload: clock(81) },
        sender(17, "abcdefghijk"),
      ),
    ).toEqual({ ok: false });
    expect(runtimeSend).not.toHaveBeenCalled();
    const status = request({ type: "MM_STATUS" });
    const helloCommand = ports[0]!.posted[0]!;
    ports[0]!.emit({
      protocol_version: 1,
      request_id: helloCommand.request_id,
      type: "HELLO",
      payload: {
        ready: true,
        version: "0.1.0",
        platform: "darwin",
        arch: "arm64",
        max_duration_seconds: 900,
      },
    });
    expect(((await status) as ExtensionStatus).job).toBeNull();
  });
});

describe("playback-first background publication", () => {
  async function publicationSession() {
    const snapshot = await start(
      17,
      1,
      "abcdefghijk",
      sender(17, "abcdefghijk"),
      ["background_publication_v1"],
    );
    const port = ports[0]!;
    const startCommand = port.posted.findLast((c) => c.type === "START")!;
    function update(save_state: JobSnapshot["save_state"]) {
      port.emit({
        protocol_version: 1,
        request_id: startCommand.request_id,
        type: "JOB",
        payload: { ...snapshot, ...(save_state ? { save_state } : {}) },
      });
    }
    const acknowledgements = () =>
      port.posted.filter((c) => c.type === "PLAYBACK_STARTED");
    return { snapshot, port, update, acknowledgements };
  }
  it("negotiates before acknowledging only trusted first playback and latches success", async () => {
    const { snapshot, port, acknowledgements } = await publicationSession();
    expect(port.posted[0]?.payload).toEqual({});
    expect(acknowledgements()).toEqual([]);
    await request({ type: "MM_AUDIO_READY", generation: 1 });
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: false });
    await request({ type: "MM_AUDIO_STATE", generation: 2, playing: true });
    await request(
      { type: "MM_AUDIO_STATE", generation: 1, playing: true },
      sender(17, "abcdefghijk"),
    );
    await request(
      {
        type: "MM_EVENT",
        payload: {
          component: "extension",
          severity: "info",
          event: "playback_started",
        },
      },
      sender(17, "abcdefghijk"),
    );
    expect(acknowledgements()).toEqual([]);
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    expect(acknowledgements()).toHaveLength(1);
    const acknowledgement = acknowledgements()[0]!;
    expect(acknowledgement.payload).toEqual({
      job_id: snapshot.job_id,
      video_id: snapshot.video_id,
    });
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    expect(acknowledgements()).toHaveLength(1);
    port.emit({
      protocol_version: 1,
      request_id: acknowledgement.request_id,
      type: "JOB",
      payload: snapshot,
    });
    await flush();
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: false });
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    expect(acknowledgements()).toHaveLength(1);
  });
  it("keeps legacy helpers on their existing playback contract", async () => {
    await start(17, 1);
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    expect(ports[0]!.posted.some((c) => c.type === "PLAYBACK_STARTED")).toBe(
      false,
    );
    expect(ports[0]!.posted.filter((c) => c.type === "HELLO")).toHaveLength(1);
  });
  it("rejects malformed publication support flags without negotiating them", async () => {
    const result = request({ type: "MM_STATUS" });
    const port = ports[0]!;
    const helloCommand = port.posted[0]!;
    const response: NativeReply = {
      protocol_version: 1,
      request_id: helloCommand.request_id,
      type: "HELLO",
      payload: {
        ready: true,
        version: "0.1.0",
        platform: "darwin",
        arch: "arm64",
        max_duration_seconds: 900,
      },
    };
    for (const flag of ["true", 1, null, []]) {
      port.emit({
        ...response,
        payload: {
          ...response.payload,
          background_publication_supported: flag,
        },
      } as unknown as NativeReply);
      await flush();
      expect(port.posted).toHaveLength(1);
    }
    port.emit(response);
    expect(((await result) as ExtensionStatus).hello).toEqual(response.payload);
    expect(port.posted).toHaveLength(1);
  });
  it("forwards saving snapshots without reloading or stopping the player", async () => {
    const { update } = await publicationSession();
    const stops = stoppedAudioCount();
    const loads = runtimeSend.mock.calls.filter(
      ([message]) => message.type === "MM_AUDIO_LOAD",
    ).length;
    vi.mocked(chrome.tabs.sendMessage).mockClear();
    for (const save_state of ["pending", "saving", "saved"] as const) {
      update(save_state);
      await flush();
      expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(17, {
        type: "MM_JOB",
        generation: 1,
        payload: expect.objectContaining({ state: "READY", save_state }),
      });
    }
    expect(
      runtimeSend.mock.calls.filter(
        ([message]) => message.type === "MM_AUDIO_LOAD",
      ),
    ).toHaveLength(loads);
    expect(stoppedAudioCount()).toBe(stops);
  });
  it("bounds failed acknowledgement retries and keeps playback active", async () => {
    const { port, acknowledgements } = await publicationSession();
    const stops = stoppedAudioCount();
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    const acknowledgement = acknowledgements()[0]!;
    port.emit({
      protocol_version: 1,
      request_id: acknowledgement.request_id,
      type: "ERROR",
      payload: { error_code: "LOCAL_COMPANION_BUSY" },
    });
    await flush();
    for (let index = 0; index < 10; index++)
      await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    expect(acknowledgements()).toHaveLength(1);
    expect(errors()).toEqual([]);
    expect(stoppedAudioCount()).toBe(stops);
    await vi.advanceTimersByTimeAsync(5_001);
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    expect(acknowledgements()).toHaveLength(2);
  });
  it("records Start-to-first-playing once, bound to the active job", async () => {
    const { snapshot, port } = await publicationSession();
    await vi.advanceTimersByTimeAsync(120);
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    const events = port.posted.filter(
      (command) =>
        command.type === "EVENT" &&
        command.payload.metrics?.stage === "start-to-playback",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      payload: {
        event: "stage_completed",
        job_id: snapshot.job_id,
        metrics: {
          stage: "start-to-playback",
          duration_ms: expect.any(Number),
        },
      },
    });
  });
  it("releases after transient contention while continuous playback emits only one trusted state", async () => {
    const { snapshot, port, acknowledgements } = await publicationSession();
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    port.emit({
      protocol_version: 1,
      request_id: acknowledgements()[0]!.request_id,
      type: "ERROR",
      payload: { error_code: "LOCAL_COMPANION_BUSY" },
    });
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    expect(acknowledgements()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(acknowledgements()).toHaveLength(2);
    port.emit({
      protocol_version: 1,
      request_id: acknowledgements()[1]!.request_id,
      type: "JOB",
      payload: snapshot,
    });
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(acknowledgements()).toHaveLength(2);
    expect(errors()).toEqual([]);
  });
  it("does not disconnect a playing session when publication acknowledgement times out", async () => {
    const { port, acknowledgements } = await publicationSession();
    const stops = stoppedAudioCount();
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(port.port.disconnect).not.toHaveBeenCalled();
    expect(errors()).toEqual([]);
    expect(stoppedAudioCount()).toBe(stops);
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    expect(acknowledgements()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(acknowledgements()).toHaveLength(2);
    port.emit({
      protocol_version: 1,
      request_id: acknowledgements()[1]!.request_id,
      type: "JOB",
      payload: null,
    });
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(acknowledgements()).toHaveLength(2);
    expect(errors()).toEqual([]);
  });
  it("bounds permanent acknowledgement failures to six commands without interrupting playback", async () => {
    const { port, acknowledgements } = await publicationSession();
    const stops = stoppedAudioCount();
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    for (let attempt = 1; attempt <= 6; attempt++) {
      expect(acknowledgements()).toHaveLength(attempt);
      port.emit({
        protocol_version: 1,
        request_id: acknowledgements().at(-1)!.request_id,
        type: "ERROR",
        payload: { error_code: "COMMUNITY_OUTBOX_UNSAFE" },
      });
      await flush();
      if (attempt < 6)
        await vi.advanceTimersByTimeAsync(
          Math.min(5_000, 1_000 * 2 ** (attempt - 1)) + 1,
        );
    }
    await vi.advanceTimersByTimeAsync(30_000);
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    expect(acknowledgements()).toHaveLength(6);
    expect(errors()).toEqual([]);
    expect(stoppedAudioCount()).toBe(stops);
    expect(port.port.disconnect).not.toHaveBeenCalled();
  });
  it.each(["pause", "stop", "disconnect"])(
    "cancels scheduled publication retry on %s",
    async (action) => {
      const { port, acknowledgements } = await publicationSession();
      await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
      port.emit({
        protocol_version: 1,
        request_id: acknowledgements()[0]!.request_id,
        type: "ERROR",
        payload: { error_code: "LOCAL_COMPANION_BUSY" },
      });
      await flush();
      if (action === "pause")
        await request({
          type: "MM_AUDIO_STATE",
          generation: 1,
          playing: false,
        });
      else if (action === "stop")
        await request(
          { type: "MM_STOP", generation: 1 },
          sender(17, "abcdefghijk"),
        );
      else {
        port.disconnect();
        await flush();
      }
      await vi.advanceTimersByTimeAsync(20_000);
      expect(acknowledgements()).toHaveLength(1);
      if (action !== "disconnect") expect(errors()).toEqual([]);
    },
  );
  it("resets retries when a new job reuses the page generation", async () => {
    const { port, acknowledgements } = await publicationSession();
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    port.emit({
      protocol_version: 1,
      request_id: acknowledgements()[0]!.request_id,
      type: "ERROR",
      payload: { error_code: "LOCAL_COMPANION_BUSY" },
    });
    await flush();
    const replacement = await start(17, 1);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(acknowledgements()).toHaveLength(1);
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    expect(acknowledgements()).toHaveLength(2);
    expect(acknowledgements()[1]?.payload).toEqual({
      job_id: replacement.job_id,
      video_id: replacement.video_id,
    });
  });
  it("ignores publication acknowledgements after Stop and for cloud results", async () => {
    const { snapshot, port, acknowledgements } = await publicationSession();
    const startCommand = port.posted.findLast((c) => c.type === "START")!;
    port.emit({
      protocol_version: 1,
      request_id: startCommand.request_id,
      type: "JOB",
      payload: { ...snapshot, provider: "ONLINE_MUSICMUTE" },
    });
    await flush();
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    expect(acknowledgements()).toEqual([]);
    await request(
      { type: "MM_STOP", generation: 1 },
      sender(17, "abcdefghijk"),
    );
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    expect(acknowledgements()).toEqual([]);
  });
  it("releases the idle helper after a delayed acknowledgement finishes following Stop", async () => {
    const { port, acknowledgements } = await publicationSession();
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    const acknowledgement = acknowledgements()[0]!;
    await request(
      { type: "MM_STOP", generation: 1 },
      sender(17, "abcdefghijk"),
    );
    expect(port.port.disconnect).not.toHaveBeenCalled();
    port.emit({
      protocol_version: 1,
      request_id: acknowledgement.request_id,
      type: "JOB",
      payload: null,
    });
    await flush();
    expect(port.port.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("production playback lifecycle regressions", () => {
  it("disconnects a timed-out native START so late work cannot outlive its owner", async () => {
    const result = request(
      {
        type: "MM_START",
        generation: 1,
        payload: {
          video_id: "abcdefghijk",
          duration_seconds: 19,
          provider: "LOCAL_MACOS",
        },
      },
      sender(17, "abcdefghijk"),
    );
    await flush();
    const port = ports[0]!;
    const disconnect = vi.fn();
    port.port.disconnect = disconnect;
    const hello = port.posted.find((c) => c.type === "HELLO")!;
    port.emit({
      protocol_version: 1,
      request_id: hello.request_id,
      type: "HELLO",
      payload: {
        ready: true,
        version: "0.1.0",
        platform: "darwin",
        arch: "arm64",
        max_duration_seconds: 900,
      },
    });
    await flush();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await result).toEqual({ ok: false, error: "COMPANION_TIMEOUT" });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(errors()).toEqual(["COMPANION_TIMEOUT"]);
  });
  it("releases a failed manual job before the next automatic video", async () => {
    enableAutoStart();
    const first = request(
      {
        type: "MM_START",
        generation: 1,
        payload: {
          video_id: "abcdefghijk",
          duration_seconds: 19,
          provider: "LOCAL_MACOS",
        },
      },
      sender(17, "abcdefghijk"),
    );
    const snapshot = await completeAdmission(first);
    const port = ports[0]!;
    const command = port.posted.findLast((c) => c.type === "START")!;
    port.emit({
      protocol_version: 1,
      request_id: command.request_id,
      type: "JOB",
      payload: {
        ...snapshot,
        state: "FAILED",
        stage: "failed",
        error_code: "SOURCE_UNAVAILABLE",
      },
    });
    await flush();
    await completeAdmission(
      automaticStart(17, 2, 19, "11111111111"),
      "11111111111",
    );
    expect(
      ports.flatMap((item) => item.posted).filter((c) => c.type === "START"),
    ).toHaveLength(2);
  });
  it("revokes the native grant after audio failure", async () => {
    const snapshot = await start(17, 1);
    await request({
      type: "MM_AUDIO_ERROR",
      generation: 1,
      code: "AUDIO_DECODE_FAILED",
    });
    await flush();
    expect(ports[0]!.posted).toContainEqual(
      expect.objectContaining({
        type: "CANCEL",
        payload: { job_id: snapshot.job_id },
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it("releases an abandoned page and permits another automatic owner", async () => {
    enableAutoStart();
    const snapshot = await start(17, 1);
    await vi.advanceTimersByTimeAsync(90_001);
    expect(ports[0]!.posted).toContainEqual(
      expect.objectContaining({
        type: "CANCEL",
        payload: { job_id: snapshot.job_id },
      }),
    );
    await completeAdmission(automaticStart(18, 2));
  });
  it("retains a paused live page across hidden-tab timer batching", async () => {
    await start(17, 1);
    for (let sequence = 1; sequence <= 6; sequence++) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(
        await request(
          {
            type: "MM_CLOCK",
            payload: { ...clock(1), paused: true, sequence },
          },
          sender(17, "abcdefghijk"),
        ),
      ).toEqual({ ok: true });
    }
    expect(ports[0]!.posted.some((c) => c.type === "CANCEL")).toBe(false);
    expect(ports[0]!.port.disconnect).not.toHaveBeenCalled();
  });
  it("retires ownership when delivery confirms the owning document is gone", async () => {
    const snapshot = await start(17, 1);
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValueOnce(
      new Error("no receiver"),
    );
    await request({ type: "MM_AUDIO_STATE", generation: 1, playing: true });
    await flush();
    expect(ports[0]!.posted).toContainEqual(
      expect.objectContaining({
        type: "CANCEL",
        payload: { job_id: snapshot.job_id },
      }),
    );
  });
  it("rejects clocks from an old document in a reused tab", async () => {
    enableAutoStart();
    const from = {
      ...sender(17, "abcdefghijk"),
      documentId: "current-document",
    };
    await completeAdmission(automaticStart(17, 1, 19, "abcdefghijk", from));
    expect(
      await request(
        { type: "MM_CLOCK", payload: clock(1) },
        { ...from, documentId: "old-document" },
      ),
    ).toEqual({ ok: false });
    expect(
      await request({ type: "MM_CLOCK", payload: clock(1) }, from),
    ).toEqual({ ok: true });
  });
  it("targets teardown only at the owning document after a tab reload", async () => {
    enableAutoStart();
    const from = {
      ...sender(17, "abcdefghijk"),
      documentId: "retired-document",
    };
    await completeAdmission(automaticStart(17, 1, 19, "abcdefghijk", from));
    vi.mocked(chrome.tabs.sendMessage).mockClear();
    await request({ type: "MM_STOP", generation: 1 }, from);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      17,
      { type: "MM_ERROR", code: "SESSION_STOPPED", generation: 1 },
      { documentId: "retired-document" },
    );
  });
  it("rejects a start for a video different from the current tab route", async () => {
    getTab.mockResolvedValue({
      id: 17,
      url: "https://www.youtube.com/watch?v=11111111111",
    } as chrome.tabs.Tab);
    const result = await request(
      {
        type: "MM_START",
        generation: 1,
        payload: {
          video_id: "abcdefghijk",
          duration_seconds: 19,
          provider: "LOCAL_MACOS",
        },
      },
      sender(17, "abcdefghijk"),
    );
    expect(result).toEqual({ ok: false, error: "UNSUPPORTED_VIDEO" });
    expect(ports).toEqual([]);
  });
  it("rejects non-offscreen playback notifications", async () => {
    await start(17, 1);
    vi.mocked(chrome.tabs.sendMessage).mockClear();
    expect(
      await request(
        { type: "MM_AUDIO_STATE", generation: 1, playing: true },
        {
          ...offscreenSender,
          url: `chrome-extension://${extensionId}/popup.html`,
        },
      ),
    ).toEqual({ ok: false });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { type: 1 },
    { type: "MM_CLOCK", payload: null },
    { type: "MM_CLOCK", payload: { ...clock(1), paused: "false" } },
  ])("rejects malformed envelopes without throwing", async (value) => {
    const result = await request(value as ExtensionMessage);
    expect(result).toEqual({ ok: false, error: "INVALID_MESSAGE" });
    expect(ports).toEqual([]);
  });
});

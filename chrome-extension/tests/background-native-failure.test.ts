import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeCommand, NativeReply } from "../src/shared/protocol";
import type {
  ExtensionMessage,
  ExtensionStatus,
} from "../src/extension/messages";

const startupRequestId = "00000000-0000-4000-8000-000000000000";
const extensionId = "musicmute-test-extension";
const popupSender: chrome.runtime.MessageSender = {
  id: extensionId,
  url: `chrome-extension://${extensionId}/popup.html`,
};
const pageSender: chrome.runtime.MessageSender = {
  id: extensionId,
  url: "https://www.youtube.com/watch?v=abcdefghijk",
  tab: { id: 17 } as chrome.tabs.Tab,
};
type MessageHandler = (
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
  respond: (response: unknown) => void,
) => unknown;

function mockPort(ownsNativeLock = true) {
  const messageListeners: ((reply: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  const posted: NativeCommand[] = [];
  const port = {
    onMessage: {
      addListener: vi.fn((listener: (reply: unknown) => void) => {
        messageListeners.push(listener);
      }),
    },
    onDisconnect: {
      addListener: vi.fn((listener: () => void) => {
        disconnectListeners.push(listener);
      }),
    },
    postMessage: vi.fn((command: NativeCommand) => posted.push(command)),
    disconnect: vi.fn(() => {
      if (ownsNativeLock) nativeExitingUntil = Date.now() + nativeExitDelayMs;
      for (const listener of disconnectListeners) listener();
    }),
  } as unknown as chrome.runtime.Port;
  return {
    port,
    posted,
    emit(reply: unknown) {
      for (const listener of messageListeners) listener(reply);
    },
    disconnect() {
      for (const listener of disconnectListeners) listener();
    },
  };
}
type MockPort = ReturnType<typeof mockPort>;
let ports: MockPort[];
let nativeExitDelayMs: number;
let nativeExitingUntil: number;
let stored: Record<string, unknown>;
let listener: MessageHandler | undefined;
let updateListener: (() => void) | undefined;
const runtimeSend = vi.fn<(message: unknown) => Promise<unknown>>();
const getTab = vi.fn<(id: number) => Promise<chrome.tabs.Tab>>();

function request(
  message: ExtensionMessage,
  sender = popupSender,
): Promise<unknown> {
  return new Promise((resolve) => {
    if (!listener) throw new Error("Background listener not installed");
    expect(listener(message, sender, resolve)).toBe(true);
  });
}
function startupError(code: string): NativeReply {
  return {
    protocol_version: 1,
    request_id: startupRequestId,
    type: "ERROR",
    payload: { error_code: code },
  };
}
function hello(requestId: string): NativeReply {
  return {
    protocol_version: 1,
    request_id: requestId,
    type: "HELLO",
    payload: {
      ready: true,
      version: "0.1.0",
      platform: "darwin",
      arch: "arm64",
      max_duration_seconds: 900,
    },
  };
}
async function flush(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}
function savedCodes(): unknown[] {
  const diagnostics = stored.musicmute_local_errors as
    { code?: string }[] | undefined;
  return diagnostics?.map((event) => event.code) ?? [];
}
function observe(promise: Promise<unknown>) {
  const settled = vi.fn();
  void promise.then(settled);
  return settled;
}
async function renderPopup(state: unknown) {
  const nodes = Object.fromEntries(
    [
      "status",
      "details",
      "report",
      "clear",
      "check",
      "check-summary",
      "check-results",
      "helper-title",
      "helper-pill",
      "helper-meta",
      "setup",
      "report-details",
      "diagnostic-count",
      "provider",
      "cloud",
      "language-settings",
      "language-status",
    ].map((id) => [
      `#${id}`,
      {
        textContent: "",
        disabled: false,
        open: false,
        value: "",
        addEventListener: vi.fn(),
        append: vi.fn(),
        setAttribute: vi.fn(),
      },
    ]),
  );
  const body = { dataset: {} as Record<string, string> };
  const element = () => ({
    textContent: "",
    setAttribute: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    append: vi.fn(),
  });
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("document", {
    documentElement: element(),
    createElement: element,
    querySelectorAll: () => [],
    body,
    querySelector: (selector: string) => nodes[selector],
  });
  runtimeSend.mockResolvedValue(state);
  await import("../src/extension/popup");
  await flush();
  return { nodes, body };
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  ports = [];
  nativeExitDelayMs = 0;
  nativeExitingUntil = 0;
  stored = {};
  listener = undefined;
  updateListener = undefined;
  runtimeSend.mockReset().mockResolvedValue(undefined);
  getTab
    .mockReset()
    .mockImplementation(async (id) => ({ id }) as chrome.tabs.Tab);
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("chrome", {
    runtime: {
      id: extensionId,
      getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
      connectNative: vi.fn(() => {
        const busy = Date.now() < nativeExitingUntil;
        const port = mockPort(!busy);
        ports.push(port);
        if (busy)
          queueMicrotask(() => port.emit(startupError("LOCAL_COMPANION_BUSY")));
        return port.port;
      }),
      onMessage: {
        addListener: vi.fn((callback: MessageHandler) => {
          listener = callback;
        }),
      },
      sendMessage: runtimeSend,
      reload: vi.fn(),
      onUpdateAvailable: {
        addListener: vi.fn((callback: () => void) => {
          updateListener = callback;
        }),
      },
    },
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
        set: vi.fn(async (values: Record<string, unknown>) =>
          Object.assign(stored, values),
        ),
      },
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
      update: vi.fn(async () => ({})),
      query: vi.fn(async () => [{ id: 17, url: pageSender.url }]),
      sendMessage: vi.fn(async () => undefined),
      onRemoved: { addListener: vi.fn() },
    },
  });
  await import("../src/extension/background");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native startup failure propagation through the actual background handler", () => {
  it.each([
    ["LOCAL_COMPANION_BUSY", "Close that session, then check again."],
    [
      "LOCAL_COMPANION_LOCK_UNSAFE",
      "inspect local diagnostics and repair setup",
    ],
    [
      "LOCAL_COMPANION_START_FAILED",
      "check readiness and export local diagnostics",
    ],
  ])(
    "settles pending commands promptly and preserves %s through disconnect and the popup",
    async (code, hint) => {
      const status = request({ type: "MM_STATUS" });
      const exported = observe(request({ type: "MM_DIAGNOSTICS" }));
      const statusSettled = observe(status);
      const port = ports[0]!;
      expect(port.posted.map((command) => command.type)).toEqual([
        "HELLO",
        "DIAGNOSTICS",
      ]);
      port.emit(startupError(code));
      port.disconnect();
      await flush();
      expect(statusSettled).toHaveBeenCalledOnce();
      expect(exported).toHaveBeenCalledWith({ ok: false, error: code });
      expect(vi.getTimerCount()).toBe(0);
      expect(savedCodes()).toEqual([code]);
      const state = (await status) as ExtensionStatus;
      expect(state.hello).toBeNull();
      expect(state.error).toBe(code);
      const { nodes, body } = await renderPopup(state);
      expect(body.dataset.helperState).toBe("setup");
      expect(nodes["#status"]!.textContent).toContain(hint);
      expect(nodes["#details"]!.textContent).toContain(`Last error: ${code}`);
      expect(nodes["#setup"]!.open).toBe(true);
    },
  );

  it("retires a failed idle port and ignores its replies while a fresh diagnostic command reconnects", async () => {
    const first = observe(request({ type: "MM_DIAGNOSTICS" }));
    const port = ports[0]!;
    port.emit(startupError("LOCAL_COMPANION_BUSY"));
    await flush();
    expect(first).toHaveBeenCalledWith({
      ok: false,
      error: "LOCAL_COMPANION_BUSY",
    });
    const posted = port.posted.length;
    const second = observe(request({ type: "MM_DIAGNOSTICS" }));
    port.emit(startupError("LOCAL_COMPANION_LOCK_UNSAFE"));
    port.disconnect();
    await flush();
    expect(second).not.toHaveBeenCalled();
    expect(ports).toHaveLength(2);
    ports[1]!.emit(startupError("LOCAL_COMPANION_BUSY"));
    await flush();
    expect(second).toHaveBeenCalledWith({
      ok: false,
      error: "LOCAL_COMPANION_BUSY",
    });
    expect(port.posted).toHaveLength(posted);
    expect(savedCodes()).toEqual([
      "LOCAL_COMPANION_BUSY",
      "LOCAL_COMPANION_BUSY",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let old port callbacks or old command rejections overwrite a newer failure", async () => {
    const previous = observe(request({ type: "MM_DIAGNOSTICS" }));
    const oldPort = ports[0]!;
    oldPort.emit(startupError("LOCAL_COMPANION_BUSY"));
    oldPort.disconnect();
    const current = observe(request({ type: "MM_DIAGNOSTICS" }));
    const newPort = ports[1]!;
    newPort.emit(startupError("LOCAL_COMPANION_LOCK_UNSAFE"));
    oldPort.emit(startupError("LOCAL_COMPANION_START_FAILED"));
    oldPort.emit(hello(newPort.posted[0]!.request_id));
    oldPort.disconnect();
    const status = observe(request({ type: "MM_STATUS" }));
    await flush();
    expect(previous).toHaveBeenCalledWith({
      ok: false,
      error: "LOCAL_COMPANION_BUSY",
    });
    expect(current).toHaveBeenCalledWith({
      ok: false,
      error: "LOCAL_COMPANION_LOCK_UNSAFE",
    });
    expect(status).toHaveBeenCalledWith(
      expect.objectContaining({
        hello: null,
        error: "LOCAL_COMPANION_LOCK_UNSAFE",
      }),
    );
    expect(savedCodes()).toEqual([
      "LOCAL_COMPANION_BUSY",
      "LOCAL_COMPANION_LOCK_UNSAFE",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a new port's pending HELLO untouched by old matching replies and disconnects", async () => {
    const previous = observe(request({ type: "MM_STATUS" }));
    const oldPort = ports[0]!;
    oldPort.disconnect();
    await flush();
    expect(previous).toHaveBeenCalledOnce();
    const current = observe(request({ type: "MM_STATUS" }));
    const newPort = ports[1]!;
    const reply = hello(newPort.posted[0]!.request_id);
    oldPort.emit(reply);
    oldPort.disconnect();
    await flush();
    expect(current).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    newPort.emit(reply);
    await flush();
    expect(current).toHaveBeenCalledWith(
      expect.objectContaining({ hello: reply.payload }),
    );
    expect(savedCodes()).toEqual(["COMPANION_DISCONNECTED"]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["null", null],
    ["array", []],
    [
      "wrong protocol",
      { ...startupError("LOCAL_COMPANION_BUSY"), protocol_version: 2 },
    ],
    [
      "wrong type",
      { ...startupError("LOCAL_COMPANION_BUSY"), type: "UNKNOWN" },
    ],
    ["wrong startup type", { ...hello(startupRequestId) }],
    [
      "missing payload",
      { protocol_version: 1, request_id: startupRequestId, type: "ERROR" },
    ],
    [
      "null payload",
      { ...startupError("LOCAL_COMPANION_BUSY"), payload: null },
    ],
    ["array payload", { ...startupError("LOCAL_COMPANION_BUSY"), payload: [] }],
    [
      "non-string code",
      { ...startupError("LOCAL_COMPANION_BUSY"), payload: { error_code: 7 } },
    ],
    ["unbounded code", startupError("X".repeat(81))],
    ["unknown code", startupError("UNRECOGNIZED_STARTUP_FAILURE")],
    ["raw text", startupError("https://private.invalid/?token=private-token")],
    [
      "extra raw fields",
      {
        ...startupError("LOCAL_COMPANION_BUSY"),
        payload: {
          error_code: "LOCAL_COMPANION_BUSY",
          path: "/Users/private/model",
        },
      },
    ],
    [
      "wrong request",
      {
        ...startupError("LOCAL_COMPANION_BUSY"),
        request_id: "11111111-1111-4111-8111-111111111111",
      },
    ],
    [
      "malformed request",
      { ...startupError("LOCAL_COMPANION_BUSY"), request_id: "not-a-request" },
    ],
  ])("keeps %s unsolicited startup input generic", async (_label, reply) => {
    const settled = observe(request({ type: "MM_DIAGNOSTICS" }));
    const port = ports[0]!;
    expect(() => port.emit(reply)).not.toThrow();
    await flush();
    expect(settled).not.toHaveBeenCalled();
    expect(savedCodes()).toEqual([]);
    port.disconnect();
    await flush();
    expect(settled).toHaveBeenCalledWith({
      ok: false,
      error: "COMPANION_DISCONNECTED",
    });
    expect(savedCodes()).toEqual(["COMPANION_DISCONNECTED"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores unknown reserved startup failures while a page is waiting to start", async () => {
    const started = observe(
      request(
        {
          type: "MM_START",
          generation: 1,
          payload: {
            video_id: "abcdefghijk",
            duration_seconds: 10,
            provider: "LOCAL_MACOS",
          },
        },
        pageSender,
      ),
    );
    await flush();
    const port = ports[0]!;
    port.emit(startupError("UNKNOWN_STARTUP_FAILURE"));
    await flush();
    expect(started).not.toHaveBeenCalled();
    expect(savedCodes()).toEqual([]);
    port.disconnect();
    await flush();
    expect(started).toHaveBeenCalledWith({
      ok: false,
      error: "COMPANION_DISCONNECTED",
    });
    expect(savedCodes()).toEqual(["COMPANION_DISCONNECTED"]);
  });

  it("reports the startup code once to the waiting video and settles its start command", async () => {
    const started = observe(
      request(
        {
          type: "MM_START",
          generation: 7,
          payload: {
            video_id: "abcdefghijk",
            duration_seconds: 10,
            provider: "LOCAL_MACOS",
          },
        },
        pageSender,
      ),
    );
    await flush();
    const port = ports[0]!;
    port.emit(startupError("LOCAL_COMPANION_BUSY"));
    port.disconnect();
    await flush();
    expect(started).toHaveBeenCalledWith({
      ok: false,
      error: "LOCAL_COMPANION_BUSY",
    });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(17, {
      type: "MM_ERROR",
      code: "LOCAL_COMPANION_BUSY",
      generation: 7,
    });
    expect(savedCodes()).toEqual(["LOCAL_COMPANION_BUSY"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves solicited ERROR replies without treating their codes as startup failures", async () => {
    const settled = observe(request({ type: "MM_DIAGNOSTICS" }));
    const port = ports[0]!;
    const reply = {
      ...startupError("LOCAL_COMPANION_BUSY"),
      request_id: port.posted[0]!.request_id,
    };
    port.emit(reply);
    await flush();
    expect(settled).toHaveBeenCalledWith(reply);
    expect(savedCodes()).toEqual([]);
    port.disconnect();
    await flush();
    expect(savedCodes()).toEqual([]);
  });
});

describe("saved native processing selection", () => {
  const confirmationScope = "a".repeat(64);
  function begin(
    options: {
      confirmed?: boolean;
      automatic?: boolean;
      provider?: "LOCAL_MACOS" | "ONLINE_MUSICMUTE";
      scope?: string;
    } = {},
  ) {
    return request(
      {
        type: "MM_START",
        generation: 12,
        ...(options.confirmed
          ? {
              cloud_confirmed: true,
              cloud_confirmation_scope: options.scope ?? confirmationScope,
            }
          : {}),
        ...(options.automatic ? { intent: "automatic" } : {}),
        payload: {
          video_id: "abcdefghijk",
          duration_seconds: 19,
          provider: options.provider ?? "LOCAL_MACOS",
        },
      },
      pageSender,
    );
  }
  function selection(
    port: MockPort,
    provider = "ONLINE_MUSICMUTE",
    ready = true,
    scope: string | undefined = confirmationScope,
  ) {
    const command = port.posted.findLast((item) => item.type === "HELLO")!;
    port.emit({
      ...hello(command.request_id),
      payload: {
        ...(hello(command.request_id).payload as object),
        ready,
        capabilities: ["processing_selection_v1"],
        processing_provider: provider,
        ...(scope !== undefined ? { processing_scope: scope } : {}),
      },
    });
  }
  function accepted(
    port: MockPort,
    provider: "LOCAL_MACOS" | "ONLINE_MUSICMUTE",
  ) {
    const command = port.posted.findLast((item) => item.type === "START")!;
    expect(command.payload).toEqual({
      video_id: "abcdefghijk",
      duration_seconds: 19,
      provider,
    });
    port.emit({
      protocol_version: 1,
      request_id: command.request_id,
      type: "JOB",
      payload: {
        job_id: "11111111-1111-4111-8111-111111111111",
        video_id: "abcdefghijk",
        provider,
        state: "DOWNLOADING",
        stage: "download",
      },
    });
  }
  it("asks for explicit confirmation without submitting cloud work", async () => {
    const result = begin();
    await flush();
    const port = ports[0]!;
    selection(port);
    expect(await result).toEqual({
      ok: false,
      error: "CLOUD_CONFIRMATION_REQUIRED",
      processing_provider: "ONLINE_MUSICMUTE",
      cloud_confirmation_scope: confirmationScope,
    });
    await flush();
    expect(port.posted.some((item) => item.type === "START")).toBe(false);
    expect(port.port.disconnect).toHaveBeenCalledOnce();
    expect(savedCodes()).toEqual([]);
  });
  it("routes a confirmed manual attempt through cloud despite no local model assertion", async () => {
    const result = begin({ confirmed: true });
    await flush();
    const port = ports[0]!;
    selection(port);
    await flush();
    accepted(port, "ONLINE_MUSICMUTE");
    expect(await result).toEqual({ ok: true });
  });
  it("requires a signed-in account before asking for cloud confirmation", async () => {
    const result = begin();
    await flush();
    const port = ports[0]!;
    const command = port.posted.findLast((item) => item.type === "HELLO")!;
    port.emit({
      ...hello(command.request_id),
      payload: {
        ...(hello(command.request_id).payload as object),
        capabilities: ["processing_selection_v1"],
        processing_provider: "ONLINE_MUSICMUTE",
      },
    });
    expect(await result).toEqual({
      ok: false,
      error: "ACCOUNT_REQUIRED",
      processing_provider: "ONLINE_MUSICMUTE",
    });
    expect(port.posted.some((item) => item.type === "START")).toBe(false);
  });
  it("rejects an account switch while the user's cloud confirmation is open", async () => {
    const first = begin();
    await flush();
    selection(ports[0]!);
    expect(await first).toMatchObject({
      cloud_confirmation_scope: confirmationScope,
    });
    await flush();
    const second = begin({ confirmed: true });
    await flush();
    const port = ports[1]!;
    selection(port, "ONLINE_MUSICMUTE", true, "b".repeat(64));
    expect(await second).toEqual({
      ok: false,
      error: "ACCOUNT_CHANGED",
      processing_provider: "ONLINE_MUSICMUTE",
    });
    expect(
      ports
        .flatMap((item) => item.posted)
        .some((item) => item.type === "START"),
    ).toBe(false);
  });
  it("rejects a malformed confirmation scope before connecting", async () => {
    for (const scope of [
      "private-account",
      "a".repeat(64) + "\n",
      "a".repeat(65),
    ])
      expect(await begin({ confirmed: true, scope })).toEqual({
        ok: false,
        error: "UNSUPPORTED_VIDEO",
      });
    expect(ports).toHaveLength(0);
  });
  it("negotiates saved selection only after the new helper advertises its additive provider field", async () => {
    const result = begin({ confirmed: true });
    await flush();
    const port = ports[0]!;
    const first = port.posted.findLast((item) => item.type === "HELLO")!;
    expect(first.payload).toEqual({});
    port.emit({
      ...hello(first.request_id),
      payload: {
        ...(hello(first.request_id).payload as object),
        capabilities: ["error_context_v1", "cloud_handoff_v1"],
        processing_provider: "ONLINE_MUSICMUTE",
        processing_scope: confirmationScope,
      },
    });
    await flush();
    const configured = port.posted.findLast((item) => item.type === "HELLO")!;
    expect(configured.request_id).not.toBe(first.request_id);
    expect(configured.payload).toEqual({
      capabilities: ["error_context_v1", "processing_selection_v1"],
    });
    selection(port);
    await flush();
    accepted(port, "ONLINE_MUSICMUTE");
    expect(await result).toEqual({ ok: true });
  });
  it("refuses automatic cloud processing even with a forged confirmation", async () => {
    Object.assign(stored, {
      "musicmute.settings.v1": { version: 1 },
      "musicmute.settings.v1.autoStartEnabled": true,
      "musicmute.settings.v1.maxDurationMinutes": 10,
    });
    const result = begin({ confirmed: true, automatic: true });
    await flush();
    const port = ports[0]!;
    selection(port);
    expect(await result).toEqual({
      ok: false,
      error: "AUTO_START_CLOUD_CONFIRMATION_REQUIRED",
      processing_provider: "ONLINE_MUSICMUTE",
    });
    expect(port.posted.some((item) => item.type === "START")).toBe(false);
  });
  it("reads the app choice again after confirmation and refuses a changed selection", async () => {
    const first = begin();
    await flush();
    selection(ports[0]!);
    await first;
    await flush();
    const second = begin({ confirmed: true });
    await flush();
    expect(ports).toHaveLength(2);
    selection(ports[1]!, "LOCAL_MACOS");
    expect(await second).toEqual({
      ok: false,
      error: "PROCESSING_SELECTION_CHANGED",
      processing_provider: "LOCAL_MACOS",
    });
    expect(
      ports
        .flatMap((port) => port.posted)
        .some((item) => item.type === "START"),
    ).toBe(false);
  });
  it("rejects a renderer cloud provider before connecting", async () => {
    expect(
      await begin({ provider: "ONLINE_MUSICMUTE", confirmed: true }),
    ).toEqual({
      ok: false,
      error: "UNSUPPORTED_VIDEO",
    });
    expect(ports).toHaveLength(0);
  });
  it("keeps old companions local without sending an unknown capability", async () => {
    const result = begin();
    await flush();
    const port = ports[0]!;
    const command = port.posted.findLast((item) => item.type === "HELLO")!;
    port.emit(hello(command.request_id));
    await flush();
    accepted(port, "LOCAL_MACOS");
    expect(await result).toEqual({ ok: true });
    expect(port.posted.filter((item) => item.type === "HELLO")).toHaveLength(1);
    expect(command.payload).toEqual({});
  });
  it("refreshes the selected provider on a connected companion before another start", async () => {
    const first = begin({ confirmed: true });
    await flush();
    const port = ports[0]!;
    selection(port);
    await flush();
    accepted(port, "ONLINE_MUSICMUTE");
    await first;
    await flush();
    const second = begin({ confirmed: true });
    await flush();
    const cancel = port.posted.findLast((item) => item.type === "CANCEL")!;
    expect(cancel).toBeDefined();
    port.emit({
      protocol_version: 1,
      request_id: cancel.request_id,
      type: "JOB",
      payload: null,
    });
    await flush();
    expect(port.posted.filter((item) => item.type === "HELLO")).toHaveLength(2);
    selection(port, "LOCAL_MACOS");
    expect(await second).toEqual({
      ok: false,
      error: "PROCESSING_SELECTION_CHANGED",
      processing_provider: "LOCAL_MACOS",
    });
    expect(port.posted.filter((item) => item.type === "START")).toHaveLength(1);
  });
  it("rejects invalid native selection values and waits for a valid handshake", async () => {
    const result = begin({ confirmed: true });
    const settled = observe(result);
    await flush();
    const port = ports[0]!;
    selection(port, "LOCAL_WINDOWS");
    await flush();
    expect(settled).not.toHaveBeenCalled();
    expect(port.posted.some((item) => item.type === "START")).toBe(false);
    selection(port, "ONLINE_MUSICMUTE", true, "a".repeat(64) + "\n");
    await flush();
    expect(settled).not.toHaveBeenCalled();
    selection(port);
    await flush();
    accepted(port, "ONLINE_MUSICMUTE");
    expect(await result).toEqual({ ok: true });
  });
  it("displays the saved cloud choice in the popup", async () => {
    const { nodes } = await renderPopup({
      hello: {
        ready: true,
        version: "0.1.0",
        platform: "darwin",
        arch: "arm64",
        max_duration_seconds: 900,
        capabilities: ["processing_selection_v1"],
        processing_provider: "ONLINE_MUSICMUTE",
      },
      job: null,
      diagnostics: [],
    });
    expect(nodes["#provider"]!.value).toBe("ONLINE_MUSICMUTE");
    expect(nodes["#status"]!.textContent).toContain("monthly allowance");
    expect(nodes["#status"]!.textContent).not.toContain("confirmation");
    expect(nodes["#helper-title"]!.textContent).toBe(
      "MusicMute cloud is selected",
    );
  });
  it("describes explicit cloud handoff without implying the app account is signed out", async () => {
    const { nodes } = await renderPopup({
      hello: null,
      job: null,
      diagnostics: [],
    });
    vi.stubGlobal("location", {
      href: "chrome-extension://fixture/popup.html",
    });
    runtimeSend.mockResolvedValue({
      ok: true,
      handoff_url: "musicmute-local://cloud?video_id=abcdefghijk",
    });
    const click = nodes["#cloud"]!.addEventListener.mock.calls.find(
      ([type]) => type === "click",
    )?.[1] as (() => void) | undefined;
    expect(click).toBeTypeOf("function");
    click!();
    await flush();
    expect(nodes["#details"]!.textContent).toContain(
      "review monthly allowance and confirm cloud processing",
    );
    expect(nodes["#details"]!.textContent).not.toContain("select your account");
    expect(nodes["#details"]!.textContent).toContain(
      "No cloud request was submitted by Chrome",
    );
    expect(location.href).toBe("musicmute-local://cloud?video_id=abcdefghijk");
    expect(runtimeSend).toHaveBeenLastCalledWith({ type: "MM_CLOUD_ACTIVE" });
  });
});

describe("compatible error context and explicit cloud app handoff", () => {
  async function expireStatus(reply?: NativeReply): Promise<void> {
    nativeExitDelayMs = 250;
    const status = request({ type: "MM_STATUS" });
    const port = ports[0]!;
    port.emit({
      ...(reply ?? hello(port.posted[0]!.request_id)),
      request_id: port.posted[0]!.request_id,
    });
    await status;
    await flush();
    await vi.advanceTimersByTimeAsync(1001);
    expect(port.port.disconnect).toHaveBeenCalledOnce();
  }
  function startAfterStatus(cloudScope?: string): Promise<unknown> {
    return request(
      {
        type: "MM_START",
        generation: 4,
        ...(cloudScope
          ? { cloud_confirmed: true, cloud_confirmation_scope: cloudScope }
          : {}),
        payload: {
          video_id: "abcdefghijk",
          duration_seconds: 19,
          provider: "LOCAL_MACOS",
        },
      },
      pageSender,
    );
  }
  async function finishIdleHandoff(): Promise<MockPort> {
    await flush();
    expect(savedCodes()).toEqual([]);
    expect(
      ports
        .flatMap((port) => port.posted)
        .some((command) => command.type === "START"),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    const port = ports.at(-1)!;
    expect(port.posted.map((command) => command.type)).toEqual(["HELLO"]);
    return port;
  }
  it("waits through our expired idle host's delayed lock release and submits START exactly once", async () => {
    await expireStatus();
    const starting = startAfterStatus();
    const port = await finishIdleHandoff();
    port.emit(hello(port.posted[0]!.request_id));
    await flush();
    const command = port.posted.find((command) => command.type === "START")!;
    port.emit({
      protocol_version: 1,
      request_id: command.request_id,
      type: "JOB",
      payload: {
        job_id: "11111111-1111-4111-8111-111111111111",
        video_id: "abcdefghijk",
        provider: "LOCAL_MACOS",
        state: "DOWNLOADING",
        stage: "download",
      },
    });
    expect(await starting).toEqual({ ok: true });
    expect(
      ports
        .flatMap((item) => item.posted)
        .filter((item) => item.type === "START"),
    ).toHaveLength(1);
    expect(savedCodes()).toEqual([]);
  });
  it("ends bounded HELLO recovery with the genuine busy code if another session keeps the lock", async () => {
    await expireStatus();
    nativeExitingUntil = Date.now() + 10_000;
    const starting = startAfterStatus();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await starting).toEqual({
      ok: false,
      error: "LOCAL_COMPANION_BUSY",
    });
    expect(ports.length).toBeLessThanOrEqual(12);
    expect(
      ports
        .flatMap((item) => item.posted)
        .some((item) => item.type === "START"),
    ).toBe(false);
    expect(savedCodes()).toEqual(["LOCAL_COMPANION_BUSY"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("abandons HELLO recovery when Stop retires admission and then installs a waiting update", async () => {
    await expireStatus();
    const starting = startAfterStatus();
    await flush();
    const attempts = ports.length;
    updateListener!();
    expect(chrome.runtime.reload).not.toHaveBeenCalled();
    expect(
      await request({ type: "MM_STOP", generation: 4 }, pageSender),
    ).toEqual({ ok: true });
    expect(chrome.runtime.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(await starting).toEqual({ ok: false, error: "SESSION_STOPPED" });
    expect(ports).toHaveLength(attempts);
    expect(chrome.runtime.reload).toHaveBeenCalledOnce();
    expect(
      ports
        .flatMap((item) => item.posted)
        .some((item) => item.type === "START"),
    ).toBe(false);
    expect(savedCodes()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses the new helper's fresh account and processing choice after idle handoff", async () => {
    const initial = hello(startupRequestId);
    if (initial.type !== "HELLO") throw new Error("fixture");
    initial.payload.capabilities = ["processing_selection_v1"];
    initial.payload.processing_provider = "ONLINE_MUSICMUTE";
    initial.payload.processing_scope = "a".repeat(64);
    await expireStatus(initial);
    const starting = startAfterStatus("a".repeat(64));
    const port = await finishIdleHandoff();
    const fresh = hello(port.posted[0]!.request_id);
    if (fresh.type !== "HELLO") throw new Error("fixture");
    fresh.payload.capabilities = ["processing_selection_v1"];
    fresh.payload.processing_provider = "ONLINE_MUSICMUTE";
    fresh.payload.processing_scope = "b".repeat(64);
    port.emit(fresh);
    expect(await starting).toEqual({
      ok: false,
      error: "ACCOUNT_CHANGED",
      processing_provider: "ONLINE_MUSICMUTE",
    });
    expect(
      ports
        .flatMap((item) => item.posted)
        .some((item) => item.type === "START"),
    ).toBe(false);
    expect(savedCodes()).toEqual([]);
  });
  it("never retries START refused after a successful idle handoff", async () => {
    await expireStatus();
    const starting = startAfterStatus();
    const port = await finishIdleHandoff();
    port.emit(hello(port.posted[0]!.request_id));
    await flush();
    port.emit(startupError("LOCAL_COMPANION_BUSY"));
    expect(await starting).toEqual({
      ok: false,
      error: "LOCAL_COMPANION_BUSY",
    });
    const attempts = ports.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(ports).toHaveLength(attempts);
    expect(
      ports
        .flatMap((item) => item.posted)
        .filter((item) => item.type === "START"),
    ).toHaveLength(1);
    expect(savedCodes()).toEqual(["LOCAL_COMPANION_BUSY"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds the status handoff and reconnects after expiry only for an explicit fresh check", async () => {
    const first = request({ type: "MM_STATUS" });
    const port = ports[0]!;
    port.emit(hello(port.posted[0]!.request_id));
    await first;
    await flush();
    expect(port.port.disconnect).not.toHaveBeenCalled();
    expect(savedCodes()).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(
      ((await request({ type: "MM_STATUS" })) as ExtensionStatus).hello?.ready,
    ).toBe(true);
    expect(ports).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(port.port.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const fresh = request({ type: "MM_STATUS", refresh: true });
    const next = ports[1]!;
    next.emit(hello(next.posted[0]!.request_id));
    expect(((await fresh) as ExtensionStatus).hello?.ready).toBe(true);
    await flush();
    expect(next.port.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(next.port.disconnect).toHaveBeenCalledOnce();
    expect(savedCodes()).toEqual([]);
  });
  it("reuses a status helper for START while a retired native host would still hold its lock", async () => {
    nativeExitDelayMs = 250;
    const status = request({ type: "MM_STATUS", refresh: true });
    const port = ports[0]!;
    port.emit(hello(port.posted[0]!.request_id));
    await status;
    await flush();
    await vi.advanceTimersByTimeAsync(30);
    const starting = request(
      {
        type: "MM_START",
        generation: 4,
        payload: {
          video_id: "abcdefghijk",
          duration_seconds: 19,
          provider: "LOCAL_MACOS",
        },
      },
      pageSender,
    );
    await flush();
    expect(ports).toHaveLength(1);
    expect(port.port.disconnect).not.toHaveBeenCalled();
    expect(
      port.posted.filter((command) => command.type === "HELLO"),
    ).toHaveLength(1);
    const command = port.posted.find((command) => command.type === "START")!;
    expect(command).toBeDefined();
    port.emit({
      protocol_version: 1,
      request_id: command.request_id,
      type: "JOB",
      payload: {
        job_id: "11111111-1111-4111-8111-111111111111",
        video_id: "abcdefghijk",
        provider: "LOCAL_MACOS",
        state: "DOWNLOADING",
        stage: "download",
      },
    });
    expect(await starting).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(port.port.disconnect).not.toHaveBeenCalled();
    expect(savedCodes()).toEqual([]);
  });
  it("releases a status helper immediately when an idle Chrome update arrives", async () => {
    const status = request({ type: "MM_STATUS" });
    const port = ports[0]!;
    port.emit(hello(port.posted[0]!.request_id));
    await status;
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    updateListener!();
    expect(chrome.runtime.reload).toHaveBeenCalledOnce();
    expect(port.port.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("finishes status capability negotiation on one port before installing a waiting Chrome update", async () => {
    const status = request({ type: "MM_STATUS" });
    const port = ports[0]!;
    const first = port.posted[0]!;
    updateListener!();
    expect(chrome.runtime.reload).not.toHaveBeenCalled();
    const reply = hello(first.request_id);
    if (reply.type !== "HELLO") throw new Error("fixture");
    reply.payload.capabilities = ["error_context_v1"];
    port.emit(reply);
    await flush();
    expect(chrome.runtime.reload).not.toHaveBeenCalled();
    expect(port.port.disconnect).not.toHaveBeenCalled();
    expect(ports).toHaveLength(1);
    const configured = port.posted.findLast(
      (command) => command.type === "HELLO",
    )!;
    expect(configured.request_id).not.toBe(first.request_id);
    expect(configured.payload).toEqual({ capabilities: ["error_context_v1"] });
    port.emit({ ...reply, request_id: configured.request_id });
    expect(((await status) as ExtensionStatus).hello?.ready).toBe(true);
    await flush();
    expect(chrome.runtime.reload).toHaveBeenCalledOnce();
    expect(port.port.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(savedCodes()).toEqual([]);
  });
  it("keeps cache cancellation and its clear command on the same port while an update waits", async () => {
    nativeExitDelayMs = 250;
    const status = request({ type: "MM_STATUS" });
    const port = ports[0]!;
    port.emit(hello(port.posted[0]!.request_id));
    await status;
    await flush();
    const starting = request(
      {
        type: "MM_START",
        generation: 4,
        payload: {
          video_id: "abcdefghijk",
          duration_seconds: 19,
          provider: "LOCAL_MACOS",
        },
      },
      pageSender,
    );
    await flush();
    const start = port.posted.find((command) => command.type === "START")!;
    port.emit({
      protocol_version: 1,
      request_id: start.request_id,
      type: "JOB",
      payload: {
        job_id: "11111111-1111-4111-8111-111111111111",
        video_id: "abcdefghijk",
        provider: "LOCAL_MACOS",
        state: "DOWNLOADING",
        stage: "download",
      },
    });
    expect(await starting).toEqual({ ok: true });
    const clearing = request({ type: "MM_CLEAR_CACHE" });
    updateListener!();
    await flush();
    expect(chrome.runtime.reload).not.toHaveBeenCalled();
    expect(port.port.disconnect).not.toHaveBeenCalled();
    expect(ports).toHaveLength(1);
    const cancel = port.posted.find((command) => command.type === "CANCEL")!;
    expect(cancel).toBeDefined();
    expect(port.posted.some((command) => command.type === "CLEAR_CACHE")).toBe(
      false,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(port.port.disconnect).not.toHaveBeenCalled();
    port.emit({
      protocol_version: 1,
      request_id: cancel.request_id,
      type: "JOB",
      payload: null,
    });
    await flush();
    const command = port.posted.find(
      (command) => command.type === "CLEAR_CACHE",
    )!;
    expect(command).toBeDefined();
    expect(port.port.disconnect).not.toHaveBeenCalled();
    expect(chrome.runtime.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(port.port.disconnect).not.toHaveBeenCalled();
    port.emit({
      protocol_version: 1,
      request_id: command.request_id,
      type: "JOB",
      payload: null,
    });
    await clearing;
    await flush();
    expect(chrome.runtime.reload).toHaveBeenCalledOnce();
    expect(port.port.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(savedCodes()).toEqual([]);
  });
  it("preserves genuine other-session busy failures without replaying START", async () => {
    const status = request({ type: "MM_STATUS" });
    const port = ports[0]!;
    port.emit(startupError("LOCAL_COMPANION_BUSY"));
    await status;
    await flush();
    expect(savedCodes()).toEqual(["LOCAL_COMPANION_BUSY"]);
    expect(
      port.posted
        .filter((command) => command.type !== "EVENT")
        .map((command) => command.type),
    ).toEqual(["HELLO"]);
    expect(port.port.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  async function handshake(port: MockPort, ready = true): Promise<void> {
    const first = port.posted.findLast((command) => command.type === "HELLO")!;
    port.emit({
      ...hello(first.request_id),
      payload: {
        ...(hello(first.request_id).payload as object),
        ready,
        capabilities: ["error_context_v1", "cloud_handoff_v1"],
      },
    });
    await flush();
    const configured = port.posted.findLast(
      (command) => command.type === "HELLO",
    )!;
    expect(configured.request_id).not.toBe(first.request_id);
    expect(configured.payload).toEqual({ capabilities: ["error_context_v1"] });
    port.emit({
      ...hello(configured.request_id),
      payload: {
        ...(hello(configured.request_id).payload as object),
        ready,
        capabilities: ["error_context_v1", "cloud_handoff_v1"],
      },
    });
    await flush();
  }
  it("opens the canonical public source for confirmation even if local models are not ready", async () => {
    const result = request(
      {
        type: "MM_CLOUD_HANDOFF",
        video_id: "abcdefghijk",
        duration_seconds: 120.1,
        generation: 1,
      },
      pageSender,
    );
    await flush();
    expect(await result).toEqual({
      ok: true,
      handoff_url:
        "musicmute-local://cloud?video_id=abcdefghijk&duration_seconds=121",
    });
    expect(ports).toHaveLength(0);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
  it("fences old companions without sending new commands or cloud work", async () => {
    const status = request({ type: "MM_STATUS" });
    await flush();
    const port = ports[0]!;
    port.emit(hello(port.posted[0]!.request_id));
    await status;
    const result = request({ type: "MM_CLOUD_ACTIVE" });
    expect(await result).toEqual({ ok: false, error: "APP_UPDATE_REQUIRED" });
    expect(port.posted).toHaveLength(1);
  });
  it("rejects a stale or forged source before connecting", async () => {
    getTab.mockResolvedValue({
      id: 17,
      url: "https://www.youtube.com/watch?v=other_video",
    } as chrome.tabs.Tab);
    expect(
      await request(
        { type: "MM_CLOUD_HANDOFF", video_id: "abcdefghijk", generation: 1 },
        pageSender,
      ),
    ).toEqual({ ok: false, error: "UNSUPPORTED_VIDEO" });
    expect(ports).toHaveLength(0);
  });
  it("rejects navigation during local cancellation before returning a cloud app link", async () => {
    const starting = request(
      {
        type: "MM_START",
        generation: 4,
        payload: {
          video_id: "abcdefghijk",
          duration_seconds: 19,
          provider: "LOCAL_MACOS",
        },
      },
      pageSender,
    );
    await flush();
    const port = ports[0]!;
    await handshake(port);
    const start = port.posted.findLast((command) => command.type === "START")!;
    port.emit({
      protocol_version: 1,
      request_id: start.request_id,
      type: "JOB",
      payload: {
        job_id: "11111111-1111-4111-8111-111111111111",
        video_id: "abcdefghijk",
        provider: "LOCAL_MACOS",
        state: "READY",
        stage: "ready",
      },
    });
    await starting;
    const result = request(
      { type: "MM_CLOUD_HANDOFF", generation: 4, video_id: "abcdefghijk" },
      pageSender,
    );
    await flush();
    const cancel = port.posted.findLast(
      (command) => command.type === "CANCEL",
    )!;
    expect(cancel).toBeDefined();
    getTab.mockResolvedValue({
      id: 17,
      url: "https://www.youtube.com/watch?v=11111111111",
    } as chrome.tabs.Tab);
    port.emit({
      protocol_version: 1,
      request_id: cancel.request_id,
      type: "JOB",
      payload: null,
    });
    expect(await result).toEqual({ ok: false, error: "UNSUPPORTED_VIDEO" });
    expect(
      port.posted.filter((command) => command.type === "START"),
    ).toHaveLength(1);
  });
  it("carries only validated failure evidence after the capability handshake", async () => {
    const starting = request(
      {
        type: "MM_START",
        generation: 4,
        payload: {
          video_id: "abcdefghijk",
          duration_seconds: 120,
          provider: "LOCAL_MACOS",
        },
      },
      pageSender,
    );
    await flush();
    const port = ports[0]!;
    await handshake(port);
    const start = port.posted.findLast((command) => command.type === "START")!;
    const context = {
      stage: "metadata",
      retry_at: Date.now() + 900_000,
      block_reason: "SOURCE_BOT_CHALLENGE",
    } as const;
    port.emit({
      protocol_version: 1,
      request_id: start.request_id,
      type: "ERROR",
      payload: { error_code: "ACQUISITION_COOLDOWN", error_context: context },
    });
    await flush();
    expect(await starting).toEqual({
      ok: false,
      error: "ACQUISITION_COOLDOWN",
      error_context: context,
    });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(17, {
      type: "MM_ERROR",
      code: "ACQUISITION_COOLDOWN",
      generation: 4,
      error_context: context,
    });
    const status = (await request({ type: "MM_STATUS" })) as ExtensionStatus;
    expect(status.error_context).toEqual(context);
    expect(status.diagnostics[0]?.recorded_at).toMatch(/Z$/);
  });
  it("installs a Chrome update immediately only while no processing or playback owns the extension", () => {
    updateListener!();
    expect(chrome.runtime.reload).toHaveBeenCalledOnce();
  });
  it("defers an update through active playback until Stop releases its native grant", async () => {
    const starting = request(
      {
        type: "MM_START",
        generation: 4,
        payload: {
          video_id: "abcdefghijk",
          duration_seconds: 19,
          provider: "LOCAL_MACOS",
        },
      },
      pageSender,
    );
    await flush();
    const port = ports[0]!;
    port.emit(hello(port.posted[0]!.request_id));
    await flush();
    const start = port.posted.findLast((command) => command.type === "START")!;
    port.emit({
      protocol_version: 1,
      request_id: start.request_id,
      type: "JOB",
      payload: {
        job_id: "11111111-1111-4111-8111-111111111111",
        video_id: "abcdefghijk",
        provider: "LOCAL_MACOS",
        state: "READY",
        stage: "ready",
      },
    });
    await starting;
    updateListener!();
    expect(chrome.runtime.reload).not.toHaveBeenCalled();
    const stopped = request({ type: "MM_STOP", generation: 4 }, pageSender);
    await flush();
    expect(chrome.runtime.reload).not.toHaveBeenCalled();
    const cancel = port.posted.findLast(
      (command) => command.type === "CANCEL",
    )!;
    expect(cancel).toBeDefined();
    port.emit({
      protocol_version: 1,
      request_id: cancel.request_id,
      type: "JOB",
      payload: null,
    });
    await stopped;
    expect(chrome.runtime.reload).toHaveBeenCalledOnce();
    expect(port.port.disconnect).toHaveBeenCalledOnce();
  });
});

describe("manual installation checks", () => {
  async function connectForCheck() {
    const status = request({ type: "MM_STATUS" });
    await flush();
    const port = ports[0]!;
    const greeting = hello(port.posted[0]!.request_id);
    if (greeting.type !== "HELLO") throw new Error("fixture");
    greeting.payload.installation_check_supported = true;
    greeting.payload.installation_id = "a".repeat(64);
    port.emit(greeting);
    await status;
    return port;
  }
  const progress = () => ({
    installation_id: "a".repeat(64),
    started_at: Date.now(),
    state: "running" as const,
    checks: ["runtime", "model", "youtube_tools"].map((component) => ({
      component,
      state: "running",
    })),
  });
  it("reuses the status port and defers idle expiry and a Chrome update through the complete check", async () => {
    nativeExitDelayMs = 250;
    const port = await connectForCheck();
    await flush();
    const checking = request({ type: "MM_CHECK" });
    await flush();
    const command = port.posted.find((command) => command.type === "CHECK")!;
    expect(command).toBeDefined();
    expect(ports).toHaveLength(1);
    expect(port.posted.filter((item) => item.type === "HELLO")).toHaveLength(1);
    port.emit({
      protocol_version: 1,
      request_id: command.request_id,
      type: "CHECK",
      payload: progress(),
    });
    updateListener!();
    await vi.advanceTimersByTimeAsync(1500);
    expect(port.port.disconnect).not.toHaveBeenCalled();
    expect(chrome.runtime.reload).not.toHaveBeenCalled();
    port.emit({
      protocol_version: 1,
      request_id: command.request_id,
      type: "CHECK",
      payload: {
        ...progress(),
        state: "passed",
        completed_at: Date.now(),
        checks: progress().checks.map((check) => ({
          ...check,
          state: "passed",
        })),
      },
    });
    expect(await checking).toMatchObject({ ok: true });
    await flush();
    expect(chrome.runtime.reload).toHaveBeenCalledOnce();
    expect(port.port.disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(savedCodes()).toEqual([]);
  });
  it("opens status without a check and coalesces duplicate manual checks", async () => {
    const initial = await connectForCheck();
    expect(initial.posted.some((command) => command.type === "CHECK")).toBe(
      false,
    );
    const first = request({ type: "MM_CHECK" });
    const second = request({ type: "MM_CHECK" });
    await flush();
    const port = ports.at(-1)!;
    const greeting = hello(port.posted[0]!.request_id);
    if (greeting.type !== "HELLO") throw new Error("fixture");
    greeting.payload.installation_check_supported = true;
    greeting.payload.installation_id = "a".repeat(64);
    port.emit(greeting);
    await flush();
    const commands = port.posted.filter((command) => command.type === "CHECK");
    expect(commands).toHaveLength(1);
    const payload = {
      ...progress(),
      state: "passed",
      completed_at: Date.now(),
      checks: progress().checks.map((check) => ({ ...check, state: "passed" })),
    };
    port.emit({
      protocol_version: 1,
      request_id: commands[0]!.request_id,
      type: "CHECK",
      payload,
    });
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    expect(stored.musicmute_installation_check).toEqual(payload);
  });
  it("settles a disconnected running check as failed so the popup can retry", async () => {
    await connectForCheck();
    const checking = request({ type: "MM_CHECK" });
    await flush();
    const port = ports.at(-1)!;
    const greeting = hello(port.posted[0]!.request_id);
    if (greeting.type !== "HELLO") throw new Error("fixture");
    greeting.payload.installation_check_supported = true;
    greeting.payload.installation_id = "a".repeat(64);
    port.emit(greeting);
    await flush();
    const command = port.posted.find((command) => command.type === "CHECK")!;
    port.emit({
      protocol_version: 1,
      request_id: command.request_id,
      type: "CHECK",
      payload: progress(),
    });
    port.disconnect();
    expect(await checking).toMatchObject({ ok: false });
    expect(stored.musicmute_installation_check).toMatchObject({
      state: "failed",
    });
  });
  it("rejects page-triggered checks", async () => {
    expect(await request({ type: "MM_CHECK" }, pageSender)).toEqual({
      ok: false,
    });
    expect(ports).toHaveLength(0);
  });
});

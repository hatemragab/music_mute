import { afterEach, beforeEach, expect, it, vi } from "vitest";

type MessageHandler = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (value: unknown) => void,
) => boolean | void;
const extensionId = "acmgefmmndomcpdlgnafkjbgobinllep";
let stop: (() => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("__MUSICMUTE_LOCAL_DEBUG__", true);
  vi.stubGlobal("__MUSICMUTE_LOCAL_PAYLOADS__", true);
  vi.stubGlobal("__MUSICMUTE_LOCAL_CONSOLE__", false);
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("document", { body: { append: vi.fn() } });
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "__MUSICMUTE_LOCAL_LOG_STATUS__");
  vi.unstubAllGlobals();
});

it.each([
  "runtime-only",
  "storage-getter-fails",
  "storage-listener-fails",
  "storage-supported",
])(
  "starts enabled debug offscreen playback with %s Chrome APIs",
  async (capability) => {
    let handler: MessageHandler | undefined;
    const records: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
      records.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", fetcher);
    const addStorageListener = vi.fn(() => {
      if (capability === "storage-listener-fails")
        throw new Error("SYNTHETIC_PRIVATE_STORAGE_FAILURE");
    });
    const runtimeOnly = {
      runtime: {
        id: extensionId,
        sendMessage: vi.fn(async () => undefined),
        onMessage: {
          addListener: (value: MessageHandler) => {
            handler = value;
          },
        },
      },
    };
    if (capability === "storage-getter-fails")
      Object.defineProperty(runtimeOnly, "storage", {
        get() {
          throw new Error("SYNTHETIC_PRIVATE_STORAGE_FAILURE");
        },
      });
    else if (capability !== "runtime-only")
      Object.assign(runtimeOnly, {
        storage: { onChanged: { addListener: addStorageListener } },
      });
    vi.stubGlobal("chrome", runtimeOnly);

    await expect(import("../src/extension/offscreen")).resolves.toBeDefined();
    const { localDiagnostics } = await import("../src/extension/local-debug");
    stop = localDiagnostics.stop;
    expect(localDiagnostics.status().enabled).toBe(true);
    expect(records).toContainEqual(
      expect.objectContaining({
        name: "lifecycle.started",
        source: "chrome-extension",
        data: { context: "extension_page" },
      }),
    );
    expect(handler).toBeTypeOf("function");
    const respond = vi.fn();
    handler!(
      { type: "MM_AUDIO_STOP" },
      {
        id: extensionId,
        url: `chrome-extension://${extensionId}/background.js`,
      },
      respond,
    );
    expect(respond).toHaveBeenCalledWith({ ok: true });
    expect(addStorageListener).toHaveBeenCalledTimes(
      capability === "storage-supported" ||
        capability === "storage-listener-fails"
        ? 1
        : 0,
    );
    expect(
      fetcher.mock.calls.every(([url]) =>
        String(url).startsWith("http://127.0.0.1:19740/ingest/"),
      ),
    ).toBe(true);
    expect(JSON.stringify(records)).not.toContain(
      "SYNTHETIC_PRIVATE_STORAGE_FAILURE",
    );
  },
);

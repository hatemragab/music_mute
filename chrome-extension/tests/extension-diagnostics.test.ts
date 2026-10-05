import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitDiagnostic,
  installErrorCapture,
  isExtensionContextInvalidated,
} from "../src/extension/diagnostics";

let events: EventTarget;
let sendMessage: ReturnType<typeof vi.fn>;
let addEventListener: ReturnType<typeof vi.fn>;
let removeEventListener: ReturnType<typeof vi.fn>;
const disposers: (() => void)[] = [];

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  events = new EventTarget();
  sendMessage = vi.fn().mockResolvedValue({ ok: true });
  addEventListener = vi.fn(events.addEventListener.bind(events));
  removeEventListener = vi.fn(events.removeEventListener.bind(events));
  vi.stubGlobal("addEventListener", addEventListener);
  vi.stubGlobal("removeEventListener", removeEventListener);
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.unstubAllGlobals();
});

describe("extension diagnostic delivery", () => {
  it("preserves only the supplied structured diagnostic fields", async () => {
    emitDiagnostic("playback_drift", undefined, { drift_ms: 24 });
    emitDiagnostic("diagnostic_error", "AUDIO_CONTEXT_LOST", {
      stage: "content",
    });
    await flush();
    expect(sendMessage.mock.calls).toEqual([
      [
        {
          type: "MM_EVENT",
          payload: {
            component: "extension",
            severity: "info",
            event: "playback_drift",
            metrics: { drift_ms: 24 },
          },
        },
      ],
      [
        {
          type: "MM_EVENT",
          payload: {
            component: "extension",
            severity: "error",
            event: "diagnostic_error",
            code: "AUDIO_CONTEXT_LOST",
            metrics: { stage: "content" },
          },
        },
      ],
    ]);
  });

  it.each([
    new Error("Extension context invalidated."),
    "Extension context invalidated",
    new Error("PRIVATE_EXCEPTION https://private.invalid/media?token=secret"),
  ])(
    "swallows a synchronous messaging failure without another send",
    (error) => {
      sendMessage.mockImplementation(() => {
        throw error;
      });
      expect(() => emitDiagnostic("playback_started")).not.toThrow();
      expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
        type: "MM_EVENT",
        payload: {
          component: "extension",
          severity: "info",
          event: "playback_started",
        },
      });
    },
  );

  it("settles a rejected message safely without persisting its exception", async () => {
    sendMessage.mockRejectedValue(
      new Error("PRIVATE_EXCEPTION https://private.invalid/media?token=secret"),
    );
    expect(() => emitDiagnostic("playback_started")).not.toThrow();
    await flush();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(JSON.stringify(sendMessage.mock.calls)).not.toContain("PRIVATE");
    expect(JSON.stringify(sendMessage.mock.calls)).not.toContain("secret");
  });

  it("tolerates an unavailable runtime and a void message return", async () => {
    vi.stubGlobal("chrome", undefined);
    expect(() => emitDiagnostic("playback_started")).not.toThrow();
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    sendMessage.mockReturnValue(undefined);
    expect(() => emitDiagnostic("playback_started")).not.toThrow();
    await flush();
    expect(sendMessage).toHaveBeenCalledOnce();
  });
});

describe("extension error capture lifecycle", () => {
  it.each(["sync", "reject"])(
    "does not create recursive failures when diagnostic delivery fails by %s",
    async (failure) => {
      const privateError = new Error(
        "PRIVATE_EXCEPTION https://private.invalid/media?token=secret",
      );
      if (failure === "sync")
        sendMessage.mockImplementation(() => {
          throw privateError;
        });
      else sendMessage.mockRejectedValue(privateError);
      disposers.push(installErrorCapture("content"));
      const error = Object.assign(new Event("error"), {
        error: privateError,
        message: privateError.message,
      });
      const rejection = Object.assign(new Event("unhandledrejection"), {
        reason: privateError,
      });
      expect(() => events.dispatchEvent(error)).not.toThrow();
      expect(() => events.dispatchEvent(rejection)).not.toThrow();
      await flush();
      expect(sendMessage.mock.calls).toEqual(
        ["UNCAUGHT_ERROR", "UNHANDLED_REJECTION"].map((code) => [
          {
            type: "MM_EVENT",
            payload: {
              component: "extension",
              severity: "error",
              event: "diagnostic_error",
              code,
              metrics: { stage: "content" },
            },
          },
        ]),
      );
    },
  );

  it("removes both registered handlers once and stops capturing after disposal", async () => {
    const dispose = installErrorCapture("content");
    disposers.push(dispose);
    events.dispatchEvent(new Event("error"));
    events.dispatchEvent(new Event("unhandledrejection"));
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    dispose();
    dispose();
    expect(removeEventListener.mock.calls).toEqual(addEventListener.mock.calls);
    expect(removeEventListener).toHaveBeenCalledTimes(2);
    events.dispatchEvent(new Event("error"));
    events.dispatchEvent(new Event("unhandledrejection"));
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("disposes only its own capture when another capture remains installed", async () => {
    const first = installErrorCapture("content");
    disposers.push(first, installErrorCapture("popup"));
    first();
    events.dispatchEvent(new Event("error"));
    await flush();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      type: "MM_EVENT",
      payload: {
        component: "extension",
        severity: "error",
        event: "diagnostic_error",
        code: "UNCAUGHT_ERROR",
        metrics: { stage: "popup" },
      },
    });
  });
});

describe("extension context invalidation classification", () => {
  it.each([
    "Extension context invalidated",
    "Extension context invalidated.",
    new Error("Extension context invalidated"),
    new Error("Extension context invalidated."),
  ])("recognizes the exact invalidation message", (error) => {
    expect(isExtensionContextInvalidated(error)).toBe(true);
  });

  it.each([
    new Error("Could not establish connection. Receiving end does not exist."),
    new Error("The message port closed before a response was received."),
    new Error("Attempting to use a disconnected port object"),
    "Uncaught Error: Extension context invalidated.",
    "extension context invalidated.",
    "Extension context invalidated. ",
    "Extension context invalidated..",
    { message: "Extension context invalidated." },
    null,
    undefined,
    42,
    Symbol("Extension context invalidated."),
  ])(
    "does not classify transient or unknown errors as invalidation",
    (error) => {
      expect(isExtensionContextInvalidated(error)).toBe(false);
    },
  );

  it("safely rejects an Error whose message getter throws", () => {
    const error = new Error();
    Object.defineProperty(error, "message", {
      get() {
        throw new Error("PRIVATE_EXCEPTION");
      },
    });
    expect(isExtensionContextInvalidated(error)).toBe(false);
  });
});

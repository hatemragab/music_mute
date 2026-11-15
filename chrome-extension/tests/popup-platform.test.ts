import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Synthetic DOM/Chrome port: imports the actual popup receiver, without a browser.
class NodeFixture extends EventTarget {
  textContent = "";
  value = "";
  disabled = false;
  hidden = false;
  open = false;
  id = "";
  htmlFor = "";
  href = "";
  target = "";
  rel = "";
  dataset: Record<string, string> = {};
  children: NodeFixture[] = [];
  attributes = new Map<string, string>();
  append(...nodes: NodeFixture[]) {
    this.children.push(...nodes);
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
}
beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

async function receivedPopup(
  hello: { platform: string; arch: string } | null,
  locale: string,
  stage?: string,
) {
  const window = new EventTarget();
  const elements = new Map<string, NodeFixture>();
  const get = (selector: string) => {
    let node = elements.get(selector);
    if (!node) {
      node = new NodeFixture();
      elements.set(selector, node);
    }
    return node;
  };
  const changed = new Set<(...args: unknown[]) => void>();
  const sendMessage = vi.fn(async (request: { type: string }) => {
    if (request.type === "MM_STATUS")
      return {
        hello: hello
          ? {
              ...hello,
              ready: false,
              version: "0.1.3",
              error_code: "SETUP_REQUIRED",
            }
          : null,
        diagnostics: [],
        job: stage
          ? {
              job_id: "fixture-job",
              video_id: "jNQXAC9IVRw",
              provider:
                hello?.platform === "darwin" ? "LOCAL_MACOS" : "LOCAL_WINDOWS",
              state: "PROCESSING",
              stage,
            }
          : null,
        error: "SETUP_REQUIRED",
      };
    throw new Error("UNEXPECTED_EFFECT");
  });
  vi.stubGlobal("window", window);
  vi.stubGlobal("addEventListener", window.addEventListener.bind(window));
  vi.stubGlobal("removeEventListener", window.removeEventListener.bind(window));
  vi.stubGlobal("document", {
    body: new NodeFixture(),
    documentElement: new NodeFixture(),
    querySelector: get,
    querySelectorAll: () => [],
    createElement: () => new NodeFixture(),
  });
  vi.stubGlobal("chrome", {
    i18n: { getUILanguage: () => locale },
    runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    storage: {
      local: { get: async () => ({}) },
      onChanged: {
        addListener: (listener: (...args: unknown[]) => void) =>
          changed.add(listener),
        removeListener: (listener: (...args: unknown[]) => void) =>
          changed.delete(listener),
      },
    },
  });
  await import("../src/extension/popup");
  await vi.waitFor(() =>
    expect(get("#status").textContent).not.toContain("Connecting"),
  );
  // Wait for actual reply projection rather than the initial connecting copy.
  await vi.waitFor(() => expect(get("#setup").open).toBe(true));
  return { get, sendMessage, window, changed };
}

it.each([
  ["win32", "x64", "en-US", "Prepare this PC"],
  ["win32", "x64", "ar-EG", "تجهيز هذا الكمبيوتر"],
  ["darwin", "arm64", "en-US", "Prepare my Mac"],
  ["darwin", "arm64", "ar-EG", "Mac"],
])(
  "renders received %s/%s popup repair in %s",
  async (platform, arch, locale, expected) => {
    const f = await receivedPopup({ platform, arch }, locale);
    expect(f.get("#status").textContent).toContain(expected);
    if (platform === "win32")
      expect(f.get("#status").textContent).not.toMatch(/Mac|Apple Silicon/);
    expect(f.get("#companion-download").href).toBe(
      platform === "darwin"
        ? "https://github.com/ahmed-dev-1/musicmute-downloads/releases/tag/macos-store-companion-2026-10-07"
        : "https://music-mute.com/#downloads",
    );
    expect(f.get("#companion-download").rel).toBe("noopener noreferrer");
    const label = f.get("#companion-download [data-i18n]").textContent;
    expect(label).not.toMatch(/Windows.*(?:download|تنزيل)/i);
    if (platform === "win32") {
      expect(f.get("#platform-summary").textContent).toContain("Windows");
      expect(f.get("#app-open-help").textContent).not.toContain("Mac");
      expect(label).toContain(
        locale.startsWith("ar") ? "عرض تنزيلات" : "View MusicMute Downloads",
      );
    } else expect(label).toContain("Mac");
    expect(f.get("#helper-meta").textContent).toContain(
      platform === "darwin" ? "macOS" : "win32",
    );
    expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith({
      type: "MM_STATUS",
      refresh: true,
    });
    f.window.dispatchEvent(new Event("pagehide"));
    expect(f.changed.size).toBe(0);
  },
);

it("does not invent a Mac from an absent companion reply", async () => {
  const f = await receivedPopup(null, "en-US");
  expect(f.get("#helper-meta").textContent).toBe("Companion not connected");
  expect(f.get("#status").textContent).not.toMatch(
    /Mac|Apple Silicon|Prepare this PC/,
  );
  expect(f.get("#status").textContent).toContain("supported installation");
  expect(f.get("#companion-download").href).toBe(
    "https://music-mute.com/#downloads",
  );
  expect(f.get("#companion-download [data-i18n]").textContent).toBe(
    "View MusicMute Downloads",
  );
  expect(f.get("#platform-summary").textContent).not.toMatch(
    /Mac|Windows|Apple Silicon/,
  );
  f.window.dispatchEvent(new Event("pagehide"));
});
it.each([
  ["waiting-for-worker", "ar-EG", "في انتظار العامل في الخلفية"],
  ["gpu-busy", "ar-EG", "معالج الرسومات مشغول"],
  ["recovering", "ar-EG", "جارٍ استعادة المعالجة المحلية"],
  ["gpu-busy", "en-US", "GPU busy"],
])(
  "renders actual Windows popup stage %s in %s",
  async (stage, locale, expected) => {
    const f = await receivedPopup(
      { platform: "win32", arch: "x64" },
      locale,
      stage,
    );
    expect(f.get("#details").textContent).toContain(expected);
    expect(f.sendMessage).toHaveBeenCalledOnce();
    f.window.dispatchEvent(new Event("pagehide"));
  },
);
it("preserves the ordinary received Mac separation stage", async () => {
  const f = await receivedPopup(
    { platform: "darwin", arch: "arm64" },
    "en-US",
    "separation",
  );
  expect(f.get("#details").textContent).toContain("Job: separation");
  f.window.dispatchEvent(new Event("pagehide"));
});
it("does not label unsupported Windows ARM as Apple Silicon or offer a Mac release", async () => {
  const f = await receivedPopup({ platform: "win32", arch: "arm64" }, "en-US");
  expect(f.get("#helper-meta").textContent).toBe("win32 · arm64 · v0.1.3");
  expect(f.get("#status").textContent).not.toMatch(
    /Mac|Apple Silicon|Prepare this PC/,
  );
  expect(f.get("#companion-download").href).toBe(
    "https://music-mute.com/#downloads",
  );
  f.window.dispatchEvent(new Event("pagehide"));
});

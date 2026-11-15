import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";

class DisclosureNode {
  textContent = "";
  dataset: { i18n: string };
  attributes = new Map<string, string>();
  constructor(key = "") {
    this.dataset = { i18n: key };
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
}
afterEach(() => vi.unstubAllGlobals());
it.each(["en-US", "ar-EG"])(
  "localizes the actual dual-platform privacy document in %s without native/network work",
  async (locale) => {
    vi.resetModules();
    const html = await readFile(
      new URL("../src/extension/static/privacy.html", import.meta.url),
      "utf8",
    );
    const nodes = [...html.matchAll(/data-i18n="([^"]+)"/g)].map(
      (match) =>
        new DisclosureNode(
          match[1]!
            .replaceAll("&#x27;", "'")
            .replaceAll("&quot;", '"')
            .replaceAll("&amp;", "&"),
        ),
    );
    const root = new DisclosureNode();
    const window = new EventTarget();
    const sendMessage = vi.fn();
    const listeners = new Set<(...args: unknown[]) => void>();
    vi.stubGlobal("document", {
      documentElement: root,
      querySelectorAll: () => nodes,
    });
    vi.stubGlobal("window", window);
    vi.stubGlobal("chrome", {
      i18n: { getUILanguage: () => locale },
      runtime: { sendMessage },
      storage: {
        local: { get: async () => ({}) },
        onChanged: {
          addListener: (listener: (...args: unknown[]) => void) =>
            listeners.add(listener),
          removeListener: (listener: (...args: unknown[]) => void) =>
            listeners.delete(listener),
        },
      },
    });
    await import("../src/extension/privacy");
    await Promise.resolve();
    const text = nodes.map((node) => node.textContent).join("\n");
    expect(root.attributes.get("dir")).toBe(
      locale.startsWith("ar") ? "rtl" : "ltr",
    );
    expect(nodes.every((node) => node.textContent.trim().length > 0)).toBe(
      true,
    );
    expect(text).toContain("macOS");
    expect(text).toContain("DPAPI");
    expect(text).toContain("Windows");
    expect(text).toContain("R2");
    expect(text).not.toMatch(/Mac app|this Mac|Signing into the Mac|تطبيق Mac/);
    if (locale === "en-US") {
      expect(text).toContain("current-user DPAPI-protected storage");
      expect(text).toContain(
        "Automatic preparation never submits new cloud processing",
      );
      expect(text).toContain(
        "Account credentials remain in the desktop app and are not sent to Chrome",
      );
      expect(text).toContain(
        "they are not contributed to the shared YouTube catalog",
      );
      expect(text).toContain("After vocals start playing");
      expect(text).toContain("no automatic expiry");
      expect(text).toContain(
        "does not delete a shared result or cancel an already released background save",
      );
    }
    expect(sendMessage).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pagehide"));
    expect(listeners.size).toBe(0);
  },
);

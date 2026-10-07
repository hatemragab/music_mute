import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { arabic } from "../src/extension/translations";
import { readFile } from "node:fs/promises";
class ElementFixture extends EventTarget {
  textContent = "";
  value = "";
  disabled = false;
  id = "";
  htmlFor = "";
  children: ElementFixture[] = [];
  attributes = new Map<string, string>();
  append(...children: ElementFixture[]) {
    this.children.push(...children);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
}
function fixture(uiLanguage = "en-US", saved?: unknown) {
  const values: Record<string, unknown> =
    saved === undefined ? {} : { "musicmute.language.v1": saved };
  const listeners = new Set<
    (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => void
  >();
  const get = vi.fn(async (key: string) => ({ [key]: values[key] }));
  const change = (value: unknown, area = "local") => {
    values["musicmute.language.v1"] = value;
    for (const listener of listeners)
      listener({ "musicmute.language.v1": { newValue: value } }, area);
  };
  const set = vi.fn(async (patch: Record<string, unknown>) => {
    Object.assign(values, patch);
    change(patch["musicmute.language.v1"]);
  });
  vi.stubGlobal("chrome", {
    i18n: { getUILanguage: () => uiLanguage },
    storage: {
      local: { get, set },
      onChanged: {
        addListener: (l: never) => listeners.add(l),
        removeListener: (l: never) => listeners.delete(l),
      },
    },
  });
  vi.stubGlobal("document", { createElement: () => new ElementFixture() });
  return { values, listeners, get, set, change };
}
beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());
describe("extension languages", () => {
  it.each([
    ["ar", "ar"],
    ["ar-EG", "ar"],
    ["AR_sa", "ar"],
    ["en-US", "en"],
    ["fr", "en"],
    ["", "en"],
    ["arabic", "en"],
  ])(
    "detects Chrome UI language %s with English fallback",
    async (locale, expected) => {
      const storage = fixture(locale);
      const i18n = await import("../src/extension/i18n");
      const dispose = i18n.subscribeLanguage(() => {});
      expect(i18n.language()).toBe(expected);
      expect(i18n.resolveLanguage("en", locale)).toBe("en");
      expect(i18n.resolveLanguage("ar", locale)).toBe("ar");
      await vi.waitFor(() => expect(storage.get).toHaveBeenCalled());
      expect(storage.set).not.toHaveBeenCalled();
      dispose();
    },
  );
  it("restores a saved override across extension contexts and returns to automatic", async () => {
    const storage = fixture("ar-EG");
    let i18n = await import("../src/extension/i18n");
    const stop = i18n.subscribeLanguage(() => {});
    await i18n.saveLanguage("en");
    stop();
    vi.resetModules();
    i18n = await import("../src/extension/i18n");
    const stopAgain = i18n.subscribeLanguage(() => {});
    await vi.waitFor(() => expect(i18n.language()).toBe("en"));
    expect(storage.values).toEqual({ [i18n.LANGUAGE_KEY]: "en" });
    await i18n.saveLanguage("auto");
    expect(i18n.language()).toBe("ar");
    stopAgain();
    expect(storage.listeners.size).toBe(0);
  });
  it("updates text, accessible labels and direction across open views without replacing children", async () => {
    const storage = fixture();
    const i18n = await import("../src/extension/i18n");
    const localizer = i18n.createLocalizer();
    const panel = new ElementFixture();
    const label = new ElementFixture();
    const output = new ElementFixture();
    panel.append(label, output);
    localizer.text(label as unknown as Element, () => i18n.t("Stop"));
    localizer.attribute(panel as unknown as Element, "aria-label", () =>
      i18n.t("MusicMute audio"),
    );
    localizer.direction(panel as unknown as Element);
    storage.change("ar");
    expect(label.textContent).toBe("إيقاف");
    expect(panel.attributes.get("dir")).toBe("rtl");
    expect(panel.attributes.get("lang")).toBe("ar");
    expect(panel.children).toEqual([label, output]);
    storage.change("en", "sync");
    expect(label.textContent).toBe("إيقاف");
    storage.change("en");
    expect(label.textContent).toBe("Stop");
    localizer.dispose();
    storage.change("ar");
    expect(label.textContent).toBe("Stop");
  });
  it("keeps the previous choice and reenables the language selector when persistence fails", async () => {
    const storage = fixture("en");
    const i18n = await import("../src/extension/i18n");
    const localizer = i18n.createLocalizer();
    const error = vi.fn();
    const control = i18n.createLanguageSelect(localizer, "language", error);
    await vi.waitFor(() => expect(storage.get).toHaveBeenCalled());
    storage.set.mockRejectedValueOnce(new Error("unavailable"));
    control.select.value = "ar";
    control.select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(i18n.languagePreference()).toBe("auto");
    expect(i18n.language()).toBe("en");
    expect(control.select.value).toBe("auto");
    expect(control.select.disabled).toBe(false);
    control.dispose();
    localizer.dispose();
  });
  it("does not overwrite a newer choice with a late initial read", async () => {
    const storage = fixture();
    let resolve!: (value: Record<string, unknown>) => void;
    storage.get.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const i18n = await import("../src/extension/i18n");
    const stop = i18n.subscribeLanguage(() => {});
    storage.change("ar");
    resolve({ [i18n.LANGUAGE_KEY]: "en" });
    await Promise.resolve();
    expect(i18n.language()).toBe("ar");
    storage.change({ untrusted: "ar" });
    expect(i18n.languagePreference()).toBe("auto");
    stop();
  });
  it("uses English when Chrome i18n is unavailable", async () => {
    fixture();
    vi.stubGlobal("chrome", {});
    const i18n = await import("../src/extension/i18n");
    expect(i18n.language()).toBe("en");
    expect(i18n.t("Stop")).toBe("Stop");
  });
  it("preserves substitution identities in every Arabic translation and renders cooldowns safely", async () => {
    for (const [key, value] of Object.entries(arabic)) {
      expect(value.trim()).not.toBe("");
      expect([...value.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort()).toEqual(
        [...key.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort(),
      );
    }
    fixture("ar");
    const { failureGuidance } = await import("../src/extension/error-guidance");
    const guidance = failureGuidance(
      "SOURCE_BOT_CHALLENGE",
      { stage: "metadata", retry_at: 121_000 },
      1_000,
    );
    expect(guidance.message).toContain("2:00");
    expect(guidance.message).toContain("YouTube");
    expect(guidance.message).not.toContain("Retry available");
    expect(guidance.cloudPrimary).toBe(true);
  });
  it("keeps English/Arabic metadata and static page catalogs complete", async () => {
    for (const locale of ["ar", "en"]) {
      const messages = JSON.parse(
        await readFile(
          new URL(
            `../src/extension/static/_locales/${locale}/messages.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
      expect(messages.extensionName.message).toBeTruthy();
      expect(messages.extensionDescription.message).toBeTruthy();
    }
    for (const page of ["popup", "privacy"]) {
      const source = await readFile(
        new URL(`../src/extension/static/${page}.html`, import.meta.url),
        "utf8",
      );
      for (const match of source.matchAll(/data-i18n="([^"]+)"/g)) {
        const key = match[1]!
          .replaceAll("&#x27;", "'")
          .replaceAll("&quot;", '"')
          .replaceAll("&amp;", "&");
        expect(Object.hasOwn(arabic, key), key).toBe(true);
      }
    }
  });
  it("keeps static privacy fallback text identical to its localized disclosure", async () => {
    const source = await readFile(
      new URL("../src/extension/static/privacy.html", import.meta.url),
      "utf8",
    );
    const decode = (value: string) =>
      value
        .replaceAll("&#x27;", "'")
        .replaceAll("&quot;", '"')
        .replaceAll("&amp;", "&")
        .replace(/\s+/g, " ")
        .trim();
    for (const match of source.matchAll(
      /<(p|h[12]|title)\b[^>]*data-i18n="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g,
    )) {
      expect(decode(match[3]!), match[2]).toBe(decode(match[2]!));
    }
  });
});

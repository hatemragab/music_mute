import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class ElementFixture extends EventTarget {
  id = "";
  className = "";
  type = "";
  title = "";
  htmlFor = "";
  innerHTML = "";
  textContent = "";
  hidden = false;
  disabled = false;
  checked = false;
  value = "";
  min = "";
  max = "";
  step = "";
  focused = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: ElementFixture[] = [];
  style = {
    properties: new Map<string, string>(),
    setProperty(name: string, value: string) {
      this.properties.set(name, value);
    },
  };
  append(...children: ElementFixture[]): void {
    this.children.push(...children);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  focus(): void {
    this.focused = true;
  }
  click(): void {
    this.dispatchEvent(new Event("click", { cancelable: true }));
  }
}

function fixture() {
  const elements: ElementFixture[] = [];
  vi.stubGlobal("document", {
    createElement: () => {
      const element = new ElementFixture();
      elements.push(element);
      return element;
    },
  });
  const values: Record<string, unknown> = {};
  const listeners = new Set<
    (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => void
  >();
  const get = vi.fn(async (keys: string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keys)
      if (Object.hasOwn(values, key))
        result[key] = structuredClone(values[key]);
    return result;
  });
  const set = vi.fn(async (updates: Record<string, unknown>) => {
    Object.assign(values, structuredClone(updates));
    const changes: Record<string, chrome.storage.StorageChange> = {};
    for (const [key, value] of Object.entries(updates))
      changes[key] = { newValue: value };
    for (const listener of listeners) listener(changes, "local");
  });
  vi.stubGlobal("chrome", {
    storage: {
      local: { get, set },
      onChanged: {
        addListener: (
          listener: typeof listeners extends Set<infer L> ? L : never,
        ) => listeners.add(listener),
        removeListener: (
          listener: typeof listeners extends Set<infer L> ? L : never,
        ) => listeners.delete(listener),
      },
    },
  });
  const find = (idOrClass: string): ElementFixture => {
    const found = elements.find(
      (element) => element.id === idOrClass || element.className === idOrClass,
    );
    if (!found) throw new Error(`Missing fixture ${idOrClass}`);
    return found;
  };
  return {
    elements,
    values,
    get,
    set,
    listeners,
    find,
    panel: new ElementFixture(),
  };
}

describe("panel settings controls", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts a clean profile with auto-start enabled and no preference writes", async () => {
    const context = fixture();
    const { createPanelSettings } =
      await import("../src/extension/panel-settings");
    const callback = vi.fn();
    const settings = createPanelSettings(
      context.panel as unknown as HTMLElement,
      callback,
    );
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(callback.mock.lastCall?.[0]).toEqual({
      transparencyPercent: 5,
      autoStartEnabled: true,
      maxDurationMinutes: 20,
    });
    expect(context.find("musicmute-setting-autostart").checked).toBe(true);
    expect(
      context.find("musicmute-settings-toggle").children[1]?.textContent,
    ).toBe("Auto-start videos");
    expect(context.set).not.toHaveBeenCalled();
    settings.dispose();
  });

  it("restores an explicit auto-start opt-out after recreating the panel", async () => {
    const context = fixture();
    const { createPanelSettings } =
      await import("../src/extension/panel-settings");
    const callback = vi.fn();
    const settings = createPanelSettings(
      context.panel as unknown as HTMLElement,
      callback,
    );
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    const toggle = context.find("musicmute-setting-autostart");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(callback.mock.lastCall?.[0].autoStartEnabled).toBe(false),
    );
    settings.dispose();
    const reloadedContext = fixture();
    Object.assign(reloadedContext.values, structuredClone(context.values));
    vi.resetModules();
    const restarted = await import("../src/extension/panel-settings");
    const reloadedCallback = vi.fn();
    const reloadedSettings = restarted.createPanelSettings(
      reloadedContext.panel as unknown as HTMLElement,
      reloadedCallback,
    );
    await vi.waitFor(() => expect(reloadedCallback).toHaveBeenCalledTimes(1));
    expect(reloadedCallback.mock.lastCall?.[0].autoStartEnabled).toBe(false);
    expect(reloadedContext.find("musicmute-setting-autostart").checked).toBe(
      false,
    );
    expect(reloadedContext.set).not.toHaveBeenCalled();
    reloadedSettings.dispose();
  });

  it("restores settings, labels controls, previews background alpha and closes with Escape", async () => {
    const context = fixture();
    const { SETTINGS_KEY } = await import("../src/extension/settings");
    Object.assign(context.values, {
      [SETTINGS_KEY]: { version: 1 },
      [`${SETTINGS_KEY}.transparencyPercent`]: 40,
      [`${SETTINGS_KEY}.autoStartEnabled`]: true,
      [`${SETTINGS_KEY}.maxDurationMinutes`]: 8,
    });
    const { createPanelSettings } =
      await import("../src/extension/panel-settings");
    const callback = vi.fn();
    const settings = createPanelSettings(
      context.panel as unknown as HTMLElement,
      callback,
    );
    await vi.waitFor(() => expect(callback).toHaveBeenCalled());
    expect(callback.mock.lastCall?.[0]).toEqual({
      transparencyPercent: 40,
      autoStartEnabled: true,
      maxDurationMinutes: 8,
    });
    const gear = settings.button as unknown as ElementFixture;
    expect(gear.attributes.get("aria-label")).toBe("Extension settings");
    expect(gear.attributes.get("aria-controls")).toBe(settings.element.id);
    expect(context.find("musicmute-setting-transparency").value).toBe("40");
    expect(context.panel.style.properties.get("--musicmute-panel-alpha")).toBe(
      "0.6",
    );
    expect(context.find("musicmute-settings-reset").hidden).toBe(true);
    gear.click();
    expect(settings.element.hidden).toBe(false);
    expect(gear.attributes.get("aria-expanded")).toBe("true");
    expect(context.find("musicmute-setting-transparency").focused).toBe(true);
    const escape = new Event("keydown", { cancelable: true });
    Object.assign(escape, { key: "Escape" });
    settings.element.dispatchEvent(escape);
    expect(settings.element.hidden).toBe(true);
    expect(gear.attributes.get("aria-expanded")).toBe("false");
    expect(gear.focused).toBe(true);
    expect(escape.defaultPrevented).toBe(true);
    expect(context.set).not.toHaveBeenCalled();
    settings.dispose();
  });

  it("previews only the background before committing the debounced transparency", async () => {
    const context = fixture();
    const { createPanelSettings } =
      await import("../src/extension/panel-settings");
    const callback = vi.fn();
    const settings = createPanelSettings(
      context.panel as unknown as HTMLElement,
      callback,
    );
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    const input = context.find("musicmute-setting-transparency");
    input.value = "60";
    input.dispatchEvent(new Event("input"));
    expect(context.panel.style.properties.get("--musicmute-panel-alpha")).toBe(
      "0.4",
    );
    expect(context.panel.style.properties.has("opacity")).toBe(false);
    expect(context.set).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledTimes(1);
    input.value = "65";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(200);
    expect(context.set).toHaveBeenCalledTimes(1);
    expect(callback.mock.lastCall?.[0].transparencyPercent).toBe(65);
    expect(context.find("musicmute-settings-status").textContent).toBe(
      "Saved on this Chrome profile.",
    );
    settings.dispose();
  });

  it("keeps automatic playback off until a save succeeds and rolls back a failed toggle", async () => {
    const context = fixture();
    const { SETTINGS_KEY } = await import("../src/extension/settings");
    Object.assign(context.values, {
      [SETTINGS_KEY]: { version: 1 },
      [`${SETTINGS_KEY}.autoStartEnabled`]: false,
    });
    const { createPanelSettings } =
      await import("../src/extension/panel-settings");
    const callback = vi.fn();
    const settings = createPanelSettings(
      context.panel as unknown as HTMLElement,
      callback,
    );
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    const toggle = context.find("musicmute-setting-autostart");
    context.set.mockRejectedValueOnce(new Error("storage unavailable"));
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    expect(callback.mock.lastCall?.[0].autoStartEnabled).toBe(false);
    await vi.waitFor(() =>
      expect(context.find("musicmute-settings-status").dataset.error).toBe(
        "true",
      ),
    );
    expect(context.find("musicmute-settings-status").textContent).toContain(
      "Couldn’t save",
    );
    expect(toggle.checked).toBe(false);
    expect(callback).toHaveBeenCalledTimes(1);
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(callback.mock.lastCall?.[0].autoStartEnabled).toBe(true),
    );
    settings.dispose();
  });

  it("rejects invalid minute values and commits a valid limit", async () => {
    const context = fixture();
    const { createPanelSettings } =
      await import("../src/extension/panel-settings");
    const callback = vi.fn();
    const settings = createPanelSettings(
      context.panel as unknown as HTMLElement,
      callback,
    );
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    const duration = context.find("musicmute-setting-duration");
    for (const value of ["", "0", "21", "2.5", "NaN"]) {
      duration.value = value;
      duration.dispatchEvent(new Event("change"));
      expect(duration.value).toBe("20");
    }
    expect(context.set).not.toHaveBeenCalled();
    duration.value = "7";
    duration.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(callback.mock.lastCall?.[0].maxDurationMinutes).toBe(7),
    );
    settings.dispose();
  });

  it("shows a load failure with safe defaults and contains late results after disposal", async () => {
    const context = fixture();
    context.get.mockRejectedValueOnce(new Error("no storage"));
    const { createPanelSettings } =
      await import("../src/extension/panel-settings");
    const callback = vi.fn();
    const settings = createPanelSettings(
      context.panel as unknown as HTMLElement,
      callback,
    );
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(callback.mock.lastCall?.[0].autoStartEnabled).toBe(false);
    expect(context.find("musicmute-setting-autostart").checked).toBe(false);
    expect(context.find("musicmute-settings-status").textContent).toBe(
      "Couldn’t load settings. Auto-start is off.",
    );
    settings.dispose();
    settings.dispose();
    expect(context.listeners.size).toBe(0);
    settings.toggle();
    expect(settings.element.hidden).toBe(true);
    context
      .find("musicmute-setting-autostart")
      .dispatchEvent(new Event("change"));
    expect(context.set).not.toHaveBeenCalled();
  });

  it("synchronizes settings changes from another tab without reopening the panel", async () => {
    const context = fixture();
    const { createPanelSettings } =
      await import("../src/extension/panel-settings");
    const { saveSettings } = await import("../src/extension/settings");
    const callback = vi.fn();
    const settings = createPanelSettings(
      context.panel as unknown as HTMLElement,
      callback,
    );
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    await saveSettings({ transparencyPercent: 25, maxDurationMinutes: 12 });
    await vi.waitFor(() =>
      expect(callback.mock.lastCall?.[0].maxDurationMinutes).toBe(12),
    );
    expect(context.find("musicmute-setting-duration").value).toBe("12");
    expect(context.panel.style.properties.get("--musicmute-panel-alpha")).toBe(
      "0.75",
    );
    expect(settings.element.hidden).toBe(true);
    settings.dispose();
  });

  it("retains a slider change when the player removes its panel during debounce", async () => {
    const context = fixture();
    const { createPanelSettings } =
      await import("../src/extension/panel-settings");
    const { loadSettings } = await import("../src/extension/settings");
    const callback = vi.fn();
    const settings = createPanelSettings(
      context.panel as unknown as HTMLElement,
      callback,
    );
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    const input = context.find("musicmute-setting-transparency");
    input.value = "55";
    input.dispatchEvent(new Event("input"));
    settings.dispose();
    await vi.waitFor(() => expect(context.set).toHaveBeenCalledTimes(1));
    expect((await loadSettings()).transparencyPercent).toBe(55);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(context.listeners.size).toBe(0);
  });

  it("does not activate a checkbox before a delayed write has committed", async () => {
    const context = fixture();
    const { SETTINGS_KEY } = await import("../src/extension/settings");
    Object.assign(context.values, {
      [SETTINGS_KEY]: { version: 1 },
      [`${SETTINGS_KEY}.autoStartEnabled`]: false,
    });
    const { createPanelSettings } =
      await import("../src/extension/panel-settings");
    const callback = vi.fn();
    const settings = createPanelSettings(
      context.panel as unknown as HTMLElement,
      callback,
    );
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    let finish: (() => void) | undefined;
    const originalSet = context.set.getMockImplementation()!;
    context.set.mockImplementationOnce(
      (updates) =>
        new Promise<void>((resolve) => {
          finish = () => void originalSet(updates).then(resolve);
        }),
    );
    const toggle = context.find("musicmute-setting-autostart");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.lastCall?.[0].autoStartEnabled).toBe(false);
    expect(context.find("musicmute-settings-status").textContent).toBe(
      "Saving…",
    );
    finish!();
    await vi.waitFor(() =>
      expect(callback.mock.lastCall?.[0].autoStartEnabled).toBe(true),
    );
    settings.dispose();
  });

  it("ignores a delayed initial load after the panel is disposed", async () => {
    const context = fixture();
    let finish: ((value: Record<string, unknown>) => void) | undefined;
    context.get.mockImplementationOnce(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          finish = resolve;
        }),
    );
    const { createPanelSettings } =
      await import("../src/extension/panel-settings");
    const callback = vi.fn();
    const settings = createPanelSettings(
      context.panel as unknown as HTMLElement,
      callback,
    );
    expect(context.find("musicmute-setting-autostart").disabled).toBe(true);
    settings.dispose();
    finish!({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callback).not.toHaveBeenCalled();
    expect(context.listeners.size).toBe(0);
  });

  it("offers reset for corrupt settings and enables auto-start only after explicit reset", async () => {
    const context = fixture();
    const { SETTINGS_KEY } = await import("../src/extension/settings");
    Object.assign(context.values, {
      [SETTINGS_KEY]: { version: 2 },
      [`${SETTINGS_KEY}.autoStartEnabled`]: true,
      [`${SETTINGS_KEY}.transparencyPercent`]: 70,
      [`${SETTINGS_KEY}.maxDurationMinutes`]: 4,
    });
    const { createPanelSettings } =
      await import("../src/extension/panel-settings");
    const callback = vi.fn();
    const settings = createPanelSettings(
      context.panel as unknown as HTMLElement,
      callback,
    );
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(callback.mock.lastCall?.[0].autoStartEnabled).toBe(false);
    const reset = context.find("musicmute-settings-reset");
    expect(reset.hidden).toBe(true);
    const duration = context.find("musicmute-setting-duration");
    duration.value = "8";
    duration.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(reset.hidden).toBe(false));
    expect(context.find("musicmute-settings-status").textContent).toContain(
      "Reset settings",
    );
    context.find("musicmute-settings-reset").click();
    await vi.waitFor(() =>
      expect(callback.mock.lastCall?.[0]).toEqual({
        transparencyPercent: 5,
        autoStartEnabled: true,
        maxDurationMinutes: 20,
      }),
    );
    expect(context.find("musicmute-setting-autostart").checked).toBe(true);
    expect(context.find("musicmute-setting-duration").value).toBe("20");
    expect(context.panel.style.properties.get("--musicmute-panel-alpha")).toBe(
      "0.95",
    );
    await vi.waitFor(() => expect(reset.hidden).toBe(true));
    expect(context.values[SETTINGS_KEY]).toEqual({ version: 1 });
    expect(context.values[`${SETTINGS_KEY}.autoStartEnabled`]).toBe(true);
    settings.dispose();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ChangeListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

function storageFixture() {
  const values: Record<string, unknown> = {};
  const listeners = new Set<ChangeListener>();
  const get = vi.fn(async (keys: string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keys)
      if (Object.hasOwn(values, key))
        result[key] = structuredClone(values[key]);
    return result;
  });
  const set = vi.fn(async (updates: Record<string, unknown>) => {
    const changes: Record<string, chrome.storage.StorageChange> = {};
    for (const [key, value] of Object.entries(updates)) {
      changes[key] = {
        oldValue: values[key],
        newValue: structuredClone(value),
      };
      values[key] = structuredClone(value);
    }
    for (const listener of listeners) listener(changes, "local");
  });
  vi.stubGlobal("chrome", {
    storage: {
      local: { get, set },
      onChanged: {
        addListener: (listener: ChangeListener) => listeners.add(listener),
        removeListener: (listener: ChangeListener) =>
          listeners.delete(listener),
      },
    },
  });
  return { values, listeners, get, set };
}

describe("persisted extension settings", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("enables auto-start by default and normalizes only bounded typed fields", async () => {
    const { DEFAULT_SETTINGS, normalizeSettings } =
      await import("../src/extension/settings");
    expect(DEFAULT_SETTINGS).toEqual({
      transparencyPercent: 5,
      autoStartEnabled: true,
      maxDurationMinutes: 20,
    });
    for (const input of [null, undefined, [], "true", true, 42])
      expect(normalizeSettings(input)).toEqual({
        ...DEFAULT_SETTINGS,
        autoStartEnabled: false,
      });
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(
      normalizeSettings({
        transparencyPercent: 100,
        autoStartEnabled: "true",
        maxDurationMinutes: -4,
      }),
    ).toEqual({
      transparencyPercent: 80,
      autoStartEnabled: false,
      maxDurationMinutes: 1,
    });
    expect(
      normalizeSettings({
        transparencyPercent: NaN,
        autoStartEnabled: true,
        maxDurationMinutes: Infinity,
        cookie: "untrusted",
      }),
    ).toEqual({ ...DEFAULT_SETTINGS, autoStartEnabled: true });
    expect(
      normalizeSettings({ transparencyPercent: 17.5 }).transparencyPercent,
    ).toBe(18);
  });

  it("uses enabled defaults for clean storage without writing preferences", async () => {
    const storage = storageFixture();
    const settings = await import("../src/extension/settings");
    expect(await settings.loadSettings()).toEqual(settings.DEFAULT_SETTINGS);
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.values).toEqual({});
  });

  it("restores saved settings after a new extension context is created", async () => {
    const storage = storageFixture();
    const first = await import("../src/extension/settings");
    expect(await first.loadSettings()).toEqual(first.DEFAULT_SETTINGS);
    await first.saveSettings({
      transparencyPercent: 35,
      autoStartEnabled: true,
      maxDurationMinutes: 7,
    });
    expect(storage.values[first.SETTINGS_KEY]).toEqual({ version: 1 });
    vi.resetModules();
    const restarted = await import("../src/extension/settings");
    expect(await restarted.loadSettings()).toEqual({
      transparencyPercent: 35,
      autoStartEnabled: true,
      maxDurationMinutes: 7,
    });
    expect(storage.set.mock.calls[0]?.[0]).not.toHaveProperty("cookie");
  });

  it("preserves a saved auto-start opt-out after reload and another setting change", async () => {
    const storage = storageFixture();
    const first = await import("../src/extension/settings");
    await first.saveSettings({ autoStartEnabled: false });
    vi.resetModules();
    const restarted = await import("../src/extension/settings");
    expect((await restarted.loadSettings()).autoStartEnabled).toBe(false);
    expect(await restarted.saveSettings({ transparencyPercent: 35 })).toEqual({
      ...restarted.DEFAULT_SETTINGS,
      transparencyPercent: 35,
      autoStartEnabled: false,
    });
    expect(storage.values[`${first.SETTINGS_KEY}.autoStartEnabled`]).toBe(
      false,
    );
  });

  it("uses the enabled default for a missing field in the current schema", async () => {
    const storage = storageFixture();
    const settings = await import("../src/extension/settings");
    storage.values[settings.SETTINGS_KEY] = { version: 1 };
    storage.values[`${settings.SETTINGS_KEY}.transparencyPercent`] = 35;
    expect(await settings.loadSettings()).toEqual({
      ...settings.DEFAULT_SETTINGS,
      transparencyPercent: 35,
    });
    expect(storage.set).not.toHaveBeenCalled();
    expect(await settings.saveSettings({ transparencyPercent: 45 })).toEqual({
      ...settings.DEFAULT_SETTINGS,
      transparencyPercent: 45,
    });
    expect(storage.values).not.toHaveProperty(
      `${settings.SETTINGS_KEY}.autoStartEnabled`,
    );
  });

  it("preserves enabled defaults after a clean profile saves only transparency", async () => {
    const storage = storageFixture();
    const settings = await import("../src/extension/settings");
    expect(await settings.saveSettings({ transparencyPercent: 35 })).toEqual({
      ...settings.DEFAULT_SETTINGS,
      transparencyPercent: 35,
    });
    expect(storage.values[settings.SETTINGS_KEY]).toEqual({ version: 1 });
    expect(storage.values).not.toHaveProperty(
      `${settings.SETTINGS_KEY}.autoStartEnabled`,
    );
    vi.resetModules();
    const restarted = await import("../src/extension/settings");
    expect((await restarted.loadSettings()).autoStartEnabled).toBe(true);
  });

  it("does not enable automatic playback for corrupt or future settings", async () => {
    const storage = storageFixture();
    const settings = await import("../src/extension/settings");
    storage.values[`${settings.SETTINGS_KEY}.autoStartEnabled`] = true;
    for (const marker of [
      undefined,
      null,
      [],
      true,
      "true",
      {},
      { version: 2 },
      { version: "1" },
    ]) {
      storage.values[settings.SETTINGS_KEY] = marker;
      expect(await settings.loadSettings()).toEqual({
        ...settings.DEFAULT_SETTINGS,
        autoStartEnabled: false,
      });
    }
    delete storage.values[settings.SETTINGS_KEY];
    expect((await settings.loadSettings()).autoStartEnabled).toBe(false);
    await expect(
      settings.saveSettings({ transparencyPercent: 20 }),
    ).rejects.toThrow("SETTINGS_RESET_REQUIRED");
    expect(storage.set).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 0, 1, "true", "false", [], {}])(
    "keeps automatic playback off for a malformed saved boolean %j",
    async (value) => {
      const storage = storageFixture();
      const settings = await import("../src/extension/settings");
      storage.values[settings.SETTINGS_KEY] = { version: 1 };
      storage.values[`${settings.SETTINGS_KEY}.autoStartEnabled`] = value;
      expect((await settings.loadSettings()).autoStartEnabled).toBe(false);
      expect(storage.set).not.toHaveBeenCalled();
    },
  );

  it("keeps automatic playback off when only a latent transparency field is stored", async () => {
    const storage = storageFixture();
    const settings = await import("../src/extension/settings");
    storage.values[`${settings.SETTINGS_KEY}.transparencyPercent`] = 35;
    expect((await settings.loadSettings()).autoStartEnabled).toBe(false);
    await expect(
      settings.saveSettings({ transparencyPercent: 20 }),
    ).rejects.toThrow("SETTINGS_RESET_REQUIRED");
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("allows an explicit current-schema boolean to enable automatic playback", async () => {
    const storage = storageFixture();
    const settings = await import("../src/extension/settings");
    storage.values[settings.SETTINGS_KEY] = { version: 1 };
    storage.values[`${settings.SETTINGS_KEY}.autoStartEnabled`] = true;
    expect((await settings.loadSettings()).autoStartEnabled).toBe(true);
  });

  it("serializes writes and preserves independent changes from separate tabs", async () => {
    const storage = storageFixture();
    const first = await import("../src/extension/settings");
    vi.resetModules();
    const second = await import("../src/extension/settings");
    await Promise.all([
      first.saveSettings({ transparencyPercent: 20 }),
      first.saveSettings({ autoStartEnabled: true }),
      second.saveSettings({ maxDurationMinutes: 6 }),
    ]);
    expect(await first.loadSettings()).toEqual({
      transparencyPercent: 20,
      autoStartEnabled: true,
      maxDurationMinutes: 6,
    });
    for (const [update] of storage.set.mock.calls)
      expect(Object.keys(update)).toHaveLength(2);
  });

  it("rejects failed saves but allows the next write to succeed", async () => {
    const storage = storageFixture();
    const settings = await import("../src/extension/settings");
    storage.values[settings.SETTINGS_KEY] = { version: 1 };
    storage.values[`${settings.SETTINGS_KEY}.autoStartEnabled`] = false;
    storage.set.mockRejectedValueOnce(new Error("quota"));
    await expect(
      settings.saveSettings({ autoStartEnabled: true }),
    ).rejects.toThrow();
    expect((await settings.loadSettings()).autoStartEnabled).toBe(false);
    expect(await settings.saveSettings({ maxDurationMinutes: 8 })).toEqual({
      ...settings.DEFAULT_SETTINGS,
      autoStartEnabled: false,
      maxDurationMinutes: 8,
    });
  });

  it("reports a successful write as committed if only its follow-up read fails", async () => {
    const storage = storageFixture();
    const settings = await import("../src/extension/settings");
    storage.get.mockImplementationOnce(async () => ({}));
    storage.get.mockRejectedValueOnce(new Error("context ended after write"));
    expect(await settings.saveSettings({ autoStartEnabled: true })).toEqual({
      ...settings.DEFAULT_SETTINGS,
      autoStartEnabled: true,
    });
    expect(storage.values[`${settings.SETTINGS_KEY}.autoStartEnabled`]).toBe(
      true,
    );
  });

  it("subscribes to local settings changes, ignores other data and disposes", async () => {
    const storage = storageFixture();
    const settings = await import("../src/extension/settings");
    const callback = vi.fn();
    const dispose = settings.subscribeSettings(callback);
    for (const listener of storage.listeners) {
      listener({ other: { newValue: true } }, "local");
      listener(
        { [settings.SETTINGS_KEY]: { newValue: { version: 1 } } },
        "sync",
      );
    }
    expect(callback).not.toHaveBeenCalled();
    await settings.saveSettings({ maxDurationMinutes: 9 });
    await vi.waitFor(() => expect(callback).toHaveBeenCalled());
    expect(callback.mock.lastCall?.[0]).toEqual({
      ...settings.DEFAULT_SETTINGS,
      maxDurationMinutes: 9,
    });
    dispose();
    dispose();
    expect(storage.listeners.size).toBe(0);
    const count = callback.mock.calls.length;
    await settings.saveSettings({ maxDurationMinutes: 11 });
    expect(callback).toHaveBeenCalledTimes(count);
  });

  it("contains subscription read failures without enabling automatic playback", async () => {
    const storage = storageFixture();
    const settings = await import("../src/extension/settings");
    const callback = vi.fn();
    const dispose = settings.subscribeSettings(callback);
    storage.get.mockRejectedValue(new Error("unavailable"));
    for (const listener of storage.listeners)
      listener(
        { [settings.SETTINGS_KEY]: { newValue: { version: 1 } } },
        "local",
      );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callback).not.toHaveBeenCalled();
    dispose();
  });

  it("requires an explicit reset before repairing an unknown schema with old enabled fields", async () => {
    const storage = storageFixture();
    const settings = await import("../src/extension/settings");
    storage.values[settings.SETTINGS_KEY] = { version: 2 };
    storage.values[`${settings.SETTINGS_KEY}.autoStartEnabled`] = true;
    await expect(
      settings.saveSettings({ transparencyPercent: 20 }),
    ).rejects.toThrow("SETTINGS_RESET_REQUIRED");
    expect(storage.set).not.toHaveBeenCalled();
    expect((await settings.loadSettings()).autoStartEnabled).toBe(false);
    expect(
      await settings.saveSettings({ ...settings.DEFAULT_SETTINGS }),
    ).toEqual(settings.DEFAULT_SETTINGS);
    expect((await settings.loadSettings()).autoStartEnabled).toBe(true);
    expect(storage.values[`${settings.SETTINGS_KEY}.autoStartEnabled`]).toBe(
      true,
    );
  });
});

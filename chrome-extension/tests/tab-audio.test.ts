import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TabAudio } from "../src/extension/tab-audio";
let stored: Record<string, unknown>;
let muted: chrome.tabs.MutedInfo;
let audio: TabAudio;
beforeEach(() => {
  stored = {};
  muted = { muted: false };
  vi.stubGlobal("chrome", {
    runtime: { id: "fixture-extension" },
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
        set: vi.fn(async (values: Record<string, unknown>) =>
          Object.assign(stored, values),
        ),
      },
    },
    tabs: {
      get: vi.fn(async () => ({ mutedInfo: { ...muted } })),
      update: vi.fn(async (_tab: number, value: { muted: boolean }) => {
        muted = {
          muted: value.muted,
          reason: "extension",
          extensionId: "fixture-extension",
        };
      }),
    },
  });
  audio = new TabAudio();
});
afterEach(() => vi.unstubAllGlobals());
it("suppresses source audio, releases ads, reacquires, and restores on Stop", async () => {
  expect(await audio.set(1, "owner", true)).toBe(false);
  expect(muted.muted).toBe(true);
  await audio.set(1, "owner", false);
  expect(muted.muted).toBe(false);
  await audio.set(1, "owner", true);
  await audio.release(1, "owner");
  expect(muted.muted).toBe(false);
});
it("preserves pre-existing browser mute and tells the caller to silence vocals", async () => {
  muted = { muted: true, reason: "user" };
  expect(await audio.set(1, "owner", true)).toBe(true);
  await audio.set(1, "owner", false);
  await audio.release(1, "owner");
  expect(muted).toEqual({ muted: true, reason: "user" });
  expect(chrome.tabs.update).not.toHaveBeenCalled();
});
it("restores from memory after background restart", async () => {
  await audio.set(1, "owner", true);
  audio = new TabAudio();
  expect(await audio.set(1, "owner", true)).toBe(false);
  await audio.release(1, "owner");
  expect(muted.muted).toBe(false);
});
it("a late Stop cannot release the successor's mute", async () => {
  await audio.set(1, "old", true);
  await audio.set(1, "next", true);
  await audio.release(1, "old");
  expect(muted.muted).toBe(true);
  await audio.release(1, "next");
  expect(muted.muted).toBe(false);
});
it.each(["user", "other-extension"])(
  "does not overwrite a later %s choice",
  async (choice) => {
    await audio.set(1, "owner", true);
    muted =
      choice === "user"
        ? { muted: false, reason: "user" }
        : { muted: true, reason: "extension", extensionId: "other" };
    const expected = { ...muted };
    await audio.release(1, "owner");
    expect(muted).toEqual(expected);
  },
);
it("does not read or write browser state on unchanged playback clocks", async () => {
  await audio.set(1, "owner", true);
  for (let i = 0; i < 20; i++) await audio.set(1, "owner", true);
  expect(chrome.tabs.get).toHaveBeenCalledTimes(1);
  expect(chrome.storage.session.set).toHaveBeenCalledTimes(1);
});
it("cleans the lease after a tab is closed", async () => {
  await audio.set(1, "owner", true);
  vi.mocked(chrome.tabs.get).mockRejectedValue(new Error("Tab closed"));
  await expect(audio.release(1, "owner")).resolves.toBeUndefined();
  expect(Object.values(stored)).toEqual([null]);
});

it("a successor preserves a browser mute changed while the old Stop is pending", async () => {
  await audio.set(1, "old", true);
  muted = { muted: true, reason: "user" };
  expect(await audio.set(1, "next", true)).toBe(true);
  await audio.release(1, "old");
  await audio.release(1, "next");
  expect(muted).toEqual({ muted: true, reason: "user" });
});

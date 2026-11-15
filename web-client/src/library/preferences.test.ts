import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readLibraryPreferences,
  recordLibraryPlay,
  toggleLibraryPreference,
  useLibraryPreferences,
} from "./preferences";

describe("library preferences", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps favorites and hidden tracks owner scoped", () => {
    const first = toggleLibraryPreference(
      "owner-a",
      readLibraryPreferences("owner-a"),
      "favorites",
      "job-1",
    );
    toggleLibraryPreference("owner-a", first, "hidden", "job-2");

    expect(readLibraryPreferences("owner-a")).toEqual({
      favorites: ["job-1"],
      hidden: ["job-2"],
      playCounts: {},
    });
    expect(readLibraryPreferences("owner-b")).toEqual({
      favorites: [],
      hidden: [],
      playCounts: {},
    });
  });

  it("ignores malformed storage and removes an existing value", () => {
    localStorage.setItem("musicmute.web.library.owner-a", "not-json");
    expect(readLibraryPreferences("owner-a").favorites).toEqual([]);

    const current = { favorites: ["job-1"], hidden: [], playCounts: {} };
    expect(
      toggleLibraryPreference("owner-a", current, "favorites", "job-1")
        .favorites,
    ).toEqual([]);
  });

  it("migrates old data, validates counts, and keeps plays local to each owner", () => {
    localStorage.setItem(
      "musicmute.web.library.owner-a",
      JSON.stringify({ favorites: ["job-1"], hidden: [] }),
    );
    expect(readLibraryPreferences("owner-a").playCounts).toEqual({});
    recordLibraryPlay("owner-a", "job-1");
    recordLibraryPlay("owner-a", "job-1");
    expect(readLibraryPreferences("owner-a")).toEqual({
      favorites: ["job-1"],
      hidden: [],
      playCounts: { "job-1": 2 },
    });
    expect(readLibraryPreferences("owner-b").playCounts).toEqual({});
    localStorage.setItem(
      "musicmute.web.library.owner-a",
      JSON.stringify({
        playCounts: { a: -1, b: 1.5, c: "5", d: Number.MAX_SAFE_INTEGER, e: 4 },
      }),
    );
    expect(readLibraryPreferences("owner-a").playCounts).toEqual({
      d: Number.MAX_SAFE_INTEGER,
      e: 4,
    });
    recordLibraryPlay("owner-a", "d");
    expect(readLibraryPreferences("owner-a").playCounts.d).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("keeps player and Library consumers synchronized without losing counts or leaking owners", () => {
    const first = renderHook(({ uid }) => useLibraryPreferences(uid), {
      initialProps: { uid: "owner-a" },
    });
    const second = renderHook(() => useLibraryPreferences("owner-a"));
    act(() => first.result.current.toggle("favorites", "job-1"));
    expect(second.result.current.preferences.favorites).toEqual(["job-1"]);
    act(() => recordLibraryPlay("owner-a", "job-1"));
    act(() => second.result.current.toggle("hidden", "job-2"));
    expect(first.result.current.preferences).toEqual({
      favorites: ["job-1"],
      hidden: ["job-2"],
      playCounts: { "job-1": 1 },
    });
    first.rerender({ uid: "owner-b" });
    expect(first.result.current.preferences.favorites).toEqual([]);
  });

  it("updates from another browser tab and survives unavailable storage for this session", () => {
    const hook = renderHook(() => useLibraryPreferences("owner-a"));
    act(() => {
      localStorage.setItem(
        "musicmute.web.library.owner-a",
        JSON.stringify({ favorites: ["remote"], playCounts: { remote: 3 } }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: "musicmute.web.library.owner-a" }),
      );
    });
    expect(hook.result.current.preferences.playCounts).toEqual({ remote: 3 });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    act(() => recordLibraryPlay("owner-a", "remote"));
    act(() => hook.result.current.toggle("hidden", "remote"));
    expect(hook.result.current.preferences).toEqual({
      favorites: ["remote"],
      hidden: ["remote"],
      playCounts: { remote: 4 },
    });
  });
});

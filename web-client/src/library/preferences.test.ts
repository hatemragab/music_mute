import { beforeEach, describe, expect, it } from "vitest";
import { readLibraryPreferences, toggleLibraryPreference } from "./preferences";

describe("library preferences", () => {
  beforeEach(() => localStorage.clear());

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
    });
    expect(readLibraryPreferences("owner-b")).toEqual({
      favorites: [],
      hidden: [],
    });
  });

  it("ignores malformed storage and removes an existing value", () => {
    localStorage.setItem("musicmute.web.library.owner-a", "not-json");
    expect(readLibraryPreferences("owner-a").favorites).toEqual([]);

    const current = { favorites: ["job-1"], hidden: [] };
    expect(
      toggleLibraryPreference("owner-a", current, "favorites", "job-1")
        .favorites,
    ).toEqual([]);
  });
});

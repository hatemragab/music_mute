import { expect, test } from "vitest";
import type { JobView } from "../api/types";
import { queryLibrary } from "./query";

const jobs = [
  { id: "a", displayName: "Alpha", status: "ready", createdAt: "2026-10-01" },
  { id: "b", displayName: "Beta", status: "ready", createdAt: "2026-10-02" },
  { id: "c", displayName: "Charlie", status: "ready", createdAt: "2026-10-03" },
  { id: "d", displayName: "Deleted", status: "ready", createdAt: "2026-10-04" },
] as JobView[];
const preferences = {
  favorites: ["a", "c", "d"],
  hidden: ["d"],
  playCounts: { a: 4, b: 9, d: 100 },
};
const options = {
  search: "",
  sort: "newest" as const,
  filter: "all" as const,
  starredOnly: false,
};

test("Most Played ranks played tracks, excludes hidden/unplayed, and intersects stars/search", () => {
  const ids = (overrides: Partial<Parameters<typeof queryLibrary>[2]>) =>
    queryLibrary(jobs, preferences, { ...options, ...overrides }).map(
      (job) => job.id,
    );
  expect(ids({ filter: "mostPlayed" })).toEqual(["b", "a"]);
  expect(ids({ sort: "mostPlayed" })).toEqual(["b", "a", "c"]);
  expect(ids({ filter: "mostPlayed", starredOnly: true })).toEqual(["a"]);
  expect(ids({ starredOnly: true })).toEqual(["c", "a"]);
  expect(ids({ filter: "mostPlayed", search: " beta " })).toEqual(["b"]);
  expect(ids({ filter: "removed", starredOnly: true })).toEqual(["d"]);
});

test("ties remain stable across snapshot ordering and queries never mutate incoming jobs", () => {
  const matching = { ...preferences, playCounts: { a: 4, b: 4 } };
  const sameDate = jobs
    .slice(0, 2)
    .map((job) => ({ ...job, createdAt: "2026-10-01" }));
  expect(
    queryLibrary([...sameDate].reverse(), matching, {
      ...options,
      sort: "mostPlayed",
    }).map((job) => job.id),
  ).toEqual(["a", "b"]);
  queryLibrary(jobs, preferences, options);
  expect(jobs.map((job) => job.id)).toEqual(["a", "b", "c", "d"]);
});

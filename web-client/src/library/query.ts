import type { JobView } from "../api/types";
import { trackTitle } from "../player/playback";
import { playCount, type LibraryPreferences } from "./preferences";

export type LibrarySort = "newest" | "title" | "mostPlayed";
export type LibraryFilter = "all" | "mostPlayed" | "removed";

export function queryLibrary(
  jobs: JobView[],
  preferences: LibraryPreferences,
  options: {
    search: string;
    sort: LibrarySort;
    filter: LibraryFilter;
    starredOnly: boolean;
  },
): JobView[] {
  const search = options.search.trim().toLocaleLowerCase();
  const sort = options.filter === "mostPlayed" ? "mostPlayed" : options.sort;
  return jobs
    .filter(
      (job) =>
        job.status === "ready" &&
        trackTitle(job, "").toLocaleLowerCase().includes(search) &&
        (!options.starredOnly || preferences.favorites.includes(job.id)) &&
        (options.filter !== "mostPlayed" ||
          playCount(preferences, job.id) > 0) &&
        (options.filter === "removed"
          ? preferences.hidden.includes(job.id)
          : !preferences.hidden.includes(job.id)),
    )
    .sort((left, right) => {
      if (sort === "mostPlayed") {
        const countOrder =
          playCount(preferences, right.id) - playCount(preferences, left.id);
        if (countOrder) return countOrder;
      }
      if (sort === "title") {
        const titleOrder = trackTitle(left, "").localeCompare(
          trackTitle(right, ""),
        );
        if (titleOrder) return titleOrder;
      }
      return (
        Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
        left.id.localeCompare(right.id)
      );
    });
}

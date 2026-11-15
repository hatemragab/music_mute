export type LibraryFilter =
  "all" | "offline" | "online" | "starred" | "removed";
export type LibrarySort = "newest" | "title" | "most-played";
export interface LibraryQuery {
  search: string;
  filter: LibraryFilter;
  sort: LibrarySort;
  mostPlayedOnly: boolean;
  starredOnly: boolean;
}
export const DEFAULT_LIBRARY_QUERY: LibraryQuery = {
  search: "",
  filter: "all",
  sort: "newest",
  mostPlayedOnly: false,
  starredOnly: false,
};
export interface LibraryTrackView {
  id: string;
  jobId: string | null;
  title: string;
  sourceKind: "file" | "url";
  videoId: string | null;
  durationSeconds: number;
  sourceDurationSeconds: number;
  trimEnabled: boolean;
  offline: boolean;
  online: boolean;
  originalAvailable: boolean;
  accountOwned: boolean;
  thumbnailUrl: string | null;
  /** Bounded cached JPEG/WebP pixels; obtained from the trusted main process. */
  thumbnailDataUrl?: string | null;
  starred: boolean;
  removed: boolean;
  playCount: number;
  updatedAt: number | null;
  canRename: boolean;
  canDeleteAccount: boolean;
  canExport: boolean;
}
export interface LibraryView {
  revision: number;
  state: "loading" | "ready" | "error";
  accountState: "signed-out" | "connecting" | "live" | "disconnected" | "error";
  errorCode: string | null;
  query: LibraryQuery;
  tracks: LibraryTrackView[];
  visibleIds: string[];
  total: number;
  nextCursor: string | null;
}
export type LibraryAction =
  | { type: "QUERY"; query: LibraryQuery }
  | {
      type: "STAR" | "HIDE" | "RESTORE" | "REMOVE_CACHE" | "DELETE_LOCAL";
      trackId: string;
    }
  | { type: "RENAME"; trackId: string; title: string }
  | { type: "DELETE_ACCOUNT"; trackId: string; confirmation: string };
const TRACK = /^[A-Za-z0-9:_-]{1,160}$/u;
export function parseLibraryQuery(value: unknown): LibraryQuery {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_REQUEST");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join() !==
      "filter,mostPlayedOnly,search,sort,starredOnly" ||
    typeof row.search !== "string" ||
    row.search.length > 300 ||
    /[\p{Cc}]/u.test(row.search) ||
    !["all", "offline", "online", "starred", "removed"].includes(
      String(row.filter),
    ) ||
    !["newest", "title", "most-played"].includes(String(row.sort)) ||
    typeof row.mostPlayedOnly !== "boolean" ||
    typeof row.starredOnly !== "boolean"
  )
    throw new Error("INVALID_REQUEST");
  return row as unknown as LibraryQuery;
}
export function parseLibraryAction(value: unknown): LibraryAction {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_REQUEST");
  const row = value as Record<string, unknown>;
  if (row.type === "QUERY") {
    if (Object.keys(row).sort().join() !== "query,type")
      throw new Error("INVALID_REQUEST");
    return { type: "QUERY", query: parseLibraryQuery(row.query) };
  }
  if (typeof row.trackId !== "string" || !TRACK.test(row.trackId))
    throw new Error("INVALID_REQUEST");
  const keys =
    row.type === "RENAME"
      ? ["type", "trackId", "title"]
      : row.type === "DELETE_ACCOUNT"
        ? ["type", "trackId", "confirmation"]
        : ["type", "trackId"];
  if (Object.keys(row).sort().join() !== keys.sort().join())
    throw new Error("INVALID_REQUEST");
  if (
    ["STAR", "HIDE", "RESTORE", "REMOVE_CACHE", "DELETE_LOCAL"].includes(
      String(row.type),
    )
  )
    return row as unknown as LibraryAction;
  if (
    row.type === "RENAME" &&
    typeof row.title === "string" &&
    /^[^\p{Cc}\p{Cf}]{1,200}$/u.test(row.title) &&
    row.title.trim()
  )
    return row as unknown as LibraryAction;
  if (
    row.type === "DELETE_ACCOUNT" &&
    row.confirmation === "delete-account-item"
  )
    return row as unknown as LibraryAction;
  throw new Error("INVALID_REQUEST");
}

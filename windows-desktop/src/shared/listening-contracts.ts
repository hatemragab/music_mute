export interface PlaybackBookmark {
  id: string;
  seconds: number;
  title: string;
}
export interface ListeningView {
  loopStart: number | null;
  loopEnd: number | null;
  bookmarks: PlaybackBookmark[];
  sleepRemainingSeconds: number | null;
  skipSilence: boolean;
  analyzingSilence: boolean;
  error: "PREFERENCES_UNAVAILABLE" | "SILENCE_UNAVAILABLE" | null;
}
export type ListeningCommand =
  | { type: "SLEEP"; seconds: number }
  | { type: "LOOP_START" | "LOOP_END" | "LOOP_CLEAR" | "BOOKMARK_ADD" }
  | { type: "BOOKMARK_REMOVE" | "BOOKMARK_SEEK"; id: string }
  | { type: "BOOKMARK_RENAME"; id: string; title: string }
  | { type: "SKIP_SILENCE"; enabled: boolean };
export function parseListeningCommand(value: unknown): ListeningCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const exact = (keys: string[]) =>
    Object.keys(row).sort().join() === keys.sort().join();
  if (
    ["LOOP_START", "LOOP_END", "LOOP_CLEAR", "BOOKMARK_ADD"].includes(
      String(row.type),
    ) &&
    exact(["type"])
  )
    return row as ListeningCommand;
  if (
    row.type === "SLEEP" &&
    exact(["type", "seconds"]) &&
    Number.isSafeInteger(row.seconds) &&
    Number(row.seconds) >= 0 &&
    Number(row.seconds) <= 43200
  )
    return row as ListeningCommand;
  if (
    row.type === "SKIP_SILENCE" &&
    exact(["type", "enabled"]) &&
    typeof row.enabled === "boolean"
  )
    return row as ListeningCommand;
  if (
    ["BOOKMARK_REMOVE", "BOOKMARK_SEEK", "BOOKMARK_RENAME"].includes(
      String(row.type),
    ) &&
    typeof row.id === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
      row.id,
    ) &&
    exact(
      row.type === "BOOKMARK_RENAME" ? ["type", "id", "title"] : ["type", "id"],
    )
  ) {
    if (
      row.type === "BOOKMARK_RENAME" &&
      (typeof row.title !== "string" ||
        row.title.trim().length < 1 ||
        row.title.length > 80 ||
        /[\p{Cc}\p{Cf}]/u.test(row.title))
    )
      return null;
    return row as ListeningCommand;
  }
  return null;
}

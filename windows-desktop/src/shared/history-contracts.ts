export interface HistoryEntryView {
  aliases: string[];
  count: number;
  lastListenedAt: string;
  listenedSeconds: number;
  lastPosition: number;
}
export interface HistoryView {
  state:
    "loading" | "ready" | "recovery-required" | "unsupported" | "unavailable";
  errorCode: string | null;
  entries: HistoryEntryView[];
}
export interface HistoryTrack {
  id: string;
  jobId?: string | null;
  title: string;
}
export type HistoryCommand = { type: "RESTORE" | "RECOVER" | "CLEAR" };
export function parseHistoryCommand(value: unknown): HistoryCommand {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "type") ||
    !["RESTORE", "RECOVER", "CLEAR"].includes(
      String((value as Record<string, unknown>).type),
    )
  )
    throw new Error("HISTORY_COMMAND_INVALID");
  return value as HistoryCommand;
}

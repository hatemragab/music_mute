export type PlaybackVariant = "voice" | "original";
export type RepeatMode = "off" | "track" | "queue";
export type PlaybackPhase =
  "idle" | "preparing" | "buffering" | "paused" | "playing" | "error";
export interface PlaybackView {
  generation: string;
  trackId: string | null;
  phase: PlaybackPhase;
  variant: PlaybackVariant;
  position: number;
  sourcePosition: number;
  duration: number;
  url: string | null;
  requestedPlaying: boolean;
  seekRevision: number;
  rate: number;
  volume: number;
  muted: boolean;
  repeat: RepeatMode;
  shuffle: boolean;
  queue: string[];
  queueRevision?: number;
  error: "MEDIA_UNAVAILABLE" | "COMPARISON_TIMELINE_UNAVAILABLE" | null;
  listening?: ListeningView;
  timeCoordinate?: "original" | "voice-output";
  comparisonAvailable?: boolean;
}
export type PlaybackCommand =
  | ListeningCommand
  | { type: "LOAD"; trackId: string }
  | {
      type:
        "PLAY" | "PAUSE" | "STOP" | "MUTE" | "NEXT" | "PREVIOUS" | "RESTART";
    }
  | {
      type: "QUEUE_PLAY";
      generation: string;
      queueRevision: number;
      index: number;
      trackId: string;
    }
  | QueueEditCommand
  | { type: "SEEK"; seconds: number }
  | { type: "RATE"; rate: number }
  | { type: "VOLUME"; level: number }
  | { type: "SOURCE"; variant: PlaybackVariant }
  | { type: "REPEAT"; mode: RepeatMode }
  | { type: "SHUFFLE"; enabled: boolean }
  | { type: "QUEUE"; ids: string[] }
  | {
      type: "MEDIA_EVENT";
      generation: string;
      event:
        | "loaded"
        | "playing"
        | "paused"
        | "buffering"
        | "time"
        | "ended"
        | "seeked"
        | "error";
      position: number;
      seekRevision?: number;
    };
type QueueEditBase = {
  type: "QUEUE_EDIT";
  generation: string;
  queueRevision: number;
};
export type QueueEditCommand = QueueEditBase &
  (
    | { action: "append"; trackId: string }
    | { action: "insert-next"; trackId: string }
    | { action: "remove"; index: number; trackId: string }
    | { action: "move"; index: number; trackId: string; to: number }
    | { action: "clear" }
  );
/** Whole queue replacement is a trusted controller operation, never renderer intake. */
export type PlaybackUiCommand = Exclude<PlaybackCommand, { type: "QUEUE" }>;
export const TRACK_ID = /^[A-Za-z0-9:_-]{1,160}$/u;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export function parsePlaybackCommand(value: unknown): PlaybackCommand {
  const listening = parseListeningCommand(value);
  if (listening) return listening;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_REQUEST");
  const row = value as Record<string, unknown>;
  const keys = (expected: string[]) =>
    Object.keys(row).sort().join() === expected.sort().join();
  const finite = (key: string, min: number, max: number) =>
    typeof row[key] === "number" &&
    Number.isFinite(row[key]) &&
    (row[key] as number) >= min &&
    (row[key] as number) <= max;
  const queueFence = () =>
    typeof row.generation === "string" &&
    UUID.test(row.generation) &&
    Number.isSafeInteger(row.queueRevision) &&
    Number(row.queueRevision) >= 0;
  const queueIndex = (key: string) =>
    Number.isSafeInteger(row[key]) &&
    Number(row[key]) >= 0 &&
    Number(row[key]) < 1000;
  const track = () =>
    typeof row.trackId === "string" && TRACK_ID.test(row.trackId);
  if (row.type === "QUEUE_EDIT" && queueFence()) {
    const base = ["type", "generation", "queueRevision", "action"];
    if (
      (["append", "insert-next"].includes(String(row.action)) &&
        keys([...base, "trackId"]) &&
        track()) ||
      (row.action === "remove" &&
        keys([...base, "index", "trackId"]) &&
        queueIndex("index") &&
        track()) ||
      (row.action === "move" &&
        keys([...base, "index", "trackId", "to"]) &&
        queueIndex("index") &&
        queueIndex("to") &&
        track()) ||
      (row.action === "clear" && keys(base))
    )
      return row as QueueEditCommand;
  }
  if (
    ["PLAY", "PAUSE", "STOP", "MUTE", "NEXT", "PREVIOUS", "RESTART"].includes(
      String(row.type),
    ) &&
    keys(["type"])
  )
    return row as PlaybackCommand;
  if (
    row.type === "QUEUE_PLAY" &&
    keys(["type", "generation", "queueRevision", "index", "trackId"]) &&
    queueFence() &&
    queueIndex("index") &&
    track()
  )
    return row as PlaybackCommand;
  if (
    row.type === "LOAD" &&
    keys(["type", "trackId"]) &&
    typeof row.trackId === "string" &&
    TRACK_ID.test(row.trackId)
  )
    return row as PlaybackCommand;
  if (
    row.type === "SEEK" &&
    keys(["type", "seconds"]) &&
    finite("seconds", 0, 7200)
  )
    return row as PlaybackCommand;
  if (row.type === "RATE" && keys(["type", "rate"]) && finite("rate", 0.25, 3))
    return row as PlaybackCommand;
  if (row.type === "VOLUME" && keys(["type", "level"]) && finite("level", 0, 1))
    return row as PlaybackCommand;
  if (
    row.type === "SOURCE" &&
    keys(["type", "variant"]) &&
    ["voice", "original"].includes(String(row.variant))
  )
    return row as PlaybackCommand;
  if (
    row.type === "REPEAT" &&
    keys(["type", "mode"]) &&
    ["off", "track", "queue"].includes(String(row.mode))
  )
    return row as PlaybackCommand;
  if (
    row.type === "SHUFFLE" &&
    keys(["type", "enabled"]) &&
    typeof row.enabled === "boolean"
  )
    return row as PlaybackCommand;
  if (
    row.type === "QUEUE" &&
    keys(["type", "ids"]) &&
    Array.isArray(row.ids) &&
    row.ids.length <= 1000 &&
    row.ids.every((id) => typeof id === "string" && TRACK_ID.test(id))
  )
    return row as PlaybackCommand;
  if (
    row.type === "MEDIA_EVENT" &&
    keys(
      row.event === "seeked"
        ? ["type", "generation", "event", "position", "seekRevision"]
        : ["type", "generation", "event", "position"],
    ) &&
    (row.event !== "seeked" ||
      (Number.isSafeInteger(row.seekRevision) &&
        Number(row.seekRevision) >= 0)) &&
    typeof row.generation === "string" &&
    UUID.test(row.generation) &&
    [
      "loaded",
      "playing",
      "paused",
      "buffering",
      "time",
      "ended",
      "seeked",
      "error",
    ].includes(String(row.event)) &&
    finite("position", 0, 7200)
  )
    return row as PlaybackCommand;
  throw new Error("INVALID_REQUEST");
}
import {
  parseListeningCommand,
  type ListeningCommand,
  type ListeningView,
} from "./listening-contracts.js";

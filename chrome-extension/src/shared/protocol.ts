/** Shared control contract; capabilities never enter the YouTube page. */
import type { ErrorContext } from "./error-context.js";
import type { InstallationCheck } from "./installation-check.js";
export type NativeCapability =
  | "error_context_v1"
  | "cloud_handoff_v1"
  | "processing_selection_v1"
  | "background_publication_v1";
export const PROTOCOL_VERSION = 1 as const;
export const NATIVE_HOST = "com.musicmute.local";
/** Match Android's inclusive 20-minute processing ceiling. */
export const MVP_MAX_DURATION_SECONDS = 1_200;
export const VERSION = "0.1.1";

export type ProviderId = "LOCAL_MACOS" | "LOCAL_WINDOWS" | "ONLINE_MUSICMUTE";
export type JobState =
  | "DOWNLOADING"
  | "PROCESSING"
  | "VALIDATING"
  | "READY"
  | "FAILED"
  | "CANCELLED";
export interface StartPayload {
  video_id: string;
  duration_seconds: number;
  provider: ProviderId;
}
export interface PreparedAudio {
  output_path: string;
  source_duration_seconds: number;
  duration_seconds: number;
  bytes: number;
  sha256: string;
  model_id: string;
  trim_enabled: false;
  timings_ms: Record<string, number>;
  /** Native-only temporary source; never sent to the YouTube page. */
  original?: LocalAudioArtifact;
  /** Private retained byte identity; contains no temporary path or media grant. */
  original_declaration?: LocalAudioDeclaration;
  source?: LocalAudioSource;
  /** Bounded native display metadata, never source identity or a browser media grant. */
  source_title?: string;
  /** Native shared-publication marker; private files never set this field. */
  shared_youtube_profile?: "kim-vocal-2-full-timeline-v1";
  /** Native-only marker for a durable shared pair awaiting first playback. */
  publication_pending?: boolean;
}
/** Optional display text must never make otherwise valid audio unusable. */
export function sanitizeSourceTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value
    .replace(/[\p{Cc}\uD800-\uDFFF]/gu, "")
    .trim()
    .slice(0, 300)
    // Keep native JSON valid if the display limit split a supplementary character.
    .replace(/[\uD800-\uDBFF]$/u, "")
    .trim();
  return title || undefined;
}
export interface LocalAudioDeclaration {
  extension: string;
  duration_seconds: number;
  bytes: number;
  sha256: string;
  content_type: string;
}
export interface LocalAudioArtifact extends LocalAudioDeclaration {
  path: string;
}
const LOCAL_AUDIO_TYPES: Readonly<Record<string, string>> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  webm: "audio/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
};
/** Strict private-cache declaration validation; legacy absence is handled by callers. */
export function isLocalAudioDeclaration(
  value: unknown,
  expectedDuration?: number,
): value is LocalAudioDeclaration {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    Object.keys(entry).length === 5 &&
    typeof entry.extension === "string" &&
    Object.hasOwn(LOCAL_AUDIO_TYPES, entry.extension) &&
    entry.content_type === LOCAL_AUDIO_TYPES[entry.extension] &&
    typeof entry.bytes === "number" &&
    Number.isSafeInteger(entry.bytes) &&
    entry.bytes > 0 &&
    entry.bytes <= 256 * 1024 ** 2 &&
    typeof entry.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(entry.sha256) &&
    typeof entry.duration_seconds === "number" &&
    Number.isFinite(entry.duration_seconds) &&
    entry.duration_seconds > 0 &&
    entry.duration_seconds <= 1800 &&
    (expectedDuration === undefined ||
      (Number.isFinite(expectedDuration) &&
        Math.abs(entry.duration_seconds - expectedDuration) <= 0.25))
  );
}
/** Device-reported acquisition evidence, not server attestation. */
export interface LocalAudioSource {
  kind: "youtube";
  video_id: string;
  format_id: string;
  audio_track_id: string | null;
  audio_is_default: boolean | null;
  language: string | null;
}
export interface MediaSource {
  url: string;
  duration_seconds: number;
  trim_enabled: false;
  model_id: string;
}
export interface JobSnapshot {
  job_id: string;
  video_id: string;
  provider: ProviderId;
  state: JobState;
  stage: string;
  completed?: number;
  total?: number;
  error_code?: string;
  error_context?: ErrorContext;
  media?: MediaSource;
  cache_hit?: boolean;
  /** Playback remains READY while a retained shared pair saves in the background. */
  save_state?: "pending" | "saving" | "saved";
}
export interface HelloPayload {
  ready: boolean;
  version: string;
  platform: string;
  arch: string;
  max_duration_seconds: number;
  error_code?: string;
  capabilities?: NativeCapability[];
  /** Discovery is separate so legacy clients keep their bounded capability list. */
  background_publication_supported?: boolean;
  /** Saved app choice; trusted only with processing_selection_v1. */
  processing_provider?: "LOCAL_MACOS" | "ONLINE_MUSICMUTE";
  /** Token-free confirmation fence for the selected account and session. */
  processing_scope?: string;
  /** Explicit manual diagnostics discovery; old clients ignore these optional fields. */
  installation_check_supported?: boolean;
  installation_id?: string;
}
export type NativeCommand = {
  protocol_version: 1;
  request_id: string;
} & (
  | {
      type: "STATUS" | "DIAGNOSTICS" | "CLEAR_CACHE" | "CHECK";
      payload: Record<string, never>;
    }
  | { type: "HELLO"; payload: { capabilities?: NativeCapability[] } }
  | { type: "START"; payload: StartPayload }
  | { type: "CANCEL"; payload: { job_id: string } }
  | { type: "PLAYBACK_STARTED"; payload: { job_id: string; video_id: string } }
  | { type: "EVENT"; payload: DiagnosticInput }
);
export type NativeReply = {
  protocol_version: 1;
  request_id: string;
} & (
  | { type: "HELLO"; payload: HelloPayload }
  | { type: "JOB"; payload: JobSnapshot | null }
  | { type: "CHECK"; payload: InstallationCheck }
  | {
      type: "ERROR";
      payload: { error_code: string; error_context?: ErrorContext };
    }
  | { type: "REPORT"; payload: { report: unknown; path?: string } }
);
export interface MediaClock {
  video_id: string;
  generation: number;
  sequence: number;
  current_time: number;
  duration_seconds: number;
  playback_rate: number;
  paused: boolean;
  seeking: boolean;
  ended: boolean;
  buffering: boolean;
  ad_active: boolean;
  volume: number;
  user_muted: boolean;
  sampled_at_ms: number;
}
export interface DiagnosticInput {
  component: "extension" | "companion" | "engine" | "harness";
  severity: "info" | "warning" | "error";
  event: string;
  job_id?: string;
  request_id?: string;
  code?: string;
  metrics?: Record<string, number | boolean | string>;
}
export interface PipelineHooks {
  signal: AbortSignal;
  onProgress: (stage: string, completed?: number, total?: number) => void;
  /** Native-only validation evidence; never part of the browser EVENT command. */
  onDiagnostic: (event: DiagnosticInput, verifiedModelSha256?: string) => void;
}
export interface ProcessingProvider {
  readonly id: ProviderId;
  prepare: (
    request: StartPayload,
    workRoot: string,
    hooks: PipelineHooks,
  ) => Promise<PreparedAudio>;
}
export function isVideoId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 11 &&
    /^[A-Za-z0-9_-]{11}$/.test(value)
  );
}
export function canonicalYouTubeUrl(videoId: string): string {
  if (!isVideoId(videoId)) throw new TypeError("INVALID_VIDEO_ID");
  return `https://www.youtube.com/watch?v=${videoId}`;
}
export function parseYouTubeVideoId(value: string): string | null {
  try {
    if (value.length > 2048 || /[\s\\]/u.test(value) || value.includes("#"))
      return null;
    const url = new URL(value);
    const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1]?.toLowerCase();
    if (
      url.protocol !== "https:" ||
      !["www.youtube.com", "youtube.com", "youtu.be"].includes(
        authority ?? "",
      ) ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      return null;
    if (url.hostname === "youtu.be") {
      if (url.searchParams.has("v")) return null;
      return /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] ?? null;
    }
    if (url.pathname !== "/watch" || url.searchParams.getAll("v").length !== 1)
      return null;
    const id = url.searchParams.get("v");
    return isVideoId(id) ? id : null;
  } catch {
    return null;
  }
}

import { isVideoId, MVP_MAX_DURATION_SECONDS } from "../shared/protocol";
import { isErrorContext, type ErrorContext } from "../shared/error-context";
import type { LocalErrorEvent } from "./local-error-report";
import {
  isInstallationCheck,
  type InstallationCheck,
} from "../shared/installation-check";
import type {
  DiagnosticInput,
  HelloPayload,
  JobSnapshot,
  MediaClock,
  MediaSource,
  StartPayload,
} from "../shared/protocol";

export type PageJob = Omit<JobSnapshot, "media">;
export type ExtensionMessage =
  | {
      type: "MM_START";
      payload: StartPayload;
      generation: number;
      intent?: "manual" | "automatic";
      /** Manual request to use the companion's saved cloud choice. */
      cloud_confirmed?: boolean;
      /** Token-free account scope captured before cloud submission. */
      cloud_confirmation_scope?: string;
    }
  | {
      type: "MM_CANCEL" | "MM_STOP";
      generation: number;
      reason?: "pagehide" | "navigation";
    }
  | { type: "MM_CLOCK"; payload: MediaClock }
  | { type: "MM_STATUS"; refresh?: boolean }
  | { type: "MM_CHECK" }
  | { type: "MM_CHECK_PROGRESS"; payload: InstallationCheck }
  | { type: "MM_DIAGNOSTICS" | "MM_CLEAR_CACHE" }
  | { type: "MM_CLOUD_ACTIVE" }
  | { type: "MM_EVENT"; payload: DiagnosticInput }
  | { type: "MM_JOB"; payload: PageJob; generation: number }
  | { type: "MM_READY"; generation: number }
  | { type: "MM_PLAYBACK"; playing: boolean; generation: number }
  | {
      type: "MM_ERROR";
      code: string;
      generation: number;
      error_context?: ErrorContext;
    }
  | {
      type: "MM_CLOUD_HANDOFF";
      video_id: string;
      duration_seconds?: number;
      generation: number;
    }
  | {
      type: "MM_AUDIO_LOAD";
      media: MediaSource;
      generation: number;
      video_id: string;
    }
  | { type: "MM_AUDIO_CLOCK"; payload: MediaClock }
  | { type: "MM_AUDIO_STOP" }
  | { type: "MM_AUDIO_READY"; generation: number }
  | {
      type: "MM_AUDIO_STATE";
      playing: boolean;
      generation: number;
      drift_ms?: number;
    }
  | { type: "MM_AUDIO_ERROR"; generation: number; code: string };

export interface ExtensionStatus {
  hello: HelloPayload | null;
  job: PageJob | null;
  diagnostics: LocalErrorEvent[];
  error?: string;
  error_context?: ErrorContext;
  installation_check?: InstallationCheck;
}

export function pageJob(job: JobSnapshot): PageJob {
  return {
    job_id: job.job_id,
    video_id: job.video_id,
    provider: job.provider,
    state: job.state,
    stage: job.stage,
    ...(job.completed === undefined ? {} : { completed: job.completed }),
    ...(job.total === undefined ? {} : { total: job.total }),
    ...(job.error_code === undefined ? {} : { error_code: job.error_code }),
    ...(job.error_context === undefined
      ? {}
      : { error_context: job.error_context }),
    ...(typeof job.cache_hit === "boolean" ? { cache_hit: job.cache_hit } : {}),
    ...(job.save_state === undefined ? {} : { save_state: job.save_state }),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function boundedNumber(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}
function generation(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function isErrorCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 80 &&
    /^[A-Z][A-Z0-9_]*$/.test(value) &&
    !/\s/.test(value)
  );
}
export function isMediaClock(value: unknown): value is MediaClock {
  if (!record(value)) return false;
  return (
    isVideoId(value.video_id) &&
    generation(value.generation) &&
    generation(value.sequence) &&
    boundedNumber(value.current_time, 0, 86400) &&
    boundedNumber(value.duration_seconds, 0, 86400) &&
    boundedNumber(value.playback_rate, 0.25, 4) &&
    boundedNumber(value.volume, 0, 1) &&
    boundedNumber(value.sampled_at_ms, 0, Number.MAX_SAFE_INTEGER) &&
    [
      "paused",
      "seeking",
      "ended",
      "buffering",
      "ad_active",
      "user_muted",
    ].every((key) => typeof value[key] === "boolean")
  );
}
export function isMediaSource(value: unknown): value is MediaSource {
  if (
    !record(value) ||
    typeof value.url !== "string" ||
    value.url.length > 2048 ||
    value.trim_enabled !== false ||
    !boundedNumber(value.duration_seconds, 0.001, 1800) ||
    typeof value.model_id !== "string" ||
    value.model_id.length > 128
  )
    return false;
  try {
    const url = new URL(value.url);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      !!url.port &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}
export function isJobSnapshot(value: unknown): value is JobSnapshot {
  return (
    record(value) &&
    typeof value.job_id === "string" &&
    value.job_id.length <= 64 &&
    isVideoId(value.video_id) &&
    typeof value.provider === "string" &&
    ["LOCAL_MACOS", "LOCAL_WINDOWS", "ONLINE_MUSICMUTE"].includes(
      value.provider,
    ) &&
    typeof value.state === "string" &&
    [
      "DOWNLOADING",
      "PROCESSING",
      "VALIDATING",
      "READY",
      "FAILED",
      "CANCELLED",
    ].includes(value.state) &&
    typeof value.stage === "string" &&
    value.stage.length <= 80 &&
    /^[a-zA-Z0-9_-]+$/.test(value.stage) &&
    (value.error_code === undefined || isErrorCode(value.error_code)) &&
    (value.error_context === undefined ||
      isErrorContext(value.error_context)) &&
    (value.completed === undefined ||
      boundedNumber(value.completed, 0, Number.MAX_SAFE_INTEGER)) &&
    (value.total === undefined ||
      boundedNumber(value.total, 0, Number.MAX_SAFE_INTEGER)) &&
    (value.media === undefined || isMediaSource(value.media)) &&
    (value.save_state === undefined ||
      (typeof value.save_state === "string" &&
        ["pending", "saving", "saved"].includes(value.save_state)))
  );
}
/** Runtime validation is independent of TypeScript: messages cross renderer boundaries. */
export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (!record(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "MM_START":
      // Detailed START admission retains its existing UNSUPPORTED_VIDEO response.
      return record(value.payload);
    case "MM_CANCEL":
    case "MM_STOP":
      return (
        generation(value.generation) &&
        (value.reason === undefined ||
          value.reason === "pagehide" ||
          value.reason === "navigation")
      );
    case "MM_READY":
    case "MM_AUDIO_READY":
      return generation(value.generation);
    case "MM_CLOCK":
    case "MM_AUDIO_CLOCK":
      return isMediaClock(value.payload);
    case "MM_STATUS":
      return value.refresh === undefined || typeof value.refresh === "boolean";
    case "MM_CLOUD_ACTIVE":
    case "MM_CHECK":
    case "MM_DIAGNOSTICS":
    case "MM_CLEAR_CACHE":
    case "MM_AUDIO_STOP":
      return true;
    case "MM_CHECK_PROGRESS":
      return isInstallationCheck(value.payload);
    case "MM_EVENT":
      return (
        record(value.payload) &&
        value.payload.component === "extension" &&
        ["info", "warning", "error"].includes(String(value.payload.severity)) &&
        typeof value.payload.event === "string" &&
        value.payload.event.length <= 80 &&
        (value.payload.code === undefined || isErrorCode(value.payload.code)) &&
        (value.payload.metrics === undefined ||
          (record(value.payload.metrics) &&
            Object.keys(value.payload.metrics).length <= 16))
      );
    case "MM_JOB":
      return generation(value.generation) && isJobSnapshot(value.payload);
    case "MM_PLAYBACK":
    case "MM_AUDIO_STATE":
      return generation(value.generation) && typeof value.playing === "boolean";
    case "MM_ERROR":
      return (
        generation(value.generation) &&
        isErrorCode(value.code) &&
        (value.error_context === undefined ||
          isErrorContext(value.error_context))
      );
    case "MM_CLOUD_HANDOFF":
      return (
        generation(value.generation) &&
        isVideoId(value.video_id) &&
        (value.duration_seconds === undefined ||
          boundedNumber(
            value.duration_seconds,
            0.001,
            MVP_MAX_DURATION_SECONDS,
          )) &&
        Object.keys(value).every((key) =>
          ["type", "generation", "video_id", "duration_seconds"].includes(key),
        )
      );
    case "MM_AUDIO_ERROR":
      return generation(value.generation) && isErrorCode(value.code);
    case "MM_AUDIO_LOAD":
      return (
        generation(value.generation) &&
        isVideoId(value.video_id) &&
        record(value.media)
      );
    default:
      return false;
  }
}

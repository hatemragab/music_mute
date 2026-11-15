import type { SessionAccountScope } from "./session-contracts.js";
import type { DirectmlGpuIdentity } from "../../../worker/src/enrollment/report-builder.js";

export const PERSONAL_MAX_BYTES = 256 * 1024 ** 2;
export const PERSONAL_MAX_SECONDS = 1200;
export const PERSONAL_MAX_JOBS = 16;
export const PERSONAL_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export const PERSONAL_FORMATS = new Set([
  "mp3",
  "m4a",
  "mp4",
  "mkv",
  "mov",
  "webm",
  "opus",
  "ogg",
  "aac",
  "wav",
  "flac",
]);
export type PersonalStage =
  | "queued"
  | "metadata"
  | "downloading"
  | "input-validation"
  | "preparation"
  | "model-load"
  | "separation"
  | "encoding"
  | "output-validation";
export type PersonalWaitReason =
  "waiting-for-worker" | "gpu-busy" | "recovering";
export type PersonalError =
  | "INVALID_REQUEST"
  | "INPUT_UNSUPPORTED"
  | "INPUT_CHANGED"
  | "INPUT_LIMIT"
  | "PREPARE_REQUIRED"
  | "GPU_BUSY"
  | "GPU_UNSUPPORTED"
  | "SOURCE_UNAVAILABLE"
  | "SOURCE_BOT_CHALLENGE"
  | "ACQUISITION_RATE_LIMITED"
  | "ACQUISITION_COOLDOWN"
  | "DURATION_LIMIT"
  | "OUTPUT_INVALID"
  | "PROCESSING_FAILED"
  | "CANCELLED"
  | "OWNER_DETACHED"
  | "SCOPE_CHANGED"
  | "STOP_UNCONFIRMED";
export type PersonalInput =
  { kind: "file"; capability: string } | { kind: "youtube"; videoId: string };
export interface PersonalSubmission {
  ownerId: string;
  requestId: string;
  input: PersonalInput;
  rightsConfirmed: true;
  recipeId: "kim-vocals-v2" | "kim-vocals-v2-trim";
}
export interface PersonalArtifact {
  id: string;
  kind: "original" | "vocals";
  name: string;
  bytes: number;
  sha256: string;
  durationSeconds: number;
  contentType: string;
}
export interface PersonalJobView {
  id: string;
  ownerId: string;
  state: "preparing" | "ready" | "failed" | "cancelled";
  stage: PersonalStage;
  progress: number | null;
  /** Ephemeral admission state; meaningful only during preparing/preparation. */
  waitReason?: PersonalWaitReason | null;
  name: string;
  error: PersonalError | null;
  original: PersonalArtifact | null;
  vocals: PersonalArtifact | null;
  source?: { kind: "file" } | { kind: "youtube"; videoId: string };
}
export type PersonalCommand = { version: 1; requestId: string } & (
  | { action: "status" }
  | { action: "idle_proof" }
  | { action: "yield_idle" }
  | { action: "jobs"; ownerId: string }
  | {
      action: "wait_changes";
      ownerId: string;
      afterVersion: number;
      instanceId?: string;
    }
  | { action: "submit"; submission: PersonalSubmission }
  | { action: "cancel"; ownerId: string; jobId: string }
  | { action: "detach"; ownerId: string }
  | { action: "scope"; scope: SessionAccountScope | null }
  | { action: "stop" }
  | { action: "guard_acquire"; jobId: string; gpu: DirectmlGpuIdentity }
  | { action: "guard_status"; jobId: string }
  | { action: "guard_release"; jobId: string; guardNonce: string }
);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_REQUEST");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join() !== keys.sort().join())
    throw new Error("INVALID_REQUEST");
}
export function parsePersonalScope(value: unknown): SessionAccountScope | null {
  if (value === null) return null;
  const row = record(value);
  exact(row, ["firebaseUid", "generation"]);
  if (
    typeof row.firebaseUid !== "string" ||
    !/^[^\p{Cc}\p{Cf}]{1,128}$/u.test(row.firebaseUid) ||
    typeof row.generation !== "string" ||
    !PERSONAL_UUID.test(row.generation)
  )
    throw new Error("INVALID_REQUEST");
  return { firebaseUid: row.firebaseUid, generation: row.generation };
}
export function parsePersonalSubmission(value: unknown): PersonalSubmission {
  const row = record(value);
  exact(row, ["ownerId", "requestId", "input", "rightsConfirmed", "recipeId"]);
  if (
    typeof row.ownerId !== "string" ||
    !PERSONAL_UUID.test(row.ownerId) ||
    typeof row.requestId !== "string" ||
    !PERSONAL_UUID.test(row.requestId) ||
    row.rightsConfirmed !== true ||
    !["kim-vocals-v2", "kim-vocals-v2-trim"].includes(String(row.recipeId))
  )
    throw new Error("INVALID_REQUEST");
  const input = record(row.input);
  if (input.kind === "file") {
    exact(input, ["kind", "capability"]);
    if (
      typeof input.capability !== "string" ||
      !PERSONAL_UUID.test(input.capability)
    )
      throw new Error("INVALID_REQUEST");
  } else if (input.kind === "youtube") {
    exact(input, ["kind", "videoId"]);
    if (
      typeof input.videoId !== "string" ||
      !/^[A-Za-z0-9_-]{11}$/.test(input.videoId)
    )
      throw new Error("INVALID_REQUEST");
  } else throw new Error("INVALID_REQUEST");
  return row as unknown as PersonalSubmission;
}
export function parsePersonalCommand(bytes: Uint8Array): PersonalCommand {
  if (bytes.byteLength > 4096) throw new Error("INVALID_REQUEST");
  const row = record(
    JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
  );
  if (
    row.version !== 1 ||
    typeof row.requestId !== "string" ||
    !PERSONAL_UUID.test(row.requestId)
  )
    throw new Error("INVALID_REQUEST");
  const base = { version: 1 as const, requestId: row.requestId };
  switch (row.action) {
    case "wait_changes": {
      exact(row, [
        "version",
        "requestId",
        "action",
        "ownerId",
        "afterVersion",
        ...(row.instanceId === undefined ? [] : ["instanceId"]),
      ]);
      if (
        typeof row.ownerId !== "string" ||
        !PERSONAL_UUID.test(row.ownerId) ||
        !Number.isSafeInteger(row.afterVersion) ||
        Number(row.afterVersion) < 0 ||
        (row.instanceId !== undefined &&
          (typeof row.instanceId !== "string" ||
            !PERSONAL_UUID.test(row.instanceId)))
      )
        throw new Error("INVALID_REQUEST");
      return row as unknown as PersonalCommand;
    }
    case "guard_acquire":
    case "guard_status":
    case "guard_release": {
      exact(row, [
        "version",
        "requestId",
        "action",
        "jobId",
        ...(row.action === "guard_acquire"
          ? ["gpu"]
          : row.action === "guard_release"
            ? ["guardNonce"]
            : []),
      ]);
      if (
        typeof row.jobId !== "string" ||
        !PERSONAL_UUID.test(row.jobId) ||
        (row.action === "guard_release" &&
          (typeof row.guardNonce !== "string" ||
            !/^[a-f0-9]{64}$/.test(row.guardNonce)))
      )
        throw new Error("INVALID_REQUEST");
      if (row.action === "guard_acquire") record(row.gpu);
      return row as unknown as PersonalCommand;
    }
    case "status":
    case "idle_proof":
    case "yield_idle":
    case "stop":
      exact(row, ["version", "requestId", "action"]);
      return { ...base, action: row.action };
    case "submit":
      exact(row, ["version", "requestId", "action", "submission"]);
      return {
        ...base,
        action: "submit",
        submission: parsePersonalSubmission(row.submission),
      };
    case "scope":
      exact(row, ["version", "requestId", "action", "scope"]);
      return { ...base, action: "scope", scope: parsePersonalScope(row.scope) };
    case "cancel":
    case "detach":
    case "jobs": {
      exact(row, [
        "version",
        "requestId",
        "action",
        "ownerId",
        ...(row.action === "cancel" ? ["jobId"] : []),
      ]);
      if (
        typeof row.ownerId !== "string" ||
        !PERSONAL_UUID.test(row.ownerId) ||
        (row.action === "cancel" &&
          (typeof row.jobId !== "string" || !PERSONAL_UUID.test(row.jobId)))
      )
        throw new Error("INVALID_REQUEST");
      return row as unknown as PersonalCommand;
    }
    default:
      throw new Error("INVALID_REQUEST");
  }
}

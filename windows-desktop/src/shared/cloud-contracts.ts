import type { ProcessingMode } from "./usage-contracts.js";
export interface CloudConfirmationView {
  capability: string;
  requestId: string;
  kind: "youtube" | "file";
  title: string;
  estimatedDurationSeconds: number | null;
  expiresAt: string;
}
export interface CloudJobView {
  id: string;
  status: string;
  title: string | null;
  durationSeconds: number | null;
  resultAvailable: boolean;
}
export interface CloudView {
  mode: ProcessingMode;
  ready: boolean;
  reason: string | null;
  signInRequired: boolean;
  linkImportVisible: boolean;
  connection: string;
  busy: boolean;
  phase:
    | "idle"
    | "confirming"
    | "preparing"
    | "importing"
    | "processing"
    | "downloading"
    | "ready"
    | "cancellation-requested"
    | "cancelled"
    | "failed";
  confirmation: CloudConfirmationView | null;
  job: CloudJobView | null;
  errorCode: string | null;
  resultCapability: string | null;
}
export interface CloudBrowserSettings {
  processing_mode: ProcessingMode;
  processing_provider: "LOCAL_WINDOWS" | "ONLINE_MUSICMUTE";
  automatic_processing_allowed: boolean;
  max_duration_seconds: number;
  link_import_visible: boolean;
}
export type CloudCommand =
  | { type: "RESTORE" | "CANCEL" | "CLEAR_CONFIRMATION" }
  | { type: "SET_MODE"; mode: ProcessingMode }
  | {
      type: "PREPARE_YOUTUBE";
      videoId: string;
      durationSeconds?: number;
      title?: string;
    }
  | {
      type: "PREPARE_FILE";
      fileCapability: string;
      name: string;
      bytes: number;
    }
  | { type: "CONFIRM"; capability: string; rightsConfirmed: true };
export function parseCloudCommand(value: unknown): CloudCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("CLOUD_COMMAND_INVALID");
  const row = value as Record<string, unknown>;
  const shapes: Record<string, string[]> = {
    RESTORE: [],
    CANCEL: [],
    CLEAR_CONFIRMATION: [],
    SET_MODE: ["mode"],
    PREPARE_YOUTUBE: ["videoId", "durationSeconds", "title"],
    PREPARE_FILE: ["fileCapability", "name", "bytes"],
    CONFIRM: ["capability", "rightsConfirmed"],
  };
  if (
    typeof row.type !== "string" ||
    !Object.hasOwn(shapes, row.type) ||
    Object.keys(row).some(
      (key) => key !== "type" && !shapes[String(row.type)]!.includes(key),
    )
  )
    throw new Error("CLOUD_COMMAND_INVALID");
  const uuid = (v: unknown) =>
    typeof v === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
      v,
    );
  if (row.type === "SET_MODE" && !["local", "cloud"].includes(String(row.mode)))
    throw new Error("CLOUD_COMMAND_INVALID");
  if (
    row.type === "PREPARE_YOUTUBE" &&
    (typeof row.videoId !== "string" ||
      !/^[A-Za-z0-9_-]{11}$/.test(row.videoId) ||
      (row.durationSeconds !== undefined &&
        (!Number.isFinite(row.durationSeconds) ||
          (row.durationSeconds as number) <= 0 ||
          (row.durationSeconds as number) > 1200)) ||
      (row.title !== undefined &&
        (typeof row.title !== "string" ||
          row.title.length > 200 ||
          /[\p{Cc}\p{Cf}]/u.test(row.title))))
  )
    throw new Error("CLOUD_COMMAND_INVALID");
  if (
    row.type === "PREPARE_FILE" &&
    (!uuid(row.fileCapability) ||
      typeof row.name !== "string" ||
      row.name.length < 1 ||
      row.name.length > 255 ||
      /[\\/\p{Cc}\p{Cf}]/u.test(row.name) ||
      !Number.isSafeInteger(row.bytes) ||
      (row.bytes as number) < 1 ||
      (row.bytes as number) > 256 * 1024 ** 2)
  )
    throw new Error("CLOUD_COMMAND_INVALID");
  if (
    row.type === "CONFIRM" &&
    (!uuid(row.capability) || row.rightsConfirmed !== true)
  )
    throw new Error("CLOUD_COMMAND_INVALID");
  return structuredClone(row) as CloudCommand;
}

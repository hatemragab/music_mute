import { isAbsolute } from "node:path";
import { MVP_MAX_DURATION_SECONDS, parseYouTubeVideoId } from "./protocol.js";
import { isOfflineVocalsBudget } from "./storage-policy.js";

export const DESKTOP_PROTOCOL_VERSION = 1 as const;
export { OFFLINE_VOCALS_BUDGET_BYTES } from "./storage-policy.js";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Ephemeral native IPC only: never part of browser messages or stored manifests. */
export interface DesktopSession {
  firebase_uid: string;
  session_generation: string;
  installation_id: string;
  id_token?: string;
}
export type DesktopSource =
  | {
      source_kind: "url";
      youtube_url: string;
      duration_seconds?: number;
      source_title?: string;
    }
  | { source_kind: "file"; source_path: string; source_title?: string };
export type DesktopRequest = {
  protocol_version: 1;
  request_id: string;
  session?: DesktopSession;
} & (
  | { type: "LOCAL_START" | "CLOUD_START"; payload: DesktopSource }
  | { type: "SYNC" | "CLEAR_CACHE"; payload: Record<string, never> }
  | { type: "LIBRARY_CACHE"; payload: { cursor?: string; limit?: number } }
  | { type: "SET_CACHE_BUDGET"; payload: { budget_bytes: number } }
  | {
      type: "LIBRARY_DOWNLOAD" | "LIBRARY_ORIGINAL_PLAYBACK";
      payload: { job_id: string };
    }
);
export interface DesktopEvent {
  protocol_version: 1;
  request_id: string;
  type: "progress" | "result" | "error";
  payload?: unknown;
  error_code?: string;
}
export class DesktopProtocolError extends Error {
  constructor(readonly code = "INVALID_DESKTOP_REQUEST") {
    super(code);
  }
}
export function desktopUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
export function desktopRecord(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new DesktopProtocolError();
}
export function validateDesktopSession(
  value: unknown,
  requireToken = false,
): DesktopSession {
  if (!desktopRecord(value)) throw new DesktopProtocolError();
  exactKeys(value, [
    "firebase_uid",
    "session_generation",
    "installation_id",
    "id_token",
  ]);
  if (
    typeof value.firebase_uid !== "string" ||
    !/^[A-Za-z0-9_.:@+-]{1,128}$/.test(value.firebase_uid) ||
    !desktopUuid(value.session_generation) ||
    !desktopUuid(value.installation_id) ||
    (requireToken && value.id_token === undefined) ||
    (value.id_token !== undefined &&
      (typeof value.id_token !== "string" ||
        value.id_token.length > 8192 ||
        !TOKEN.test(value.id_token)))
  )
    throw new DesktopProtocolError();
  return value as unknown as DesktopSession;
}
export function parseDesktopRequest(raw: string): DesktopRequest {
  if (Buffer.byteLength(raw) > 64 * 1024) throw new DesktopProtocolError();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DesktopProtocolError();
  }
  if (!desktopRecord(value)) throw new DesktopProtocolError();
  exactKeys(value, [
    "protocol_version",
    "request_id",
    "type",
    "payload",
    "session",
  ]);
  if (
    value.protocol_version !== DESKTOP_PROTOCOL_VERSION ||
    !desktopUuid(value.request_id) ||
    ![
      "LOCAL_START",
      "CLOUD_START",
      "SYNC",
      "CLEAR_CACHE",
      "LIBRARY_CACHE",
      "SET_CACHE_BUDGET",
      "LIBRARY_DOWNLOAD",
      "LIBRARY_ORIGINAL_PLAYBACK",
    ].includes(String(value.type)) ||
    !desktopRecord(value.payload)
  )
    throw new DesktopProtocolError();
  const authenticated = [
    "CLOUD_START",
    "SYNC",
    "LIBRARY_DOWNLOAD",
    "LIBRARY_ORIGINAL_PLAYBACK",
  ].includes(String(value.type));
  if (value.session !== undefined)
    validateDesktopSession(value.session, authenticated);
  if (authenticated && !value.session)
    throw new DesktopProtocolError("ACCOUNT_REQUIRED");
  const payload = value.payload;
  if (
    value.type === "LIBRARY_DOWNLOAD" ||
    value.type === "LIBRARY_ORIGINAL_PLAYBACK"
  ) {
    exactKeys(payload, ["job_id"]);
    if (
      typeof payload.job_id !== "string" ||
      !/^[a-f0-9]{24}$/.test(payload.job_id)
    )
      throw new DesktopProtocolError();
  } else if (value.type === "SET_CACHE_BUDGET") {
    exactKeys(payload, ["budget_bytes"]);
    if (!isOfflineVocalsBudget(payload.budget_bytes))
      throw new DesktopProtocolError();
  } else if (value.type === "SYNC" || value.type === "CLEAR_CACHE") {
    exactKeys(payload, []);
  } else if (value.type === "LIBRARY_CACHE") {
    exactKeys(payload, ["cursor", "limit"]);
    if (
      (payload.cursor !== undefined &&
        (typeof payload.cursor !== "string" ||
          payload.cursor.length > 4096 ||
          !/^[A-Za-z0-9_-]+$/.test(payload.cursor))) ||
      (payload.limit !== undefined &&
        (!Number.isInteger(payload.limit) ||
          Number(payload.limit) < 1 ||
          Number(payload.limit) > 50))
    )
      throw new DesktopProtocolError();
  } else {
    const title = payload.source_title;
    if (
      title !== undefined &&
      (typeof title !== "string" ||
        title.trim().length < 1 ||
        [...title].length > 200 ||
        /[\p{Cc}\p{Cf}]/u.test(title))
    )
      throw new DesktopProtocolError();
    if (payload.source_kind === "url") {
      exactKeys(payload, [
        "source_kind",
        "youtube_url",
        "duration_seconds",
        "source_title",
      ]);
      if (
        typeof payload.youtube_url !== "string" ||
        payload.youtube_url.length > 2048 ||
        !parseYouTubeVideoId(payload.youtube_url) ||
        (payload.duration_seconds !== undefined &&
          (typeof payload.duration_seconds !== "number" ||
            !Number.isFinite(payload.duration_seconds) ||
            payload.duration_seconds <= 0 ||
            payload.duration_seconds > MVP_MAX_DURATION_SECONDS))
      )
        throw new DesktopProtocolError();
    } else if (payload.source_kind === "file") {
      exactKeys(payload, ["source_kind", "source_path", "source_title"]);
      if (
        typeof payload.source_path !== "string" ||
        payload.source_path.length > 4096 ||
        !isAbsolute(payload.source_path) ||
        payload.source_path.includes("\0")
      )
        throw new DesktopProtocolError();
    } else throw new DesktopProtocolError();
  }
  return value as unknown as DesktopRequest;
}

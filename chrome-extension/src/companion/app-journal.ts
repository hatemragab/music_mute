import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import {
  sanitizeDiagnosticIdentity,
  type DiagnosticIdentity,
} from "./diagnostic-identity.js";

export interface AppUiEvent {
  schema_version: 1;
  at: string;
  session_id: string;
  event: "app_operation_error" | "app_started" | "app_setup_cancelled";
  code: string;
  command: "status" | "setup" | "snapshot" | "export" | "none";
  identity?: DiagnosticIdentity;
}
export interface AppUiFields {
  app_ui_events: AppUiEvent[];
  app_ui_coverage: {
    available: boolean;
    malformed_records: number;
    history_truncated: boolean;
  };
}
const EVENTS = new Set([
  "app_operation_error",
  "app_started",
  "app_setup_cancelled",
]);
const COMMANDS = new Set(["status", "setup", "snapshot", "export", "none"]);
const MAX_BYTES = 512 * 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Keep in sync with macos/UIJournal.swift. Unknown codes never carry raw text.
const CODES = new Set([
  "NONE",
  "LOCAL_COMPANION_BUSY",
  "LOCAL_COMPANION_LOCK_UNSAFE",
  "LOCAL_COMPANION_START_FAILED",
  "UNKNOWN_ERROR",
  "APP_OPERATION_BUSY",
  "APP_RESOURCES_INCOMPLETE",
  "APP_PROCESS_START_FAILED",
  "APP_OPERATION_TIMEOUT",
  "APP_CONTROL_INVALID",
  "APP_PROCESS_EXITED",
  "APP_RESULT_MISSING",
  "APP_EXPORT_PATH_INVALID",
  "APP_UI_JOURNAL_UNAVAILABLE",
  "CACHE_PIN_UNAVAILABLE",
  "DESKTOP_PLAYBACK_START_FAILED",
  "DESKTOP_AUDIO_PLAYBACK_FAILED",
  "GOOGLE_SIGN_IN_TIMEOUT",
  "AUTH_SIGN_IN_FAILED",
  "GOOGLE_TOKEN_INVALID_CLIENT",
  "GOOGLE_TOKEN_INVALID_GRANT",
  "GOOGLE_TOKEN_INVALID_REQUEST",
  "GOOGLE_TOKEN_REDIRECT_MISMATCH",
  "GOOGLE_TOKEN_UNAVAILABLE",
  "GOOGLE_CLIENT_SECRET_REQUIRED",
  "GOOGLE_TOKEN_EXCHANGE_FAILED",
  "UNSUPPORTED_PLATFORM",
  "CHROME_NOT_INSTALLED",
  "CHROME_OPEN_FAILED",
  "MODEL_DOWNLOAD_INTERRUPTED",
  "MODEL_DOWNLOAD_FAILED",
  "MODEL_CHECKSUM_MISMATCH",
  "MODEL_NOT_READY",
  "MODEL_SOURCE_UNAVAILABLE",
  "MODEL_SETUP_FAILED",
  "MODEL_DOWNLOAD_INVALID",
  "MODEL_SIZE_MISMATCH",
  "SETUP_REQUIRED",
  "SETUP_CANCELLED",
  "SETUP_FAILED",
  "DEV_RUNTIME_INCOMPLETE",
  "DEV_RUNTIME_MISSING",
  "ENGINE_DOCTOR_INVALID",
  "ENGINE_MISSING",
  "ENGINE_NOT_READY",
  "INVALID_LOCAL_CONFIG",
  "LOCAL_DIRECTORY_NOT_PRIVATE",
  "YT_DLP_MISSING",
  "YT_DLP_VERSION_INVALID",
  "YT_DLP_EJS_MISSING",
  "YT_DLP_IDENTITY_INVALID",
  "DISK_SPACE_LOW",
  "MEMORY_LOW",
  "TOOL_FAILED",
  "TOOL_TIMEOUT",
  "TOOL_UNAVAILABLE",
  "COMMAND_FAILED",
  "DIAGNOSTICS_EXPORT_FAILED",
  "DIAGNOSTICS_UNAVAILABLE",
  "COMPANION_CRASH",
  "COMPANION_REJECTION",
  "APP_RUNTIME_MISSING",
  "APP_RUNTIME_INVALID",
  "APP_MANIFEST_INVALID",
  "APP_NODE_INVALID",
  "APP_MODEL_INVALID",
  "APP_REGISTRATION_FAILED",
  "APP_ALREADY_RUNNING",
  "FOREIGN_NATIVE_REGISTRATION",
  "NATIVE_REGISTRATION_CONFLICT",
  "INVALID_EXTENSION_PATH",
  "INVALID_APP_RESOURCES",
  "APP_SETUP_FAILED",
  "APP_SETUP_CANCELLED",
  "APP_STATUS_FAILED",
  "APP_REPLY_TOO_LARGE",
  "APP_RESOURCES_REQUIRED",
  "APP_RESOURCES_MISSING",
  "APP_COMMAND_FAILED",
  "INVALID_APP_COMMAND",
  "CANCELLED",
  "EXTENSION_MANIFEST_KEY_INVALID",
  "FOREIGN_NATIVE_LAUNCHER_EXISTS",
  "FOREIGN_NATIVE_REGISTRATION_EXISTS",
  "MODEL_CACHE_INVALID",
  "MODEL_CHECKSUM_INVALID",
  "MODEL_DOWNLOAD_TIMEOUT",
  "MODEL_REDIRECT_INVALID",
  "MODEL_SIZE_INVALID",
  "MODEL_SOURCE_INVALID",
  "SETUP_BUSY",
  "UNSAFE_NATIVE_REGISTRATION_DIRECTORY",
  "UNSAFE_SETUP_FILE",
  "CLI_OPTION_UNSUPPORTED",
]);

async function readPrivateJournal(path: string): Promise<string> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.mode & 0o077 ||
      info.uid !== process.getuid?.() ||
      info.size > MAX_BYTES
    )
      throw new Error("UNSAFE_UI_JOURNAL");
    // The file may grow after fstat. Read at most one byte beyond the quota,
    // rather than allowing readFile to allocate an unbounded append stream.
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await file.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count > MAX_BYTES || (await file.stat()).size > MAX_BYTES)
      throw new Error("UI_JOURNAL_TOO_LARGE");
    return bytes.subarray(0, count).toString("utf8");
  } finally {
    await file.close();
  }
}

export async function readAppUiJournal(logsRoot: string): Promise<AppUiFields> {
  const events: AppUiEvent[] = [];
  let available = true;
  let malformed = 0;
  let truncated = false;
  try {
    const root = await lstat(logsRoot);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.mode & 0o077 ||
      root.uid !== process.getuid?.()
    )
      throw new Error("UNSAFE_UI_JOURNAL_ROOT");
  } catch {
    return {
      app_ui_events: [],
      app_ui_coverage: {
        available: false,
        malformed_records: 0,
        history_truncated: false,
      },
    };
  }
  for (const name of ["ui-events.jsonl.1", "ui-events.jsonl"]) {
    try {
      const path = join(logsRoot, name);
      const text = await readPrivateJournal(path);
      if (name.endsWith(".1")) truncated = true;
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          if (Buffer.byteLength(line) > 1024) throw new Error();
          const value = JSON.parse(line) as Record<string, unknown>;
          if (
            value.schema_version !== 1 ||
            typeof value.at !== "string" ||
            !/^\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z$/.test(value.at) ||
            !Number.isFinite(Date.parse(value.at)) ||
            typeof value.session_id !== "string" ||
            !UUID.test(value.session_id) ||
            typeof value.event !== "string" ||
            !EVENTS.has(value.event) ||
            typeof value.command !== "string" ||
            !COMMANDS.has(value.command) ||
            typeof value.code !== "string" ||
            !/^[A-Z_]{1,60}$/.test(value.code)
          )
            throw new Error();
          const identity = sanitizeDiagnosticIdentity(value.identity);
          if (value.identity != null && !identity) {
            malformed++;
            truncated = true;
          }
          events.push({
            schema_version: 1,
            at: value.at,
            session_id: value.session_id,
            event: value.event as AppUiEvent["event"],
            code: CODES.has(value.code) ? value.code : "UNKNOWN_ERROR",
            command: value.command as AppUiEvent["command"],
            ...(identity ? { identity } : {}),
          });
        } catch {
          malformed++;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") available = false;
    }
  }
  return {
    app_ui_events: events.slice(-40),
    app_ui_coverage: {
      available,
      malformed_records: malformed,
      history_truncated: truncated || events.length > 40,
    },
  };
}

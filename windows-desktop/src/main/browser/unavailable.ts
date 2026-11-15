import {
  VERSION,
  type NativeReply,
} from "../../../../chrome-extension/src/shared/protocol.js";
import { validateCommand } from "../../../../chrome-extension/src/companion/native-protocol.js";
/** A prepared app can still safely explain a missing/mismatched detached runtime. */
export function unavailableBrowserReply(
  value: unknown,
  code:
    | "LOCAL_INSTALL_REQUIRED"
    | "WINDOWS_SESSION_ALREADY_ACTIVE" = "LOCAL_INSTALL_REQUIRED",
): NativeReply {
  const command = validateCommand(value);
  if (
    Object.keys(command).sort().join() !==
    "payload,protocol_version,request_id,type"
  )
    throw new Error("INVALID_COMMAND");
  const base = { protocol_version: 1 as const, request_id: command.request_id };
  return command.type === "HELLO"
    ? {
        ...base,
        type: "HELLO",
        payload: {
          ready: false,
          version: VERSION,
          platform: "win32",
          arch: "x64",
          max_duration_seconds: 1200,
          error_code: code,
          capabilities: [],
          background_publication_supported: false,
        },
      }
    : {
        ...base,
        type: "ERROR",
        payload: { error_code: code },
      };
}

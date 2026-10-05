import {
  PROTOCOL_VERSION,
  isVideoId,
  MVP_MAX_DURATION_SECONDS,
  type NativeCommand,
} from "../shared/protocol.js";
export const MAX_NATIVE_FRAME = 64 * 1024;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function encodeFrame(value: unknown): Buffer {
  const data = Buffer.from(JSON.stringify(value));
  if (data.length > MAX_NATIVE_FRAME) throw new Error("FRAME_TOO_LARGE");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(data.length);
  return Buffer.concat([prefix, data]);
}
export class FrameDecoder {
  private pending = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: unknown[] = [];
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32LE(0);
      if (length < 2 || length > MAX_NATIVE_FRAME)
        throw new Error("FRAME_INVALID");
      if (this.pending.length < length + 4) break;
      frames.push(
        JSON.parse(this.pending.subarray(4, length + 4).toString("utf8")),
      );
      this.pending = this.pending.subarray(length + 4);
    }
    return frames;
  }
  finish(): void {
    if (this.pending.length) throw new Error("FRAME_TRUNCATED");
  }
}
export function validateCommand(value: unknown): NativeCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_COMMAND");
  const item = value as Record<string, unknown>;
  if (
    item.protocol_version !== PROTOCOL_VERSION ||
    typeof item.request_id !== "string" ||
    !uuid.test(item.request_id) ||
    !item.payload ||
    typeof item.payload !== "object" ||
    Array.isArray(item.payload)
  )
    throw new Error("INVALID_COMMAND");
  const payload = item.payload as Record<string, unknown>;
  if (item.type === "START") {
    if (
      !isVideoId(payload.video_id) ||
      typeof payload.duration_seconds !== "number" ||
      !Number.isFinite(payload.duration_seconds) ||
      payload.duration_seconds <= 0 ||
      payload.duration_seconds > MVP_MAX_DURATION_SECONDS ||
      !["LOCAL_MACOS", "LOCAL_WINDOWS", "ONLINE_MUSICMUTE"].includes(
        String(payload.provider),
      )
    )
      throw new Error("UNSUPPORTED_VIDEO");
    if (
      Object.keys(payload).some(
        (key) => !["video_id", "duration_seconds", "provider"].includes(key),
      )
    )
      throw new Error("INVALID_COMMAND");
  } else if (item.type === "CANCEL") {
    if (
      typeof payload.job_id !== "string" ||
      !uuid.test(payload.job_id) ||
      Object.keys(payload).length !== 1
    )
      throw new Error("INVALID_COMMAND");
  } else if (item.type === "PLAYBACK_STARTED") {
    if (
      typeof payload.job_id !== "string" ||
      !uuid.test(payload.job_id) ||
      !isVideoId(payload.video_id) ||
      Object.keys(payload).length !== 2
    )
      throw new Error("INVALID_COMMAND");
  } else if (item.type === "EVENT") {
    if (
      !["extension", "harness"].includes(String(payload.component)) ||
      !["info", "warning", "error"].includes(String(payload.severity)) ||
      typeof payload.event !== "string" ||
      payload.event.length > 80
    )
      throw new Error("INVALID_COMMAND");
  } else if (item.type === "HELLO") {
    if (
      Object.keys(payload).some((key) => key !== "capabilities") ||
      (payload.capabilities !== undefined &&
        (!Array.isArray(payload.capabilities) ||
          payload.capabilities.length > 4 ||
          payload.capabilities.some(
            (capability) =>
              ![
                "error_context_v1",
                "cloud_handoff_v1",
                "processing_selection_v1",
                "background_publication_v1",
              ].includes(capability),
          ) ||
          new Set(payload.capabilities).size !== payload.capabilities.length))
    )
      throw new Error("INVALID_COMMAND");
  } else if (
    !["HELLO", "STATUS", "DIAGNOSTICS", "CLEAR_CACHE", "CHECK"].includes(
      String(item.type),
    ) ||
    Object.keys(payload).length
  )
    throw new Error("INVALID_COMMAND");
  return item as unknown as NativeCommand;
}

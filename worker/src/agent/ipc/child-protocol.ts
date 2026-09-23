import { Buffer } from "node:buffer";

export const CHILD_PROTOCOL_VERSION = 1 as const;
export const CHILD_FRAME_MAX_BYTES = 64 * 1024;
export const CHILD_PAYLOAD_MAX_DEPTH = 8;
export const CHILD_PAYLOAD_MAX_ARRAY_ITEMS = 100;
export const CHILD_PAYLOAD_MAX_STRING_LENGTH = 4096;

export const CHILD_REQUEST_COMMANDS = [
  "ping",
  "process",
  "cancel",
  "shutdown",
] as const;
export type ChildRequestCommand = (typeof CHILD_REQUEST_COMMANDS)[number];

export const CHILD_RESPONSE_TYPES = [
  "startup-progress",
  "ready",
  "accepted",
  "progress",
  "result",
  "cancelled",
  "error",
] as const;
export type ChildResponseType = (typeof CHILD_RESPONSE_TYPES)[number];

export interface ChildRequest {
  protocolVersion: typeof CHILD_PROTOCOL_VERSION;
  type: "request";
  command: ChildRequestCommand;
  requestId: string;
  incarnation: string;
  sentAt: string;
  payload: Record<string, unknown>;
}

export interface ChildResponse {
  protocolVersion: typeof CHILD_PROTOCOL_VERSION;
  type: ChildResponseType;
  requestId: string;
  incarnation: string;
  sentAt: string;
  payload: Record<string, unknown>;
}

export type ChildMessage = ChildRequest | ChildResponse;

export class ChildProtocolError extends Error {
  constructor(
    readonly code:
      | "FRAME_INVALID"
      | "FRAME_TOO_LARGE"
      | "MESSAGE_INVALID"
      | "VERSION_UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "ChildProtocolError";
  }
}

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_KEYS = new Set([
  "protocolVersion",
  "type",
  "command",
  "requestId",
  "incarnation",
  "sentAt",
  "payload",
]);
const RESPONSE_KEYS = new Set([
  "protocolVersion",
  "type",
  "requestId",
  "incarnation",
  "sentAt",
  "payload",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function assertBoundedPayload(value: unknown, depth: number): void {
  if (depth > CHILD_PAYLOAD_MAX_DEPTH)
    throw new ChildProtocolError(
      "MESSAGE_INVALID",
      "Child payload is too deeply nested",
    );
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (typeof value === "string") {
    if (value.length > CHILD_PAYLOAD_MAX_STRING_LENGTH)
      throw new ChildProtocolError(
        "MESSAGE_INVALID",
        "Child payload string is too long",
      );
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > CHILD_PAYLOAD_MAX_ARRAY_ITEMS)
      throw new ChildProtocolError(
        "MESSAGE_INVALID",
        "Child payload array contains too many items",
      );
    for (const item of value) assertBoundedPayload(item, depth + 1);
    return;
  }
  if (!isRecord(value))
    throw new ChildProtocolError(
      "MESSAGE_INVALID",
      "Child payload contains an unsupported value",
    );
  if (Object.keys(value).length > CHILD_PAYLOAD_MAX_ARRAY_ITEMS)
    throw new ChildProtocolError(
      "MESSAGE_INVALID",
      "Child payload object contains too many fields",
    );
  for (const item of Object.values(value))
    assertBoundedPayload(item, depth + 1);
}

function assertCommon(message: Record<string, unknown>): void {
  if (message.protocolVersion !== CHILD_PROTOCOL_VERSION)
    throw new ChildProtocolError(
      "VERSION_UNSUPPORTED",
      "Unsupported child protocol version",
    );
  if (
    typeof message.requestId !== "string" ||
    !UUID_V4_PATTERN.test(message.requestId) ||
    typeof message.incarnation !== "string" ||
    !UUID_V4_PATTERN.test(message.incarnation)
  )
    throw new ChildProtocolError(
      "MESSAGE_INVALID",
      "Child protocol identifiers must be UUID v4 values",
    );
  if (
    typeof message.sentAt !== "string" ||
    message.sentAt.length > 40 ||
    !Number.isFinite(Date.parse(message.sentAt)) ||
    new Date(message.sentAt).toISOString() !== message.sentAt
  )
    throw new ChildProtocolError(
      "MESSAGE_INVALID",
      "Child protocol timestamp is invalid",
    );
  if (!isRecord(message.payload))
    throw new ChildProtocolError(
      "MESSAGE_INVALID",
      "Child protocol payload must be an object",
    );
  assertBoundedPayload(message.payload, 0);
}

export function parseChildMessage(value: unknown): ChildMessage {
  if (!isRecord(value))
    throw new ChildProtocolError(
      "MESSAGE_INVALID",
      "Child message must be an object",
    );
  const request = value.type === "request";
  const keys = request ? REQUEST_KEYS : RESPONSE_KEYS;
  if (Object.keys(value).some((key) => !keys.has(key)))
    throw new ChildProtocolError(
      "MESSAGE_INVALID",
      "Child message contains an unknown field",
    );
  assertCommon(value);
  if (request) {
    const payload = value.payload as Record<string, unknown>;
    if (
      typeof value.command !== "string" ||
      !CHILD_REQUEST_COMMANDS.includes(value.command as ChildRequestCommand)
    )
      throw new ChildProtocolError(
        "MESSAGE_INVALID",
        "Child request command is invalid",
      );
    if (
      value.command === "cancel" &&
      (typeof payload.targetRequestId !== "string" ||
        !UUID_V4_PATTERN.test(payload.targetRequestId))
    )
      throw new ChildProtocolError(
        "MESSAGE_INVALID",
        "Cancellation target must be a UUID v4",
      );
    return value as unknown as ChildRequest;
  }
  if (
    typeof value.type !== "string" ||
    !CHILD_RESPONSE_TYPES.includes(value.type as ChildResponseType)
  )
    throw new ChildProtocolError(
      "MESSAGE_INVALID",
      "Child response type is invalid",
    );
  return value as unknown as ChildResponse;
}

export function encodeChildFrame(message: ChildMessage): Buffer {
  const parsed = parseChildMessage(message);
  const body = Buffer.from(JSON.stringify(parsed), "utf8");
  if (body.length === 0 || body.length > CHILD_FRAME_MAX_BYTES)
    throw new ChildProtocolError(
      "FRAME_TOO_LARGE",
      "Child frame exceeds the byte limit",
    );
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export class ChildFrameDecoder {
  private buffered = Buffer.alloc(0);
  private expectedBytes: number | null = null;

  push(chunk: Uint8Array): ChildMessage[] {
    if (chunk.byteLength === 0) return [];
    this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)]);
    const messages: ChildMessage[] = [];
    while (true) {
      if (this.expectedBytes === null) {
        if (this.buffered.length < 4) break;
        this.expectedBytes = this.buffered.readUInt32BE(0);
        this.buffered = this.buffered.subarray(4);
        if (
          this.expectedBytes === 0 ||
          this.expectedBytes > CHILD_FRAME_MAX_BYTES
        )
          throw new ChildProtocolError(
            "FRAME_TOO_LARGE",
            "Child frame declares an invalid byte length",
          );
      }
      if (this.buffered.length < this.expectedBytes) break;
      const body = this.buffered.subarray(0, this.expectedBytes);
      this.buffered = this.buffered.subarray(this.expectedBytes);
      this.expectedBytes = null;
      let decoded: unknown;
      try {
        decoded = JSON.parse(body.toString("utf8")) as unknown;
      } catch {
        throw new ChildProtocolError(
          "FRAME_INVALID",
          "Child frame contains invalid JSON",
        );
      }
      messages.push(parseChildMessage(decoded));
    }
    return messages;
  }

  finish(): void {
    if (this.buffered.length !== 0 || this.expectedBytes !== null)
      throw new ChildProtocolError(
        "FRAME_INVALID",
        "Child stream ended with an incomplete frame",
      );
  }
}

import {
  assertConsumerAbsolutePath,
  assertConsumerNonce,
  ConsumerNativeError,
  object,
  processIdentityToWire,
  type ConsumerProcessIdentity,
} from "./consumer-native-policy.js";
import {
  cacheIdentityToWire,
  type ConsumerFileBirth,
} from "./consumer-native-cache.js";

export interface ConsumerCreatedExportDiscard {
  requestId: string;
  path: string;
  creator: ConsumerProcessIdentity;
  birth: ConsumerFileBirth;
  bytes: number;
  writtenAt: string;
  changedAt: string;
}
export type ConsumerExportDiscardResult =
  | { state: "pending" }
  | { state: "completed"; requestId: string; nonce: string };
export function assertExportDiscardRequestId(value: string): void {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      value,
    )
  )
    throw new ConsumerNativeError("BAD_REQUEST");
}
export function createdExportDiscardToWire(
  value: ConsumerCreatedExportDiscard,
): Record<string, unknown> {
  assertExportDiscardRequestId(value.requestId);
  assertConsumerAbsolutePath(value.path);
  return {
    request_id: value.requestId,
    path: value.path,
    creator: processIdentityToWire(value.creator),
    expected: cacheIdentityToWire(
      {
        ...value.birth,
        bytes: value.bytes,
        writtenAt: value.writtenAt,
        changedAt: value.changedAt,
      },
      "file",
    ),
  };
}
export function parseExportDiscardResult(
  value: unknown,
  requestId: string,
): ConsumerExportDiscardResult {
  const row = object(value);
  if (row.state === "pending" && Object.keys(row).join() === "state")
    return { state: "pending" };
  if (
    row.state !== "completed" ||
    Object.keys(row).sort().join() !== "nonce,request_id,state" ||
    row.request_id !== requestId ||
    typeof row.nonce !== "string"
  )
    throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  assertConsumerNonce(row.nonce);
  return { state: "completed", requestId, nonce: row.nonce };
}

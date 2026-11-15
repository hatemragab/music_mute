import { ConsumerNativeError, object } from "./consumer-native-policy.js";
import {
  cacheIdentityToWire,
  type ConsumerCacheFileIdentity,
} from "./consumer-native-cache.js";
import { assertExportDiscardRequestId } from "./consumer-native-export.js";

export interface ConsumerShareCleanupFile {
  relativePath: string;
  identity: ConsumerCacheFileIdentity;
  sha256: string;
}
export type ConsumerStorageCleanupReceipt =
  | { state: "pending" }
  | { state: "completed"; receiptId: string; nonce: string };
export interface ConsumerLibraryCleanup {
  relativePath: string;
  birth: { device: string; fileId: string; bornAt: string };
  deletionId: string | null;
  receipt: Extract<
    ConsumerStorageCleanupReceipt,
    { state: "completed" }
  > | null;
}
export function parseStorageCleanupReceipt(
  value: unknown,
): ConsumerStorageCleanupReceipt {
  const row = object(value);
  if (row.state === "pending" && Object.keys(row).join() === "state")
    return { state: "pending" };
  if (
    row.state !== "completed" ||
    Object.keys(row).sort().join() !== "nonce,receipt_id,state" ||
    typeof row.receipt_id !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.receipt_id) ||
    typeof row.nonce !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.nonce)
  )
    throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  return { state: "completed", receiptId: row.receipt_id, nonce: row.nonce };
}
export function shareCleanupFileToWire(
  requestId: string,
  file: ConsumerShareCleanupFile | null,
): Record<string, unknown> | null {
  assertExportDiscardRequestId(requestId);
  if (file === null) return null;
  const prefix = `share\\requests\\${requestId}\\media.`;
  if (
    !file.relativePath.startsWith(prefix) ||
    !/^(mp3|m4a|webm|ogg|aac|wav|flac)$/u.test(
      file.relativePath.slice(prefix.length),
    ) ||
    !/^[a-f0-9]{64}$/u.test(file.sha256)
  )
    throw new ConsumerNativeError("BAD_REQUEST");
  return {
    relative_path: file.relativePath,
    expected: cacheIdentityToWire(file.identity, "file"),
    sha256: file.sha256,
  };
}
export function parsePersonalCleanupState(
  value: unknown,
): "completed" | "pending" {
  const row = object(value);
  if (
    Object.keys(row).join() !== "state" ||
    (row.state !== "completed" && row.state !== "pending")
  )
    throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  return row.state;
}

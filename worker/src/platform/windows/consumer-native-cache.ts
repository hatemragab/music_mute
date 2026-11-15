import {
  assertConsumerRelativePath,
  assertConsumerNonce,
  ConsumerNativeError,
  object,
} from "./consumer-native-policy.js";

export interface ConsumerFileBirth {
  device: string;
  fileId: string;
  bornAt: string;
}
export interface ConsumerCacheFileIdentity extends ConsumerFileBirth {
  bytes: number;
  writtenAt: string;
  changedAt: string;
}
export interface ConsumerCacheDeletion {
  requestId: string;
  nonce: string;
  relativePath: string;
  kind: "file" | "directory";
}
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/u;
/** Closed app-owned eviction namespaces; runtime, models, vaults, exports and selected input are excluded. */
export function assertCacheDeletionPath(relative: string): void {
  assertConsumerRelativePath(relative);
  const uuid =
    "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
  const hash = "[a-f0-9]{64}";
  const roots = new RegExp(
    `^(?:library\\\\media\\\\${hash}\\\\[a-f0-9]{24}\\\\(?:voice|original)\\\\${hash}|(?:personal\\\\(?:jobs|inputs|engine-session)|cloud\\\\work|prepare\\\\(?:work|downloads))\\\\${uuid}|personal\\\\results\\\\${uuid}\\.pending)(?:\\\\[^\\\\]+)*$`,
    "u",
  );
  const leaf = new RegExp(
    `^(?:personal\\\\results\\\\${uuid}\\\\(?:vocals\\.mp3|original\\.(?:mp3|m4a|mp4|webm|opus|ogg|aac|wav|flac))|library\\\\thumbnails\\\\${hash}\\.image)$`,
    "u",
  );
  if (!roots.test(relative) && !leaf.test(relative))
    throw new ConsumerNativeError("BAD_REQUEST");
}
export function cacheIdentityToWire(
  identity: ConsumerFileBirth | ConsumerCacheFileIdentity,
  kind: "file" | "directory",
): Record<string, unknown> {
  if (kind !== "file" && kind !== "directory")
    throw new ConsumerNativeError("BAD_REQUEST");
  const row = object(identity);
  const fields =
    kind === "file"
      ? ["device", "fileId", "bornAt", "bytes", "writtenAt", "changedAt"]
      : ["device", "fileId", "bornAt"];
  if (Object.keys(row).sort().join() !== fields.sort().join())
    throw new ConsumerNativeError("BAD_REQUEST");
  for (const key of fields.filter((key) => key !== "bytes")) {
    if (typeof row[key] !== "string" || !DECIMAL.test(row[key] as string))
      throw new ConsumerNativeError("BAD_REQUEST");
  }
  if (
    row.fileId === "0" ||
    (kind === "file" &&
      (!Number.isSafeInteger(row.bytes) || (row.bytes as number) < 0))
  )
    throw new ConsumerNativeError("BAD_REQUEST");
  return {
    device: row.device,
    file_id: row.fileId,
    born_at: row.bornAt,
    ...(kind === "file"
      ? {
          bytes: row.bytes,
          written_at: row.writtenAt,
          changed_at: row.changedAt,
        }
      : {}),
  };
}
export function cacheDeletionToWire(
  value: ConsumerCacheDeletion,
): Record<string, unknown> {
  if (
    !UUID.test(value.requestId) ||
    !["file", "directory"].includes(value.kind)
  )
    throw new ConsumerNativeError("BAD_REQUEST");
  assertCacheDeletionPath(value.relativePath);
  assertConsumerNonce(value.nonce);
  return {
    request_id: value.requestId,
    nonce: value.nonce,
    relative_path: value.relativePath,
    kind: value.kind,
  };
}
export function parseCacheDeletion(value: unknown): ConsumerCacheDeletion {
  const row = object(value);
  if (
    Object.keys(row).sort().join() !== "kind,nonce,relative_path,request_id" ||
    typeof row.request_id !== "string" ||
    typeof row.relative_path !== "string" ||
    typeof row.nonce !== "string" ||
    (row.kind !== "file" && row.kind !== "directory")
  )
    throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  const result: ConsumerCacheDeletion = {
    requestId: row.request_id,
    relativePath: row.relative_path,
    nonce: row.nonce,
    kind: row.kind,
  };
  cacheDeletionToWire(result);
  return result;
}

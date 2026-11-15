import {
  ConsumerNativeError,
  object,
  assertConsumerNonce,
  processIdentityFromWire,
  processIdentityToWire,
  type ConsumerProcessIdentity,
} from "./consumer-native-policy.js";

export const CONSUMER_SHARE_MAX_BYTES = 256 * 1024 ** 2;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MIME = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  webm: "audio/webm",
  ogg: "audio/ogg",
  aac: "audio/aac",
  wav: "audio/wav",
  flac: "audio/flac",
} as const;
export interface ConsumerShareSource {
  requestId: string;
  windowHandle: string;
  windowOwner: ConsumerProcessIdentity;
  relativePath: string;
  sha256: string;
  bytes: number;
  title: string;
  mime: string;
}
export interface ConsumerShareReceipt {
  version: 1;
  requestId: string;
  nonce: string;
  helper: ConsumerProcessIdentity;
  windowOwner: ConsumerProcessIdentity;
  relativePath: string;
  sha256: string;
  bytes: number;
  fileIdentity: {
    volumeSerial: number;
    fileIndex: string;
    creationTime: string;
  };
  state: "pending" | "completed" | "cancelled" | "unconfirmed";
  shown: boolean;
  quiesced: boolean;
  callback: "ShareCompleted" | "ShareCanceled" | null;
}
export function assertShareRequestId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value))
    throw new ConsumerNativeError("BAD_REQUEST");
}
function decimal64(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]{0,19}$/u.test(value) &&
    BigInt(value) <= 0xffffffffffffffffn
  );
}
export function consumerShareArgs(
  source: ConsumerShareSource,
): Record<string, unknown> {
  assertShareRequestId(source.requestId);
  const prefix = `share\\requests\\${source.requestId}\\media.`,
    extension = source.relativePath.slice(prefix.length);
  if (
    !source.relativePath.startsWith(prefix) ||
    !Object.hasOwn(MIME, extension) ||
    MIME[extension as keyof typeof MIME] !== source.mime ||
    !decimal64(source.windowHandle) ||
    !Number.isSafeInteger(source.bytes) ||
    source.bytes < 1 ||
    source.bytes > CONSUMER_SHARE_MAX_BYTES ||
    !/^[a-f0-9]{64}$/u.test(source.sha256) ||
    typeof source.title !== "string" ||
    !source.title.trim() ||
    Buffer.byteLength(source.title, "utf8") > 180 ||
    /[\p{Cc}\p{Cf}]/u.test(source.title)
  )
    throw new ConsumerNativeError("BAD_REQUEST");
  return {
    request_id: source.requestId,
    window_handle: source.windowHandle,
    window_owner: processIdentityToWire(source.windowOwner),
    relative_path: source.relativePath,
    sha256: source.sha256,
    bytes: source.bytes,
    title: source.title,
    mime: source.mime,
  };
}
export function parseConsumerShareReceipt(
  value: unknown,
): ConsumerShareReceipt {
  const row = object(value),
    file = object(row.file_identity);
  if (
    Object.keys(row).sort().join() !==
      "bytes,callback,file_identity,helper,nonce,quiesced,relative_path,request_id,sha256,shown,state,version,window_owner" ||
    row.version !== 1 ||
    Object.keys(file).sort().join() !==
      "creation_time,file_index,volume_serial" ||
    !Number.isInteger(file.volume_serial) ||
    (file.volume_serial as number) < 0 ||
    (file.volume_serial as number) > 0xffffffff ||
    !decimal64(file.file_index) ||
    !decimal64(file.creation_time) ||
    !["pending", "completed", "cancelled", "unconfirmed"].includes(
      row.state as string,
    ) ||
    typeof row.shown !== "boolean" ||
    typeof row.quiesced !== "boolean" ||
    ![null, "ShareCompleted", "ShareCanceled"].includes(
      row.callback as null | string,
    )
  )
    throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  assertShareRequestId(row.request_id);
  assertConsumerNonce(row.nonce as string);
  const windowOwner = processIdentityFromWire(row.window_owner),
    helper = processIdentityFromWire(row.helper);
  const relativePath = row.relative_path as string,
    extension = relativePath?.split(".").at(-1);
  consumerShareArgs({
    requestId: row.request_id,
    windowOwner,
    windowHandle: "1",
    relativePath,
    sha256: row.sha256 as string,
    bytes: row.bytes as number,
    title: "Share",
    mime: MIME[extension as keyof typeof MIME] ?? "",
  });
  if (
    helper.sid !== windowOwner.sid ||
    helper.sessionId !== windowOwner.sessionId ||
    (row.state === "completed") !== (row.callback === "ShareCompleted") ||
    (row.state === "cancelled") !== (row.callback === "ShareCanceled") ||
    (row.quiesced && row.state !== "completed" && row.state !== "cancelled")
  )
    throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  return {
    version: 1,
    requestId: row.request_id,
    nonce: row.nonce as string,
    helper,
    windowOwner,
    relativePath,
    sha256: row.sha256 as string,
    bytes: row.bytes as number,
    fileIdentity: {
      volumeSerial: file.volume_serial as number,
      fileIndex: file.file_index,
      creationTime: file.creation_time,
    },
    state: row.state as ConsumerShareReceipt["state"],
    shown: row.shown,
    quiesced: row.quiesced,
    callback: row.callback as ConsumerShareReceipt["callback"],
  };
}
export function shareReceiptAllowsCleanup(
  receipt: ConsumerShareReceipt,
): boolean {
  return (
    receipt.quiesced &&
    ((receipt.state === "completed" && receipt.callback === "ShareCompleted") ||
      (receipt.state === "cancelled" && receipt.callback === "ShareCanceled"))
  );
}

import { timingSafeEqual } from "node:crypto";
import { win32 } from "node:path";

export const CONSUMER_NATIVE_VERSION = 1;
export const CONSUMER_NATIVE_MAX_FRAME = 65_536;
export const CONSUMER_NATIVE_MAX_SECRET = 16_384;
export const CONSUMER_NATIVE_MAX_PIPE_PAYLOAD = 4_096;
export const CONSUMER_NATIVE_MAX_PIPE_RESPONSE = 32_768;

export const CONSUMER_NATIVE_ERROR_CODES = [
  "BAD_REQUEST",
  "PROTOCOL_MISMATCH",
  "UNSUPPORTED_HOST",
  "INTERACTIVE_SESSION_REQUIRED",
  "IDENTITY_UNAVAILABLE",
  "BOOT_IDENTITY_UNAVAILABLE",
  "ACL_UNSAFE",
  "PATH_UNSAFE",
  "VAULT_UNAVAILABLE",
  "VAULT_CORRUPT",
  "VAULT_RECOVERY_REQUIRED",
  "PEER_DENIED",
  "PIPE_UNAVAILABLE",
  "FRAME_TOO_LARGE",
  "TIMEOUT",
  "JOB_BUSY",
  "JOB_NOT_OWNED",
  "JOB_UNAVAILABLE",
  "HELPER_UNAVAILABLE",
  "HELPER_INTEGRITY_INVALID",
  "LAUNCH_VERIFICATION_REQUIRED",
  "STARTUP_CONFLICT",
  "GPU_INVENTORY_UNAVAILABLE",
  "GPU_GUARD_UNSAFE",
  "BROWSER_REGISTRATION_CONFLICT",
  "INSTALLER_LAUNCH_CONFLICT",
  "INSTALLER_LAUNCH_UNKNOWN",
  "WINDOWS_SESSION_ALREADY_ACTIVE",
  "PROTOCOL_REGISTRATION_CONFLICT",
  "SHARE_UNAVAILABLE",
  "SHARE_BUSY",
  "CHROME_UNAVAILABLE",
] as const;
export type ConsumerNativeErrorCode =
  (typeof CONSUMER_NATIVE_ERROR_CODES)[number];

/** Safe to serialize: native error strings, command lines and secrets are absent. */
export class ConsumerNativeError extends Error {
  constructor(readonly code: ConsumerNativeErrorCode) {
    super(code);
    this.name = "ConsumerNativeError";
  }
  toJSON(): { code: ConsumerNativeErrorCode } {
    return { code: this.code };
  }
}

export type ConsumerRoot = "personal" | "fleet";
export type ConsumerVaultNamespace = "account" | "fleet";
export type ConsumerOwnedRole =
  "session-agent" | "fleet" | "personal" | "prepare";
export interface ConsumerProcessIdentity {
  sid: string;
  sessionId: number;
  pid: number;
  /** Decimal Windows FILETIME, not a JavaScript number or wall-clock estimate. */
  creationTime: string;
}
export interface ConsumerHostIdentity extends ConsumerProcessIdentity {
  logonSid: string;
  nativeArch: "x64";
  processArch: "x64";
  osMajor: 10;
  osBuild: number;
  localAppData: string;
}
export interface ConsumerOwnedProcess {
  role: ConsumerOwnedRole;
  nonce: string;
  identity: ConsumerProcessIdentity;
}
export interface ConsumerPipeConnection {
  token: string;
  nonce: string;
  peer: ConsumerProcessIdentity;
}
export type ConsumerMutexScope =
  | "session"
  | "account"
  | "activation"
  | "prepare"
  | "acquisition"
  | "cache"
  | "metadata";
export interface ConsumerMutexLease {
  scope: ConsumerMutexScope;
  nonce: string;
  identity: ConsumerProcessIdentity;
  abandoned: boolean;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  return value as Record<string, unknown>;
}
export function isCurrentUserSid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:S-1-5-21-(?:\d{1,10}-){3}\d{1,10}|S-1-12-1-(?:\d{1,10}-){3}\d{1,10})$/u.test(
      value,
    ) &&
    value
      .split("-")
      .slice(4)
      .every((part) => BigInt(part) <= 0xffffffffn)
  );
}
export function isLogonSid(value: unknown): value is string {
  return (
    typeof value === "string" && /^S-1-5-5-\d{1,10}-\d{1,10}$/u.test(value)
  );
}
export function processIdentityFromWire(
  value: unknown,
): ConsumerProcessIdentity {
  const wire = object(value);
  if (
    !isCurrentUserSid(wire.sid) ||
    !Number.isSafeInteger(wire.session_id) ||
    (wire.session_id as number) < 1 ||
    (wire.session_id as number) > 0xffffffff ||
    !Number.isSafeInteger(wire.pid) ||
    (wire.pid as number) < 1 ||
    (wire.pid as number) > 2_147_483_647 ||
    typeof wire.creation_time !== "string" ||
    !/^[1-9]\d{1,19}$/u.test(wire.creation_time) ||
    BigInt(wire.creation_time) > 0xffffffffffffffffn
  )
    throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  return {
    sid: wire.sid,
    sessionId: wire.session_id as number,
    pid: wire.pid as number,
    creationTime: wire.creation_time,
  };
}
export function processIdentityToWire(
  identity: ConsumerProcessIdentity,
): Record<string, unknown> {
  const wire = {
    sid: identity.sid,
    session_id: identity.sessionId,
    pid: identity.pid,
    creation_time: identity.creationTime,
  };
  processIdentityFromWire(wire);
  return wire;
}
export function sameConsumerProcess(
  first: ConsumerProcessIdentity,
  second: ConsumerProcessIdentity,
): boolean {
  return (
    first.sid === second.sid &&
    first.sessionId === second.sessionId &&
    first.pid === second.pid &&
    first.creationTime === second.creationTime
  );
}

/** The helper repeats this policy with Win32 handles, ACLs and reparse checks. */
export function assertConsumerRelativePath(
  value: string,
  emptyAllowed = false,
): void {
  if (value === "" && emptyAllowed) return;
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 4096 ||
    value.includes("/") ||
    value.includes(":") ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    /[<>"|?*]/u.test(value) ||
    win32.isAbsolute(value) ||
    win32.normalize(value) !== value ||
    value
      .split("\\")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[ .]$/u.test(part) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(part),
      )
  )
    throw new ConsumerNativeError("PATH_UNSAFE");
}
export function assertConsumerAbsolutePath(value: string): void {
  if (!/^[A-Za-z]:\\/u.test(value))
    throw new ConsumerNativeError("PATH_UNSAFE");
  assertConsumerRelativePath(value.slice(3));
}
export function consumerDataSddl(sid: string): string {
  if (!isCurrentUserSid(sid)) throw new ConsumerNativeError("ACL_UNSAFE");
  return `O:${sid}D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)`;
}
export function consumerPipeSddl(sid: string, logonSid: string): string {
  if (!isCurrentUserSid(sid) || !isLogonSid(logonSid))
    throw new ConsumerNativeError("ACL_UNSAFE");
  // Do not use generic write: FILE_APPEND_DATA aliases CREATE_PIPE_INSTANCE.
  return `O:${sid}D:P(A;;0x0012019b;;;${logonSid})`;
}
export function assertConsumerNonce(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value))
    throw new ConsumerNativeError("BAD_REQUEST");
}
export function assertConsumerPipePeer(
  owner: ConsumerHostIdentity,
  expected: ConsumerProcessIdentity,
  actual: ConsumerProcessIdentity,
  expectedNonce: string,
  actualNonce: string,
): void {
  assertConsumerNonce(expectedNonce);
  assertConsumerNonce(actualNonce);
  if (
    owner.sid !== actual.sid ||
    owner.sessionId !== actual.sessionId ||
    !sameConsumerProcess(expected, actual) ||
    !timingSafeEqual(Buffer.from(expectedNonce), Buffer.from(actualNonce))
  )
    throw new ConsumerNativeError("PEER_DENIED");
}
export function decodeConsumerBase64(value: unknown, maximum: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(maximum / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  )
    throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  const result = Buffer.from(value, "base64");
  if (result.byteLength > maximum || result.toString("base64") !== value)
    throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  return result;
}

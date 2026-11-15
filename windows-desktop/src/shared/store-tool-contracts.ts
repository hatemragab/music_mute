import {
  processIdentityFromWire,
  sameConsumerProcess,
  type ConsumerProcessIdentity,
} from "../../../worker/src/platform/windows/consumer-native.js";
export const STORE_FIXED_TOOL_KINDS = Object.freeze([
  "cloud-probe-input",
  "cloud-transcode",
  "cloud-probe-output",
  "silence-probe",
  "silence-decode",
  "doctor-metadata",
  "doctor-media",
  "downloader-version",
  "downloader-help",
  "downloader-ejs",
  "deno-version",
  "deno-provider",
] as const);
export type StoreFixedToolKind = (typeof STORE_FIXED_TOOL_KINDS)[number];
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
function deny(): never {
  throw new Error("STORE_TOOL_INVALID");
}
function exact(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    deny();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== "string" || !fields.includes(k))
  )
    deny();
  const out: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) deny();
    out[field] = d.value;
  }
  return out;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) deny();
  return value;
}
export function assertStoreFixedTool(
  kind: unknown,
  requestId: unknown,
): asserts kind is StoreFixedToolKind {
  if (
    !STORE_FIXED_TOOL_KINDS.some((k) => k === kind) ||
    typeof requestId !== "string" ||
    !UUID.test(requestId)
  )
    deny();
}
/** Receiving bytes only. The actual issuer/Creator's live protected role and
 * owned child table confer launch/cleanup authority independently. */
export function parseStoreToolStarted(
  value: unknown,
  owner: ConsumerProcessIdentity,
  previous?: { token: string; process: ConsumerProcessIdentity },
) {
  try {
    const row = exact(value, ["token", "started", "process"]),
      token = digest(row.token);
    const shape = exact(row.process, [
        "sid",
        "session_id",
        "pid",
        "creation_time",
      ]),
      child = processIdentityFromWire(shape);
    if (
      row.started !== true ||
      child.pid === owner.pid ||
      child.sid !== owner.sid ||
      child.sessionId !== owner.sessionId ||
      (previous &&
        (previous.token !== token ||
          !sameConsumerProcess(previous.process, child)))
    )
      deny();
    return Object.freeze({ token, process: Object.freeze(child) });
  } catch {
    return deny();
  }
}
export function parseStoreToolToken(value: unknown): string {
  try {
    const row = exact(value, ["token", "started", "process"]);
    if (row.started !== true && row.started !== false) deny();
    if (row.started === false) {
      if (row.process !== null) deny();
    } else
      processIdentityFromWire(
        exact(row.process, ["sid", "session_id", "pid", "creation_time"]),
      );
    return digest(row.token);
  } catch {
    return deny();
  }
}
function decoded(value: unknown, maximum: number) {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4)
    deny();
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maximum || bytes.toString("base64") !== value) deny();
  return bytes;
}
export function parseStoreToolChunk(value: unknown) {
  try {
    const row = exact(value, [
      "bytes_base64",
      "stderr_base64",
      "eof",
      "exit_code",
    ]);
    if (
      typeof row.eof !== "boolean" ||
      (row.eof
        ? !Number.isSafeInteger(row.exit_code) ||
          (row.exit_code as number) < 0 ||
          (row.exit_code as number) > 0xffffffff
        : row.exit_code !== null)
    )
      deny();
    return {
      bytes: decoded(row.bytes_base64, 24576),
      diagnostics: decoded(row.stderr_base64, 16384),
      eof: row.eof,
      exitCode: row.exit_code as number | null,
    };
  } catch {
    return deny();
  }
}
export function parseStoreToolCleanup(value: unknown): void {
  try {
    const row = exact(value, ["job", "stopped"]);
    if (row.job !== "confirmed" || row.stopped !== true) deny();
  } catch {
    return deny();
  }
}

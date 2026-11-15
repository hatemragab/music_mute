import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
import { STORE_PREPARE_FAILURE_CODES } from "./store-prepare-contracts.js";
/** Supplementary terminal failure bytes, never GPU/Job/Ready authority. The
 * caller must independently observe the original owned child's nonzero exit
 * and positive child cleanup before interpreting these receiving bytes. */
export function parseStoreQualificationFailure(
  bytes: Uint8Array,
): (typeof STORE_PREPARE_FAILURE_CODES)[number] | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 262144)
    throw new Error("STORE_QUALIFICATION_RESULT_INVALID");
  const text = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
  if (
    text.charCodeAt(0) === 0xfeff ||
    text.includes("\r") ||
    text.includes("\0")
  )
    throw new Error("STORE_QUALIFICATION_RESULT_INVALID");
  if (!text.length) return undefined;
  if (!text.endsWith("\n"))
    throw new Error("STORE_QUALIFICATION_RESULT_INVALID");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > 2048)
    throw new Error("STORE_QUALIFICATION_RESULT_INVALID");
  const final = lines.at(-1)!;
  if (!final.startsWith("{")) return undefined;
  const value = parseStrictJson(final, 16384, 256);
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const row = value as Record<string, unknown>;
  if (row.kind !== "store-qualification-failure") return undefined;
  if (
    Object.keys(row).sort().join() !== "errorCode,kind,version" ||
    row.version !== 1 ||
    !(STORE_PREPARE_FAILURE_CODES as readonly unknown[]).includes(row.errorCode)
  )
    throw new Error("STORE_QUALIFICATION_RESULT_INVALID");
  return row.errorCode as (typeof STORE_PREPARE_FAILURE_CODES)[number];
}

import { assertConsumerRelativePath } from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import type { StorageWriteLease } from "./write-journal.js";
const UUID =
  "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const EXTENSION = "(?:m4a|mp4|webm|mp3|opus|ogg|aac|wav|flac)";
const THUMBNAIL = new RegExp(
  `^(library\\\\thumbnails\\\\[a-f0-9]{64}\\.image)\\.${UUID}\\.tmp$`,
  "u",
);
const OUTBOX = new RegExp(
  `^(outbox\\\\[a-f0-9]{64}\\\\${UUID}\\\\(original|vocals)\\.${EXTENSION})\\.${UUID}\\.part$`,
  "u",
);
const DIAGNOSTIC_REPORT = new RegExp(
  `^(diagnostics\\\\reports\\\\${UUID}\\.json)\\.${UUID}\\.tmp$`,
  "u",
);
export const DIAGNOSTIC_PARTIAL_LIMIT = 4;
export const DIAGNOSTIC_PARTIAL_MAX_BYTES = 2 * 1024 ** 2;
export const THUMBNAIL_PARTIAL_LIMIT = 16;
export const THUMBNAIL_PARTIAL_MAX_BYTES = 1024 ** 2;
export const OUTBOX_PARTIAL_ROLE_MAX_BYTES = 256 * 1024 ** 2;
export interface StoragePartialWriteAdmission {
  beginPartialWrite(
    relative: string,
    bytes: number,
  ): Promise<StorageWriteLease>;
  recoverPartialWrites(canonical: string, signal: AbortSignal): Promise<void>;
}
/** Closed, never-playable temporary slots. Canonical files are excluded from this authority. */
export function partialWriteTarget(relative: string):
  | {
      canonical: string;
      kind:
        "thumbnail" | "outbox-original" | "outbox-vocals" | "diagnostic-report";
      maxBytes: number;
    }
  | undefined {
  assertConsumerRelativePath(relative);
  const diagnostic = DIAGNOSTIC_REPORT.exec(relative);
  if (diagnostic)
    return {
      canonical: diagnostic[1]!,
      kind: "diagnostic-report",
      maxBytes: DIAGNOSTIC_PARTIAL_MAX_BYTES,
    };
  const thumbnail = THUMBNAIL.exec(relative);
  if (thumbnail)
    return {
      canonical: thumbnail[1]!,
      kind: "thumbnail",
      maxBytes: THUMBNAIL_PARTIAL_MAX_BYTES,
    };
  const outbox = OUTBOX.exec(relative);
  if (outbox?.[2] === "vocals" && !outbox[1]!.endsWith(".mp3"))
    return undefined;
  if (outbox)
    return {
      canonical: outbox[1]!,
      kind: outbox[2] === "original" ? "outbox-original" : "outbox-vocals",
      maxBytes: 100000000,
    };
  return undefined;
}
export function assertPartialCanonical(relative: string): void {
  assertConsumerRelativePath(relative);
  if (
    !partialWriteTarget(
      `${relative}.00000000-0000-4000-8000-000000000000.${relative.startsWith("library\\") || relative.startsWith("diagnostics\\reports\\") ? "tmp" : "part"}`,
    )
  )
    throw new Error("STORAGE_WRITE_INVALID");
}

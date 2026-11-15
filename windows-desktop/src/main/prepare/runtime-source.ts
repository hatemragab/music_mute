import type { UpdateMetadata } from "../../../../worker/src/platform/shared/update-metadata.js";
import { PrepareFailure } from "./controller.js";
import { consumerUpdateUrl } from "../update/metadata.js";
export interface PreparationRuntimeSource {
  version: 1;
  platform: "windows-amd64";
  installationProfile: "windows-user";
  targetIdentity: string;
  filename: string;
  bytes: number;
  sha256: string;
  /** Null is allowed only for an authenticated installed catalog source, never a sealed package descriptor. */
  unpackedBytes: number | null;
  url: string;
  /** Internal authenticated catalog trust only; the sealed descriptor rejects this field. */
  allowedOrigins?: readonly string[];
}
export function runtimeDownloadUrl(
  raw: string,
  allowedOrigins?: readonly string[],
): URL {
  if (allowedOrigins !== undefined) {
    try {
      if (
        !Array.isArray(allowedOrigins) ||
        allowedOrigins.length < 1 ||
        allowedOrigins.length > 4 ||
        new Set(allowedOrigins).size !== allowedOrigins.length ||
        allowedOrigins.some(
          (origin) =>
            consumerUpdateUrl(origin, allowedOrigins).origin !== origin,
        )
      )
        throw new Error();
      return consumerUpdateUrl(raw, allowedOrigins);
    } catch {
      throw new PrepareFailure("INTEGRITY_INVALID");
    }
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PrepareFailure("INTEGRITY_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "downloads.music-mute.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/releases\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,119}\/){0,8}[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.zip$/u.test(
      url.pathname,
    ) ||
    url.pathname.split("/").some((part) => part === "." || part === "..")
  )
    throw new PrepareFailure("INTEGRITY_INVALID");
  return url;
}
/** Sealed app resource only; the runtime ZIP can never supply its own URL/trust descriptor. */
export function parsePreparationRuntimeSource(
  value: unknown,
  metadata: UpdateMetadata,
  target: string,
): PreparationRuntimeSource {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PrepareFailure("INTEGRITY_INVALID");
  const row = value as PreparationRuntimeSource;
  if (
    Object.keys(row).sort().join() !==
      "bytes,filename,installationProfile,platform,sha256,targetIdentity,unpackedBytes,url,version" ||
    row.version !== 1 ||
    row.platform !== "windows-amd64" ||
    row.installationProfile !== "windows-user" ||
    metadata.installationProfile !== "windows-user" ||
    row.targetIdentity !== target ||
    row.filename !== metadata.release.filename ||
    row.bytes !== metadata.release.bytes ||
    row.sha256 !== metadata.release.sha256 ||
    row.bytes > 4 * 1024 ** 3 ||
    typeof row.unpackedBytes !== "number" ||
    !Number.isSafeInteger(row.unpackedBytes) ||
    row.unpackedBytes < 1 ||
    row.unpackedBytes > 16 * 1024 ** 3 ||
    typeof row.url !== "string"
  )
    throw new PrepareFailure("INTEGRITY_INVALID");
  const url = runtimeDownloadUrl(row.url);
  if (url.pathname.split("/").at(-1) !== row.filename)
    throw new PrepareFailure("INTEGRITY_INVALID");
  return structuredClone(row);
}

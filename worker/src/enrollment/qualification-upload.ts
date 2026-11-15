import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { WorkerEnrollmentClient } from "./enrollment-client.js";

const MAX_RESULT_BYTES = 30_000_000;
const VERSION_ID = /^[A-Za-z0-9+/=_.,:-]{1,1024}$/u;

type QualificationClient = Pick<
  WorkerEnrollmentClient,
  "qualificationUploadGrant" | "confirmQualificationUpload"
>;

export interface QualificationUploadOptions {
  client: QualificationClient;
  installationId: string;
  installationCredential: string;
  grantRequestId: string;
  confirmRequestId: string;
  outputPath: string;
  expectedBytes: number;
  expectedSha256: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface QualificationUploadResult {
  bytes: number;
  sha256: string;
  confirmed: true;
  replayed: boolean;
}

export async function uploadQualificationResult(
  options: QualificationUploadOptions,
): Promise<QualificationUploadResult> {
  if (!isAbsolute(options.outputPath))
    throw new TypeError("Qualification output path must be absolute");
  const info = await lstat(options.outputPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 1 ||
    info.size > MAX_RESULT_BYTES ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new TypeError("Qualification output file is unsafe");
  const payload = await readFile(options.outputPath);
  if (payload.byteLength !== info.size)
    throw new TypeError("Qualification output file changed while reading");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  if (
    payload.byteLength !== options.expectedBytes ||
    sha256 !== options.expectedSha256
  )
    throw new TypeError("Qualification output does not match service evidence");
  const reservation = await options.client.qualificationUploadGrant(
    options.installationId,
    options.installationCredential,
    options.grantRequestId,
    payload.byteLength,
    sha256,
  );
  if (reservation.confirmed)
    return {
      bytes: payload.byteLength,
      sha256,
      confirmed: true,
      replayed: true,
    };
  const grant = reservation.grant;
  if (grant === null || Date.parse(grant.expiresAt) <= Date.now())
    throw new TypeError("Qualification upload grant is unavailable");
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 60 * 60_000
  )
    throw new TypeError("Qualification upload timeout is invalid");
  const response = await (options.fetch ?? fetch)(grant.url, {
    method: "PUT",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
    headers: grant.headers,
    body: payload,
  });
  if (!response.ok) throw new Error("Qualification result upload failed");
  const versionId = response.headers.get("x-amz-version-id");
  if (versionId === null || !VERSION_ID.test(versionId))
    throw new TypeError("Qualification upload version is unavailable");
  const confirmed = await options.client.confirmQualificationUpload(
    options.installationId,
    options.installationCredential,
    options.confirmRequestId,
    versionId,
  );
  return {
    bytes: payload.byteLength,
    sha256,
    confirmed: true,
    replayed: confirmed.replayed,
  };
}

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { WorkerEnrollmentClient } from "./enrollment-client.js";

import { TransferBudget } from "./transfer-budget.js";

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
  idleTimeoutMs?: number;
  signal?: AbortSignal;
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
  options.signal?.throwIfAborted();
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
  const budget = new TransferBudget(
    options.timeoutMs,
    options.idleTimeoutMs,
    options.signal,
  );
  let response: Response | undefined;
  let versionId: string;
  try {
    budget.signal.throwIfAborted();
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (budget.signal.aborted) {
          controller.error(budget.signal.reason);
          return;
        }
        if (offset === payload.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 64 * 1024, payload.byteLength);
        controller.enqueue(payload.subarray(offset, end));
        offset = end;
        budget.progress();
      },
    });
    const request: RequestInit & { duplex: "half" } = {
      method: "PUT",
      redirect: "error",
      signal: budget.signal,
      headers: {
        ...grant.headers,
        "Content-Length": String(payload.byteLength),
      },
      body,
      duplex: "half",
    };
    response = await (options.fetch ?? fetch)(grant.url, request);
    budget.signal.throwIfAborted();
    if (!response.ok) throw new Error("Qualification result upload failed");
    const version = response.headers.get("x-amz-version-id");
    if (version === null || !VERSION_ID.test(version))
      throw new TypeError("Qualification upload version is unavailable");
    versionId = version;
  } finally {
    budget.dispose();
    await response?.body?.cancel().catch(() => undefined);
  }
  options.signal?.throwIfAborted();
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

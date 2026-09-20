import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type {
  ObjectIdentity,
  TransferGrant,
  UploadGrant,
} from "./contracts.js";

const UPLOAD_HEADER_NAMES = new Set([
  "content-type",
  "if-none-match",
  "x-amz-checksum-sha256",
]);
const DEFAULT_TRANSFER_TIMEOUT_MS = 2 * 60 * 60_000;

export class TransferError extends Error {
  constructor(
    readonly code: "DOWNLOAD_FAILED" | "OUTPUT_UPLOAD_FAILED",
    readonly retryable: boolean,
  ) {
    super(
      code === "DOWNLOAD_FAILED"
        ? "Input download failed"
        : "Output upload failed",
    );
    this.name = "TransferError";
  }
}

export interface TransferClientOptions {
  fetch?: typeof fetch;
  allowInsecureLoopback?: boolean;
  timeoutMs?: number;
}

export class WorkerTransferClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly allowInsecureLoopback: boolean;
  private readonly timeoutMs: number;

  constructor(options: TransferClientOptions = {}) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.allowInsecureLoopback = options.allowInsecureLoopback === true;
    this.timeoutMs = boundedTimeout(
      options.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS,
    );
  }

  async download(
    grant: TransferGrant,
    expected: ObjectIdentity,
    destination: string,
    signal?: AbortSignal,
  ): Promise<void> {
    validateGrantUrl(grant, this.allowInsecureLoopback, "DOWNLOAD_FAILED");
    if (Date.parse(grant.expiresAt) <= Date.now())
      throw new TransferError("DOWNLOAD_FAILED", true);
    const target = resolve(destination);
    if (
      !isAbsolute(destination) ||
      basename(target) !== basename(destination) ||
      dirname(target) === target
    )
      throw new TransferError("DOWNLOAD_FAILED", false);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const response = await this.fetchImplementation(grant.url, {
        method: "GET",
        redirect: "error",
        signal: requestSignal,
        headers: { Accept: expected.contentType },
      });
      if (response.status !== 200 || !response.body)
        throw new TransferError(
          "DOWNLOAD_FAILED",
          response.status === 408 ||
            response.status === 429 ||
            response.status >= 500,
        );
      const encoding = response.headers.get("content-encoding");
      if (encoding && encoding.toLowerCase() !== "identity")
        throw new TransferError("DOWNLOAD_FAILED", false);
      const contentType = response.headers.get("content-type");
      if (contentType && contentType.split(";", 1)[0] !== expected.contentType)
        throw new TransferError("DOWNLOAD_FAILED", false);
      const declared = response.headers.get("content-length");
      if (declared && Number(declared) !== expected.bytes)
        throw new TransferError("DOWNLOAD_FAILED", false);
      handle = await open(target, "wx", 0o600);
      const digest = createHash("sha256");
      const reader = response.body.getReader();
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > expected.bytes) {
          await reader.cancel();
          throw new TransferError("DOWNLOAD_FAILED", false);
        }
        digest.update(value);
        let offset = 0;
        while (offset < value.byteLength) {
          const { bytesWritten } = await handle.write(
            value,
            offset,
            value.byteLength - offset,
          );
          if (bytesWritten < 1)
            throw new TransferError("DOWNLOAD_FAILED", true);
          offset += bytesWritten;
        }
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      const actualDigest = digest.digest();
      const expectedDigest = Buffer.from(expected.sha256, "base64");
      if (
        bytes !== expected.bytes ||
        expectedDigest.length !== actualDigest.length ||
        !timingSafeEqual(actualDigest, expectedDigest)
      )
        throw new TransferError("DOWNLOAD_FAILED", false);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(target).catch(() => undefined);
      if (signal?.aborted) throw signal.reason;
      if (error instanceof TransferError) throw error;
      throw new TransferError("DOWNLOAD_FAILED", true);
    }
  }

  async upload(
    grant: UploadGrant,
    source: string,
    expected: {
      bytes: number;
      sha256: string;
      contentType: "audio/mpeg";
    },
    signal?: AbortSignal,
  ): Promise<string> {
    validateGrantUrl(grant, this.allowInsecureLoopback, "OUTPUT_UPLOAD_FAILED");
    validateUploadHeaders(grant, expected);
    if (Date.parse(grant.expiresAt) <= Date.now())
      throw new TransferError("OUTPUT_UPLOAD_FAILED", true);
    try {
      const sourceStat = await lstat(source);
      if (
        !sourceStat.isFile() ||
        sourceStat.isSymbolicLink() ||
        sourceStat.size !== expected.bytes
      )
        throw new TransferError("OUTPUT_UPLOAD_FAILED", false);
      const body = await readFile(source);
      const digest = createHash("sha256").update(body).digest();
      const expectedDigest = Buffer.from(expected.sha256, "base64");
      if (
        digest.length !== expectedDigest.length ||
        !timingSafeEqual(digest, expectedDigest)
      )
        throw new TransferError("OUTPUT_UPLOAD_FAILED", false);
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeout])
        : timeout;
      const response = await this.fetchImplementation(grant.url, {
        method: "PUT",
        redirect: "error",
        signal: requestSignal,
        headers: grant.headers,
        body,
      });
      if (!response.ok)
        throw new TransferError(
          "OUTPUT_UPLOAD_FAILED",
          response.status === 408 ||
            response.status === 409 ||
            response.status === 412 ||
            response.status === 429 ||
            response.status >= 500,
        );
      const versionId = response.headers.get("x-amz-version-id");
      if (!versionId || versionId === "null" || versionId.length > 1024)
        throw new TransferError("OUTPUT_UPLOAD_FAILED", true);
      return versionId;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof TransferError) throw error;
      throw new TransferError("OUTPUT_UPLOAD_FAILED", true);
    }
  }
}

function validateGrantUrl(
  grant: TransferGrant,
  allowInsecureLoopback: boolean,
  code: "DOWNLOAD_FAILED" | "OUTPUT_UPLOAD_FAILED",
): void {
  const url = new URL(grant.url);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(allowInsecureLoopback && loopback))
  )
    throw new TransferError(code, false);
  if (!Number.isFinite(Date.parse(grant.expiresAt)))
    throw new TransferError(code, false);
}

function validateUploadHeaders(
  grant: UploadGrant,
  expected: { sha256: string; contentType: "audio/mpeg" },
): void {
  if (grant.method !== "PUT")
    throw new TransferError("OUTPUT_UPLOAD_FAILED", false);
  const headers = new Map(
    Object.entries(grant.headers).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  if (
    headers.size !== 3 ||
    [...headers.keys()].some((name) => !UPLOAD_HEADER_NAMES.has(name)) ||
    headers.get("content-type") !== expected.contentType ||
    headers.get("x-amz-checksum-sha256") !== expected.sha256 ||
    headers.get("if-none-match") !== "*"
  )
    throw new TransferError("OUTPUT_UPLOAD_FAILED", false);
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 7_200_000)
    throw new TypeError("Transfer timeout is invalid");
  return value;
}

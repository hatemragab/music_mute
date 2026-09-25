import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
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
  "x-amz-storage-class",
]);
const DEFAULT_TRANSFER_TIMEOUT_MS = 2 * 60 * 60_000;
const DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

export class TransferError extends Error {
  constructor(
    readonly code: "DOWNLOAD_FAILED" | "OUTPUT_UPLOAD_FAILED",
    readonly retryable: boolean,
    readonly diagnostic?: string,
  ) {
    super(
      code === "DOWNLOAD_FAILED"
        ? "Input download failed"
        : "Output upload failed",
    );
    this.name = "TransferError";
  }
}

/** File-handle ownership is uncertain; the caller must preserve its workspace. */
export class TransferOwnershipError extends TransferError {
  constructor(code: "DOWNLOAD_FAILED" | "OUTPUT_UPLOAD_FAILED") {
    super(code, false, "file-close-failed");
    this.name = "TransferOwnershipError";
  }
}

export interface TransferClientOptions {
  fetch?: typeof fetch;
  allowInsecureLoopback?: boolean;
  timeoutMs?: number;
  downloadIdleTimeoutMs?: number;
  uploadIdleTimeoutMs?: number;
}

export class WorkerTransferClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly allowInsecureLoopback: boolean;
  private readonly timeoutMs: number;
  private readonly downloadIdleTimeoutMs: number;
  private readonly uploadIdleTimeoutMs: number;

  constructor(options: TransferClientOptions = {}) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.allowInsecureLoopback = options.allowInsecureLoopback === true;
    this.timeoutMs = boundedTimeout(
      options.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS,
    );
    this.uploadIdleTimeoutMs = boundedTimeout(
      options.uploadIdleTimeoutMs ?? 30_000,
    );
    this.downloadIdleTimeoutMs = boundedTimeout(
      options.downloadIdleTimeoutMs ?? DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS,
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
    const idle = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout>;
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(), this.downloadIdleTimeoutMs);
      idleTimer.unref();
    };
    resetIdleTimer();
    const requestSignal = AbortSignal.any([
      timeout,
      idle.signal,
      ...(signal ? [signal] : []),
    ]);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let created = false;
    try {
      requestSignal.throwIfAborted();
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
          `download-http-${response.status}`,
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
      created = true;
      requestSignal.throwIfAborted();
      const digest = createHash("sha256");
      const reader = response.body.getReader();
      let bytes = 0;
      while (true) {
        requestSignal.throwIfAborted();
        const { done, value } = await reader.read();
        requestSignal.throwIfAborted();
        if (done) break;
        if (value.byteLength > 0) resetIdleTimer();
        bytes += value.byteLength;
        if (bytes > expected.bytes) {
          await reader.cancel();
          throw new TransferError("DOWNLOAD_FAILED", false);
        }
        digest.update(value);
        let offset = 0;
        while (offset < value.byteLength) {
          requestSignal.throwIfAborted();
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
      requestSignal.throwIfAborted();
      await handle.sync();
      requestSignal.throwIfAborted();
      await handle.close();
      handle = undefined;
      requestSignal.throwIfAborted();
      const actualDigest = digest.digest();
      const expectedDigest = Buffer.from(expected.sha256, "base64");
      if (
        bytes !== expected.bytes ||
        expectedDigest.length !== actualDigest.length ||
        !timingSafeEqual(actualDigest, expectedDigest)
      )
        throw new TransferError("DOWNLOAD_FAILED", false);
    } catch (error) {
      await closeTransferHandle(handle, "DOWNLOAD_FAILED");
      if (created) await unlink(target).catch(() => undefined);
      if (signal?.aborted) throw signal.reason;
      if (error instanceof TransferError) throw error;
      throw new TransferError(
        "DOWNLOAD_FAILED",
        true,
        idle.signal.aborted
          ? "download-idle-timeout"
          : timeout.aborted
            ? "download-total-timeout"
            : `download-transport-${transferErrorName(error)}`,
      );
    } finally {
      clearTimeout(idleTimer!);
      // Release the HTTP connection on validation failures as well.
      idle.abort();
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
      throw new TransferError("OUTPUT_UPLOAD_FAILED", true, "grant-expired");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let body:
      | ReturnType<Awaited<ReturnType<typeof open>>["createReadStream"]>
      | undefined;
    let validationError: TransferError | undefined;
    let verified = false;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const idle = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout>;
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(), this.uploadIdleTimeoutMs);
      idleTimer.unref();
    };
    const requestSignal = AbortSignal.any([
      timeout,
      idle.signal,
      ...(signal ? [signal] : []),
    ]);
    // Fetch exposes body consumption, not remote acknowledgement of each byte.
    // This also bounds waiting for response headers after the body is consumed.
    resetIdleTimer();
    const abortBody = () => {
      body?.destroy();
    };
    requestSignal.addEventListener("abort", abortBody, { once: true });
    try {
      requestSignal.throwIfAborted();
      const pathStat = await lstat(source);
      if (!pathStat.isFile() || pathStat.isSymbolicLink())
        throw new TransferError(
          "OUTPUT_UPLOAD_FAILED",
          false,
          "output-identity-mismatch",
        );
      handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      const sourceStat = await handle.stat();
      if (
        !sourceStat.isFile() ||
        sourceStat.dev !== pathStat.dev ||
        sourceStat.ino !== pathStat.ino ||
        !Number.isSafeInteger(expected.bytes) ||
        expected.bytes <= 0 ||
        expected.bytes > 30_000_000 ||
        sourceStat.size !== expected.bytes
      )
        throw new TransferError(
          "OUTPUT_UPLOAD_FAILED",
          false,
          "output-identity-mismatch",
        );
      body = handle.createReadStream({
        autoClose: false,
        highWaterMark: 64 * 1024,
      });
      requestSignal.throwIfAborted();
      const sourceStream = body;
      async function* verifiedBody() {
        const digest = createHash("sha256");
        let bytes = 0;
        // Hold the final chunk until verification so corrupt content cannot
        // finish a PUT. Earlier chunks upload while subsequent chunks are read.
        let pending: Buffer | undefined;
        for await (const chunk of sourceStream) {
          requestSignal.throwIfAborted();
          const data = chunk as Buffer;
          if (data.length > 0) resetIdleTimer();
          bytes += data.length;
          if (bytes > expected.bytes) {
            validationError = new TransferError(
              "OUTPUT_UPLOAD_FAILED",
              false,
              "output-identity-mismatch",
            );
            throw validationError;
          }
          digest.update(data);
          if (pending) yield pending;
          pending = data;
        }
        const actual = digest.digest();
        const expectedDigest = Buffer.from(expected.sha256, "base64");
        if (
          bytes !== expected.bytes ||
          actual.length !== expectedDigest.length ||
          !timingSafeEqual(actual, expectedDigest)
        ) {
          validationError = new TransferError(
            "OUTPUT_UPLOAD_FAILED",
            false,
            "output-checksum-mismatch",
          );
          throw validationError;
        }
        verified = true;
        if (pending) {
          requestSignal.throwIfAborted();
          resetIdleTimer();
          yield pending;
        }
      }
      const request: RequestInit & { duplex: "half" } = {
        method: "PUT",
        redirect: "error",
        signal: requestSignal,
        headers: { ...grant.headers, "Content-Length": String(expected.bytes) },
        body: verifiedBody(),
        duplex: "half",
      };
      const response = await this.fetchImplementation(grant.url, request);
      // PUT responses carry no useful body; release the connection immediately.
      void response.body?.cancel().catch(() => undefined);
      if (!response.ok)
        throw new TransferError(
          "OUTPUT_UPLOAD_FAILED",
          response.status === 408 ||
            response.status === 409 ||
            response.status === 412 ||
            response.status === 429 ||
            response.status >= 500,
          `upload-http-${response.status}`,
        );
      if (!verified)
        throw new TransferError(
          "OUTPUT_UPLOAD_FAILED",
          false,
          "output-not-consumed",
        );
      const versionId = response.headers.get("x-amz-version-id");
      if (!versionId || versionId === "null" || versionId.length > 1024)
        throw new TransferError(
          "OUTPUT_UPLOAD_FAILED",
          true,
          "upload-version-id-missing",
        );
      return versionId;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (validationError) throw validationError;
      if (error instanceof TransferError) throw error;
      throw new TransferError(
        "OUTPUT_UPLOAD_FAILED",
        true,
        idle.signal.aborted
          ? "upload-idle-timeout"
          : timeout.aborted
            ? "upload-total-timeout"
            : `upload-transport-${transferErrorName(error)}`,
      );
    } finally {
      clearTimeout(idleTimer!);
      requestSignal.removeEventListener("abort", abortBody);
      idle.abort();
      body?.destroy();
      await closeTransferHandle(handle, "OUTPUT_UPLOAD_FAILED");
    }
  }
}

function transferErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  return error.name.replace(/[^a-z0-9-]/gi, "-").slice(0, 64) || "error";
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
  const storageClass = headers.get("x-amz-storage-class");
  if (
    headers.size < 3 ||
    headers.size > 4 ||
    Object.keys(grant.headers).length !== headers.size ||
    [...headers.keys()].some((name) => !UPLOAD_HEADER_NAMES.has(name)) ||
    headers.get("content-type") !== expected.contentType ||
    headers.get("x-amz-checksum-sha256") !== expected.sha256 ||
    headers.get("if-none-match") !== "*" ||
    (storageClass !== undefined && storageClass !== "INTELLIGENT_TIERING")
  )
    throw new TransferError(
      "OUTPUT_UPLOAD_FAILED",
      false,
      "upload-header-mismatch",
    );
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 7_200_000)
    throw new TypeError("Transfer timeout is invalid");
  return value;
}

async function closeTransferHandle(
  handle: Awaited<ReturnType<typeof open>> | undefined,
  code: "DOWNLOAD_FAILED" | "OUTPUT_UPLOAD_FAILED",
): Promise<void> {
  try {
    await handle?.close();
  } catch {
    throw new TransferOwnershipError(code);
  }
}

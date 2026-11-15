import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { validateUploadGrant } from "../../../../chrome-extension/src/companion/local-sync-client.js";
import {
  parseDownloadGrant,
  type DownloadGrant,
  type InputDeclaration,
  type JobMetadata,
} from "../../../../chrome-extension/src/companion/cloud-provider.js";
import { DesktopApiError } from "../../../../chrome-extension/src/companion/account-api.js";
import type {
  PrivateReadable,
  PrivateWritable,
} from "../../../../worker/src/platform/windows/consumer-private-file.js";
type CloudDownloadDestination = Pick<
  PrivateWritable,
  "info" | "write" | "sync"
>;
export type CloudUploadGrant = ReturnType<typeof validateUploadGrant>;
export interface CloudUploadSource {
  /** Retained only for the existing declaration validation; never opened here. */
  path: string;
  file: PrivateReadable;
}
export interface CloudTransferOptions {
  fetch?: typeof fetch;
  signal: AbortSignal;
  assertCurrent(): void;
}
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DesktopApiError("CANCELLED"));
    if (signal.aborted) {
      void operation.catch(() => {});
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
function expiry(value: string) {
  const expires = Date.parse(value);
  if (
    !Number.isFinite(expires) ||
    expires <= Date.now() ||
    expires > Date.now() + 630000
  )
    throw new DesktopApiError("UPLOAD_GRANT_EXPIRED");
}
/** Consumes and closes the native reader on every outcome, including grant denial. */
export async function uploadCloudAudio(
  source: CloudUploadSource,
  input: InputDeclaration,
  grant: CloudUploadGrant,
  options: CloudTransferOptions,
): Promise<void> {
  const { path, file } = source;
  let response: Response | undefined;
  try {
    const validated = validateUploadGrant(grant, {
      path,
      extension: input.extension as "m4a",
      content_type: input.content_type,
      bytes: input.bytes,
      duration_seconds: input.duration_seconds,
      sha256: Buffer.from(input.sha256, "base64").toString("hex"),
    });
    expiry(validated.expires_at);
    options.assertCurrent();
    const before = await file.info();
    if (before.bytes !== input.bytes)
      throw new DesktopApiError("CLOUD_INPUT_INVALID");
    const expectedBytes = before.bytes,
      signal = AbortSignal.any([options.signal, AbortSignal.timeout(120000)]),
      sourceChunks = file.chunks({ end: expectedBytes, signal }),
      stream = Readable.from(
        (async function* () {
          let count = 0;
          for await (const bytes of sourceChunks) {
            signal.throwIfAborted();
            if (
              bytes.byteLength < 1 ||
              bytes.byteLength > expectedBytes - count
            )
              throw new DesktopApiError("CLOUD_INPUT_INVALID");
            count += bytes.byteLength;
            yield bytes;
          }
          if (count !== expectedBytes)
            throw new DesktopApiError("CLOUD_INPUT_INVALID");
        })(),
        { objectMode: false },
      ),
      bodyComplete = finished(stream, { cleanup: true });
    // A response (or cancellation) can arrive before the body finishes. Keep
    // its error observed even when an early 412 intentionally skips the body.
    void bodyComplete.catch(() => {});
    try {
      options.assertCurrent();
      signal.throwIfAborted();
      response = await bounded(
        (options.fetch ?? fetch)(validated.url, {
          method: "PUT",
          headers: {
            ...validated.headers,
            "Content-Length": String(input.bytes),
          },
          body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
          duplex: "half",
          redirect: "error",
          signal,
        } as RequestInit & { duplex: "half" }),
        signal,
      );
      options.assertCurrent();
      signal.throwIfAborted();
      if (!response.ok && response.status !== 412)
        throw new DesktopApiError("UPLOAD_REJECTED", response.status);
      if (response.status !== 412) await bounded(bodyComplete, signal);
      options.assertCurrent();
      signal.throwIfAborted();
      const after = await file.info();
      options.assertCurrent();
      signal.throwIfAborted();
      if (
        after.device !== before.device ||
        after.fileId !== before.fileId ||
        after.bornAt !== before.bornAt ||
        after.bytes !== before.bytes ||
        after.writtenAt !== before.writtenAt ||
        after.changedAt !== before.changedAt
      )
        throw new DesktopApiError("CLOUD_INPUT_INVALID");
    } catch (error) {
      if (error instanceof DesktopApiError) throw error;
      if (
        error instanceof Error &&
        ["ACCOUNT_CHANGED", "SESSION_CHANGED"].includes(error.message)
      )
        throw new DesktopApiError("ACCOUNT_CHANGED");
      if (options.signal.aborted) throw new DesktopApiError("CANCELLED");
      throw new DesktopApiError("UPLOAD_UNAVAILABLE");
    } finally {
      stream.destroy();
    }
  } finally {
    try {
      await file.close();
    } finally {
      void response?.body?.cancel().catch(() => {});
    }
  }
}
/** Count and hash each byte before publishing a private output handle. Caller owns its staging cleanup. */
export async function downloadCloudOutput(
  file: CloudDownloadDestination,
  job: JobMetadata,
  grant: DownloadGrant,
  options: CloudTransferOptions,
): Promise<void> {
  const output = job.output;
  if (
    !output ||
    job.status !== "ready" ||
    !job.can_download_output ||
    !Number.isSafeInteger(output.bytes) ||
    output.bytes < 1 ||
    output.bytes > 100000000 ||
    !/^[A-Za-z0-9+/]{43}=$/.test(output.sha256)
  )
    throw new DesktopApiError("CLOUD_RESULT_UNAVAILABLE");
  return downloadCloudArtifact(file, output, grant, options);
}
/** The caller selects either validated input or output metadata; grants remain opaque R2-only capabilities. */
export async function downloadCloudArtifact(
  file: CloudDownloadDestination,
  output: { bytes: number; sha256: string; content_type: string },
  grant: DownloadGrant,
  options: CloudTransferOptions,
): Promise<void> {
  if (
    !Number.isSafeInteger(output.bytes) ||
    output.bytes < 1 ||
    output.bytes > 256 * 1024 ** 2 ||
    !/^[A-Za-z0-9+/]{43}=$/.test(output.sha256) ||
    !/^audio\/[a-z0-9.+-]{1,64}$/u.test(output.content_type)
  )
    throw new DesktopApiError("CLOUD_RESULT_UNAVAILABLE");
  const validated = parseDownloadGrant(grant),
    signal = AbortSignal.any([options.signal, AbortSignal.timeout(180000)]);
  options.assertCurrent();
  let response: Response | undefined;
  try {
    response = await bounded(
      (options.fetch ?? fetch)(validated.url, {
        method: "GET",
        redirect: "error",
        signal,
        headers: { Accept: output.content_type },
      }),
      signal,
    );
    options.assertCurrent();
    if (!response.ok || !response.body)
      throw new DesktopApiError("CLOUD_RESULT_UNAVAILABLE", response.status);
    const length = response.headers.get("content-length"),
      encoding = response.headers.get("content-encoding"),
      type = response.headers.get("content-type")?.split(";")[0];
    if (
      (length !== null &&
        (!/^\d+$/.test(length) || Number(length) !== output.bytes)) ||
      (encoding && encoding !== "identity") ||
      (type && type !== output.content_type)
    )
      throw new DesktopApiError("CLOUD_REPLY_INVALID");
    const reader = response.body.getReader(),
      hash = createHash("sha256");
    let bytes = 0;
    const before = await file.info();
    if (before.bytes !== 0) throw new DesktopApiError("CLOUD_INPUT_INVALID");
    try {
      for (;;) {
        signal.throwIfAborted();
        options.assertCurrent();
        const part = await bounded(reader.read(), signal);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > output.bytes)
          throw new DesktopApiError("CLOUD_REPLY_INVALID");
        hash.update(part.value);
        let offset = 0;
        while (offset < part.value.length) {
          const written = await file.write(
            part.value,
            offset,
            part.value.length - offset,
          );
          if (written.bytesWritten < 1)
            throw new DesktopApiError("CLOUD_INPUT_INVALID");
          offset += written.bytesWritten;
        }
      }
      options.assertCurrent();
      if (bytes !== output.bytes || hash.digest("base64") !== output.sha256)
        throw new DesktopApiError("CLOUD_REPLY_INVALID");
      await file.sync();
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof DesktopApiError) throw error;
    if (
      error instanceof Error &&
      ["ACCOUNT_CHANGED", "SESSION_CHANGED"].includes(error.message)
    )
      throw new DesktopApiError("ACCOUNT_CHANGED");
    throw new DesktopApiError(
      options.signal.aborted ? "CANCELLED" : "CLOUD_RESULT_UNAVAILABLE",
    );
  } finally {
    void response?.body?.cancel().catch(() => {});
  }
}

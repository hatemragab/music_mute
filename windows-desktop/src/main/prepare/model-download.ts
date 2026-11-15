import { createHash } from "node:crypto";
import type { PrivateWritable } from "../../../../worker/src/platform/windows/consumer-private-file.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import { PrepareFailure, preparationFailure } from "./controller.js";
export interface ModelPin {
  url: string;
  bytes: number;
  sha256: string;
}
export interface ModelDownloadOptions {
  signal: AbortSignal;
  fetch?: typeof fetch;
  onProgress?: (written: number, total: number) => void;
}
type ModelDestination = Pick<PrivateWritable, "info" | "write" | "sync">;
const REDIRECT_HOSTS = new Set([
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
function permittedUrl(raw: string, initial: boolean): URL {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    (initial ? url.toString() !== MODEL.url : !REDIRECT_HOSTS.has(url.hostname))
  )
    throw new PrepareFailure("INTEGRITY_INVALID");
  return url;
}
/** Trusted setup code only. The renderer cannot supply a pin, destination or URL. */
export async function downloadPinnedModel(
  file: ModelDestination,
  pin: ModelPin,
  options: ModelDownloadOptions,
): Promise<void> {
  if (
    !Number.isSafeInteger(pin.bytes) ||
    pin.bytes < 1 ||
    pin.bytes > 1024 ** 3 ||
    !/^[a-f0-9]{64}$/.test(pin.sha256)
  )
    throw new PrepareFailure("INTEGRITY_INVALID");
  let url = permittedUrl(pin.url, true);
  const output = await file.info();
  if (output.bytes !== 0) throw new PrepareFailure("INTEGRITY_INVALID");
  const fetcher = options.fetch ?? fetch;
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(15 * 60_000),
  ]);
  let response: Response | undefined;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      signal.throwIfAborted();
      response = await fetcher(url, {
        redirect: "manual",
        signal,
        headers: { Accept: "application/octet-stream" },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 5)
        throw new PrepareFailure("NETWORK_UNAVAILABLE");
      url = permittedUrl(new URL(location, url).toString(), false);
    }
    if (!response || response.status !== 200 || !response.body)
      throw new PrepareFailure("NETWORK_UNAVAILABLE");
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^[0-9]{1,16}$/.test(length) || Number(length) !== pin.bytes)
    )
      throw new PrepareFailure("INTEGRITY_INVALID");
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding !== "identity")
      throw new PrepareFailure("INTEGRITY_INVALID");
    const reader = response.body.getReader(),
      hash = createHash("sha256");
    let written = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        written += chunk.value.length;
        if (written > pin.bytes) throw new PrepareFailure("INTEGRITY_INVALID");
        hash.update(chunk.value);
        let offset = 0;
        while (offset < chunk.value.length) {
          const result = await file.write(
            chunk.value,
            offset,
            chunk.value.length - offset,
          );
          if (result.bytesWritten < 1)
            throw new PrepareFailure("PERMISSION_DENIED");
          offset += result.bytesWritten;
        }
        options.onProgress?.(written, pin.bytes);
      }
      if (written !== pin.bytes || hash.digest("hex") !== pin.sha256)
        throw new PrepareFailure("INTEGRITY_INVALID");
      signal.throwIfAborted();
      await file.sync();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    if (options.signal.aborted) throw new PrepareFailure("PREPARE_INTERRUPTED");
    if (error instanceof PrepareFailure) throw error;
    const classified = preparationFailure(error);
    if (classified.code !== "OPERATION_FAILED") throw classified;
    throw new PrepareFailure("NETWORK_UNAVAILABLE");
  } finally {
    await response?.body?.cancel().catch(() => {});
  }
}
export function downloadVerifiedModel(
  file: ModelDestination,
  options: ModelDownloadOptions,
): Promise<void> {
  return downloadPinnedModel(file, MODEL, options);
}

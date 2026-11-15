import { createHash, type Hash } from "node:crypto";
import type { PrivateWritable } from "../../../../worker/src/platform/windows/consumer-private-file.js";
import { PrepareFailure, preparationFailure } from "./controller.js";

export interface TransferPin {
  binding: string;
  url: string;
  bytes: number;
  sha256: string;
}
interface TransferFingerprint {
  device: string;
  fileId: string;
}
export interface TransferCheckpoint {
  version: 1;
  binding: string;
  bytes: number;
  sha256: string;
  etag: string;
  fingerprint: TransferFingerprint;
}
export interface TransferCheckpointPort {
  read(): Promise<unknown | null>;
  write(checkpoint: TransferCheckpoint): Promise<void>;
  remove(): Promise<void>;
}
export interface ArtifactTransferOptions {
  signal: AbortSignal;
  checkpoints: TransferCheckpointPort;
  permittedUrl(url: string, initial: boolean): URL;
  /** Callers revalidate the exact held destination throughout transfer. */
  assertCurrentFile(): Promise<void>;
  fetch?: typeof fetch;
  onProgress?: (written: number, total: number) => void;
  allowNetwork?: boolean;
}
type ArtifactDestination = Pick<
  PrivateWritable,
  "info" | "read" | "write" | "truncate" | "sync"
>;
const HASH = /^[a-f0-9]{64}$/u;
const STRONG_ETAG = /^"[\x21\x23-\x7e]{0,256}"$/u;
const CHECKPOINT_INTERVAL = 4 * 1024 ** 2;
function invalid(): never {
  throw new PrepareFailure("INTEGRITY_INVALID");
}
function checkpoint(
  value: unknown,
  pin: TransferPin,
): TransferCheckpoint | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const row = value as TransferCheckpoint;
  if (
    Object.keys(row).sort().join() !==
      "binding,bytes,etag,fingerprint,sha256,version" ||
    row.version !== 1 ||
    row.binding !== pin.binding ||
    !Number.isSafeInteger(row.bytes) ||
    row.bytes < 1 ||
    row.bytes > pin.bytes ||
    !HASH.test(row.sha256) ||
    !STRONG_ETAG.test(row.etag) ||
    !row.fingerprint ||
    Object.keys(row.fingerprint).sort().join() !== "device,fileId" ||
    !/^[0-9]{1,30}$/u.test(row.fingerprint.device) ||
    !/^[0-9]{1,30}$/u.test(row.fingerprint.fileId) ||
    row.fingerprint.fileId === "0"
  )
    return invalid();
  return row;
}
async function inspect(
  file: Pick<PrivateWritable, "info">,
): Promise<{ bytes: number; fingerprint: TransferFingerprint }> {
  const identity = await file.info();
  if (
    identity.fileId === "0" ||
    !Number.isSafeInteger(identity.bytes) ||
    identity.bytes < 0
  )
    return invalid();
  return {
    bytes: identity.bytes,
    fingerprint: { device: identity.device, fileId: identity.fileId },
  };
}
async function prefix(
  file: Pick<PrivateWritable, "read">,
  bytes: number,
  signal: AbortSignal,
): Promise<Hash> {
  const hash = createHash("sha256");
  let position = 0;
  while (position < bytes) {
    signal.throwIfAborted();
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, bytes - position));
    const read = await file.read(buffer, 0, buffer.length, position);
    if (read.bytesRead < 1) return invalid();
    hash.update(buffer.subarray(0, read.bytesRead));
    position += read.bytesRead;
  }
  return hash;
}
/** One bounded attempt. No automatic network retry, credentials or persisted redirect/grant URL. */
export async function transferArtifact(
  file: ArtifactDestination,
  pin: TransferPin,
  options: ArtifactTransferOptions,
): Promise<void> {
  if (
    !HASH.test(pin.binding) ||
    !HASH.test(pin.sha256) ||
    !Number.isSafeInteger(pin.bytes) ||
    pin.bytes < 1 ||
    pin.bytes > 4 * 1024 ** 3
  )
    return invalid();
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(15 * 60_000),
  ]);
  let written = 0,
    savedAt = 0,
    etag: string | null = null,
    hash = createHash("sha256");
  let response: Response | undefined;
  const save = async () => {
    if (!etag || written < 1) return;
    await file.sync();
    await options.assertCurrentFile();
    const current = await inspect(file);
    if (current.bytes !== written) return invalid();
    await options.checkpoints.write({
      version: 1,
      binding: pin.binding,
      bytes: written,
      sha256: hash.copy().digest("hex"),
      etag,
      fingerprint: current.fingerprint,
    });
    savedAt = written;
  };
  try {
    signal.throwIfAborted();
    await options.assertCurrentFile();
    const current = await inspect(file);
    if (current.bytes > pin.bytes) return invalid();
    // A complete exact pinned file is reusable without any network or resume validator.
    if (current.bytes === pin.bytes) {
      hash = await prefix(file, pin.bytes, signal);
      await options.assertCurrentFile();
      if (hash.digest("hex") !== pin.sha256) return invalid();
      await options.checkpoints.remove();
      options.onProgress?.(pin.bytes, pin.bytes);
      return;
    }
    if (options.allowNetwork === false)
      throw new PrepareFailure("NETWORK_UNAVAILABLE");
    const saved = checkpoint(await options.checkpoints.read(), pin);
    if (saved) {
      if (
        current.bytes < saved.bytes ||
        JSON.stringify(current.fingerprint) !==
          JSON.stringify(saved.fingerprint)
      )
        return invalid();
      hash = await prefix(file, saved.bytes, signal);
      await options.assertCurrentFile();
      if (hash.copy().digest("hex") !== saved.sha256) return invalid();
      await file.truncate(saved.bytes);
      written = savedAt = saved.bytes;
      etag = saved.etag;
    } else if (current.bytes) {
      // Uncheckpointed bytes cannot be appended to merely because a partial exists.
      await file.truncate(0);
    }
    let url = options.permittedUrl(pin.url, true);
    const headers: Record<string, string> = {
      Accept: "application/octet-stream",
      "Accept-Encoding": "identity",
    };
    if (written) {
      headers.Range = `bytes=${written}-`;
      headers["If-Range"] = etag!;
    }
    for (let redirects = 0; redirects <= 5; redirects++) {
      signal.throwIfAborted();
      response = await (options.fetch ?? fetch)(url, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        signal,
        headers,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 5)
        throw new PrepareFailure("NETWORK_UNAVAILABLE");
      url = options.permittedUrl(new URL(location, url).toString(), false);
    }
    if (!response || !response.body || ![200, 206].includes(response.status))
      throw new PrepareFailure("NETWORK_UNAVAILABLE");
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding !== "identity") return invalid();
    const returnedEtag = response.headers.get("etag");
    if (response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(
        response.headers.get("content-range") ?? "",
      );
      if (
        !written ||
        returnedEtag !== etag ||
        !range ||
        Number(range[1]) !== written ||
        Number(range[2]) !== pin.bytes - 1 ||
        Number(range[3]) !== pin.bytes
      )
        return invalid();
    } else {
      if (response.headers.has("content-range")) return invalid();
      if (written) {
        await file.truncate(0);
        await options.checkpoints.remove();
        written = savedAt = 0;
        hash = createHash("sha256");
      }
      etag =
        returnedEtag && STRONG_ETAG.test(returnedEtag) ? returnedEtag : null;
    }
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^\d{1,16}$/u.test(length) || Number(length) !== pin.bytes - written)
    )
      return invalid();
    options.onProgress?.(written, pin.bytes);
    const reader = response.body.getReader();
    try {
      while (true) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        if (
          next.value.length > 16 * 1024 ** 2 ||
          written + next.value.length > pin.bytes
        )
          return invalid();
        let offset = 0;
        while (offset < next.value.length) {
          signal.throwIfAborted();
          const result = await file.write(
            next.value,
            offset,
            next.value.length - offset,
            written,
          );
          if (result.bytesWritten < 1)
            throw new PrepareFailure("PERMISSION_DENIED");
          hash.update(
            next.value.subarray(offset, offset + result.bytesWritten),
          );
          offset += result.bytesWritten;
          written += result.bytesWritten;
        }
        options.onProgress?.(written, pin.bytes);
        if (written - savedAt >= CHECKPOINT_INTERVAL) await save();
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (written !== pin.bytes) throw new PrepareFailure("NETWORK_UNAVAILABLE");
    if (hash.copy().digest("hex") !== pin.sha256) return invalid();
    await file.sync();
    await options.assertCurrentFile();
    signal.throwIfAborted();
    if ((await inspect(file)).bytes !== pin.bytes) return invalid();
    await options.checkpoints.remove();
  } catch (error) {
    const classified =
      error instanceof PrepareFailure ? error : preparationFailure(error);
    if (classified.code === "INTEGRITY_INVALID")
      await options.checkpoints.remove();
    else {
      try {
        await save();
      } catch {
        /* A failed checkpoint never authorizes prefix reuse. */
      }
    }
    if (options.signal.aborted) throw new PrepareFailure("PREPARE_INTERRUPTED");
    if (classified.code !== "OPERATION_FAILED") throw classified;
    throw new PrepareFailure("NETWORK_UNAVAILABLE");
  } finally {
    await response?.body?.cancel().catch(() => {});
  }
}

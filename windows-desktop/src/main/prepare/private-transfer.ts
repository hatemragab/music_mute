import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { win32 } from "node:path";
import type { HostContext } from "../host-context.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import {
  transferArtifact,
  type TransferPin,
  type TransferCheckpoint,
} from "./artifact-transfer.js";
import { PrepareFailure } from "./controller.js";
import { privateFingerprint, verifyPrivateFile } from "./private-files.js";
import { runtimeDownloadUrl } from "./runtime-source.js";
import type { PrivateWritable } from "../../../../worker/src/platform/windows/consumer-private-file.js";

export const PREPARATION_TRANSFER_KEYS = {
  runtime: "prepare_runtime_transfer",
  model: "prepare_model_transfer",
} as const;
const MODEL_REDIRECTS = new Set([
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
export function modelDownloadUrl(raw: string, initial: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PrepareFailure("INTEGRITY_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    (initial
      ? url.toString() !== MODEL.url
      : !MODEL_REDIRECTS.has(url.hostname))
  )
    throw new PrepareFailure("INTEGRITY_INVALID");
  return url;
}
export function preparationTransferBinding(
  kind: "runtime" | "model",
  pin: { url: string; bytes: number; sha256: string },
  target: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "windows-user",
        kind,
        target,
        pin.url,
        pin.bytes,
        pin.sha256,
      ]),
    )
    .digest("hex");
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function assertOpened(
  host: HostContext,
  relative: string,
  file: FileHandle,
): Promise<void> {
  // This existing resume writer remains a legacy Node route. Keep its previous
  // named metadata proof; an immutable native reader would conflict with it.
  await host.native.validatePath("personal", relative, "file");
  const named = await lstat(win32.join(host.personalRoot, relative), {
      bigint: true,
    }),
    stat = await file.stat({ bigint: true });
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1n ||
    named.ino === 0n ||
    !stat.isFile() ||
    stat.nlink !== 1n ||
    named.dev !== stat.dev ||
    named.ino !== stat.ino ||
    named.size !== stat.size
  )
    throw new PrepareFailure("INTEGRITY_INVALID");
}
/** Explicit compatibility bridge; native resume containment remains separate. */
function legacyPreparationTransferFile(
  file: FileHandle,
): Pick<PrivateWritable, "info" | "read" | "write" | "truncate" | "sync"> {
  return {
    info: async () => {
      const stat = await file.stat({ bigint: true });
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        stat.ino === 0n ||
        stat.size < 0n ||
        stat.size > BigInt(Number.MAX_SAFE_INTEGER)
      )
        throw new PrepareFailure("INTEGRITY_INVALID");
      return {
        device: String(stat.dev),
        fileId: String(stat.ino),
        bornAt: String(stat.birthtimeNs),
        bytes: Number(stat.size),
        writtenAt: String(stat.mtimeNs),
        changedAt: String(stat.ctimeNs),
      };
    },
    read: (target, offset, length, position) =>
      file.read(target, offset, length, position),
    write: (source, offset, length, position) =>
      file.write(source, offset, length, position),
    truncate: (length) => file.truncate(length),
    sync: () => file.sync(),
  };
}
/** Caller owns the Prepare mutex. Fixed dedicated Node-only partials never contain user media. */
export async function downloadPrivatePreparationArtifact(options: {
  host: HostContext;
  kind: "runtime" | "model";
  target: string;
  pin: Omit<TransferPin, "binding">;
  destination: string;
  signal: AbortSignal;
  allowNetwork?: boolean;
  fetch?: typeof fetch;
  onProgress?: (written: number, total: number) => void;
  runtimeOrigins?: readonly string[];
}): Promise<string> {
  const { host, kind, pin, destination, signal } = options;
  if (
    !/^[a-f0-9]{64}$/u.test(options.target) ||
    destination !==
      (kind === "runtime"
        ? `prepare\\downloads\\runtime-${options.target}.zip`
        : `models\\${MODEL.filename}.verified`) ||
    (kind === "model" &&
      (pin.url !== MODEL.url ||
        pin.bytes !== MODEL.bytes ||
        pin.sha256 !== MODEL.sha256))
  )
    throw new PrepareFailure("INTEGRITY_INVALID");
  const permitted =
    kind === "runtime"
      ? (url: string) => runtimeDownloadUrl(url, options.runtimeOrigins)
      : modelDownloadUrl;
  permitted(pin.url, true);
  const final = win32.join(host.personalRoot, destination);
  if (await exists(final)) {
    const before = await privateFingerprint(host, destination);
    let valid = false;
    try {
      valid =
        (await verifyPrivateFile(host, destination, pin.bytes, signal))
          .sha256 === pin.sha256;
    } catch (error) {
      signal.throwIfAborted();
      if (!(
        error instanceof PrepareFailure && error.code === "INTEGRITY_INVALID"
      ))
        throw error;
    }
    if (valid) {
      options.onProgress?.(pin.bytes, pin.bytes);
      return final;
    }
    if (
      options.allowNetwork === false ||
      JSON.stringify(before) !==
        JSON.stringify(await privateFingerprint(host, destination))
    )
      throw new PrepareFailure("INTEGRITY_INVALID");
    // These final paths are disposable transfer caches, not installed runtime/model or user media.
    await unlink(final);
  }
  const partial =
    kind === "runtime"
      ? "prepare\\downloads\\runtime.part"
      : "models\\Kim_Vocal_2.onnx.part";
  await host.directory(win32.dirname(partial));
  const path = win32.join(host.personalRoot, partial),
    present = await exists(path);
  if (options.allowNetwork === false && !present)
    throw new PrepareFailure("INTEGRITY_INVALID");
  await host.native.validatePath(
    "personal",
    partial,
    present ? "file" : "absent",
  );
  const file = await open(
    path,
    present ? constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) : "wx+",
    0o600,
  );
  const key = PREPARATION_TRANSFER_KEYS[kind];
  try {
    await transferArtifact(
      legacyPreparationTransferFile(file),
      {
        ...pin,
        binding: preparationTransferBinding(kind, pin, options.target),
      },
      {
        signal,
        permittedUrl: permitted,
        assertCurrentFile: () => assertOpened(host, partial, file),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.allowNetwork !== undefined
          ? { allowNetwork: options.allowNetwork }
          : {}),
        checkpoints: {
          read: async () => {
            const bytes = await host.native.vaultRead("account", key);
            if (!bytes) return null;
            if (bytes.length > 4096)
              throw new PrepareFailure("INTEGRITY_INVALID");
            try {
              return JSON.parse(bytes.toString("utf8"));
            } catch {
              throw new PrepareFailure("INTEGRITY_INVALID");
            }
          },
          write: (row: TransferCheckpoint) =>
            host.native.vaultWrite(
              "account",
              key,
              Buffer.from(JSON.stringify(row)),
            ),
          remove: () => host.native.vaultDelete("account", key),
        },
      },
    );
  } catch (error) {
    if (error instanceof PrepareFailure && error.code === "INTEGRITY_INVALID") {
      // The exact owned corrupt partial cannot poison every later Retry.
      await assertOpened(host, partial, file);
      await file.truncate(0);
      await file.sync();
    }
    throw error;
  } finally {
    await file.close();
  }
  signal.throwIfAborted();
  const verified = await verifyPrivateFile(host, partial, pin.bytes, signal);
  if (verified.sha256 !== pin.sha256)
    throw new PrepareFailure("INTEGRITY_INVALID");
  await host.directory(win32.dirname(destination));
  await host.native.validatePath("personal", destination, "absent");
  await rename(path, final);
  await host.native.validatePath("personal", destination, "file");
  return final;
}
export async function removePreparationArchive(
  host: HostContext,
  target: string,
  pin?: { bytes: number; sha256: string },
  signal = new AbortController().signal,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(target))
    throw new PrepareFailure("INTEGRITY_INVALID");
  const relative = `prepare\\downloads\\runtime-${target}.zip`,
    path = win32.join(host.personalRoot, relative);
  if (!(await exists(path))) return;
  await host.native.validatePath("personal", relative, "file");
  const before = await privateFingerprint(host, relative);
  if (
    pin &&
    (await verifyPrivateFile(host, relative, pin.bytes, signal)).sha256 !==
      pin.sha256
  )
    throw new PrepareFailure("INTEGRITY_INVALID");
  if (
    JSON.stringify(before) !==
    JSON.stringify(await privateFingerprint(host, relative))
  )
    throw new PrepareFailure("INTEGRITY_INVALID");
  signal.throwIfAborted();
  await unlink(path);
}

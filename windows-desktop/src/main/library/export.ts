import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import type { SessionAccountScope } from "../../shared/session-contracts.js";
import type { LibraryPlaybackPort } from "./playback.js";
const EXTENSION: Readonly<Record<string, string>> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/flac": "flac",
};
export function libraryExportFilename(title: string, mime: string): string {
  const extension = EXTENSION[mime];
  if (!extension) throw new Error("LIBRARY_RESULT_INVALID");
  let name = title
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, "_")
    .replace(/[. ]+$/u, "")
    .trim()
    .slice(0, 150);
  if (!name || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(name))
    name = `Voice_${name || "track"}`;
  return `${name}.${extension}`;
}
export interface LibraryExportDestination {
  /** A trusted native Save/Share dialog opens a NEW file exclusively. No renderer path is accepted. */
  choose(
    name: string,
    mime: string,
    signal: AbortSignal,
  ): Promise<{
    file: FileHandle;
    commit(): Promise<void>;
    discard(): Promise<void>;
  } | null>;
}
export async function exportLibraryTrack(options: {
  playback: LibraryPlaybackPort;
  destination: LibraryExportDestination;
  trackId: string;
  variant: "voice" | "original";
  scope: SessionAccountScope | null;
  signal: AbortSignal;
  /** Trusted owner lifetime retains exact cleanup closures until positive ACK.
   * Legacy callers may omit this; desktop production supplies its owner registry. */
  retainCleanup?: (cleanup: () => Promise<void>) => () => Promise<void>;
}): Promise<boolean> {
  const pin = await options.playback.pin(
    options.trackId,
    options.variant,
    options.scope,
  );
  let destination: Awaited<ReturnType<LibraryExportDestination["choose"]>> =
    null;
  let source: FileHandle | undefined;
  let closeSource: () => Promise<void> = async () => {};
  const retain =
    options.retainCleanup ?? ((cleanup: () => Promise<void>) => cleanup);
  const releasePin = retain(async () => {
    // A pin cannot be released while its source descriptor is unconfirmed.
    await closeSource();
    await pin.release();
  });
  let committed = false;
  let failed = false;
  let failure: unknown;
  let result = false;
  const perform = async (): Promise<boolean> => {
    const artifact = await options.playback.resolvePlayback(
      options.trackId,
      options.variant,
      options.scope,
      options.signal,
    );
    if (
      pin.artifactId !== artifact.artifactId ||
      pin.relativePath !== artifact.relativePath ||
      pin.sha256 !== artifact.sha256
    )
      throw new Error("LIBRARY_RESULT_CHANGED");
    destination = await options.destination.choose(
      libraryExportFilename(artifact.title, artifact.mime),
      artifact.mime,
      options.signal,
    );
    if (!destination) return false;
    options.signal.throwIfAborted();
    await artifact.current();
    source = await open(
      artifact.path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = source;
    let closed = false;
    closeSource = retain(async () => {
      if (closed) return;
      await opened.close();
      closed = true;
    });
    const before = await source.stat({ bigint: true }),
      named = await lstat(artifact.path, { bigint: true }),
      target = await destination.file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size !== BigInt(artifact.bytes) ||
      named.isSymbolicLink() ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      !target.isFile() ||
      target.nlink !== 1n ||
      target.size !== 0n
    )
      throw new Error("LIBRARY_RESULT_INVALID");
    const buffer = Buffer.alloc(1024 ** 2),
      hash = createHash("sha256");
    let offset = 0;
    while (offset < artifact.bytes) {
      options.signal.throwIfAborted();
      await artifact.current();
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.length, artifact.bytes - offset),
        offset,
      );
      if (!bytesRead) throw new Error("LIBRARY_RESULT_INVALID");
      offset += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
      await destination.file.writeFile(buffer.subarray(0, bytesRead));
    }
    const after = await source.stat({ bigint: true }),
      finalNamed = await lstat(artifact.path, { bigint: true });
    if (
      hash.digest("hex") !== artifact.sha256 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      finalNamed.dev !== before.dev ||
      finalNamed.ino !== before.ino
    )
      throw new Error("LIBRARY_RESULT_INVALID");
    await destination.file.sync();
    options.signal.throwIfAborted();
    await artifact.current();
    await destination.commit();
    committed = true;
    return true;
  };
  try {
    result = await perform();
  } catch (error) {
    failed = true;
    failure = error;
  }
  const closed = await Promise.allSettled([
    Promise.resolve().then(closeSource),
    Promise.resolve().then(() =>
      destination && !committed ? destination.discard() : undefined,
    ),
  ]);
  const released = await Promise.allSettled([
    Promise.resolve().then(releasePin),
  ]);
  if (failed) throw failure;
  if ([...closed, ...released].some((result) => result.status === "rejected"))
    throw new Error("LIBRARY_EXPORT_CLEANUP_PENDING");
  return result;
}

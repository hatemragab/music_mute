import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { win32 } from "node:path";
import type { HostContext } from "../host-context.js";
import type {
  LibraryPlaybackPort,
  LibraryPlaybackArtifact,
} from "../library/playback.js";
import type { SessionAccountScope } from "../../shared/session-contracts.js";
import { assertConsumerRelativePath } from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import {
  privateFingerprint,
  type PrivateFileFingerprint,
} from "../prepare/private-files.js";
import type {
  PlaybackAccountingPort,
  PlaybackSource,
  PlaybackSourcePort,
} from "./controller.js";
import type {
  ScopedMediaServer,
  VerifiedPlaybackFile,
} from "./media-server.js";
import type { WindowsSilenceRunner } from "./silence-runner.js";
function same(a: PrivateFileFingerprint, b: PrivateFileFingerprint): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
/** Renderer track IDs resolve only through Library authority; an exact artifact pin precedes verification. */
export class LibraryPlaybackSources implements PlaybackSourcePort {
  constructor(
    private readonly options: {
      host: HostContext;
      library: LibraryPlaybackPort;
      server: Pick<ScopedMediaServer, "issue">;
      scope(): SessionAccountScope | null;
      silence?: Pick<WindowsSilenceRunner, "run">;
      /** Unissued open failure: retain this exact descriptor/pin retry until its ACK. */
      onReleasePending?(retry: () => Promise<void>): void;
      openFile?: (path: string) => Promise<FileHandle>;
      fingerprint?: (relative: string) => Promise<PrivateFileFingerprint>;
      accountingFor?(input: {
        trackId: string;
        variant: "voice" | "original";
        artifact: LibraryPlaybackArtifact;
      }): PlaybackAccountingPort;
      onPlaybackStarted?(input: {
        trackId: string;
        variant: "voice" | "original";
        artifact: LibraryPlaybackArtifact;
        assertCurrent(): Promise<void>;
      }): Promise<void>;
    },
  ) {}
  async open(
    trackId: string,
    variant: "voice" | "original",
    signal: AbortSignal,
  ): Promise<PlaybackSource> {
    const { host, library } = this.options,
      scope = structuredClone(this.options.scope());
    signal.throwIfAborted();
    const pin = await library.pin(trackId, variant, scope);
    let descriptor: FileHandle | undefined,
      released = false,
      releasing = false,
      descriptorClosing = false,
      grantIssued = false,
      descriptorClosed = false,
      releasePending: Promise<void> | undefined;
    const analyses = new Set<AbortController>(),
      pending = new Set<Promise<unknown>>();
    const releaseFile = () => {
      if (released) return Promise.resolve();
      if (releasePending) return releasePending;
      releasing = true;
      for (const abort of analyses) abort.abort();
      return (releasePending = (async () => {
        await Promise.allSettled(pending);
        if (!descriptorClosed) {
          descriptorClosing = true;
          await descriptor?.close();
          descriptorClosed = true;
        }
        await pin.release();
        released = true;
      })().finally(() => {
        releasePending = undefined;
      }));
    };
    try {
      const artifact = await library.resolvePlayback(
        trackId,
        variant,
        scope,
        signal,
      );
      assertConsumerRelativePath(artifact.relativePath);
      if (
        pin.artifactId !== artifact.artifactId ||
        pin.relativePath !== artifact.relativePath ||
        pin.sha256 !== artifact.sha256 ||
        win32.resolve(artifact.path).toLowerCase() !==
          win32.resolve(host.personalRoot, artifact.relativePath).toLowerCase()
      )
        throw new Error("MEDIA_UNAVAILABLE");
      await artifact.current();
      signal.throwIfAborted();
      const fingerprint =
          this.options.fingerprint ??
          ((relative) => privateFingerprint(host, relative)),
        before = await fingerprint(artifact.relativePath);
      descriptor = await (
        this.options.openFile ??
        ((path) => open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)))
      )(artifact.path);
      const file = descriptor,
        stat = await file.stat({ bigint: true });
      const matches = async () => {
        const now = await file.stat({ bigint: true });
        if (
          !now.isFile() ||
          now.nlink !== 1n ||
          now.ino === 0n ||
          String(now.dev) !== before.device ||
          String(now.ino) !== before.fileId ||
          Number(now.size) !== before.bytes ||
          String(now.mtimeNs) !== before.writtenAt ||
          String(now.ctimeNs) !== before.changedAt
        )
          throw new Error("MEDIA_UNAVAILABLE");
      };
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        stat.ino === 0n ||
        stat.size < 1n ||
        stat.size > 256n * 1024n ** 2n ||
        Number(stat.size) !== artifact.bytes ||
        before.bytes !== artifact.bytes ||
        !/^[a-f0-9]{64}$/u.test(artifact.sha256)
      )
        throw new Error("MEDIA_UNAVAILABLE");
      await matches();
      const hash = createHash("sha256"),
        buffer = Buffer.alloc(65536);
      let position = 0;
      while (position < artifact.bytes) {
        signal.throwIfAborted();
        const read = await file.read(
          buffer,
          0,
          Math.min(buffer.length, artifact.bytes - position),
          position,
        );
        if (!read.bytesRead) throw new Error("MEDIA_UNAVAILABLE");
        hash.update(buffer.subarray(0, read.bytesRead));
        position += read.bytesRead;
      }
      await matches();
      if (
        !same(before, await fingerprint(artifact.relativePath)) ||
        hash.digest("hex") !== artifact.sha256
      )
        throw new Error("MEDIA_UNAVAILABLE");
      signal.throwIfAborted();
      await artifact.current();
      const verified: VerifiedPlaybackFile = {
        file,
        bytes: artifact.bytes,
        mime: artifact.mime,
        current: async () => {
          if (released || descriptorClosing)
            throw new Error("MEDIA_UNAVAILABLE");
          await artifact.current();
          if (!same(before, await fingerprint(artifact.relativePath)))
            throw new Error("MEDIA_UNAVAILABLE");
          await matches();
        },
        release: releaseFile,
      };
      const grant = await this.options.server.issue(randomUUID(), verified);
      grantIssued = true;
      if (signal.aborted) {
        await grant.release();
        signal.throwIfAborted();
      }
      const source: PlaybackSource = {
        url: grant.url,
        originalDuration: artifact.originalDuration,
        voiceDuration: artifact.voiceDuration,
        timelineIdentity: artifact.sha256,
        sourceDuration: artifact.sourceDuration,
        trimmed: artifact.trimEnabled,
        accountOwned: artifact.accountOwned,
        ...(this.options.accountingFor
          ? {
              accounting: this.options.accountingFor({
                trackId,
                variant,
                artifact,
              }),
            }
          : {}),
        ...(artifact.comparisonRanges
          ? { comparisonRanges: artifact.comparisonRanges }
          : {}),
        release: async () => {
          releasing = true;
          for (const abort of analyses) abort.abort();
          await Promise.allSettled(pending);
          await grant.release();
        },
      };
      if (this.options.onPlaybackStarted) {
        let acknowledged: Promise<void> | undefined;
        source.playbackStarted = () => {
          if (acknowledged) return acknowledged;
          if (released || releasing)
            return Promise.reject(new Error("MEDIA_UNAVAILABLE"));
          const work = (async () => {
            await verified.current();
            await this.options.onPlaybackStarted!({
              trackId,
              variant,
              artifact: { ...artifact },
              assertCurrent: verified.current,
            });
          })();
          pending.add(work);
          void work.then(
            () => pending.delete(work),
            () => pending.delete(work),
          );
          return (acknowledged = work);
        };
      }
      if (variant === "voice" && this.options.silence)
        source.analyzeSilence = (analysisSignal) => {
          if (released || releasing)
            return Promise.reject(new Error("SILENCE_UNAVAILABLE"));
          const abort = new AbortController();
          analyses.add(abort);
          const result = this.options.silence!.run(
            verified,
            artifact.sha256,
            artifact.sourceDuration,
            AbortSignal.any([analysisSignal, abort.signal]),
          );
          pending.add(result);
          void result
            .finally(() => {
              pending.delete(result);
              analyses.delete(abort);
            })
            .catch(() => {});
          return result;
        };
      return source;
    } catch (error) {
      try {
        await releaseFile();
      } catch (cleanup) {
        if (!grantIssued) this.options.onReleasePending?.(releaseFile);
        throw cleanup;
      }
      throw error;
    }
  }
}

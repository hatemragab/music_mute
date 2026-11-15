import { win32 } from "node:path";
import type { HostContext } from "../host-context.js";
import type { SessionAccountScope } from "../../shared/session-contracts.js";
import { publicThumbnailUrl } from "../../../../chrome-extension/src/shared/thumbnail-url.js";
import { localTrackId } from "./model.js";
import type { LibraryStore } from "./store.js";
import type {
  LibraryArtifactCache,
  TrustedLibraryArtifact,
} from "./artifacts.js";
import type { LibraryPins } from "./pins.js";
import type {
  LibraryPlaybackArtifact,
  LibraryPlaybackPort,
} from "./playback.js";
export class LibraryPlaybackProvider implements LibraryPlaybackPort {
  constructor(
    private readonly host: HostContext,
    private readonly store: LibraryStore,
    private readonly cache: LibraryArtifactCache,
    private readonly pins: LibraryPins,
    private readonly current: (scope: SessionAccountScope | null) => boolean,
  ) {}
  private async selected(
    trackId: string,
    variant: "voice" | "original",
    scope: SessionAccountScope | null,
    signal: AbortSignal,
  ): Promise<{
    file: TrustedLibraryArtifact;
    metadata: Omit<
      LibraryPlaybackArtifact,
      | "path"
      | "relativePath"
      | "artifactId"
      | "bytes"
      | "sha256"
      | "mime"
      | "sourceDuration"
      | "current"
    >;
  }> {
    signal.throwIfAborted();
    const guestSnapshot = await this.store.snapshot(null),
      local = guestSnapshot.guest.entries.find(
        (entry) => localTrackId(entry) === trackId,
      );
    if (local) {
      let file: TrustedLibraryArtifact,
        accountOwned = false;
      try {
        file = await this.cache.local(
          local.personalJobId,
          variant === "voice" ? local.vocals : local.original,
          variant,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !scope)
          throw error;
        const snapshot = await this.store.snapshot(scope),
          link = snapshot.account.links.find(
            (link) =>
              link.localId === trackId &&
              link.outputSha256 === local.vocals.sha256,
          ),
          job = link
            ? snapshot.account.jobs.find(
                (job) => job.metadata.id === link.jobId,
              )
            : undefined;
        const selected =
            variant === "voice" ? job?.metadata.output : job?.metadata.input,
          expected = variant === "voice" ? local.vocals : local.original;
        if (
          !job ||
          !selected ||
          Buffer.from(selected.sha256, "base64").toString("hex") !==
            expected.sha256 ||
          selected.bytes !== expected.bytes
        )
          throw new Error("LIBRARY_RESULT_UNAVAILABLE");
        const cached = await this.cache.lookup(
          job.metadata,
          scope,
          signal,
          variant,
        );
        if (!cached) throw new Error("LIBRARY_DOWNLOAD_REQUIRED");
        file = {
          relativePath: cached.relativePath,
          artifactId: cached.artifactId,
          bytes: cached.bytes,
          sha256: cached.sha256,
          mime: cached.contentType,
          durationSeconds: cached.durationSeconds,
        };
        accountOwned = true;
      }
      return {
        file,
        metadata: {
          originalDuration: local.timeline
            ? local.timeline.sourceSamples / 44100
            : local.original.durationSeconds,
          voiceDuration: local.vocals.durationSeconds,
          trimEnabled: local.timeline?.trimEnabled ?? false,
          ...(local.timeline?.trimEnabled
            ? { comparisonRanges: local.timeline.comparisonRanges }
            : {}),
          accountOwned,
          title: local.catalog.source_title ?? "Voice track",
          thumbnailUrl: publicThumbnailUrl(local.catalog.thumbnail_url),
        },
      };
    }
    if (!scope) throw new Error("LIBRARY_NOT_FOUND");
    const snapshot = await this.store.snapshot(scope);
    const job = snapshot.account.jobs.find(
      (row) => row.metadata.id === trackId,
    );
    if (!job || job.metadata.status !== "ready")
      throw new Error("LIBRARY_NOT_FOUND");
    const cached = await this.cache.lookup(
      job.metadata,
      scope,
      signal,
      variant,
    );
    if (!cached) throw new Error("LIBRARY_DOWNLOAD_REQUIRED");
    const voiceDuration =
      job.metadata.output?.duration_seconds ??
      (variant === "voice" ? cached.durationSeconds : undefined);
    if (
      variant === "voice" &&
      job.metadata.trim_enabled &&
      voiceDuration === undefined
    )
      throw new Error("LIBRARY_RESULT_UNAVAILABLE");
    return {
      file: {
        relativePath: cached.relativePath,
        artifactId: cached.artifactId,
        bytes: cached.bytes,
        sha256: cached.sha256,
        mime: cached.contentType,
        durationSeconds: cached.durationSeconds,
      },
      metadata: {
        originalDuration: job.metadata.input.duration_seconds,
        voiceDuration:
          voiceDuration ??
          (job.metadata.trim_enabled
            ? null
            : job.metadata.input.duration_seconds),
        trimEnabled: job.metadata.trim_enabled,
        ...(job.comparisonRanges
          ? { comparisonRanges: job.comparisonRanges }
          : {}),
        accountOwned: true,
        title:
          job.metadata.display_name ??
          job.metadata.source_title ??
          "Voice track",
        thumbnailUrl: publicThumbnailUrl(job.metadata.thumbnail_url),
      },
    };
  }
  async resolvePlayback(
    trackId: string,
    variant: "voice" | "original",
    scope: SessionAccountScope | null,
    signal: AbortSignal,
  ): Promise<LibraryPlaybackArtifact> {
    const { file, metadata } = await this.selected(
      trackId,
      variant,
      scope,
      signal,
    );
    const current = async () => {
      signal.throwIfAborted();
      if (metadata.accountOwned && !this.current(scope))
        throw new Error("ACCOUNT_CHANGED");
      await this.host.native.validatePath(
        "personal",
        file.relativePath,
        "file",
      );
    };
    await current();
    if (
      ![
        "audio/mpeg",
        "audio/mp4",
        "audio/webm",
        "audio/ogg",
        "audio/aac",
        "audio/wav",
        "audio/flac",
      ].includes(file.mime)
    )
      throw new Error("LIBRARY_RESULT_INVALID");
    return {
      ...metadata,
      ...file,
      path: win32.join(this.host.personalRoot, file.relativePath),
      mime: file.mime as LibraryPlaybackArtifact["mime"],
      sourceDuration: file.durationSeconds,
      current,
    };
  }
  async pin(
    trackId: string,
    variant: "voice" | "original",
    scope: SessionAccountScope | null,
  ) {
    const { file, metadata } = await this.selected(
      trackId,
      variant,
      scope,
      new AbortController().signal,
    );
    const pin = await this.pins.pin(file);
    try {
      if (metadata.accountOwned && !this.current(scope))
        throw new Error("ACCOUNT_CHANGED");
      return pin;
    } catch (error) {
      await pin.release();
      throw error;
    }
  }
}

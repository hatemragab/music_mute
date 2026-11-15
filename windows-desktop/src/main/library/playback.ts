import type { SessionAccountScope } from "../../shared/session-contracts.js";
import type { ComparisonRange } from "../player/timeline.js";
export interface LibraryPlaybackArtifact {
  relativePath: string;
  path: string;
  artifactId: string;
  bytes: number;
  sha256: string;
  mime:
    | "audio/mpeg"
    | "audio/mp4"
    | "audio/webm"
    | "audio/ogg"
    | "audio/aac"
    | "audio/wav"
    | "audio/flac";
  originalDuration: number;
  voiceDuration: number | null;
  sourceDuration: number;
  trimEnabled: boolean;
  comparisonRanges?: ComparisonRange[];
  accountOwned: boolean;
  title: string;
  thumbnailUrl: string | null;
  /** Local Windows-user artifacts survive account changes; account bytes require the captured generation. */
  current(): Promise<void>;
}
export interface LibraryPlaybackPort {
  resolvePlayback(
    trackId: string,
    variant: "voice" | "original",
    scope: SessionAccountScope | null,
    signal: AbortSignal,
  ): Promise<LibraryPlaybackArtifact>;
  pin(
    trackId: string,
    variant: "voice" | "original",
    scope: SessionAccountScope | null,
  ): Promise<{
    artifactId: string;
    relativePath: string;
    sha256: string;
    release(): Promise<void>;
  }>;
}

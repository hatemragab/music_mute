import type { LibraryPlaybackArtifact } from "./library/playback.js";
import { localTrackId } from "./library/model.js";
import type { VerifiedPersonalPair } from "./reuse/pair.js";
import type { WindowsCommunityPublisher } from "./reuse/publication.js";
import type { PersonalPlaybackOwnerProof } from "./session/personal-owner-proof.js";
import { assertPublicationPair } from "./browser-publication.js";

export interface DesktopPublicationInput {
  trackId: string;
  variant: "voice" | "original";
  artifact: LibraryPlaybackArtifact;
  assertCurrent(): Promise<void>;
}
/** Library sources supply an actual verified descriptor and pin. Historical guest
 * playback remains authorized after its original processing owner has detached. */
export async function publishDesktopPlayback(
  input: DesktopPublicationInput,
  options: {
    publisher: Pick<
      WindowsCommunityPublisher,
      "stage" | "releasePlayback" | "drain"
    >;
    pair(jobId: string): Promise<VerifiedPersonalPair>;
    liveOwnerProof?(
      pair: VerifiedPersonalPair,
    ): Promise<PersonalPlaybackOwnerProof | null>;
  },
): Promise<void> {
  if (input.variant !== "voice" || input.artifact.accountOwned) return;
  const jobId = /^personal\\results\\([a-f0-9-]{36})\\vocals\.mp3$/u.exec(
    input.artifact.relativePath,
  )?.[1];
  if (!jobId) return;
  await input.assertCurrent();
  const pair = await options.pair(jobId);
  if (pair.reuse?.source.kind !== "youtube") return;
  const videoId = pair.reuse.source.videoId;
  const check = (current: VerifiedPersonalPair) => {
    if (
      current.entry.personalJobId !== jobId ||
      localTrackId(current.entry) !== input.trackId ||
      current.entry.catalog.trim_enabled ||
      current.reuse?.source.kind !== "youtube" ||
      current.reuse.source.videoId !== videoId ||
      current.entry.vocals.id !== input.artifact.artifactId ||
      current.entry.vocals.sha256 !== input.artifact.sha256 ||
      current.entry.vocals.bytes !== input.artifact.bytes ||
      current.entry.vocals.contentType !== input.artifact.mime ||
      Math.abs(
        current.entry.vocals.durationSeconds - input.artifact.sourceDuration,
      ) > 0.001 ||
      current.entry.original.sha256 !== pair.entry.original.sha256 ||
      current.entry.original.bytes !== pair.entry.original.bytes ||
      current.completion?.ownerId !== pair.completion?.ownerId
    )
      throw new Error("COMMUNITY_SOURCE_INVALID");
  };
  check(pair);
  const proof = await options.liveOwnerProof?.(pair);
  if (proof) assertPublicationPair(pair, proof);
  const record = await options.publisher.stage(jobId, true);
  if (
    record.jobId !== jobId ||
    record.vocalsSha256 !== input.artifact.sha256 ||
    record.vocalsBytes !== input.artifact.bytes ||
    record.originalSha256 !== pair.entry.original.sha256 ||
    record.originalBytes !== pair.entry.original.bytes
  )
    throw new Error("COMMUNITY_SOURCE_INVALID");
  await input.assertCurrent();
  check(await options.pair(jobId));
  await options.publisher.releasePlayback(jobId, input.artifact.sha256);
  void options.publisher.drain().catch(() => {});
}

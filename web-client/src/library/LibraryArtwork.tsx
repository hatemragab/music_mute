import { TrackArtwork } from "../player/TrackArtwork";

export function LibraryArtwork({
  url,
  trackId,
}: {
  url?: string | null;
  trackId?: string;
}) {
  return <TrackArtwork url={url} trackId={trackId} variant="library" />;
}

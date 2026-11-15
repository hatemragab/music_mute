import { Music2 } from "lucide-react";
import { useState } from "react";
import { thumbnailUrl } from "../api/thumbnail";

type ArtworkVariant = "library" | "mini" | "player" | "queue";
const coverClass: Record<ArtworkVariant, string> = {
  library: "library-cover",
  mini: "mini-cover",
  player: "player-art",
  queue: "queue-cover",
};

function Thumbnail({ url, variant }: { url: string; variant: ArtworkVariant }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <>
      {!loaded && <Music2 />}
      {!failed && (
        <img
          src={url}
          alt=""
          width={variant === "player" ? 300 : 48}
          height={variant === "player" ? 300 : 48}
          loading={
            variant === "player" || variant === "mini" ? "eager" : "lazy"
          }
          decoding="async"
          referrerPolicy="no-referrer"
          className={`track-artwork-image${variant === "library" ? " library-thumbnail" : ""}${loaded ? " loaded" : ""}`}
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLoaded(false);
            setFailed(true);
          }}
        />
      )}
    </>
  );
}

export function TrackArtwork({
  url,
  trackId,
  variant,
}: {
  url?: string | null;
  trackId?: string;
  variant: ArtworkVariant;
}) {
  const validUrl = thumbnailUrl(url);
  const Container = variant === "queue" ? "span" : "div";
  return (
    <Container
      className={`track-artwork ${coverClass[variant]}`}
      aria-hidden="true"
    >
      {validUrl ? (
        <Thumbnail
          key={`${trackId ?? ""}:${validUrl}`}
          url={validUrl}
          variant={variant}
        />
      ) : (
        <Music2 />
      )}
    </Container>
  );
}

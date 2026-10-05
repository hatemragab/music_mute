import { isVideoId, MVP_MAX_DURATION_SECONDS } from "./protocol.js";

/** Only public video identity and an advisory estimate cross the app launch boundary. */
export function cloudHandoffUrl(
  videoId: string,
  durationSeconds?: number,
): string {
  if (!isVideoId(videoId)) throw new TypeError("INVALID_VIDEO_ID");
  const query = new URLSearchParams({ video_id: videoId });
  if (
    typeof durationSeconds === "number" &&
    Number.isFinite(durationSeconds) &&
    durationSeconds > 0 &&
    durationSeconds <= MVP_MAX_DURATION_SECONDS
  )
    query.set("duration_seconds", String(Math.ceil(durationSeconds)));
  return `musicmute-local://cloud?${query}`;
}

import {
  isVideoId,
  MVP_MAX_DURATION_SECONDS,
} from "../../../../chrome-extension/src/shared/protocol.js";
export interface WindowsCloudHandoff {
  videoId: string;
  durationSeconds?: number;
}
/** OS launch accepts public video identity only; never credentials, account scope or submission rights. */
export function parseWindowsCloudHandoff(
  raw: string,
): WindowsCloudHandoff | null {
  if (raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "musicmute-local:" ||
      url.hostname !== "cloud" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !["", "/"].includes(url.pathname)
    )
      return null;
    const keys = [...url.searchParams.keys()];
    if (
      keys.some((key) => !["video_id", "duration_seconds"].includes(key)) ||
      new Set(keys).size !== keys.length
    )
      return null;
    const videoId = url.searchParams.get("video_id"),
      duration = url.searchParams.get("duration_seconds");
    if (
      !isVideoId(videoId) ||
      (duration !== null &&
        (!/^[1-9][0-9]{0,3}$/u.test(duration) ||
          Number(duration) > MVP_MAX_DURATION_SECONDS))
    )
      return null;
    return {
      videoId,
      ...(duration === null ? {} : { durationSeconds: Number(duration) }),
    };
  } catch {
    return null;
  }
}

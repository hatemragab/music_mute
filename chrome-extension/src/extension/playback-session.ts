import { isVideoId, MVP_MAX_DURATION_SECONDS } from "../shared/protocol";

export interface PlaybackCheckpoint {
  version: 1;
  tabId: number;
  documentId: string;
  generation: number;
  videoId: string;
  durationSeconds: number;
  requestId: string;
  jobId: string;
  savedAt: number;
}
export const PLAYBACK_SESSION_KEY = "musicmute.playback.session.v1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function playbackCheckpoint(
  value: unknown,
  now = Date.now(),
): PlaybackCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    item.version !== 1 ||
    !Number.isSafeInteger(item.tabId) ||
    Number(item.tabId) < 0 ||
    !Number.isSafeInteger(item.generation) ||
    Number(item.generation) < 0 ||
    typeof item.documentId !== "string" ||
    !item.documentId ||
    item.documentId.length > 128 ||
    !isVideoId(item.videoId) ||
    typeof item.durationSeconds !== "number" ||
    !Number.isFinite(item.durationSeconds) ||
    item.durationSeconds <= 0 ||
    item.durationSeconds > MVP_MAX_DURATION_SECONDS ||
    typeof item.requestId !== "string" ||
    !UUID.test(item.requestId) ||
    typeof item.jobId !== "string" ||
    !UUID.test(item.jobId) ||
    typeof item.savedAt !== "number" ||
    !Number.isFinite(item.savedAt) ||
    now < item.savedAt ||
    now - item.savedAt > 2 * 60 * 60 * 1000
  )
    return null;
  return {
    version: 1,
    tabId: Number(item.tabId),
    documentId: item.documentId,
    generation: Number(item.generation),
    videoId: item.videoId,
    durationSeconds: item.durationSeconds,
    requestId: item.requestId,
    jobId: item.jobId,
    savedAt: item.savedAt,
  };
}

/** Chrome-owned memory only: never persist media capabilities or account data. */
export class PlaybackSessionStore {
  private writes = Promise.resolve();
  save(checkpoint: PlaybackCheckpoint | null): void {
    this.writes = this.writes
      .then(async () => {
        await chrome.storage.session?.set({
          [PLAYBACK_SESSION_KEY]: checkpoint,
        });
      })
      .catch(() => undefined);
  }
  async read(): Promise<PlaybackCheckpoint | null> {
    await this.writes;
    try {
      const stored = await chrome.storage.session?.get(PLAYBACK_SESSION_KEY);
      return playbackCheckpoint(stored?.[PLAYBACK_SESSION_KEY]);
    } catch {
      return null;
    }
  }
}

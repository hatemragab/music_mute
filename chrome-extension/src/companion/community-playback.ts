import type { JobSnapshot } from "../shared/protocol.js";
import type { YouTubeCommunityOutbox } from "./youtube-community-outbox.js";

export interface CommunityPlaybackIdentity {
  job_id: string;
  video_id: string;
  sha256: string;
}

/** Authority comes from the ready native job, never page diagnostics or a URL. */
export async function releaseCommunityPlayback(
  snapshot: JobSnapshot | null,
  identity: CommunityPlaybackIdentity | undefined,
  acknowledgement: { job_id: string; video_id: string },
  outbox: YouTubeCommunityOutbox,
  start: () => Promise<void>,
): Promise<boolean> {
  if (
    !snapshot ||
    snapshot.state !== "READY" ||
    snapshot.provider !== "LOCAL_MACOS" ||
    !identity ||
    snapshot.job_id !== acknowledgement.job_id ||
    snapshot.video_id !== acknowledgement.video_id ||
    identity.job_id !== snapshot.job_id ||
    identity.video_id !== snapshot.video_id
  )
    throw new Error("STALE_JOB");
  const released = await outbox.release(identity.video_id, identity.sha256);
  if (released) await start();
  return released;
}

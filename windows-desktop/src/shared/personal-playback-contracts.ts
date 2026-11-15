/** Trusted fresh desktop intent only; no media grant, filesystem path or play count. */
export interface PersonalPlaybackPreparation {
  requestId: string;
  jobId: string | null;
}

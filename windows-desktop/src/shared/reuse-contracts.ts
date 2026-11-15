import type { SessionAccountScope } from "./session-contracts.js";
export type ReuseSourceIdentity =
  | { kind: "file"; inputSha256: string; inputBytes: number }
  | {
      kind: "youtube";
      videoId: string;
      formatId: string;
      audioTrackId: string | null;
      audioIsDefault: boolean | null;
      language: string | null;
      inputSha256: string;
      inputBytes: number;
    }
  | {
      kind: "community-youtube";
      videoId: string;
      provenance: "trusted" | "community_contributed";
      sourceIdentityVerified: boolean;
      inputSha256: string;
      inputBytes: number;
    };
export interface ReuseReceipt {
  version: 1;
  profileId: "kim-vocal-2-full-timeline-v1";
  modelDigest: string;
  recipeDigest: string;
  trimEnabled: false;
  denoiseEnabled: false;
  source: ReuseSourceIdentity;
  originalSha256: string;
  vocalsSha256: string;
}
export interface CompletionReceipt {
  version: 1;
  installationId: string;
  jobId: string;
  ownerId: string;
  requestId: string;
  capturedAccountScope: SessionAccountScope | null;
  originalSha256: string;
  vocalsSha256: string;
  completedAt: number;
}
export interface ReuseView {
  state: "idle" | "looking-up" | "hit" | "miss" | "ineligible" | "failed";
  origin: "local" | "account" | "community" | null;
  reason: string | null;
  requestId: string | null;
  trackId: string | null;
  provenance: "trusted" | "community_contributed" | null;
}

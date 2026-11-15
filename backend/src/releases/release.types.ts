import type { Platform } from '../auth/auth.types.js';
export type Distribution = 'play' | 'app_store';
export type UpdateSource = 'direct_apk' | 'google_play' | 'app_store';
export type ArtifactState =
  'awaiting_upload' | 'verifying' | 'verified' | 'rejected';
export type ReleaseState = 'draft' | 'published' | 'withdrawn';
export interface ReleaseTarget {
  id: string;
  versionName: string;
  buildNumber: number;
  changelogEn: string;
  source: UpdateSource;
  storeUrl: string | null;
  artifact: null | {
    bytes: number;
    sha256Hex: string;
    signerSha256Hex: string;
  };
}
export interface UpdatePolicySnapshot {
  schemaVersion: 1;
  revision: number;
  platform: Platform;
  distribution: Distribution;
  minimumBuild: number | null;
  target: ReleaseTarget | null;
  checkedAt: string;
}
export type UpdateDecision = 'none' | 'optional' | 'required';
export interface ReleaseDraft {
  platform: Platform;
  source: UpdateSource;
  versionName: string;
  buildNumber: number;
  changelogEn: string;
  storeUrl: string | null;
}
export interface ReleaseSelection {
  source: UpdateSource;
  directReleaseId: string | null;
  storeReleaseId: string | null;
}

import type { Types } from 'mongoose';
import type {
  DownloadGrant,
  InputDeclaration,
  UploadGrant,
} from '../jobs/job.types.js';

export const YOUTUBE_COMMUNITY_PROFILE_ID = 'kim-vocal-2-full-timeline-v1';
export const CONTRIBUTION_STATES = [
  'preparing',
  'waiting',
  'awaiting_upload',
  'validating',
  'ready',
  'expired',
  'failed',
] as const;
export type ContributionState = (typeof CONTRIBUTION_STATES)[number];
export interface YouTubeGuestPrincipal {
  _id: Types.ObjectId;
  expiresAt: Date;
  ipKey: string;
}
export interface YouTubeCacheDelivery {
  videoId: string;
  profileId: typeof YOUTUBE_COMMUNITY_PROFILE_ID;
  provenance: 'trusted' | 'community_contributed';
  sourceIdentityVerified: boolean;
  original: { declaration: InputDeclaration; grant: DownloadGrant };
  vocals: { declaration: InputDeclaration; grant: DownloadGrant };
}
export interface YouTubeContributionView {
  contributionId: string | null;
  requestId: string;
  videoId: string;
  profileId: typeof YOUTUBE_COMMUNITY_PROFILE_ID;
  state: ContributionState;
  producer: boolean;
  expiresAt: string;
  leaseExpiresAt: string | null;
  uploadGrants: { original: UploadGrant; vocals: UploadGrant } | null;
  artifacts: YouTubeCacheDelivery | null;
}
export interface YouTubeCommunitySnapshot {
  videoId: string;
  state:
    | 'missing'
    | 'preparing'
    | 'awaiting_upload'
    | 'validating'
    | 'ready'
    | 'failed';
  expiresAt: string | null;
}

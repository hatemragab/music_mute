import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';
import type { InputReservation } from '../jobs/job.types.js';
import { AUDIO_TYPES } from '../jobs/job.types.js';
import { isSha256 } from '../jobs/job-state.js';
import {
  MAX_AUDIO_DURATION_SECONDS,
  MAX_PREPARED_AUDIO_BYTES,
} from '../jobs/media-limits.js';
import {
  CONTRIBUTION_STATES,
  YOUTUBE_COMMUNITY_PROFILE_ID,
  type ContributionState,
} from './youtube-community.types.js';

const reservation = new MongoSchema<InputReservation>(
  {
    key: {
      type: String,
      required: true,
      match:
        /^quarantine\/youtube\/[a-f0-9]{24}\/(?:input\/source\.[a-z0-9]+|output\/vocals\.mp3)$/,
    },
    extension: { type: String, required: true, enum: Object.keys(AUDIO_TYPES) },
    contentType: {
      type: String,
      required: true,
      enum: Object.values(AUDIO_TYPES),
    },
    bytes: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_PREPARED_AUDIO_BYTES,
      validate: Number.isSafeInteger,
    },
    durationSeconds: {
      type: Number,
      required: true,
      min: Number.MIN_VALUE,
      max: MAX_AUDIO_DURATION_SECONDS,
    },
    sha256: { type: String, required: true, validate: isSha256 },
  },
  { _id: false, strict: 'throw' },
);

@Schema({
  collection: 'youtube_guest_sessions',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class YouTubeGuestSession {
  _id!: Types.ObjectId;
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: /^[a-f0-9]{64}$/,
  })
  tokenHash!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 256 })
  ipKey!: string;
  @Prop({ type: Date, required: true, immutable: true }) expiresAt!: Date;
  @Prop({ type: Date, default: null }) revokedAt!: Date | null;
  createdAt!: Date;
}
export const YouTubeGuestSessionSchema =
  SchemaFactory.createForClass(YouTubeGuestSession);
YouTubeGuestSessionSchema.index(
  { tokenHash: 1 },
  { unique: true, name: 'youtube_guest_token' },
);
YouTubeGuestSessionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'youtube_guest_expiry' },
);

@Schema({
  collection: 'youtube_contributions',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class YouTubeContribution {
  _id!: Types.ObjectId;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  guestSessionId!: Types.ObjectId;
  @Prop({ type: String, required: true, immutable: true, maxlength: 256 })
  ipKey!: string;
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: /^[a-f0-9-]{36}$/,
  })
  requestId!: string;
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: /^[a-f0-9]{64}$/,
  })
  requestHash!: string;
  @Prop({ type: String, required: true, immutable: true, match: /^[\w-]{11}$/ })
  videoId!: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 100 })
  canonicalUrl!: string;
  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: [YOUTUBE_COMMUNITY_PROFILE_ID],
  })
  profileId!: typeof YOUTUBE_COMMUNITY_PROFILE_ID;
  @Prop({ type: String, required: true, enum: CONTRIBUTION_STATES })
  state!: ContributionState;
  @Prop({ type: Boolean, required: true }) producer!: boolean;
  @Prop({ type: Date, required: true, immutable: true }) expiresAt!: Date;
  @Prop({ type: Date, default: null }) leaseExpiresAt!: Date | null;
  @Prop({ type: reservation, default: null })
  original!: InputReservation | null;
  @Prop({ type: reservation, default: null }) vocals!: InputReservation | null;
  @Prop({ type: String, default: null, match: /^[a-f0-9]{64}$/ })
  declarationHash!: string | null;
  @Prop({ type: Date, default: null }) grantExpiresAt!: Date | null;
  @Prop({ type: Number, default: 0, min: 0, max: 20 }) grantCount!: number;
  @Prop({ type: Date, default: null }) validationLeaseUntil!: Date | null;
  @Prop({ type: String, default: null, maxlength: 36 }) validationToken!:
    string | null;
  @Prop({ type: Date, required: true, immutable: true }) purgeAt!: Date;
  createdAt!: Date;
  updatedAt!: Date;
}
export const YouTubeContributionSchema =
  SchemaFactory.createForClass(YouTubeContribution);
YouTubeContributionSchema.index(
  { guestSessionId: 1, requestId: 1 },
  { unique: true, name: 'youtube_contribution_guest_request' },
);
YouTubeContributionSchema.index(
  { producer: 1, state: 1, leaseExpiresAt: 1, expiresAt: 1 },
  { name: 'youtube_contribution_pending' },
);
YouTubeContributionSchema.index(
  { guestSessionId: 1, producer: 1, state: 1 },
  { name: 'youtube_contribution_guest_pending' },
);
YouTubeContributionSchema.index(
  { ipKey: 1, producer: 1, state: 1 },
  { name: 'youtube_contribution_ip_pending' },
);
YouTubeContributionSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: 'youtube_contribution_purge' },
);

@Schema({
  collection: 'youtube_contribution_leases',
  strict: 'throw',
  versionKey: false,
})
export class YouTubeContributionLease {
  @Prop({ type: String, required: true }) _id!: string;
  @Prop({ type: MongoSchema.Types.ObjectId, default: null })
  contributionId!: Types.ObjectId | null;
  @Prop({ type: Date, default: null }) expiresAt!: Date | null;
  @Prop({ type: Number, default: 0, min: 0 }) revision!: number;
}
export const YouTubeContributionLeaseSchema = SchemaFactory.createForClass(
  YouTubeContributionLease,
);

@Schema({
  collection: 'youtube_community_budgets',
  strict: 'throw',
  versionKey: false,
})
export class YouTubeCommunityBudget {
  @Prop({ type: String, required: true }) _id!: string;
  @Prop({
    type: Number,
    required: true,
    min: 0,
    validate: Number.isSafeInteger,
  })
  reservedBytes!: number;
  @Prop({ type: Date, default: null }) purgeAt!: Date | null;
}
export const YouTubeCommunityBudgetSchema = SchemaFactory.createForClass(
  YouTubeCommunityBudget,
);
YouTubeCommunityBudgetSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: 'youtube_community_budget_purge' },
);

@Schema({
  collection: 'youtube_community_cleanup',
  strict: 'throw',
  versionKey: false,
})
export class YouTubeCommunityCleanup {
  _id!: Types.ObjectId;
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match:
      /^quarantine\/youtube\/[a-f0-9]{24}\/(?:input\/source\.[a-z0-9]+|output\/vocals\.mp3)$/,
  })
  key!: string;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  contributionId!: Types.ObjectId;
  @Prop({ type: Date, required: true }) nextAt!: Date;
  @Prop({ type: Date, required: true }) settleUntil!: Date;
  @Prop({
    type: String,
    required: true,
    enum: ['first', 'settle', 'done'],
    default: 'first',
  })
  state!: 'first' | 'settle' | 'done';
  @Prop({ type: Date, default: null }) leaseUntil!: Date | null;
  @Prop({ type: String, default: null }) leaseToken!: string | null;
  @Prop({ type: Date, default: null }) purgeAt!: Date | null;
}
export const YouTubeCommunityCleanupSchema = SchemaFactory.createForClass(
  YouTubeCommunityCleanup,
);
YouTubeCommunityCleanupSchema.index(
  { key: 1 },
  { unique: true, name: 'youtube_community_cleanup_key' },
);
YouTubeCommunityCleanupSchema.index(
  { state: 1, nextAt: 1, leaseUntil: 1 },
  { name: 'youtube_community_cleanup_due' },
);
YouTubeCommunityCleanupSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: 'youtube_community_cleanup_purge' },
);

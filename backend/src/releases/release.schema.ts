import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';
import type {
  ArtifactState,
  ReleaseState,
  UpdateSource,
} from './release.types.js';
import type { Platform } from '../auth/auth.types.js';
import {
  APK_REJECTION_CODES,
  type ApkRejectionCode,
} from './apk-verification-errors.js';

@Schema({ _id: false, strict: 'throw' })
export class ReleaseArtifact {
  @Prop({ required: true }) key!: string;
  @Prop({ required: true }) versionId!: string;
  @Prop({ required: true, min: 1, max: 268435456 }) bytes!: number;
  @Prop({ required: true, match: /^[a-f0-9]{64}$/ }) sha256Hex!: string;
  @Prop({ required: true, match: /^[a-f0-9]{64}$/ }) signerSha256Hex!: string;
  @Prop({ required: true }) packageId!: string;
  @Prop({ required: true, min: 1 }) minimumSdk!: number;
}

@Schema({
  collection: 'app_releases',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class Release {
  _id!: Types.ObjectId;
  @Prop({ required: true, type: String, enum: ['android', 'ios'] })
  platform!: Platform;
  @Prop({
    required: true,
    type: String,
    enum: ['direct_apk', 'google_play', 'app_store'],
  })
  source!: UpdateSource;
  @Prop({ required: true, maxlength: 64 }) versionName!: string;
  @Prop({ required: true, min: 1, max: 2147483647, validate: Number.isInteger })
  buildNumber!: number;
  @Prop({ required: true, maxlength: 10000 }) changelogEn!: string;
  @Prop({ type: String, default: null, maxlength: 2048 }) storeUrl!:
    string | null;
  @Prop({
    required: true,
    type: String,
    enum: ['draft', 'published', 'withdrawn'],
    default: 'draft',
  })
  state!: ReleaseState;
  @Prop({
    type: String,
    enum: ['awaiting_upload', 'verifying', 'verified', 'rejected', null],
    default: null,
  })
  artifactState!: ArtifactState | null;
  @Prop({ type: SchemaFactory.createForClass(ReleaseArtifact), default: null })
  artifact!: ReleaseArtifact | null;
  @Prop({ type: String, enum: [...APK_REJECTION_CODES, null], default: null })
  rejectionCode!: ApkRejectionCode | null;
  @Prop({ type: MongoSchema.Types.ObjectId, default: null })
  selectedUploadId!: Types.ObjectId | null;
  @Prop({ required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  revision!: number;
  @Prop({ required: true, maxlength: 128 }) createdBy!: string;
  @Prop({ type: String, default: null, maxlength: 128 }) publishedBy!:
    string | null;
  @Prop({ type: Date, default: null }) publishedAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export const ReleaseSchema = SchemaFactory.createForClass(Release);
ReleaseSchema.index(
  { platform: 1, source: 1, buildNumber: 1 },
  { unique: true, name: 'release_build_channel' },
);
ReleaseSchema.index({ createdAt: -1, _id: -1 });

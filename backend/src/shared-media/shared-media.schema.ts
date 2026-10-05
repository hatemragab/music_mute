import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, Types } from 'mongoose';
import type {
  InputDeclaration,
  ObjectIdentity,
  WorkerRecipeSnapshot,
} from '../jobs/job.types.js';
import {
  normalizeExtraData,
  type JobExtraData,
} from '../jobs/job-extra-data.js';
import { isStorageEtag } from '../storage/object-identity.js';
import { isSha256 } from '../jobs/job-state.js';

const objectIdentity = new MongoSchema<ObjectIdentity>(
  {
    key: { type: String, required: true, maxlength: 1024 },
    etag: { type: String, required: true, validate: isStorageEtag },
    bytes: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    sha256: { type: String, required: true, validate: isSha256 },
    contentType: { type: String, required: true, maxlength: 100 },
  },
  { _id: false, strict: 'throw' },
);

@Schema({
  collection: 'shared_media_sources',
  timestamps: true,
  strict: 'throw',
  versionKey: false,
})
export class SharedMediaSource {
  @Prop({ type: String, match: /^[a-f0-9]{64}$/ }) _id!: string;
  @Prop({ required: true, maxlength: 2048 }) sourceUrl!: string;
  @Prop({ required: true, maxlength: 253 }) provider!: string;
  @Prop({ required: true, maxlength: 36 }) generation!: string;
  @Prop({ required: true, enum: ['acquiring', 'ready', 'failed'] }) state!:
    'acquiring' | 'ready' | 'failed';
  @Prop({ type: MongoSchema.Types.ObjectId, default: null })
  producerImportId!: Types.ObjectId | null;
  @Prop({ type: MongoSchema.Types.ObjectId, default: null })
  communityContributionId?: Types.ObjectId | null;
  @Prop({ type: Date, default: null })
  communityLeaseUntil?: Date | null;
  @Prop({
    type: String,
    enum: ['trusted', 'community_contributed'],
    default: 'trusted',
  })
  provenance?: 'trusted' | 'community_contributed';
  @Prop({ type: objectIdentity, default: null })
  pendingInput?: ObjectIdentity | null;
  @Prop({ type: String, default: null }) inputKey!: string | null;
  @Prop({ type: MongoSchema.Types.Mixed, default: null })
  input!: InputDeclaration | null;
  @Prop({ type: objectIdentity, default: null })
  inputObject!: ObjectIdentity | null;
  @Prop({ type: String, default: null, maxlength: 200 }) sourceTitle!:
    string | null;
  @Prop({
    type: MongoSchema.Types.Mixed,
    default: null,
    set: normalizeExtraData,
  })
  extraData!: JobExtraData | null;
  @Prop({ type: Date, default: null }) acquiredAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export const SharedMediaSourceSchema =
  SchemaFactory.createForClass(SharedMediaSource);
SharedMediaSourceSchema.index({ state: 1, producerImportId: 1 });

@Schema({
  collection: 'shared_media_results',
  timestamps: true,
  strict: 'throw',
  versionKey: false,
})
export class SharedMediaResult {
  @Prop({ type: String, match: /^[a-f0-9]{64}$/ }) _id!: string;
  @Prop({ required: true, match: /^[a-f0-9]{64}$/ }) sourceKey!: string;
  @Prop({ required: true, maxlength: 36 }) sourceGeneration!: string;
  @Prop({ required: true, enum: ['processing', 'ready', 'failed'] }) state!:
    'processing' | 'ready' | 'failed';
  @Prop({ type: MongoSchema.Types.ObjectId, default: null })
  producerImportId!: Types.ObjectId | null;
  @Prop({ type: MongoSchema.Types.ObjectId, default: null })
  communityContributionId?: Types.ObjectId | null;
  @Prop({
    type: String,
    enum: ['trusted', 'community_contributed'],
    default: 'trusted',
  })
  provenance?: 'trusted' | 'community_contributed';
  @Prop({ type: String, default: null, match: /^[a-f0-9]{64}$/ })
  derivedFromResultKey?: string | null;
  @Prop({ type: objectIdentity, default: null })
  derivedFromObject?: ObjectIdentity | null;
  @Prop({ type: String, default: null, enum: ['full-mp3-gap-trim-v1', null] })
  derivationProfileId?: 'full-mp3-gap-trim-v1' | null;
  @Prop({ type: MongoSchema.Types.ObjectId, default: null })
  producerJobId!: Types.ObjectId | null;
  @Prop({ type: MongoSchema.Types.Mixed, required: true })
  recipeSnapshot!: WorkerRecipeSnapshot;
  @Prop({ type: String, default: null }) outputKey!: string | null;
  @Prop({ type: objectIdentity, default: null })
  pendingOutput!: ObjectIdentity | null;
  @Prop({ type: objectIdentity, default: null })
  outputObject!: ObjectIdentity | null;
  @Prop({ type: String, default: null }) publicationToken!: string | null;
  @Prop({ type: Date, default: null }) publicationLeaseUntil!: Date | null;
  @Prop({ type: [[Number]], default: null }) comparisonRanges!:
    number[][] | null;
  @Prop({ type: Date, default: null }) completedAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export const SharedMediaResultSchema =
  SchemaFactory.createForClass(SharedMediaResult);
SharedMediaResultSchema.index({ state: 1, producerJobId: 1 });
SharedMediaResultSchema.index({ state: 1, _id: 1 });
SharedMediaResultSchema.index({
  derivationProfileId: 1,
  state: 1,
  publicationLeaseUntil: 1,
});

/** Permanent exact-key ledger, including uncertain PUT/copy outcomes. */
@Schema({
  collection: 'shared_media_artifacts',
  timestamps: true,
  strict: 'throw',
  versionKey: false,
})
export class SharedMediaArtifact {
  @Prop({ type: String, maxlength: 1024 }) _id!: string;
  @Prop({ required: true, match: /^[a-f0-9]{64}$/ }) assetKey!: string;
  @Prop({ required: true, enum: ['input', 'output'] }) kind!:
    'input' | 'output';
  @Prop({ type: MongoSchema.Types.Mixed, required: true })
  reservation!: Omit<ObjectIdentity, 'etag'>;
  @Prop({ type: objectIdentity, default: null })
  object!: ObjectIdentity | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export const SharedMediaArtifactSchema =
  SchemaFactory.createForClass(SharedMediaArtifact);
SharedMediaArtifactSchema.index({ assetKey: 1, kind: 1 });

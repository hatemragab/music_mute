import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';
import type {
  InputReservation,
  WorkerRecipeSnapshot,
} from '../jobs/job.types.js';
import { AUDIO_TYPES } from '../jobs/job.types.js';
import { isSha256 } from '../jobs/job-state.js';
import {
  MAX_AUDIO_DURATION_SECONDS,
  MAX_PREPARED_AUDIO_BYTES,
} from '../jobs/media-limits.js';
import { isWorkerRecipeSnapshot } from '../jobs/worker-recipes.js';
import {
  isAudioName,
  YOUTUBE_SOURCE_URL_PATTERN,
} from '../jobs/job-metadata.js';

const reservation = new MongoSchema<InputReservation>(
  {
    key: { type: String, required: true, maxlength: 1024 },
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
const grant = new MongoSchema(
  {
    requestId: { type: String, required: true, match: /^[a-f0-9-]{36}$/ },
    expiresAt: { type: Date, required: true },
  },
  { _id: false, strict: 'throw' },
);
@Schema({
  collection: 'local_media_syncs',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class LocalMediaSync {
  _id!: Types.ObjectId;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  userId!: Types.ObjectId;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  jobId!: Types.ObjectId;
  @Prop({ type: String, required: true, immutable: true, maxlength: 36 })
  requestId!: string;
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: /^[a-f0-9]{64}$/,
  })
  requestHash!: string;
  @Prop({ type: reservation, required: true, immutable: true })
  original!: InputReservation;
  @Prop({ type: reservation, required: true, immutable: true })
  vocals!: InputReservation;
  @Prop({
    type: MongoSchema.Types.Mixed,
    required: true,
    immutable: true,
    validate: isWorkerRecipeSnapshot,
  })
  recipeSnapshot!: WorkerRecipeSnapshot;
  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: ['file', 'url'],
  })
  sourceKind!: 'file' | 'url';
  @Prop({
    type: String,
    default: null,
    validate: (v: unknown) => v === null || isAudioName(v),
  })
  sourceTitle!: string | null;
  @Prop({ type: String, default: null, match: YOUTUBE_SOURCE_URL_PATTERN })
  sourceUrl!: string | null;
  @Prop({ type: Date, required: true, immutable: true }) expiresAt!: Date;
  @Prop({
    type: String,
    required: true,
    enum: ['awaiting_upload', 'ready'],
    default: 'awaiting_upload',
  })
  status!: 'awaiting_upload' | 'ready';
  @Prop({
    type: [grant],
    required: true,
    default: [],
    validate: (v: unknown[]) => v.length <= 20,
  })
  grants!: { requestId: string; expiresAt: Date }[];
  @Prop({ type: Number, required: true, min: 1, max: 20, immutable: true })
  maxGrantPairs!: number;
  @Prop({ type: Date, default: null }) validationLeaseUntil!: Date | null;
  @Prop({ type: String, default: null, maxlength: 36 }) validationToken!:
    string | null;
  @Prop({ type: Date, default: null }) committedAt!: Date | null;
  @Prop({ type: Number, min: 0, default: 0, validate: Number.isSafeInteger })
  revision!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export const LocalMediaSyncSchema =
  SchemaFactory.createForClass(LocalMediaSync);
LocalMediaSyncSchema.index(
  { userId: 1, requestId: 1 },
  { unique: true, name: 'local_media_sync_owner_request' },
);
LocalMediaSyncSchema.index(
  { userId: 1, status: 1, expiresAt: 1 },
  { name: 'local_media_sync_owner_pending' },
);

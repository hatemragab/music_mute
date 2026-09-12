import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';

export const STORAGE_CLEANUP_REASONS = [
  'AUDIO_INPUT_EXPIRED',
  'AUDIO_OUTPUT_ORPHANED',
  'RELEASE_UPLOAD_ORPHANED',
] as const;
export type StorageCleanupReason = (typeof STORAGE_CLEANUP_REASONS)[number];

@Schema({
  collection: 'storage_cleanup_tasks',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class StorageCleanupTask {
  _id!: Types.ObjectId;
  @Prop({ required: true, immutable: true, maxlength: 1024 }) key!: string;
  @Prop({
    type: MongoSchema.Types.ObjectId,
    default: null,
    immutable: true,
  })
  ownerUserId!: Types.ObjectId | null;
  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: STORAGE_CLEANUP_REASONS,
  })
  reason!: StorageCleanupReason;
  @Prop({ type: Date, required: true }) nextAt!: Date | null;
  // Idempotent re-scheduling may extend this window when a later grant exists.
  @Prop({ type: Date, required: true }) settleUntil!: Date;
  @Prop({ type: Date, default: null }) leaseUntil!: Date | null;
  @Prop({ type: String, default: null, maxlength: 36 }) leaseToken!:
    string | null;
  @Prop({ type: Number, default: 0, min: 0, validate: Number.isSafeInteger })
  attempts!: number;
  @Prop({ type: Date, default: null }) completedAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export const StorageCleanupTaskSchema =
  SchemaFactory.createForClass(StorageCleanupTask);
StorageCleanupTaskSchema.index(
  { key: 1 },
  { unique: true, name: 'cleanup_key' },
);
StorageCleanupTaskSchema.index(
  { nextAt: 1, leaseUntil: 1, _id: 1 },
  {
    name: 'cleanup_due',
    partialFilterExpression: { completedAt: null },
  },
);
StorageCleanupTaskSchema.index(
  { ownerUserId: 1, completedAt: 1 },
  { name: 'cleanup_owner_pending' },
);
StorageCleanupTaskSchema.index(
  { completedAt: 1 },
  { name: 'cleanup_completed_ttl', expireAfterSeconds: 2_592_000 },
);

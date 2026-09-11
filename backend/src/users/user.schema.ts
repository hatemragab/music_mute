import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument, Types } from 'mongoose';
import type { SupportedProvider } from '../auth/auth.types.js';
import type { NameSource } from './display-name.js';

@Schema({
  collection: 'users',
  timestamps: true,
  strict: 'throw',
  versionKey: false,
})
export class User {
  _id!: Types.ObjectId;

  @Prop({ required: true, immutable: true, maxlength: 128 })
  firebaseUid!: string;

  @Prop({ type: String, default: null, maxlength: 320 })
  email!: string | null;

  @Prop({ required: true, default: false })
  emailVerified!: boolean;

  @Prop({ required: true, maxlength: 128 })
  displayName!: string;

  @Prop({
    type: String,
    required: true,
    enum: ['email_prefix', 'numeric_alias'],
  })
  nameSource!: NameSource;

  @Prop({
    type: [String],
    default: [],
    enum: ['password', 'google.com', 'apple.com'],
    validate: (values: string[]) =>
      values.length <= 3 && new Set(values).size === values.length,
  })
  providerIds!: SupportedProvider[];

  @Prop({
    type: String,
    enum: ['active', 'disabled', 'deleting', 'purging'],
    default: 'active',
    required: true,
  })
  status!: 'active' | 'disabled' | 'deleting' | 'purging';

  @Prop({ type: String, default: null })
  deletionRequestId!: string | null;

  @Prop({ type: Date, default: null })
  deletionRequestedAt!: Date | null;

  @Prop({ type: Date, default: null })
  deletionRecoverUntil!: Date | null;

  @Prop({ type: Date, default: null })
  deletionPurgeStartedAt!: Date | null;

  @Prop({ type: Date, default: null })
  deletionNextAt!: Date | null;

  @Prop({ type: Date, default: null })
  deletionLeaseUntil!: Date | null;

  @Prop({ type: String, default: null })
  deletionLeaseToken!: string | null;

  @Prop({ type: Number, default: 0 })
  accessRevision!: number;

  @Prop({ type: Boolean, default: false, required: true })
  processingSuspended!: boolean;

  @Prop({ type: String, default: null, maxlength: 500 })
  processingSuspensionReason!: string | null;

  @Prop({ type: String, default: null, maxlength: 128 })
  processingSuspendedBy!: string | null;

  @Prop({ type: Date, default: null })
  processingSuspendedAt!: Date | null;

  @Prop({ type: Number, default: 0, min: 0, validate: Number.isSafeInteger })
  adminRevision!: number;

  @Prop({
    type: Number,
    required: true,
    default: 0,
    min: 0,
    validate: Number.isSafeInteger,
  })
  sessionsRevokedAfterSec!: number;

  @Prop({ required: true, type: Date })
  profileSyncedAt!: Date;

  @Prop({ required: true, type: Date })
  lastSeenAt!: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);
UserSchema.index(
  { status: 1, deletionRecoverUntil: 1, deletionNextAt: 1 },
  { name: 'users_deletion_recovery_due' },
);
UserSchema.index(
  { firebaseUid: 1 },
  { unique: true, name: 'users_firebase_uid_unique' },
);
UserSchema.index({ email: 1 }, { name: 'admin_users_email' });
UserSchema.index({ displayName: 1, _id: 1 }, { name: 'admin_users_name' });
UserSchema.index(
  { status: 1, processingSuspended: 1, _id: 1 },
  { name: 'admin_users_filters' },
);

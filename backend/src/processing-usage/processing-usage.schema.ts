import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';

@Schema({
  collection: 'account_usage_periods',
  strict: 'throw',
  versionKey: false,
})
export class AccountUsagePeriod {
  @Prop({ type: String, required: true, maxlength: 160 })
  _id!: string;

  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  accountId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: /^\d{4}-\d{2}$/,
  })
  periodKey!: string;

  @Prop({ type: Date, required: true, immutable: true })
  periodStart!: Date;

  @Prop({ type: Date, required: true, immutable: true })
  periodEnd!: Date;

  @Prop({ required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  processingUsedSeconds!: number;

  @Prop({ required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  processingReservedSeconds!: number;

  @Prop({ required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  processingReservationCount!: number;

  @Prop({ required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  processingReleasedSeconds!: number;

  @Prop({ required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  uploadGrants!: number;

  @Prop({ required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  confirmedUploadBytes!: number;

  @Prop({ required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  downloadGrants!: number;

  @Prop({ required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  estimatedDownloadBytes!: number;

  @Prop({ required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  revision!: number;

  @Prop({ required: true })
  lastMutationAt!: Date;

  @Prop({ type: Date, default: null })
  purgeAt!: Date | null;
}

export const AccountUsagePeriodSchema =
  SchemaFactory.createForClass(AccountUsagePeriod);
AccountUsagePeriodSchema.index(
  { accountId: 1, periodKey: 1 },
  { unique: true, name: 'account_usage_unique_period' },
);
AccountUsagePeriodSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: 'account_usage_closed_period_ttl' },
);

@Schema({
  collection: 'processing_reservations',
  strict: 'throw',
  versionKey: false,
})
export class ProcessingReservation {
  @Prop({ type: MongoSchema.Types.ObjectId, required: true })
  _id!: Types.ObjectId;

  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  accountId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: /^\d{4}-\d{2}$/,
  })
  periodKey!: string;

  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  processingSeconds!: number;

  @Prop({ required: true, enum: ['reserved', 'used', 'released'] })
  state!: 'reserved' | 'used' | 'released';

  @Prop({ required: true, min: 0, validate: Number.isSafeInteger })
  globalPolicyRevision!: number;

  @Prop({
    type: Number,
    default: null,
    min: 1,
    validate: (value: number | null) =>
      value === null || Number.isSafeInteger(value),
  })
  overrideRevision!: number | null;

  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  acceptedLimitSeconds!: number;

  @Prop({ required: true, immutable: true })
  createdAt!: Date;

  @Prop({ type: Date, default: null })
  settledAt!: Date | null;

  @Prop({ type: Date, default: null })
  purgeAt!: Date | null;
}

export const ProcessingReservationSchema = SchemaFactory.createForClass(
  ProcessingReservation,
);
ProcessingReservationSchema.index(
  { accountId: 1, state: 1, periodKey: 1 },
  { name: 'processing_reservations_account_state_period' },
);
ProcessingReservationSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: 'processing_reservations_ttl' },
);

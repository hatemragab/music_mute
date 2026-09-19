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
  collection: 'account_daily_usage_periods',
  strict: 'throw',
  versionKey: false,
})
export class AccountDailyUsagePeriod {
  @Prop({ type: String, required: true, maxlength: 160 })
  _id!: string;

  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  accountId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: /^\d{4}-\d{2}-\d{2}$/,
  })
  dayKey!: string;

  @Prop({ type: Date, required: true, immutable: true })
  dayStart!: Date;

  @Prop({ type: Date, required: true, immutable: true })
  dayEnd!: Date;

  @Prop({ required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  uploadGrants!: number;

  @Prop({ required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  revision!: number;

  @Prop({ required: true })
  lastMutationAt!: Date;

  @Prop({ required: true })
  purgeAt!: Date;
}

export const AccountDailyUsagePeriodSchema = SchemaFactory.createForClass(
  AccountDailyUsagePeriod,
);
AccountDailyUsagePeriodSchema.index(
  { accountId: 1, dayKey: 1 },
  { unique: true, name: 'account_daily_usage_unique_day' },
);
AccountDailyUsagePeriodSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: 'account_daily_usage_ttl' },
);

@Schema({
  collection: 'upload_grant_receipts',
  strict: 'throw',
  versionKey: false,
})
export class UploadGrantReceipt {
  @Prop({ type: String, required: true, maxlength: 200 })
  _id!: string;

  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  accountId!: Types.ObjectId;

  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  jobId!: Types.ObjectId;

  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  logicalAudioId!: Types.ObjectId;

  @Prop({ required: true, immutable: true, maxlength: 36 })
  requestId!: string;

  @Prop({ required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ })
  dayKey!: string;

  @Prop({ required: true, immutable: true, match: /^\d{4}-\d{2}$/ })
  periodKey!: string;

  @Prop({
    required: true,
    immutable: true,
    min: 1,
    validate: Number.isSafeInteger,
  })
  attemptNumber!: number;

  @Prop({ required: true, immutable: true })
  createdAt!: Date;

  @Prop({ required: true, immutable: true })
  expiresAt!: Date;

  @Prop({ required: true })
  purgeAt!: Date;
}

export const UploadGrantReceiptSchema =
  SchemaFactory.createForClass(UploadGrantReceipt);
UploadGrantReceiptSchema.index(
  { accountId: 1, jobId: 1, createdAt: 1 },
  { name: 'upload_grants_account_job_created' },
);
UploadGrantReceiptSchema.index(
  { logicalAudioId: 1, attemptNumber: 1 },
  { unique: true, name: 'upload_grants_logical_attempt_unique' },
);
UploadGrantReceiptSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: 'upload_grant_receipts_ttl' },
);

export const DOWNLOAD_GRANT_SCOPES = [
  'user_result',
  'user_input',
  'worker_input',
] as const;
export type DownloadGrantScope = (typeof DOWNLOAD_GRANT_SCOPES)[number];

@Schema({
  collection: 'download_grant_receipts',
  strict: 'throw',
  versionKey: false,
})
export class DownloadGrantReceipt {
  @Prop({ type: String, required: true, maxlength: 240 })
  _id!: string;

  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  accountId!: Types.ObjectId;

  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  jobId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: DOWNLOAD_GRANT_SCOPES,
  })
  scope!: DownloadGrantScope;

  @Prop({ type: String, default: null, immutable: true, maxlength: 36 })
  attemptId!: string | null;

  @Prop({ required: true, immutable: true, maxlength: 36 })
  requestId!: string;

  @Prop({ required: true, immutable: true, maxlength: 1024 })
  objectVersionId!: string;

  @Prop({
    required: true,
    immutable: true,
    min: 1,
    validate: Number.isSafeInteger,
  })
  estimatedBytes!: number;

  @Prop({ required: true, immutable: true, match: /^\d{4}-\d{2}$/ })
  periodKey!: string;

  @Prop({ required: true, immutable: true })
  createdAt!: Date;

  @Prop({ required: true, immutable: true })
  expiresAt!: Date;

  @Prop({ required: true })
  purgeAt!: Date;
}

export const DownloadGrantReceiptSchema =
  SchemaFactory.createForClass(DownloadGrantReceipt);
DownloadGrantReceiptSchema.index(
  { accountId: 1, periodKey: 1, scope: 1 },
  { name: 'download_grants_account_period_scope' },
);
DownloadGrantReceiptSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: 'download_grant_receipts_ttl' },
);

@Schema({
  collection: 'service_usage_periods',
  strict: 'throw',
  versionKey: false,
})
export class ServiceUsagePeriod {
  @Prop({ type: String, required: true, maxlength: 32 })
  _id!: string;

  @Prop({ required: true, immutable: true, match: /^\d{4}-\d{2}$/ })
  periodKey!: string;

  @Prop({ type: Date, required: true, immutable: true })
  periodStart!: Date;

  @Prop({ type: Date, required: true, immutable: true })
  periodEnd!: Date;

  @Prop({ required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  estimatedOutboundBytes!: number;

  @Prop({ required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  revision!: number;

  @Prop({ required: true })
  lastMutationAt!: Date;

  @Prop({ required: true })
  purgeAt!: Date;
}

export const ServiceUsagePeriodSchema =
  SchemaFactory.createForClass(ServiceUsagePeriod);
ServiceUsagePeriodSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: 'service_usage_period_ttl' },
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

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema } from 'mongoose';
import type { Types } from 'mongoose';
import {
  ABUSE_EVENT_SEVERITIES,
  ABUSE_EVENT_TYPES,
  ABUSE_OPERATION_CLASSES,
  type AbuseEventSeverity,
  type AbuseEventType,
  type AbuseOperationClass,
} from './abuse-protection.types.js';

@Schema({
  collection: 'abuse_event_buckets',
  strict: 'throw',
  versionKey: false,
})
export class AbuseEventBucket {
  _id!: Types.ObjectId;

  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  accountId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    enum: ABUSE_EVENT_TYPES,
    immutable: true,
  })
  type!: AbuseEventType;

  @Prop({ type: String, required: true, enum: ABUSE_EVENT_SEVERITIES })
  severity!: AbuseEventSeverity;

  @Prop({
    type: String,
    required: true,
    enum: ABUSE_OPERATION_CLASSES,
    immutable: true,
  })
  operationClass!: AbuseOperationClass;

  @Prop({ type: Date, required: true, immutable: true })
  bucketStart!: Date;

  @Prop({ type: Date, required: true, immutable: true })
  bucketEnd!: Date;

  @Prop({ type: Date, required: true })
  firstOccurredAt!: Date;

  @Prop({ type: Date, required: true })
  lastOccurredAt!: Date;

  @Prop({
    required: true,
    min: 1,
    max: 1_000_000,
    validate: Number.isSafeInteger,
  })
  count!: number;

  @Prop({ type: Number, default: null, min: 0, validate: Number.isSafeInteger })
  policyRevision!: number | null;

  @Prop({ type: MongoSchema.Types.ObjectId, default: null })
  restrictionId!: Types.ObjectId | null;

  @Prop({ type: Date, required: true, immutable: true })
  expiresAt!: Date;
}

export const AbuseEventBucketSchema =
  SchemaFactory.createForClass(AbuseEventBucket);
AbuseEventBucketSchema.index(
  { accountId: 1, type: 1, operationClass: 1, bucketStart: 1 },
  { unique: true, name: 'abuse_event_bucket_unique' },
);
AbuseEventBucketSchema.index(
  { accountId: 1, lastOccurredAt: -1, _id: -1 },
  { name: 'abuse_event_account_page' },
);
AbuseEventBucketSchema.index(
  { lastOccurredAt: -1, _id: -1 },
  { name: 'abuse_event_recent_page' },
);
AbuseEventBucketSchema.index(
  { type: 1, severity: 1, lastOccurredAt: -1, _id: -1 },
  { name: 'abuse_event_admin_filter' },
);
AbuseEventBucketSchema.index(
  { severity: 1, lastOccurredAt: -1, _id: -1 },
  { name: 'abuse_event_severity_filter' },
);
AbuseEventBucketSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'abuse_event_expiry' },
);

@Schema({
  collection: 'abuse_monthly_summaries',
  strict: 'throw',
  versionKey: false,
})
export class AbuseMonthlySummary {
  _id!: Types.ObjectId;

  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  accountId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    enum: ABUSE_EVENT_TYPES,
    immutable: true,
  })
  type!: AbuseEventType;

  @Prop({ required: true, immutable: true, match: /^\d{4}-\d{2}$/ })
  month!: string;

  @Prop({
    required: true,
    min: 1,
    max: 100_000_000,
    validate: Number.isSafeInteger,
  })
  count!: number;

  @Prop({ type: Date, required: true })
  firstOccurredAt!: Date;

  @Prop({ type: Date, required: true })
  lastOccurredAt!: Date;

  @Prop({ type: Date, required: true, immutable: true })
  expiresAt!: Date;
}

export const AbuseMonthlySummarySchema =
  SchemaFactory.createForClass(AbuseMonthlySummary);
AbuseMonthlySummarySchema.index(
  { accountId: 1, type: 1, month: 1 },
  { unique: true, name: 'abuse_summary_unique' },
);
AbuseMonthlySummarySchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'abuse_summary_expiry' },
);

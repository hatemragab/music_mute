import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';

export const STANDARD_ACCOUNT_POLICY_ID = 'standard' as const;

export interface AccountPolicyValues {
  monthlyProcessingSeconds: number;
  maxDurationSeconds: number;
  maxPreparedAudioBytes: number;
  dailyUploadGrants: number;
  monthlyUploadGrants: number;
  monthlyConfirmedUploadBytes: number;
  maxWaitingJobs: number;
  maxProcessingJobs: number;
  maxInfrastructureAttempts: number;
  maxClientInputAttempts: number;
  monthlyDownloadGrants: number;
  monthlyEstimatedDownloadBytes: number;
  maxRetainedOutputBytes: number;
  signedUrlTtlSeconds: number;
  monthlyServiceOutboundBytes: number;
  deletionGraceHours: number;
}

export const DEFAULT_ACCOUNT_POLICY_VALUES: Readonly<AccountPolicyValues> =
  Object.freeze({
    monthlyProcessingSeconds: 7_200,
    maxDurationSeconds: 1_200,
    maxPreparedAudioBytes: 50_000_000,
    dailyUploadGrants: 30,
    monthlyUploadGrants: 200,
    monthlyConfirmedUploadBytes: 1_000_000_000,
    maxWaitingJobs: 3,
    maxProcessingJobs: 1,
    maxInfrastructureAttempts: 3,
    maxClientInputAttempts: 5,
    monthlyDownloadGrants: 150,
    monthlyEstimatedDownloadBytes: 10_000_000_000,
    maxRetainedOutputBytes: 1_000_000_000,
    signedUrlTtlSeconds: 600,
    monthlyServiceOutboundBytes: 80_000_000_000,
    deletionGraceHours: 15 * 24,
  });
export type AccountPolicyValueKey = keyof AccountPolicyValues;

export const ACCOUNT_POLICY_OVERRIDE_VALUE_KEYS = [
  'monthlyProcessingSeconds',
  'maxDurationSeconds',
  'maxPreparedAudioBytes',
  'dailyUploadGrants',
  'monthlyUploadGrants',
  'monthlyConfirmedUploadBytes',
  'maxClientInputAttempts',
  'monthlyDownloadGrants',
  'monthlyEstimatedDownloadBytes',
  'maxRetainedOutputBytes',
  'signedUrlTtlSeconds',
] as const satisfies readonly AccountPolicyValueKey[];
export type AccountPolicyOverrideValueKey =
  (typeof ACCOUNT_POLICY_OVERRIDE_VALUE_KEYS)[number];
export type AccountPolicyOverrideValues = Partial<
  Pick<AccountPolicyValues, AccountPolicyOverrideValueKey>
>;

@Schema({
  collection: 'account_policies',
  strict: 'throw',
  versionKey: false,
})
export class AccountPolicy {
  @Prop({ type: String, enum: [STANDARD_ACCOUNT_POLICY_ID], required: true })
  _id!: typeof STANDARD_ACCOUNT_POLICY_ID;

  @Prop({ required: true, default: true })
  acceptNewJobs!: boolean;

  @Prop({ type: String, default: '', maxlength: 1000 })
  maintenanceMessageEn!: string;

  @Prop({ type: String, default: null, maxlength: 1000 })
  maintenanceMessageAr!: string | null;

  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  monthlyProcessingSeconds!: number;

  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  maxDurationSeconds!: number;

  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  maxPreparedAudioBytes!: number;

  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  dailyUploadGrants!: number;

  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  monthlyUploadGrants!: number;

  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  monthlyConfirmedUploadBytes!: number;

  @Prop({ required: true, min: 0, validate: Number.isSafeInteger })
  maxWaitingJobs!: number;

  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  maxProcessingJobs!: number;

  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  maxInfrastructureAttempts!: number;

  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  maxClientInputAttempts!: number;

  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  monthlyDownloadGrants!: number;

  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  monthlyEstimatedDownloadBytes!: number;

  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  maxRetainedOutputBytes!: number;

  @Prop({ required: true, min: 1, max: 600, validate: Number.isSafeInteger })
  signedUrlTtlSeconds!: number;

  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  monthlyServiceOutboundBytes!: number;

  @Prop({ required: true, min: 24, validate: Number.isSafeInteger })
  deletionGraceHours!: number;

  @Prop({ required: true, min: 0, validate: Number.isSafeInteger })
  revision!: number;

  @Prop({ required: true, maxlength: 128 })
  updatedBy!: string;

  @Prop({ required: true })
  updatedAt!: Date;
}

export const AccountPolicySchema = SchemaFactory.createForClass(AccountPolicy);

@Schema({
  collection: 'account_policy_overrides',
  strict: 'throw',
  versionKey: false,
})
export class AccountPolicyOverride {
  @Prop({ type: MongoSchema.Types.ObjectId, required: true })
  _id!: Types.ObjectId;

  @Prop({
    type: MongoSchema.Types.ObjectId,
    required: true,
    immutable: true,
  })
  accountId!: Types.ObjectId;

  @Prop({
    type: Number,
    default: null,
    min: 1,
    validate: (value: number | null) =>
      value === null || Number.isSafeInteger(value),
  })
  monthlyProcessingSeconds!: number | null;

  @Prop({ type: Number, default: null, min: 1, validate: nullableSafeInteger })
  maxDurationSeconds!: number | null;

  @Prop({ type: Number, default: null, min: 1, validate: nullableSafeInteger })
  maxPreparedAudioBytes!: number | null;

  @Prop({ type: Number, default: null, min: 1, validate: nullableSafeInteger })
  dailyUploadGrants!: number | null;

  @Prop({ type: Number, default: null, min: 1, validate: nullableSafeInteger })
  monthlyUploadGrants!: number | null;

  @Prop({ type: Number, default: null, min: 1, validate: nullableSafeInteger })
  monthlyConfirmedUploadBytes!: number | null;

  @Prop({ type: Number, default: null, min: 1, validate: nullableSafeInteger })
  maxClientInputAttempts!: number | null;

  @Prop({ type: Number, default: null, min: 1, validate: nullableSafeInteger })
  monthlyDownloadGrants!: number | null;

  @Prop({ type: Number, default: null, min: 1, validate: nullableSafeInteger })
  monthlyEstimatedDownloadBytes!: number | null;

  @Prop({ type: Number, default: null, min: 1, validate: nullableSafeInteger })
  maxRetainedOutputBytes!: number | null;

  @Prop({
    type: Number,
    default: null,
    min: 1,
    max: 600,
    validate: nullableSafeInteger,
  })
  signedUrlTtlSeconds!: number | null;

  @Prop({ type: Date, default: null })
  expiresAt!: Date | null;

  @Prop({ required: true, maxlength: 500 })
  reason!: string;

  @Prop({ required: true, immutable: true, maxlength: 128 })
  createdBy!: string;

  @Prop({ required: true, maxlength: 128 })
  updatedBy!: string;

  @Prop({ required: true, immutable: true })
  createdAt!: Date;

  @Prop({ required: true })
  updatedAt!: Date;

  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  revision!: number;
}

export const AccountPolicyOverrideSchema = SchemaFactory.createForClass(
  AccountPolicyOverride,
);
AccountPolicyOverrideSchema.index(
  { accountId: 1 },
  { unique: true, name: 'account_policy_override_unique_account' },
);

function nullableSafeInteger(value: number | null): boolean {
  return value === null || Number.isSafeInteger(value);
}

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';

export const NOTIFICATION_DELIVERY_STATUSES = [
  'pending',
  'sent',
  'ineligible',
  'invalid',
  'failed',
] as const;
export type NotificationDeliveryStatus =
  (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

export const NOTIFICATION_FAILURE_KINDS = [
  'transient',
  'invalid_destination',
  'ineligible',
  'exhausted',
] as const;
export type NotificationFailureKind =
  (typeof NOTIFICATION_FAILURE_KINDS)[number];

@Schema({
  collection: 'audio_notification_deliveries',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class NotificationDelivery {
  _id!: Types.ObjectId;

  @Prop({
    type: MongoSchema.Types.ObjectId,
    required: true,
    immutable: true,
  })
  outboxId!: Types.ObjectId;

  @Prop({
    type: MongoSchema.Types.ObjectId,
    required: true,
    immutable: true,
  })
  registrationId!: Types.ObjectId;

  @Prop({
    required: true,
    min: 1,
    validate: Number.isSafeInteger,
    immutable: true,
  })
  bindingRevision!: number;

  @Prop({
    type: String,
    required: true,
    enum: NOTIFICATION_DELIVERY_STATUSES,
    default: 'pending',
  })
  status!: NotificationDeliveryStatus;

  @Prop({
    required: true,
    min: 0,
    max: 8,
    default: 0,
    validate: Number.isSafeInteger,
  })
  attempts!: number;

  @Prop({ type: Date, required: true, default: Date.now })
  nextAttemptAt!: Date;

  @Prop({
    type: String,
    enum: [...NOTIFICATION_FAILURE_KINDS, null],
    default: null,
  })
  lastFailureKind!: NotificationFailureKind | null;

  @Prop({ type: Date, default: null })
  sentAt!: Date | null;

  @Prop({ type: Date, default: null })
  failedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const NotificationDeliverySchema =
  SchemaFactory.createForClass(NotificationDelivery);
NotificationDeliverySchema.index(
  { outboxId: 1, registrationId: 1, bindingRevision: 1 },
  { unique: true, name: 'notification_delivery_target_unique' },
);
NotificationDeliverySchema.index(
  { outboxId: 1, status: 1, nextAttemptAt: 1, _id: 1 },
  { name: 'notification_delivery_due' },
);

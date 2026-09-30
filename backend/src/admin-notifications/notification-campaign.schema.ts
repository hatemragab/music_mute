import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';
import {
  NotificationDelivery,
  NotificationDeliverySchema,
} from '../notifications/notification-delivery.schema.js';
import type { CampaignDeliveryCounts } from './campaign-delivery-counts.js';

const countsSchema = new MongoSchema(
  Object.fromEntries(
    ['pending', 'sent', 'failed', 'invalid', 'ineligible'].map((status) => [
      status,
      { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
    ]),
  ),
  { _id: false, strict: 'throw' },
);

@Schema({
  collection: 'notification_campaigns',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class NotificationCampaign {
  _id!: Types.ObjectId;
  @Prop({ required: true, immutable: true, maxlength: 80 }) title!: string;
  @Prop({ required: true, immutable: true, maxlength: 500 }) body!: string;
  @Prop({ required: true, immutable: true }) actorUid!: string;
  @Prop({ required: true, immutable: true, maxlength: 500 }) reason!: string;
  @Prop({
    type: String,
    enum: ['queued', 'sending', 'completed'],
    default: 'queued',
  })
  state!: 'queued' | 'sending' | 'completed';
  @Prop({ type: MongoSchema.Types.ObjectId, default: null })
  cursor!: Types.ObjectId | null;
  @Prop({ default: false }) frozen!: boolean;
  @Prop({ type: String, default: null }) leaseId!: string | null;
  @Prop({ type: Date, default: Date.now }) nextAttemptAt!: Date;
  @Prop({ type: Date, default: null }) leaseExpiresAt!: Date | null;
  @Prop({ type: Date, default: null }) completedAt!: Date | null;
  @Prop({ type: countsSchema, default: null })
  finalCounts!: CampaignDeliveryCounts | null;
  @Prop({ type: Date, default: null })
  deliveryRetentionScheduledAt!: Date | null;
  @Prop({ type: Date, default: null }) retentionNextAt!: Date | null;
  @Prop({ type: Date, default: null }) purgeAt!: Date | null;
  createdAt!: Date;
}
export const NotificationCampaignSchema =
  SchemaFactory.createForClass(NotificationCampaign);
NotificationCampaignSchema.index({
  state: 1,
  nextAttemptAt: 1,
  leaseExpiresAt: 1,
});
NotificationCampaignSchema.index(
  {
    state: 1,
    deliveryRetentionScheduledAt: 1,
    retentionNextAt: 1,
    completedAt: 1,
    _id: 1,
  },
  { name: 'notification_campaign_retention_due' },
);
NotificationCampaignSchema.index(
  { purgeAt: 1 },
  {
    expireAfterSeconds: 0,
    partialFilterExpression: { state: 'completed' },
    name: 'notification_campaign_retention',
  },
);

// Same durable attempt/status contract as job notifications, in a separate collection.
@Schema({
  collection: 'notification_campaign_deliveries',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class CampaignDelivery extends NotificationDelivery {
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  userId!: Types.ObjectId;
}
export const CampaignDeliverySchema =
  SchemaFactory.createForClass(CampaignDelivery);
for (const [fields, options] of NotificationDeliverySchema.indexes())
  CampaignDeliverySchema.index(fields, options);

CampaignDeliverySchema.index({ userId: 1, _id: 1 });

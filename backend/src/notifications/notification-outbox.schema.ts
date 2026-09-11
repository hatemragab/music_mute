import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';

export const NOTIFICATION_OUTBOX_STATES = [
  'pending',
  'dispatching',
  'completed',
] as const;
export type NotificationOutboxState =
  (typeof NOTIFICATION_OUTBOX_STATES)[number];
export type NotificationOutcome = 'ready' | 'failed';

@Schema({
  collection: 'audio_notification_outbox',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class NotificationOutbox {
  _id!: Types.ObjectId;

  @Prop({
    type: MongoSchema.Types.ObjectId,
    required: true,
    immutable: true,
  })
  jobId!: Types.ObjectId;

  @Prop({
    type: MongoSchema.Types.ObjectId,
    required: true,
    immutable: true,
  })
  userId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: ['ready', 'failed'],
  })
  outcome!: NotificationOutcome;

  @Prop({
    type: String,
    required: true,
    enum: NOTIFICATION_OUTBOX_STATES,
    default: 'pending',
  })
  state!: NotificationOutboxState;

  @Prop({ type: Date, required: true, default: Date.now })
  nextAttemptAt!: Date;

  @Prop({ type: String, default: null, maxlength: 36 })
  leaseId!: string | null;

  @Prop({ type: Date, default: null })
  leaseExpiresAt!: Date | null;

  @Prop({ type: Date, default: null })
  targetSnapshotAt!: Date | null;

  @Prop({ type: MongoSchema.Types.ObjectId, default: null })
  targetThroughId!: Types.ObjectId | null;

  @Prop({ type: MongoSchema.Types.ObjectId, default: null })
  targetCursor!: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  targetsFrozenAt!: Date | null;

  @Prop({ type: Date, default: null })
  completedAt!: Date | null;

  @Prop({ min: 0, default: 0, validate: Number.isSafeInteger })
  revision!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const NotificationOutboxSchema =
  SchemaFactory.createForClass(NotificationOutbox);
NotificationOutboxSchema.index(
  { jobId: 1, outcome: 1 },
  { unique: true, name: 'notification_outbox_job_outcome_unique' },
);
NotificationOutboxSchema.index(
  { state: 1, nextAttemptAt: 1, leaseExpiresAt: 1, createdAt: 1, _id: 1 },
  { name: 'notification_outbox_due' },
);

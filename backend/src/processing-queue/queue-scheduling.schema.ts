import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';
@Schema({
  collection: 'processing_execution_usage',
  strict: 'throw',
  versionKey: false,
})
export class QueueExecutionUsage {
  @Prop({ type: String, required: true }) _id!: string;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  userId!: Types.ObjectId;
  @Prop({
    type: Number,
    default: null,
    min: 0,
    validate: (value: number | null) =>
      value === null || Number.isFinite(value),
  })
  executionSeconds!: number | null;
  @Prop({ type: Date, required: true }) expiresAt!: Date;
}
export const QueueExecutionUsageSchema =
  SchemaFactory.createForClass(QueueExecutionUsage);
QueueExecutionUsageSchema.index({ userId: 1, expiresAt: 1 });
QueueExecutionUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

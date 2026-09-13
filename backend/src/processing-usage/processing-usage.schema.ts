import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';

@Schema({
  collection: 'processing_usage_ledger',
  strict: 'throw',
  versionKey: false,
})
export class ProcessingUsageLedger {
  @Prop({ type: MongoSchema.Types.ObjectId, required: true })
  _id!: Types.ObjectId;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  userId!: Types.ObjectId;
  @Prop({ required: true, min: 1, max: 1800, validate: Number.isSafeInteger })
  audioSeconds!: number;
  @Prop({
    type: Number,
    default: 3600,
    min: 1,
    max: 86400,
    validate: Number.isSafeInteger,
  })
  allowanceAudioSeconds!: number;
  @Prop({ required: true, enum: ['reserved', 'pending', 'used', 'released'] })
  state!: 'reserved' | 'pending' | 'used' | 'released';
  @Prop({ type: Date, default: null }) expiresAt!: Date | null;
  @Prop({ type: Date, default: null }) purgeAt!: Date | null;
  @Prop({ type: Date, required: true }) createdAt!: Date;
}
export const ProcessingUsageLedgerSchema = SchemaFactory.createForClass(
  ProcessingUsageLedger,
);
ProcessingUsageLedgerSchema.index({ userId: 1, state: 1, expiresAt: 1 });
ProcessingUsageLedgerSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { Types } from 'mongoose';

@Schema({ collection: 'admin_operations', strict: 'throw', versionKey: false })
export class AdminOperation {
  _id!: Types.ObjectId;
  @Prop({ required: true, maxlength: 128 }) actorUid!: string;
  @Prop({ required: true, maxlength: 200 }) route!: string;
  @Prop({ required: true, maxlength: 36 }) operationId!: string;
  @Prop({ required: true, match: /^[a-f0-9]{64}$/ }) requestHash!: string;
  @Prop({ required: true, enum: ['pending', 'succeeded', 'failed'] }) status!:
    'pending' | 'succeeded' | 'failed';
  @Prop({ type: String, default: null, maxlength: 128 }) resourceId!:
    string | null;
  @Prop({ type: String, default: null }) code!: string | null;
  @Prop({ type: String, default: null }) executionToken!: string | null;
  @Prop({ type: Date, default: null }) pendingUntil!: Date | null;
  @Prop({ type: Number, default: 0 }) executionFence!: number;
  @Prop({ type: Number, default: null, min: 0 }) revision!: number | null;
  @Prop({ required: true, type: Date, default: Date.now }) at!: Date;
}

export const AdminOperationSchema =
  SchemaFactory.createForClass(AdminOperation);
AdminOperationSchema.index(
  { actorUid: 1, operationId: 1 },
  { unique: true, name: 'admin_operation_actor_id' },
);

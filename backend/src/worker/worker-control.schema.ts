import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';
import { WORKER_ID_PATTERN } from './worker-registration.schema.js';

@Schema({
  collection: 'audio_worker_control',
  strict: 'throw',
  versionKey: false,
})
export class WorkerControl {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: WORKER_ID_PATTERN,
  })
  _id!: string;
  @Prop({ required: true, min: 0, default: 0, validate: Number.isSafeInteger })
  controlRevision!: number;
  @Prop({ type: MongoSchema.Types.ObjectId, default: null })
  activeJobId!: Types.ObjectId | null;
  @Prop({ type: String, default: null, maxlength: 36 }) attemptId!:
    string | null;
  @Prop({ type: String, default: null, maxlength: 36 }) sessionId!:
    string | null;
  @Prop({ required: true, min: 0, default: 0, validate: Number.isSafeInteger })
  generation!: number;
  @Prop({ type: Date, default: null }) lastSeenAt!: Date | null;
  @Prop({ type: Date, default: null }) leaseExpiresAt!: Date | null;
}
export const WorkerControlSchema = SchemaFactory.createForClass(WorkerControl);
WorkerControlSchema.index(
  { leaseExpiresAt: 1, _id: 1 },
  {
    name: 'worker_active_lease',
    partialFilterExpression: { activeJobId: { $type: 'objectId' } },
  },
);

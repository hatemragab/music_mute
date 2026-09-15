import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema } from 'mongoose';
import {
  EVENT_CATEGORIES,
  EVENT_STATUSES,
  EVENT_STAGES,
  type EventDetails,
  type EventInput,
} from './worker-event-policy.js';

@Schema({ collection: 'worker_events', strict: 'throw', versionKey: false })
export class WorkerEvent {
  @Prop({ required: true }) installationId!: string;
  @Prop({ type: String, default: null }) workerId!: string | null;
  @Prop({ required: true }) eventId!: string;
  @Prop({ required: true }) operationId!: string;
  @Prop({ required: true, min: 1 }) sequence!: number;
  @Prop({ required: true, type: String, enum: EVENT_CATEGORIES })
  category!: EventInput['category'];
  @Prop({ required: true, type: String, enum: EVENT_STAGES })
  stage!: EventInput['stage'];
  @Prop({ required: true, type: String, enum: EVENT_STATUSES })
  status!: EventInput['status'];
  @Prop({ required: true }) occurredAt!: string;
  @Prop({ type: Number }) durationMs?: number;
  @Prop({ type: String }) code?: EventInput['code'];
  @Prop({ type: MongoSchema.Types.Mixed }) details?: EventDetails;
  @Prop({ required: true, select: false }) payloadFingerprint!: string;
  @Prop({ required: true }) receivedAt!: Date;
  @Prop({ required: true }) expiresAt!: Date;
}
export const WorkerEventSchema = SchemaFactory.createForClass(WorkerEvent);
WorkerEventSchema.index({ installationId: 1, eventId: 1 }, { unique: true });
WorkerEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
WorkerEventSchema.index({ installationId: 1, receivedAt: -1, _id: -1 });
WorkerEventSchema.index({
  installationId: 1,
  operationId: 1,
  sequence: -1,
  receivedAt: -1,
  _id: -1,
});
WorkerEventSchema.index({
  installationId: 1,
  operationId: 1,
  receivedAt: -1,
  _id: -1,
});
WorkerEventSchema.index({
  installationId: 1,
  category: 1,
  status: 1,
  receivedAt: -1,
  _id: -1,
});

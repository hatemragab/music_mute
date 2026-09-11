import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';
import { JOB_STATUSES, type JobStatus } from './job.types.js';

@Schema({
  collection: 'audio_job_receipts',
  strict: 'throw',
  versionKey: false,
})
export class JobReceipt {
  _id!: Types.ObjectId;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  jobId!: Types.ObjectId;
  @Prop({ required: true, immutable: true, maxlength: 36 }) eventId!: string;
  @Prop({ required: true, immutable: true, maxlength: 36 }) attemptId!: string;
  @Prop({ required: true, immutable: true, match: /^[a-f0-9]{64}$/ })
  requestHash!: string;
  @Prop({
    required: true,
    enum: ['stage', 'output', 'complete', 'fail', 'cancelled'],
  })
  operation!: string;
  @Prop({ type: String, required: true, enum: JOB_STATUSES })
  status!: JobStatus;
  @Prop({ required: true, type: Date }) createdAt!: Date;
}
export const JobReceiptSchema = SchemaFactory.createForClass(JobReceipt);
JobReceiptSchema.index(
  { jobId: 1, eventId: 1 },
  { unique: true, name: 'job_event_receipt_unique' },
);

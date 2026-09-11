import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';
import { JOB_FAILURE_CODES } from '../jobs/job.types.js';

@Schema({ collection: 'audio_job_errors', strict: 'throw', versionKey: false })
export class JobError {
  _id!: Types.ObjectId;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  jobId!: Types.ObjectId;
  @Prop({ required: true, immutable: true, maxlength: 100 }) eventId!: string;
  @Prop({ type: String, default: null, maxlength: 36 }) attemptId!:
    string | null;
  @Prop({
    type: Number,
    default: null,
    min: 1,
    validate: (value: number | null) =>
      value === null || Number.isSafeInteger(value),
  })
  generation!: number | null;
  @Prop({
    type: String,
    required: true,
    enum: ['processing', 'interruption', 'notification'],
  })
  classification!: string;
  @Prop({
    required: true,
    enum: [...JOB_FAILURE_CODES, 'WORKER_INTERRUPTED', 'NOTIFICATION_FAILED'],
  })
  code!: string;
  @Prop({ required: true, maxlength: 200 }) message!: string;
  @Prop({
    required: true,
    enum: [
      'validating',
      'processing',
      'uploading_result',
      'notification',
      'interrupted',
    ],
  })
  stage!: string;
  @Prop({
    type: Number,
    default: null,
    min: -2147483648,
    max: 4294967295,
    validate: (v: number | null) => v === null || Number.isInteger(v),
  })
  exitCode!: number | null;
  @Prop({ required: true, type: Date }) createdAt!: Date;
}
export const JobErrorSchema = SchemaFactory.createForClass(JobError);
JobErrorSchema.index(
  { jobId: 1, eventId: 1 },
  { unique: true, name: 'job_error_event_unique' },
);
JobErrorSchema.index(
  { jobId: 1, createdAt: -1 },
  { name: 'job_error_history' },
);

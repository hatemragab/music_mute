import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';
import { JOB_FAILURE_CODES } from '../jobs/job.types.js';

@Schema({ collection: 'audio_job_errors', strict: 'throw', versionKey: false })
export class JobError {
  _id!: Types.ObjectId;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  jobId!: Types.ObjectId;
  @Prop({ required: true, immutable: true, maxlength: 100 }) eventId!: string;
  @Prop({
    type: String,
    required: true,
    enum: ['processing', 'notification'],
  })
  classification!: string;
  @Prop({
    required: true,
    enum: [...JOB_FAILURE_CODES, 'NOTIFICATION_FAILED'],
  })
  code!: string;
  @Prop({ required: true, maxlength: 200 }) message!: string;
  @Prop({
    required: true,
    enum: ['validating', 'processing', 'uploading_result', 'notification'],
  })
  stage!: string;
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

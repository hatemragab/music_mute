import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';
import type { OutputReservation } from './job.types.js';
import { OutputReservationSchema } from './job.schema.js';

@Schema({
  collection: 'audio_job_attempts',
  strict: 'throw',
  versionKey: false,
})
export class JobAttempt {
  _id!: Types.ObjectId;
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: /^[a-z0-9][a-z0-9-]{0,63}$/,
  })
  workerId!: string;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  jobId!: Types.ObjectId;
  @Prop({ required: true, immutable: true, maxlength: 36 }) attemptId!: string;
  @Prop({ required: true, immutable: true, maxlength: 36 }) sessionId!: string;
  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  generation!: number;
  @Prop({ required: true, type: Date }) startedAt!: Date;
  @Prop({ type: Date, default: null }) processingStartedAt!: Date | null;
  @Prop({ type: Date, default: null }) processingEndedAt!: Date | null;
  @Prop({ type: Boolean, default: false })
  processingElapsedApproximate!: boolean;
  @Prop({ type: Date, default: null }) localDataDeletedAt!: Date | null;
  @Prop({ type: Date, default: null }) endedAt!: Date | null;
  @Prop({ type: Date, default: null }) releasedAt!: Date | null;
  @Prop({ type: Date, default: null }) interruptedAt!: Date | null;
  @Prop({ type: String, default: null, maxlength: 36 }) replacementAttemptId!:
    string | null;
  @Prop({
    type: String,
    enum: ['ready', 'failed', 'cancelled', 'interrupted', null],
    default: null,
  })
  outcome!: string | null;
  @Prop({ type: OutputReservationSchema, default: null })
  outputReservation!: OutputReservation | null;
}
export const JobAttemptSchema = SchemaFactory.createForClass(JobAttempt);
JobAttemptSchema.index(
  { jobId: 1, startedAt: -1, _id: -1 },
  { name: 'admin_attempt_history' },
);
JobAttemptSchema.index(
  { attemptId: 1 },
  { unique: true, name: 'attempt_id_unique' },
);
JobAttemptSchema.index(
  { jobId: 1, startedAt: 1 },
  { name: 'attempt_job_history' },
);

import { Schema as MongoSchema } from 'mongoose';
import type { ProcessingQualification } from './processing-qualification.js';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { adminError } from '../admin/admin-errors.js';
export const DEFAULT_QUEUE_POLICY = Object.freeze({
  acceptNewJobs: true,
  acceptLongJobs: false,
  maxDurationSeconds: 1800,
  maxPreparedAudioBytes: 100_000_000,
  maxActiveJobsPerUser: 1,
  allowanceAudioSeconds: 3600,
  allowanceWindowSeconds: 86400,
  maxOutstandingJobs: 100,
  maxOutstandingAudioSeconds: 60_000,
  agingThresholdSeconds: 900,
});
export type QueuePolicyValues = {
  [
    K in keyof typeof DEFAULT_QUEUE_POLICY
  ]: (typeof DEFAULT_QUEUE_POLICY)[K] extends boolean ? boolean : number;
};
export function validateQueuePolicy(value: QueuePolicyValues): void {
  const bounds: Array<[number, number, number]> = [
    [value.maxDurationSeconds, 1, 1800],
    [value.maxPreparedAudioBytes, 1, 100_000_000],
    [value.allowanceAudioSeconds, 3600, 86400],
    [value.maxOutstandingJobs, 1, 1000],
    [value.maxOutstandingAudioSeconds, 1, 1_800_000],
    [value.agingThresholdSeconds, 1, 86400],
  ];
  if (
    typeof value.acceptNewJobs !== 'boolean' ||
    typeof value.acceptLongJobs !== 'boolean' ||
    value.maxActiveJobsPerUser !== 1 ||
    value.allowanceWindowSeconds !== 86400 ||
    bounds.some(
      ([v, min, max]) => !Number.isSafeInteger(v) || v < min || v > max,
    )
  )
    throw adminError('INVALID_REQUEST');
}
@Schema({
  collection: 'processing_queue_policy',
  strict: 'throw',
  versionKey: false,
})
export class ProcessingQueuePolicy implements QueuePolicyValues {
  @Prop({ type: MongoSchema.Types.Mixed, default: null })
  qualification!: ProcessingQualification | null;
  @Prop({ type: String, required: true, enum: ['processing'] }) _id!: string;
  @Prop({ required: true }) acceptNewJobs!: boolean;
  @Prop({ required: true }) acceptLongJobs!: boolean;
  @Prop({ required: true }) maxDurationSeconds!: number;
  @Prop({ required: true }) maxPreparedAudioBytes!: number;
  @Prop({ required: true }) maxActiveJobsPerUser!: number;
  @Prop({ required: true }) allowanceAudioSeconds!: number;
  @Prop({ required: true }) allowanceWindowSeconds!: number;
  @Prop({ required: true }) maxOutstandingJobs!: number;
  @Prop({ required: true }) maxOutstandingAudioSeconds!: number;
  @Prop({ required: true }) agingThresholdSeconds!: number;
  @Prop({ required: true, min: 0, validate: Number.isSafeInteger })
  revision!: number;
  @Prop({ required: true }) updatedAt!: Date;
}
export const ProcessingQueuePolicySchema = SchemaFactory.createForClass(
  ProcessingQueuePolicy,
);

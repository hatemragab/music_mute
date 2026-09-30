import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';

/** Compact replay proof retained after the deleted job and its detail are removed. */
@Schema({
  collection: 'audio_purged_job_requests',
  strict: 'throw',
  versionKey: false,
})
export class PurgedJobRequest {
  _id!: Types.ObjectId;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  accountId!: Types.ObjectId;
  @Prop({ required: true, immutable: true, maxlength: 36 }) requestId!: string;
  @Prop({ required: true, immutable: true, match: /^[a-f0-9]{64}$/ })
  requestHash!: string;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  jobId!: Types.ObjectId;
  @Prop({ type: Date, required: true, immutable: true }) purgedAt!: Date;
}

export const PurgedJobRequestSchema =
  SchemaFactory.createForClass(PurgedJobRequest);
PurgedJobRequestSchema.index(
  { accountId: 1, requestId: 1 },
  { unique: true, name: 'purged_job_owner_request_unique' },
);

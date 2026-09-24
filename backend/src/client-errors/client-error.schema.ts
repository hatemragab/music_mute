import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema } from 'mongoose';
import type { HydratedDocument, Types } from 'mongoose';
import {
  CLIENT_ERROR_CODES,
  CLIENT_ERROR_STAGES,
  type ClientErrorCode,
  type ClientErrorStage,
} from './client-error.dto.js';

@Schema({
  collection: 'client_errors',
  strict: 'throw',
  versionKey: false,
})
export class ClientError {
  _id!: Types.ObjectId;

  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  userId!: Types.ObjectId;

  @Prop({ required: true, immutable: true, maxlength: 36 })
  eventId!: string;

  @Prop({ required: true, immutable: true, maxlength: 36 })
  operationId!: string;

  @Prop({
    type: MongoSchema.Types.ObjectId,
    default: null,
    immutable: true,
  })
  jobId!: Types.ObjectId | null;

  @Prop({
    type: String,
    required: true,
    enum: CLIENT_ERROR_STAGES,
    immutable: true,
  })
  stage!: ClientErrorStage;

  @Prop({
    type: String,
    required: true,
    enum: CLIENT_ERROR_CODES,
    immutable: true,
  })
  code!: ClientErrorCode;

  @Prop({ required: true, immutable: true })
  retryable!: boolean;

  @Prop({
    type: String,
    required: true,
    enum: ['android', 'ios'],
    immutable: true,
  })
  platform!: 'android' | 'ios';

  @Prop({ required: true, immutable: true, minlength: 1, maxlength: 32 })
  appVersion!: string;

  @Prop({ required: true, immutable: true, minlength: 1, maxlength: 64 })
  osVersion!: string;

  @Prop({ type: Date, required: true, immutable: true })
  occurredAt!: Date;

  @Prop({ type: Number, default: null, min: 100, max: 599, immutable: true })
  httpStatus!: number | null;

  @Prop({ type: Date, required: true, immutable: true })
  receivedAt!: Date;

  @Prop({ required: true, immutable: true, match: /^[a-f0-9]{64}$/ })
  payloadHash!: string;
}

export type ClientErrorDocument = HydratedDocument<ClientError>;
export const ClientErrorSchema = SchemaFactory.createForClass(ClientError);
ClientErrorSchema.index(
  { userId: 1, eventId: 1 },
  { unique: true, name: 'client_errors_owner_event_unique' },
);

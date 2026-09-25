import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, Types } from 'mongoose';
import { type ImportProvider } from './import-source.js';
import type { InputDeclaration } from '../jobs/job.types.js';

export const IMPORT_STATES = [
  'queued',
  'downloading',
  'validating',
  'uploading',
  'submitted',
  'failed',
] as const;
export const ACTIVE_IMPORT_STATES = [
  'queued',
  'downloading',
  'validating',
  'uploading',
] as const;
export type ImportState = (typeof IMPORT_STATES)[number];

@Schema({
  collection: 'media_imports',
  timestamps: true,
  strict: 'throw',
  versionKey: false,
})
export class MediaImport {
  _id!: Types.ObjectId;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  userId!: Types.ObjectId;
  @Prop({ required: true, immutable: true }) requestId!: string;
  @Prop({ required: true, immutable: true }) jobRequestId!: string;
  @Prop({ required: true, immutable: true, maxlength: 2048 })
  sourceUrl!: string;
  @Prop({ type: String, default: null, maxlength: 400 })
  sourceTitle!: string | null;
  @Prop({ type: Boolean, default: true, immutable: true })
  trimEnabled!: boolean;
  @Prop({
    type: String,
    required: true,
    immutable: true,
  })
  provider!: ImportProvider;
  @Prop({
    type: String,
    required: true,
    enum: IMPORT_STATES,
    default: 'queued',
  })
  status!: ImportState;
  @Prop({ type: MongoSchema.Types.ObjectId, default: null })
  jobId!: Types.ObjectId | null;
  @Prop({ type: MongoSchema.Types.Mixed, default: null })
  input!: InputDeclaration | null;
  @Prop({ type: String, default: null }) executionId!: string | null;
  @Prop({ type: Date, default: null }) deadlineAt!: Date | null;
  @Prop({ type: { code: String, message: String }, _id: false, default: null })
  error!: { code: string; message: string } | null;
  @Prop({ type: Date, default: null }) expiresAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export const MediaImportSchema = SchemaFactory.createForClass(MediaImport);
MediaImportSchema.index({ userId: 1, requestId: 1 }, { unique: true });
MediaImportSchema.index({ status: 1, createdAt: 1 });
MediaImportSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

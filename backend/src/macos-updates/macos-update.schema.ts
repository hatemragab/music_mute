import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';
import { isStorageEtag } from '../storage/object-identity.js';

@Schema({
  collection: 'macos_update_configuration',
  strict: 'throw',
  versionKey: false,
})
export class MacosUpdateConfiguration {
  @Prop({ type: String, default: 'global' }) _id!: string;
  @Prop({ type: String, default: null }) publicEdKey!: string | null;
  @Prop({ type: MongoSchema.Types.ObjectId, default: null })
  selectedReleaseId!: Types.ObjectId | null;
  @Prop({ required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  revision!: number;
  @Prop({ required: true, default: 0 }) mutationFence!: number;
}
export const MacosUpdateConfigurationSchema = SchemaFactory.createForClass(
  MacosUpdateConfiguration,
);

@Schema({
  collection: 'macos_updates',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class MacosUpdate {
  _id!: Types.ObjectId;
  @Prop({ required: true, maxlength: 64 }) versionName!: string;
  @Prop({ required: true, match: /^[1-9]\d{0,17}$/ }) buildNumber!: string;
  @Prop({ required: true, match: /^\d{18}$/ }) buildOrder!: string;
  @Prop({ required: true, maxlength: 256 }) archiveName!: string;
  @Prop({
    required: true,
    min: 1,
    max: 2147483648,
    validate: Number.isSafeInteger,
  })
  bytes!: number;
  @Prop({ required: true, match: /^[a-f0-9]{64}$/ }) sha256Hex!: string;
  @Prop({ required: true, maxlength: 43692 }) appcastBase64!: string;
  @Prop({ required: true }) publicEdKey!: string;
  @Prop({ required: true }) key!: string;
  @Prop({
    type: String,
    default: null,
    validate: (value: unknown) => value === null || isStorageEtag(value),
  })
  etag!: string | null;
  @Prop({
    required: true,
    type: String,
    enum: ['draft', 'published', 'withdrawn'],
    default: 'draft',
  })
  state!: 'draft' | 'published' | 'withdrawn';
  @Prop({
    required: true,
    type: String,
    enum: ['awaiting_upload', 'verified'],
    default: 'awaiting_upload',
  })
  artifactState!: 'awaiting_upload' | 'verified';
  @Prop({ required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  revision!: number;
  @Prop({ required: true, maxlength: 128 }) createdBy!: string;
  @Prop({ type: Date, default: null }) publishedAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export const MacosUpdateSchema = SchemaFactory.createForClass(MacosUpdate);
MacosUpdateSchema.index({ archiveName: 1 }, { unique: true });
MacosUpdateSchema.index({ buildNumber: 1 }, { unique: true });
MacosUpdateSchema.index({ buildOrder: -1, publishedAt: 1 });
MacosUpdateSchema.index({ createdAt: -1, _id: -1 });

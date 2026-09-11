import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';
import type { ArtifactState } from './release.types.js';
import {
  APK_REJECTION_CODES,
  type ApkRejectionCode,
} from './apk-verification-errors.js';

@Schema({ collection: 'release_uploads', strict: 'throw', versionKey: false })
export class ReleaseUpload {
  _id!: Types.ObjectId;
  @Prop({ required: true, type: MongoSchema.Types.ObjectId })
  releaseId!: Types.ObjectId;
  @Prop({ required: true }) key!: string;
  @Prop({ required: true, min: 1, max: 268435456, validate: Number.isInteger })
  expectedBytes!: number;
  @Prop({ required: true, match: /^[a-f0-9]{64}$/ }) expectedSha256!: string;
  @Prop({ required: true, type: Date }) expiresAt!: Date;
  @Prop({
    required: true,
    type: String,
    enum: ['awaiting_upload', 'verifying', 'verified', 'rejected'],
    default: 'awaiting_upload',
  })
  artifactState!: ArtifactState;
  @Prop({ type: String, default: null }) versionId!: string | null;
  @Prop({ type: String, default: null }) verificationToken!: string | null;
  @Prop({ type: String, default: null }) completionOperationId!: string | null;
  @Prop({ type: Date, default: null }) verificationDeadline!: Date | null;
  @Prop({ type: Date, default: null }) checkedAt!: Date | null;
  @Prop({ type: String, enum: [...APK_REJECTION_CODES, null], default: null })
  code!: ApkRejectionCode | null;
}
export const ReleaseUploadSchema = SchemaFactory.createForClass(ReleaseUpload);
ReleaseUploadSchema.index({ key: 1 }, { unique: true });
ReleaseUploadSchema.index({ releaseId: 1 });

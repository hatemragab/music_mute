import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema } from 'mongoose';
import type { HydratedDocument, Types } from 'mongoose';
import {
  PUSH_TOKEN_MAX_LENGTH,
  PUSH_TOKEN_PATTERN,
} from './dto/push-registration.dto.js';

const installationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

@Schema({
  collection: 'push_registrations',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class PushInstallation {
  _id!: Types.ObjectId;

  @Prop({ type: MongoSchema.Types.ObjectId, required: true })
  userId!: Types.ObjectId;

  @Prop({ required: true, immutable: true, match: installationIdPattern })
  installationId!: string;

  @Prop({
    required: true,
    select: false,
    minlength: 1,
    maxlength: PUSH_TOKEN_MAX_LENGTH,
    match: PUSH_TOKEN_PATTERN,
  })
  token!: string;

  @Prop({
    required: true,
    select: false,
    match: /^[a-f0-9]{64}$/,
  })
  tokenHash!: string;

  @Prop({
    required: true,
    default: 1,
    min: 1,
    validate: Number.isSafeInteger,
  })
  bindingRevision!: number;

  @Prop({ required: true, min: 0, validate: Number.isSafeInteger })
  authTimeSec!: number;

  @Prop({ required: true, default: true })
  active!: boolean;

  @Prop({ type: Date, default: null })
  deactivatedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type PushInstallationDocument = HydratedDocument<PushInstallation>;
export const PushInstallationSchema =
  SchemaFactory.createForClass(PushInstallation);

PushInstallationSchema.index(
  { installationId: 1 },
  { unique: true, name: 'push_installation_unique' },
);
PushInstallationSchema.index(
  { tokenHash: 1 },
  {
    unique: true,
    name: 'push_active_token_hash_unique',
    partialFilterExpression: { active: true },
  },
);
PushInstallationSchema.index(
  { userId: 1, active: 1, _id: 1 },
  { name: 'push_owner_active' },
);

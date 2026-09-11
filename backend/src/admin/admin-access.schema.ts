import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument, Types } from 'mongoose';
import type { AdminRole } from './admin.types.js';

export const ADMIN_ROLES: readonly AdminRole[] = [
  'owner',
  'release_manager',
  'worker_manager',
  'support',
  'viewer',
];

@Schema({
  collection: 'admin_access',
  timestamps: true,
  strict: 'throw',
  versionKey: false,
})
export class AdminAccess {
  _id!: Types.ObjectId;

  @Prop({ required: true, immutable: true, maxlength: 128 })
  uid!: string;

  @Prop({ required: true, trim: true, lowercase: true, maxlength: 320 })
  verifiedEmail!: string;

  @Prop({ required: true, type: String, enum: ADMIN_ROLES })
  role!: AdminRole;

  @Prop({ required: true, default: true })
  active!: boolean;

  @Prop({
    required: true,
    type: Number,
    default: 0,
    min: 0,
    validate: Number.isSafeInteger,
  })
  revision!: number;

  @Prop({
    required: true,
    type: Number,
    default: 0,
    min: 0,
    validate: Number.isSafeInteger,
  })
  authorizationFence!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type AdminAccessDocument = HydratedDocument<AdminAccess>;
export const AdminAccessSchema = SchemaFactory.createForClass(AdminAccess);
AdminAccessSchema.index(
  { uid: 1 },
  { unique: true, name: 'admin_access_uid_unique' },
);
AdminAccessSchema.index(
  { verifiedEmail: 1 },
  { unique: true, name: 'admin_access_email_unique' },
);

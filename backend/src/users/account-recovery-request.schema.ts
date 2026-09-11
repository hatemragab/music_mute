import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  Schema as MongoSchema,
  type HydratedDocument,
  type Types,
} from 'mongoose';

export type AccountRecoveryRequestStatus =
  'pending' | 'approved' | 'rejected' | 'expired';

@Schema({
  collection: 'account_recovery_requests',
  timestamps: true,
  strict: 'throw',
  versionKey: false,
})
export class AccountRecoveryRequest {
  _id!: Types.ObjectId;

  @Prop({
    type: MongoSchema.Types.ObjectId,
    required: true,
    immutable: true,
    ref: 'User',
  })
  userId!: Types.ObjectId;

  @Prop({ required: true, immutable: true, maxlength: 128 })
  deletionRequestId!: string;

  @Prop({ type: Date, required: true, immutable: true })
  deletionRequestedAt!: Date;

  @Prop({ type: Date, required: true, immutable: true })
  recoverUntil!: Date;

  @Prop({ type: String, default: null, maxlength: 500 })
  reason!: string | null;

  @Prop({
    type: String,
    required: true,
    default: 'pending',
    enum: ['pending', 'approved', 'rejected', 'expired'],
  })
  status!: AccountRecoveryRequestStatus;

  @Prop({ type: Number, required: true, default: 0, min: 0 })
  revision!: number;

  @Prop({ type: String, default: null, maxlength: 128 })
  reviewedBy!: string | null;

  @Prop({ type: Date, default: null })
  reviewedAt!: Date | null;

  @Prop({ type: String, default: null, maxlength: 500 })
  reviewReason!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export type AccountRecoveryRequestDocument =
  HydratedDocument<AccountRecoveryRequest>;
export const AccountRecoveryRequestSchema = SchemaFactory.createForClass(
  AccountRecoveryRequest,
);
AccountRecoveryRequestSchema.index(
  { userId: 1, deletionRequestId: 1 },
  { unique: true, name: 'account_recovery_request_once_per_deletion' },
);
AccountRecoveryRequestSchema.index(
  { status: 1, createdAt: 1, _id: 1 },
  { name: 'admin_account_recovery_queue' },
);
AccountRecoveryRequestSchema.index(
  { status: 1, recoverUntil: 1 },
  { name: 'admin_account_recovery_active_deadline' },
);

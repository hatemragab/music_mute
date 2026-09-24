import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema } from 'mongoose';
import type { Types } from 'mongoose';
import {
  RESTRICTION_REASON_CODES,
  type RestrictionReasonCode,
} from './abuse-protection.types.js';

@Schema({
  collection: 'account_restrictions',
  strict: 'throw',
  versionKey: false,
})
export class AccountRestriction {
  _id!: Types.ObjectId;

  @Prop({
    type: MongoSchema.Types.ObjectId,
    required: true,
    immutable: true,
  })
  accountId!: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    enum: ['active', 'expired', 'removed'],
  })
  status!: 'active' | 'expired' | 'removed';

  @Prop({ type: String, required: true, enum: RESTRICTION_REASON_CODES })
  reasonCode!: RestrictionReasonCode;

  @Prop({ type: String, required: true, minlength: 1, maxlength: 500 })
  note!: string;

  @Prop({ type: Date, required: true })
  startsAt!: Date;

  @Prop({ type: Date, default: null })
  expiresAt!: Date | null;

  @Prop({ type: String, required: true, maxlength: 128 })
  createdBy!: string;

  @Prop({ type: String, required: true, maxlength: 128 })
  updatedBy!: string;

  @Prop({ type: Date, required: true })
  updatedAt!: Date;

  @Prop({ required: true, min: 0, validate: Number.isSafeInteger })
  revision!: number;
}

export const AccountRestrictionSchema =
  SchemaFactory.createForClass(AccountRestriction);
AccountRestrictionSchema.index(
  { accountId: 1 },
  { unique: true, name: 'account_restriction_lookup' },
);

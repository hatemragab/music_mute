import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/** Non-personal completion proof. Never add account, identity, device, media, or note fields. */
@Schema({
  collection: 'account_deletion_tombstones',
  strict: 'throw',
  versionKey: false,
})
export class AccountDeletionTombstone {
  @Prop({ type: String, required: true, maxlength: 128 })
  _id!: string;

  @Prop({ type: Date, required: true, immutable: true })
  acceptedAt!: Date;

  @Prop({ type: Date, required: true })
  completedAt!: Date;

  @Prop({ type: String, required: true, enum: ['purged'] })
  status!: 'purged';

  @Prop({ type: Number, required: true, enum: [1] })
  schemaVersion!: 1;
}

export const AccountDeletionTombstoneSchema = SchemaFactory.createForClass(
  AccountDeletionTombstone,
);

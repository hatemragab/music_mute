import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/** A short-lived pseudonymous replay fence survives removal of a deleted profile. */
@Schema({
  collection: 'user_identity_fences',
  versionKey: false,
  strict: 'throw',
})
export class UserIdentityFence {
  @Prop({ type: String, required: true })
  _id!: string;

  @Prop({ required: true, default: false })
  blocked!: boolean;

  @Prop({ required: true, default: 0 })
  revision!: number;

  @Prop({ type: Date, default: null })
  expiresAt!: Date | null;
}
export const UserIdentityFenceSchema =
  SchemaFactory.createForClass(UserIdentityFence);
UserIdentityFenceSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'identity_fence_expiry' },
);

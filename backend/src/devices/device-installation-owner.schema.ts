import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema } from 'mongoose';
import type { HydratedDocument, Types } from 'mongoose';

@Schema({
  collection: 'device_installation_owners',
  strict: 'throw',
  versionKey: false,
})
export class DeviceInstallationOwner {
  @Prop({ type: String, required: true, immutable: true })
  _id!: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    default: null,
  })
  userId!: Types.ObjectId | null;

  @Prop({ required: true, min: 0, validate: Number.isSafeInteger })
  authTimeSec!: number;

  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  revision!: number;

  @Prop({ required: true, type: Date })
  claimedAt!: Date;

  @Prop({ type: Date, default: null })
  ambiguousAt!: Date | null;
}

export type DeviceInstallationOwnerDocument =
  HydratedDocument<DeviceInstallationOwner>;
export const DeviceInstallationOwnerSchema = SchemaFactory.createForClass(
  DeviceInstallationOwner,
);

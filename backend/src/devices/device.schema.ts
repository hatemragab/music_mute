import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema } from 'mongoose';
import type { HydratedDocument, Types } from 'mongoose';
import type { Platform } from '../auth/auth.types.js';

const printable = /^[^\p{Cc}\p{Cf}]+$/u;

function isBoundedPrintable(value: string, maximum: number): boolean {
  const length = Array.from(value).length;
  return length >= 1 && length <= maximum && printable.test(value);
}

@Schema({ _id: false, strict: 'throw' })
export class VersionTransition {
  @Prop({
    required: true,
    validate: (value: string) => isBoundedPrintable(value, 32),
  })
  appVersion!: string;
  @Prop({ required: true, min: 1, max: 2147483647 }) buildNumber!: number;
  @Prop({ required: true, min: 1 }) metadataRevision!: number;
  @Prop({ required: true, type: Date }) observedAt!: Date;
}
const TransitionSchema = SchemaFactory.createForClass(VersionTransition);

@Schema({ collection: 'user_devices', strict: 'throw', versionKey: false })
export class Device {
  _id!: Types.ObjectId;
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    required: true,
    immutable: true,
  })
  userId!: Types.ObjectId;
  @Prop({ required: true, immutable: true }) installationId!: string;
  @Prop({
    type: String,
    required: true,
    enum: ['android', 'ios'],
    immutable: true,
  })
  platform!: Platform;
  @Prop({
    required: true,
    validate: (value: string) => isBoundedPrintable(value, 32),
  })
  appVersion!: string;
  @Prop({ required: true, min: 1, max: 2147483647, validate: Number.isInteger })
  buildNumber!: number;
  @Prop({ required: true, min: 1, validate: Number.isSafeInteger })
  metadataRevision!: number;
  @Prop({
    required: true,
    validate: (value: string) => isBoundedPrintable(value, 64),
  })
  osVersion!: string;
  @Prop({
    type: String,
    default: null,
    validate: (value: string | null) =>
      value === null || isBoundedPrintable(value, 100),
  })
  deviceModel!: string | null;
  @Prop({ required: true, type: Date, immutable: true }) firstSeenAt!: Date;
  @Prop({ required: true, type: Date }) lastSeenAt!: Date;
  @Prop({ required: true, min: 0, validate: Number.isSafeInteger })
  lastAuthenticatedAtSec!: number;
  @Prop({ type: Date, default: null }) historyHiddenAt!: Date | null;
  @Prop({
    type: [TransitionSchema],
    default: [],
    validate: (items: VersionTransition[]) => items.length <= 20,
  })
  versionHistory!: VersionTransition[];
}
export type DeviceDocument = HydratedDocument<Device>;
export const DeviceSchema = SchemaFactory.createForClass(Device);
DeviceSchema.index(
  { userId: 1, installationId: 1 },
  { unique: true, name: 'devices_owner_installation_unique' },
);
DeviceSchema.index({ userId: 1, _id: -1 }, { name: 'devices_owner_cursor' });
DeviceSchema.index(
  { lastSeenAt: 1, platform: 1, buildNumber: 1 },
  { name: 'devices_recent_versions' },
);

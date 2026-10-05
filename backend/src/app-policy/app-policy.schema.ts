import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { ReleaseSelection } from '../releases/release.types.js';

@Schema({ _id: false, strict: 'throw' })
class StoredReleaseSelection {
  @Prop({
    required: true,
    type: String,
    enum: ['direct_apk', 'google_play', 'app_store'],
  })
  source!: ReleaseSelection['source'];
  @Prop({ type: String, default: null, match: /^[a-f0-9]{24}$/ })
  directReleaseId!: string | null;
  @Prop({ type: String, default: null, match: /^[a-f0-9]{24}$/ })
  storeReleaseId!: string | null;
}

@Schema({ _id: false, strict: 'throw' })
export class PlatformPolicy {
  @Prop({ type: Number, default: null }) minimumBuild!: number | null;
  @Prop({
    type: SchemaFactory.createForClass(StoredReleaseSelection),
    required: true,
  })
  releaseSelection!: ReleaseSelection;
}
const PlatformPolicySchema = SchemaFactory.createForClass(PlatformPolicy);

/** Desktop builds have their own gate; mobile store selections do not apply. */
@Schema({ _id: false, strict: 'throw' })
export class DesktopPlatformPolicy {
  @Prop({
    type: Number,
    default: null,
    validate: (value: number | null) =>
      value === null ||
      (Number.isInteger(value) && value >= 1 && value <= 2147483647),
  })
  minimumBuild!: number | null;
}

@Schema({ _id: false, strict: 'throw' })
class Platforms {
  @Prop({ type: PlatformPolicySchema, required: true })
  android!: PlatformPolicy;
  @Prop({ type: PlatformPolicySchema, required: true }) ios!: PlatformPolicy;
  @Prop({
    type: SchemaFactory.createForClass(DesktopPlatformPolicy),
    default: undefined,
  })
  macos?: DesktopPlatformPolicy;
}

@Schema({ collection: 'app_policies', strict: 'throw', versionKey: false })
export class AppPolicy {
  @Prop({ type: String, enum: ['global'], required: true }) _id!: 'global';
  @Prop({ required: true, default: false }) requireVerifiedEmail!: boolean;
  @Prop({ type: SchemaFactory.createForClass(Platforms), required: true })
  platforms!: Platforms;
  @Prop({ required: true, min: 0, validate: Number.isSafeInteger })
  revision!: number;
  @Prop({ type: Date, required: true }) updatedAt!: Date;
}
export const AppPolicySchema = SchemaFactory.createForClass(AppPolicy);

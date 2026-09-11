import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export const DEFAULT_PROCESSING_SETTINGS = Object.freeze({
  acceptNewJobs: true,
  maintenanceMessageEn: '',
  maintenanceMessageAr: null as string | null,
  maxInputBytesExclusive: 30_000_000,
  maxDurationSecondsExclusive: 600,
  maxActiveJobsPerUser: null as number | null,
});

@Schema({
  collection: 'processing_settings',
  strict: 'throw',
  versionKey: false,
})
export class ProcessingSettings {
  @Prop({ type: String, enum: ['processing'], required: true })
  _id!: 'processing';
  @Prop({ required: true }) acceptNewJobs!: boolean;
  @Prop({ type: String, default: '', maxlength: 1000 })
  maintenanceMessageEn!: string;
  @Prop({ type: String, default: null, maxlength: 1000 })
  maintenanceMessageAr!: string | null;
  @Prop({
    required: true,
    min: 2,
    max: 30_000_000,
    validate: Number.isSafeInteger,
  })
  maxInputBytesExclusive!: number;
  @Prop({ required: true, min: Number.MIN_VALUE, max: 600 })
  maxDurationSecondsExclusive!: number;
  @Prop({
    type: Number,
    default: null,
    min: 1,
    max: 100,
    validate: (value: number | null) =>
      value === null || Number.isSafeInteger(value),
  })
  maxActiveJobsPerUser!: number | null;
  @Prop({ required: true, min: 0, validate: Number.isSafeInteger })
  revision!: number;
  @Prop({ required: true }) updatedAt!: Date;
}
export const ProcessingSettingsSchema =
  SchemaFactory.createForClass(ProcessingSettings);

@Schema({
  collection: 'processing_admission_fences',
  strict: 'throw',
  versionKey: false,
})
export class ProcessingAdmissionFence {
  @Prop({ required: true, immutable: true, type: String, maxlength: 128 })
  _id!: string;
  @Prop({ required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  revision!: number;
}
export const ProcessingAdmissionFenceSchema = SchemaFactory.createForClass(
  ProcessingAdmissionFence,
);

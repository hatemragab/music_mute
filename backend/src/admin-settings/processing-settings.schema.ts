import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

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

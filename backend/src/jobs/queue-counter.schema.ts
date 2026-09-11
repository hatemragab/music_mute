import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({
  collection: 'audio_queue_counters',
  strict: 'throw',
  versionKey: false,
})
export class QueueCounter {
  @Prop({ type: String, required: true, enum: ['audio'] }) _id!: string;
  @Prop({ type: BigInt, required: true, default: 0n }) sequence!: bigint;
}
export const QueueCounterSchema = SchemaFactory.createForClass(QueueCounter);

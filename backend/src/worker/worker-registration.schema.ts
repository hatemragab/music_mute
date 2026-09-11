import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export const WORKER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const WORKER_KEY_PATTERN = /^[a-f0-9]{64}$/;
export type WorkerState = 'enabled' | 'draining' | 'revoked';

@Schema({
  collection: 'audio_workers',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class WorkerRegistration {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: WORKER_ID_PATTERN,
  })
  _id!: string;
  @Prop({ required: true, trim: true, minlength: 1, maxlength: 100 })
  label!: string;
  @Prop({ required: true, match: WORKER_KEY_PATTERN, select: false })
  keySha256!: string;
  @Prop({
    required: true,
    type: String,
    enum: ['enabled', 'draining', 'revoked'],
  })
  state!: WorkerState;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WorkerRegistrationSchema =
  SchemaFactory.createForClass(WorkerRegistration);
WorkerRegistrationSchema.index(
  { keySha256: 1 },
  { unique: true, name: 'worker_key_digest_unique' },
);
WorkerRegistrationSchema.index({ state: 1, _id: 1 }, { name: 'worker_state' });

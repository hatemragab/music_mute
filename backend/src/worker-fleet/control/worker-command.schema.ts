import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema } from 'mongoose';
import {
  UUID_V4_PATTERN,
  isBoundedStringArray,
} from '../worker-fleet.types.js';
import type { WorkerMetric } from '../telemetry/worker-diagnostic.schema.js';

const metric = new MongoSchema<WorkerMetric>(
  {
    name: { type: String, required: true, maxlength: 100 },
    value: { type: Number, required: true, validate: Number.isFinite },
    unit: { type: String, required: true, maxlength: 30 },
  },
  { _id: false, strict: 'throw' },
);

@Schema({
  collection: 'worker_commands',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class WorkerCommand {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: UUID_V4_PATTERN,
  })
  _id!: string;
  @Prop({ required: true, immutable: true, match: UUID_V4_PATTERN })
  machineId!: string;
  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: ['doctor', 'benchmark'],
  })
  kind!: 'doctor' | 'benchmark';
  @Prop({
    type: String,
    required: true,
    enum: ['pending', 'succeeded', 'failed'],
  })
  state!: 'pending' | 'succeeded' | 'failed';
  @Prop({
    type: [String],
    default: [],
    validate: (value: unknown) => isBoundedStringArray(value, 8, 50),
  })
  checks!: string[];
  @Prop({ type: String, default: null, maxlength: 100 }) recipeId!:
    string | null;
  @Prop({
    type: Number,
    default: null,
    min: 1,
    max: 5,
    validate: (value: number | null) =>
      value === null || Number.isSafeInteger(value),
  })
  iterations!: number | null;
  @Prop({ required: true, immutable: true, maxlength: 128 })
  requestedByUid!: string;
  @Prop({ required: true, immutable: true }) requestedAt!: Date;
  @Prop({ required: true, immutable: true }) expiresAt!: Date;
  @Prop({ type: String, default: null, match: UUID_V4_PATTERN })
  resultRequestId!: string | null;
  @Prop({ type: String, default: null, maxlength: 500 }) summary!:
    string | null;
  @Prop({ type: [metric], default: [] }) metrics!: WorkerMetric[];
  @Prop({ type: Date, default: null }) completedAt!: Date | null;
  @Prop({ type: Number, default: 0, min: 0, validate: Number.isSafeInteger })
  revision!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WorkerCommandSchema = SchemaFactory.createForClass(WorkerCommand);
WorkerCommandSchema.index(
  { machineId: 1, state: 1, createdAt: 1, _id: 1 },
  { name: 'worker_command_machine_pending' },
);
WorkerCommandSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 604800, name: 'worker_command_expiry' },
);

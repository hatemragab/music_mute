import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  WORKER_RECIPE_IDS,
  type WorkerRecipeId,
} from '../protocol/v1/protocol.js';
import {
  UUID_V4_PATTERN,
  WORKER_SLOT_STATES,
  isBoundedStringArray,
  type WorkerSlotState,
} from '../worker-fleet.types.js';

@Schema({
  collection: 'worker_slots',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class WorkerSlot {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: UUID_V4_PATTERN,
  })
  _id!: string;
  @Prop({ required: true, immutable: true, match: UUID_V4_PATTERN })
  machineId!: string;
  @Prop({ required: true, immutable: true, maxlength: 128 }) gpuId!: string;
  @Prop({
    type: Number,
    required: true,
    immutable: true,
    min: 0,
    max: 15,
    validate: Number.isSafeInteger,
  })
  slotIndex!: number;
  @Prop({ type: String, required: true, match: UUID_V4_PATTERN })
  sessionId!: string;
  @Prop({ type: String, required: true, match: UUID_V4_PATTERN })
  incarnation!: string;
  @Prop({ type: String, required: true, enum: WORKER_SLOT_STATES })
  state!: WorkerSlotState;
  @Prop({
    type: [String],
    required: true,
    enum: WORKER_RECIPE_IDS,
    validate: (value: unknown) =>
      isBoundedStringArray(value, 16, 100) &&
      new Set(value as string[]).size === (value as string[]).length,
  })
  allowedRecipeIds!: WorkerRecipeId[];
  @Prop({ type: String, default: null, match: UUID_V4_PATTERN })
  currentAttemptId!: string | null;
  @Prop({ type: Date, default: null }) lastSeenAt!: Date | null;
  @Prop({ type: Number, default: 0, min: 0, validate: Number.isSafeInteger })
  revision!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WorkerSlotSchema = SchemaFactory.createForClass(WorkerSlot);
WorkerSlotSchema.index(
  { machineId: 1, gpuId: 1, slotIndex: 1 },
  { unique: true, name: 'worker_slot_identity_unique' },
);
WorkerSlotSchema.index(
  { currentAttemptId: 1 },
  {
    unique: true,
    name: 'worker_slot_current_attempt_unique',
    partialFilterExpression: { currentAttemptId: { $type: 'string' } },
  },
);
WorkerSlotSchema.index(
  { machineId: 1, state: 1, _id: 1 },
  { name: 'worker_slot_machine_state' },
);

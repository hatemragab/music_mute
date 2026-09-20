import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema } from 'mongoose';
import {
  WORKER_RECIPE_IDS,
  type WorkerRecipeId,
} from '../protocol/v1/protocol.js';

export interface WorkerRecipePolicy {
  recipeId: WorkerRecipeId;
  enabled: boolean;
  maxSlotsPerMachine: number;
}

const recipePolicy = new MongoSchema<WorkerRecipePolicy>(
  {
    recipeId: { type: String, required: true, enum: WORKER_RECIPE_IDS },
    enabled: { type: Boolean, required: true },
    maxSlotsPerMachine: {
      type: Number,
      required: true,
      min: 1,
      max: 16,
      validate: Number.isSafeInteger,
    },
  },
  { _id: false, strict: 'throw' },
);

@Schema({
  collection: 'worker_fleet_policies',
  strict: 'throw',
  versionKey: false,
})
export class WorkerFleetPolicy {
  @Prop({ type: String, required: true, enum: ['worker-fleet'] })
  _id!: 'worker-fleet';
  @Prop({
    type: Number,
    required: true,
    min: 0,
    validate: Number.isSafeInteger,
  })
  revision!: number;
  @Prop({ type: Boolean, required: true }) acceptClaims!: boolean;
  @Prop({
    type: [recipePolicy],
    required: true,
    validate: (value: WorkerRecipePolicy[]) =>
      Array.isArray(value) &&
      value.length >= 1 &&
      value.length <= 16 &&
      new Set(value.map((item) => item.recipeId)).size === value.length,
  })
  recipes!: WorkerRecipePolicy[];
  @Prop({ type: Number, required: true, min: 15, max: 300 })
  leaseSeconds!: number;
  @Prop({ type: Number, required: true, min: 60, max: 7200 })
  processingDeadlineSeconds!: number;
  @Prop({ required: true }) updatedAt!: Date;
  @Prop({ required: true, maxlength: 128 }) updatedByUid!: string;
}

export const WorkerFleetPolicySchema =
  SchemaFactory.createForClass(WorkerFleetPolicy);

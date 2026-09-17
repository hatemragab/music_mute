import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema } from 'mongoose';
import {
  WORKER_PLATFORMS,
  WORKER_PROVIDERS,
  WORKER_PROTOCOL_VERSION,
  WORKER_RECIPE_IDS,
  type WorkerPlatform,
  type WorkerProvider,
  type WorkerRecipeId,
} from '../protocol/v1/protocol.js';
import {
  SHA256_HEX_PATTERN,
  UUID_V4_PATTERN,
  WORKER_MACHINE_STATUSES,
  isBoundedStringArray,
  type WorkerMachineStatus,
} from '../worker-fleet.types.js';

export interface WorkerGpuIdentity {
  id: string;
  name: string;
  driverVersion: string;
  memoryBytes: number | null;
}

export interface WorkerHardwareReport {
  os: string;
  osBuild: string;
  architecture: string;
  cpu: string;
  memoryBytes: number;
  gpus: WorkerGpuIdentity[];
}

export interface WorkerRuntimeIdentity {
  workerVersion: string;
  protocolVersion: number;
  manifestDigest: string;
  modelDigest: string;
  providerRuntimeVersion: string;
}

export interface WorkerCapability {
  platform: WorkerPlatform;
  provider: WorkerProvider;
  gpuId: string;
  recipeIds: WorkerRecipeId[];
  maxSlots: number;
}

export interface WorkerSessionIdentity {
  sessionId: string;
  incarnation: string;
  generation: number;
  startedAt: Date;
  lastSeenAt: Date;
}

const gpuIdentity = new MongoSchema<WorkerGpuIdentity>(
  {
    id: { type: String, required: true, maxlength: 128 },
    name: { type: String, required: true, maxlength: 200 },
    driverVersion: { type: String, required: true, maxlength: 100 },
    memoryBytes: {
      type: Number,
      default: null,
      min: 1,
      validate: (value: number | null) =>
        value === null || Number.isSafeInteger(value),
    },
  },
  { _id: false, strict: 'throw' },
);

export const WorkerHardwareReportSchema = new MongoSchema<WorkerHardwareReport>(
  {
    os: { type: String, required: true, maxlength: 100 },
    osBuild: { type: String, required: true, maxlength: 100 },
    architecture: { type: String, required: true, maxlength: 50 },
    cpu: { type: String, required: true, maxlength: 200 },
    memoryBytes: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    gpus: {
      type: [gpuIdentity],
      required: true,
      validate: (value: WorkerGpuIdentity[]) =>
        Array.isArray(value) && value.length >= 1 && value.length <= 8,
    },
  },
  { _id: false, strict: 'throw' },
);

export const WorkerRuntimeIdentitySchema =
  new MongoSchema<WorkerRuntimeIdentity>(
    {
      workerVersion: { type: String, required: true, maxlength: 100 },
      protocolVersion: {
        type: Number,
        required: true,
        enum: [WORKER_PROTOCOL_VERSION],
      },
      manifestDigest: {
        type: String,
        required: true,
        match: SHA256_HEX_PATTERN,
      },
      modelDigest: { type: String, required: true, match: SHA256_HEX_PATTERN },
      providerRuntimeVersion: {
        type: String,
        required: true,
        maxlength: 100,
      },
    },
    { _id: false, strict: 'throw' },
  );

export const WorkerCapabilitySchema = new MongoSchema<WorkerCapability>(
  {
    platform: { type: String, required: true, enum: WORKER_PLATFORMS },
    provider: { type: String, required: true, enum: WORKER_PROVIDERS },
    gpuId: { type: String, required: true, maxlength: 128 },
    recipeIds: {
      type: [String],
      required: true,
      enum: WORKER_RECIPE_IDS,
      validate: (value: unknown) => isBoundedStringArray(value, 16, 100),
    },
    maxSlots: {
      type: Number,
      required: true,
      min: 1,
      max: 16,
      validate: Number.isSafeInteger,
    },
  },
  { _id: false, strict: 'throw' },
);

const sessionIdentity = new MongoSchema<WorkerSessionIdentity>(
  {
    sessionId: { type: String, required: true, match: UUID_V4_PATTERN },
    incarnation: { type: String, required: true, match: UUID_V4_PATTERN },
    generation: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    startedAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
  },
  { _id: false, strict: 'throw' },
);

@Schema({
  collection: 'worker_machines',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class WorkerMachine {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: UUID_V4_PATTERN,
  })
  _id!: string;
  @Prop({ required: true, match: SHA256_HEX_PATTERN })
  credentialDigest!: string;
  @Prop({ type: Number, default: 1, min: 1, validate: Number.isSafeInteger })
  credentialRevision!: number;
  @Prop({ type: String, required: true, enum: WORKER_MACHINE_STATUSES })
  status!: WorkerMachineStatus;
  @Prop({ type: String, required: true, maxlength: 120 }) label!: string;
  @Prop({ type: String, default: null, maxlength: 100 }) groupId!:
    string | null;
  @Prop({ type: Number, default: 0, min: 0, validate: Number.isSafeInteger })
  policyRevision!: number;
  @Prop({
    type: [WorkerCapabilitySchema],
    default: [],
    validate: (value: WorkerCapability[]) =>
      Array.isArray(value) &&
      value.length <= 16 &&
      new Set(
        value.map((item) => `${item.platform}:${item.provider}:${item.gpuId}`),
      ).size === value.length,
  })
  approvedCapabilities!: WorkerCapability[];
  @Prop({ type: WorkerHardwareReportSchema, default: null })
  hardwareReport!: WorkerHardwareReport | null;
  @Prop({ type: WorkerRuntimeIdentitySchema, default: null })
  runtimeIdentity!: WorkerRuntimeIdentity | null;
  @Prop({ type: sessionIdentity, default: null })
  currentSession!: WorkerSessionIdentity | null;
  @Prop({ type: Number, default: 0, min: 0, validate: Number.isSafeInteger })
  supervisorGeneration!: number;
  @Prop({ type: Number, default: 0, min: 0, validate: Number.isSafeInteger })
  desiredRevision!: number;
  @Prop({ type: Number, default: 0, min: 0, validate: Number.isSafeInteger })
  appliedRevision!: number;
  @Prop({ type: Date, default: null }) lastSeenAt!: Date | null;
  @Prop({ type: Date, default: null }) revokedAt!: Date | null;
  @Prop({ type: Number, default: 0, min: 0, validate: Number.isSafeInteger })
  revision!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WorkerMachineSchema = SchemaFactory.createForClass(WorkerMachine);
WorkerMachineSchema.index(
  { credentialDigest: 1 },
  { unique: true, name: 'worker_machine_credential_unique' },
);
WorkerMachineSchema.index(
  { status: 1, lastSeenAt: -1, _id: 1 },
  { name: 'worker_machine_status_seen' },
);
WorkerMachineSchema.index(
  { groupId: 1, status: 1, _id: 1 },
  { name: 'worker_machine_group_status' },
);

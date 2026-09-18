import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema } from 'mongoose';
import {
  SHA256_HEX_PATTERN,
  UUID_V4_PATTERN,
  WORKER_DIAGNOSTIC_KINDS,
  isBoundedStringArray,
  type WorkerDiagnosticKind,
} from '../worker-fleet.types.js';

export interface WorkerMetric {
  name: string;
  value: number;
  unit: string;
}

export interface WorkerDiagnosticArchive {
  key: string;
  versionId: string;
  digest: string;
  bytes: number;
}

const metric = new MongoSchema<WorkerMetric>(
  {
    name: { type: String, required: true, maxlength: 100 },
    value: { type: Number, required: true, validate: Number.isFinite },
    unit: { type: String, required: true, maxlength: 30 },
  },
  { _id: false, strict: 'throw' },
);

const archive = new MongoSchema<WorkerDiagnosticArchive>(
  {
    key: { type: String, required: true, maxlength: 1024 },
    versionId: { type: String, required: true, maxlength: 1024 },
    digest: { type: String, required: true, match: SHA256_HEX_PATTERN },
    bytes: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
  },
  { _id: false, strict: 'throw' },
);

@Schema({
  collection: 'worker_diagnostics',
  strict: 'throw',
  versionKey: false,
  timestamps: { createdAt: true, updatedAt: false },
})
export class WorkerDiagnostic {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: UUID_V4_PATTERN,
  })
  _id!: string;
  @Prop({ type: String, default: null, match: UUID_V4_PATTERN })
  machineId!: string | null;
  @Prop({ type: String, default: null, match: UUID_V4_PATTERN })
  installationId!: string | null;
  @Prop({ type: String, required: true, enum: WORKER_DIAGNOSTIC_KINDS })
  kind!: WorkerDiagnosticKind;
  @Prop({
    type: Number,
    required: true,
    min: 0,
    validate: Number.isSafeInteger,
  })
  sequenceStart!: number;
  @Prop({
    type: Number,
    required: true,
    min: 0,
    validate: Number.isSafeInteger,
  })
  sequenceEnd!: number;
  @Prop({ required: true, match: SHA256_HEX_PATTERN }) digest!: string;
  @Prop({
    type: [String],
    default: [],
    validate: (value: unknown) => isBoundedStringArray(value, 100, 1000),
  })
  lines!: string[];
  @Prop({
    type: [metric],
    default: [],
    validate: (value: WorkerMetric[]) =>
      Array.isArray(value) && value.length <= 100,
  })
  metrics!: WorkerMetric[];
  @Prop({ type: archive, default: null })
  archive!: WorkerDiagnosticArchive | null;
  @Prop({ required: true }) expiresAt!: Date;
  createdAt!: Date;
}

export const WorkerDiagnosticSchema =
  SchemaFactory.createForClass(WorkerDiagnostic);
WorkerDiagnosticSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'worker_diagnostic_expiry' },
);
WorkerDiagnosticSchema.index(
  { machineId: 1, kind: 1, sequenceStart: 1 },
  {
    unique: true,
    name: 'worker_diagnostic_machine_sequence_unique',
    partialFilterExpression: {
      machineId: { $type: 'string' },
      kind: 'runtime_log',
    },
  },
);
WorkerDiagnosticSchema.index(
  { machineId: 1, createdAt: -1, _id: -1 },
  {
    name: 'worker_diagnostic_machine_history',
    partialFilterExpression: { machineId: { $type: 'string' } },
  },
);
WorkerDiagnosticSchema.index(
  { installationId: 1, sequenceStart: 1 },
  {
    unique: true,
    name: 'worker_diagnostic_installation_sequence_unique',
    partialFilterExpression: { installationId: { $type: 'string' } },
  },
);

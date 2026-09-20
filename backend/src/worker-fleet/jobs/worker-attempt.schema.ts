import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';
import type { ObjectIdentity } from '../../jobs/job.types.js';
import {
  JOB_FAILURE_CLASSES,
  type JobFailureClass,
} from '../../jobs/job-lifecycle-policy.js';
import { isSha256 } from '../../jobs/job-state.js';
import {
  UUID_V4_PATTERN,
  WORKER_ATTEMPT_STAGES,
  WORKER_ATTEMPT_STATES,
  type WorkerAttemptStage,
  type WorkerAttemptState,
} from '../worker-fleet.types.js';

export interface WorkerStageTiming {
  stage: WorkerAttemptStage;
  startedAt: Date;
  finishedAt: Date | null;
  elapsedMs: number | null;
}

export interface WorkerOutputReservation {
  key: string;
  bytes: number;
  sha256: string;
  contentType: 'audio/mpeg';
  measuredDurationSeconds: number;
  grantExpiresAt: Date;
}

const stageTiming = new MongoSchema<WorkerStageTiming>(
  {
    stage: { type: String, required: true, enum: WORKER_ATTEMPT_STAGES },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    elapsedMs: {
      type: Number,
      default: null,
      min: 0,
      validate: (value: number | null) =>
        value === null || Number.isSafeInteger(value),
    },
  },
  { _id: false, strict: 'throw' },
);

const outputObject = new MongoSchema<ObjectIdentity>(
  {
    key: { type: String, required: true, maxlength: 1024 },
    versionId: { type: String, required: true, maxlength: 1024 },
    bytes: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    sha256: { type: String, required: true, validate: isSha256 },
    contentType: { type: String, required: true, maxlength: 100 },
  },
  { _id: false, strict: 'throw' },
);

const outputReservation = new MongoSchema<WorkerOutputReservation>(
  {
    key: { type: String, required: true, maxlength: 1024 },
    bytes: {
      type: Number,
      required: true,
      min: 1,
      max: 30_000_000,
      validate: Number.isSafeInteger,
    },
    sha256: { type: String, required: true, validate: isSha256 },
    contentType: { type: String, required: true, enum: ['audio/mpeg'] },
    measuredDurationSeconds: {
      type: Number,
      required: true,
      min: 0.001,
      max: 1200,
    },
    grantExpiresAt: { type: Date, required: true },
  },
  { _id: false, strict: 'throw' },
);

@Schema({
  collection: 'worker_attempts',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class WorkerAttempt {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: UUID_V4_PATTERN,
  })
  _id!: string;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  jobId!: Types.ObjectId;
  @Prop({ required: true, immutable: true, match: UUID_V4_PATTERN })
  machineId!: string;
  @Prop({ required: true, immutable: true, match: UUID_V4_PATTERN })
  workerId!: string;
  @Prop({ required: true, immutable: true, maxlength: 128 }) gpuId!: string;
  @Prop({ required: true, immutable: true, match: UUID_V4_PATTERN })
  sessionId!: string;
  @Prop({ required: true, immutable: true, match: UUID_V4_PATTERN })
  incarnation!: string;
  @Prop({ required: true, immutable: true, match: UUID_V4_PATTERN })
  claimRequestId!: string;
  @Prop({
    type: Number,
    required: true,
    min: 1,
    validate: Number.isSafeInteger,
  })
  attemptNumber!: number;
  @Prop({ type: String, required: true, enum: WORKER_ATTEMPT_STATES })
  state!: WorkerAttemptState;
  @Prop({ type: String, required: true, enum: WORKER_ATTEMPT_STAGES })
  stage!: WorkerAttemptStage;
  @Prop({ required: true }) leaseExpiresAt!: Date;
  @Prop({ required: true, immutable: true }) deadlineAt!: Date;
  @Prop({
    type: [stageTiming],
    default: [],
    validate: (value: WorkerStageTiming[]) =>
      Array.isArray(value) && value.length <= 32,
  })
  timings!: WorkerStageTiming[];
  @Prop({ type: outputObject, default: null })
  outputObject!: ObjectIdentity | null;
  @Prop({ type: outputReservation, default: null })
  outputReservation!: WorkerOutputReservation | null;
  @Prop({ type: String, default: null, maxlength: 100 })
  terminalCode!: string | null;
  @Prop({ type: String, default: null, enum: JOB_FAILURE_CLASSES })
  failureClass!: JobFailureClass | null;
  @Prop({ type: String, default: null, maxlength: 500 })
  terminalSummary!: string | null;
  @Prop({ type: Date, default: null }) finishedAt!: Date | null;
  @Prop({ type: Number, default: 0, min: 0, validate: Number.isSafeInteger })
  revision!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WorkerAttemptSchema = SchemaFactory.createForClass(WorkerAttempt);
WorkerAttemptSchema.index(
  { machineId: 1, claimRequestId: 1 },
  { unique: true, name: 'worker_attempt_claim_request_unique' },
);
WorkerAttemptSchema.index(
  { jobId: 1, attemptNumber: 1 },
  { unique: true, name: 'worker_attempt_job_number_unique' },
);
WorkerAttemptSchema.index(
  { state: 1, leaseExpiresAt: 1, _id: 1 },
  { name: 'worker_attempt_lease_recovery' },
);
WorkerAttemptSchema.index(
  { machineId: 1, workerId: 1, createdAt: -1 },
  { name: 'worker_attempt_slot_history' },
);

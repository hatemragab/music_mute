import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema } from 'mongoose';
import { WORKER_ID_PATTERN } from './worker-registration.schema.js';
import {
  INSTALLATION_ID_PATTERN,
  PROFILE_ID_PATTERN,
  SHA256_PATTERN,
} from './dto/worker-runtime.dto.js';
import type {
  BootReportDto,
  WorkerRuntimeDto,
} from './dto/worker-runtime.dto.js';

const safeInteger = {
  type: Number,
  required: true,
  min: 1,
  max: Number.MAX_SAFE_INTEGER,
  validate: Number.isSafeInteger,
};
const reportSchema = new MongoSchema(
  {
    installationId: {
      type: String,
      required: true,
      match: INSTALLATION_ID_PATTERN,
    },
    workerBuild: safeInteger,
    launcherBuild: safeInteger,
    protocolVersion: { ...safeInteger, enum: [3] },
    profileId: { type: String, required: true, match: PROFILE_ID_PATTERN },
    modelSha256: { type: String, required: true, match: SHA256_PATTERN },
    runtimeLockSha256: { type: String, required: true, match: SHA256_PATTERN },
    os: { type: String, required: true, enum: ['windows', 'macos', 'linux'] },
    arch: { type: String, required: true, enum: ['x64', 'arm64'] },
    activity: {
      type: String,
      required: true,
      enum: [
        'starting',
        'ready',
        'busy',
        'updating',
        'paused',
        'recovery_required',
      ],
    },
    bootVerified: { type: Boolean, required: true },
  },
  { _id: false, strict: 'throw' },
);

const bootSchema = new MongoSchema(
  {
    serviceBindingSha256: {
      type: String,
      required: true,
      match: SHA256_PATTERN,
    },
    profileId: { type: String, required: true, match: PROFILE_ID_PATTERN },
    installed: { type: Boolean, required: true },
    serviceContextPassed: { type: Boolean, required: true },
    unattendedRebootPassed: { type: Boolean, required: true },
    observedBootId: { type: String, default: null, maxlength: 128 },
    observedAt: { type: String, required: true, maxlength: 35 },
    reasonCodes: { type: [String], required: true },
  },
  { _id: false, strict: 'throw' },
);

@Schema({
  collection: 'audio_worker_runtime',
  strict: 'throw',
  versionKey: false,
})
export class WorkerRuntime {
  /** Serializes rollout compatibility confirmation against changed runtime reports. */
  @Prop({ type: Number, default: 0, min: 0 }) rolloutFence!: number;
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: WORKER_ID_PATTERN,
  })
  _id!: string;
  @Prop({ type: reportSchema, required: true }) report!: WorkerRuntimeDto;
  @Prop({ type: Date, required: true }) receivedAt!: Date;
  /** Contributor-reported evidence, never an approved boot qualification. */
  @Prop({ type: bootSchema, default: null })
  reportedBoot!: BootReportDto | null;
  @Prop({ type: String, default: null, match: INSTALLATION_ID_PATTERN })
  qualificationReportId!: string | null;
  @Prop({ type: Date, default: null }) readinessReceivedAt!: Date | null;
}
export const WorkerRuntimeSchema = SchemaFactory.createForClass(WorkerRuntime);
WorkerRuntimeSchema.index(
  { receivedAt: 1, _id: 1 },
  { name: 'worker_runtime_liveness' },
);

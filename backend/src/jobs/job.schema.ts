import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';
import { AUDIO_TYPES, JOB_FAILURE_CODES, JOB_STATUSES } from './job.types.js';
import type {
  InputReservation,
  AdmissionSnapshot,
  JobStatus,
  ObjectIdentity,
  SafeJobError,
  WorkerExecutionOwnership,
  WorkerRecipeSnapshot,
  WorkerRetryEligibility,
} from './job.types.js';
import { isSha256 } from './job-state.js';
import { isAudioName, YOUTUBE_SOURCE_URL_PATTERN } from './job-metadata.js';
import {
  WORKER_RECIPE_IDS,
  WORKER_RECIPE_STEP_IDS,
} from '../worker-fleet/protocol/v1/protocol.js';

const objectIdentity = new MongoSchema<ObjectIdentity>(
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

const inputReservation = new MongoSchema<InputReservation>(
  {
    key: { type: String, required: true, maxlength: 1024 },
    extension: { type: String, required: true, enum: Object.keys(AUDIO_TYPES) },
    contentType: {
      type: String,
      required: true,
      enum: Object.values(AUDIO_TYPES),
    },
    bytes: {
      type: Number,
      required: true,
      min: 1,
      max: 50_000_000,
      validate: Number.isInteger,
    },
    durationSeconds: {
      type: Number,
      required: true,
      validate: (v: number) => Number.isFinite(v) && v > 0 && v <= 1_200,
    },
    sha256: { type: String, required: true, validate: isSha256 },
  },
  { _id: false, strict: 'throw' },
);

const admissionSnapshot = new MongoSchema<AdmissionSnapshot>(
  {
    policyVersion: { type: Number, required: true, enum: [2] },
    maxDurationSeconds: {
      type: Number,
      required: true,
      min: Number.MIN_VALUE,
      max: 1_200,
    },
    maxInputBytes: {
      type: Number,
      required: true,
      min: 1,
      max: 50_000_000,
      validate: Number.isSafeInteger,
    },
    preparationProfileId: { type: String, required: true, maxlength: 100 },
    source: {
      type: String,
      required: true,
      enum: ['audio_file', 'video_file', 'youtube'],
    },
    settingsRevision: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isSafeInteger,
    },
    maxWaitingJobs: {
      type: Number,
      required: true,
      min: 1,
      max: 100,
      validate: Number.isSafeInteger,
    },
    maxProcessingJobs: {
      type: Number,
      required: true,
      min: 1,
      max: 100,
      validate: Number.isSafeInteger,
    },
    maxInfrastructureAttempts: {
      type: Number,
      required: true,
      min: 1,
      max: 10,
      validate: Number.isSafeInteger,
    },
    maxClientInputAttempts: {
      type: Number,
      required: true,
      min: 1,
      max: 20,
      validate: Number.isSafeInteger,
    },
    reservationExpiresAt: { type: Date, required: true },
  },
  { _id: false, strict: 'throw' },
);

const safeError = new MongoSchema<SafeJobError>(
  {
    code: { type: String, required: true, enum: JOB_FAILURE_CODES },
    message: { type: String, required: true, maxlength: 200 },
    at: { type: Date, required: true },
  },
  { _id: false, strict: 'throw' },
);

const workerRecipeSnapshot = new MongoSchema<WorkerRecipeSnapshot>(
  {
    recipeId: { type: String, required: true, enum: WORKER_RECIPE_IDS },
    recipeRevision: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    protocolVersion: { type: Number, required: true, enum: [1] },
    recipeDigest: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    modelFilename: {
      type: String,
      required: true,
      enum: ['Kim_Vocal_2.onnx'],
    },
    modelDigest: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    modelBytes: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    preparationProfileId: {
      type: String,
      required: true,
      enum: ['pcm16-stereo-44100-v1'],
    },
    stepIds: {
      type: [{ type: String, enum: WORKER_RECIPE_STEP_IDS }],
      required: true,
      validate: (value: string[]) =>
        Array.isArray(value) &&
        value.length >= 4 &&
        value.length <= 6 &&
        new Set(value).size === value.length,
    },
    trimEnabled: { type: Boolean, required: true },
    denoiseEnabled: { type: Boolean, required: true },
    denoisePresetId: {
      type: String,
      enum: ['afftdn-conservative-v1', null],
      default: null,
    },
    trimProfileId: {
      type: String,
      enum: ['trim-vocal-gaps-v1', null],
      default: null,
    },
    outputFormat: { type: String, required: true, enum: ['mp3'] },
    outputBitrateKbps: { type: Number, required: true, enum: [192] },
  },
  { _id: false, strict: 'throw' },
);

const workerRetryEligibility = new MongoSchema<WorkerRetryEligibility>(
  {
    eligible: { type: Boolean, required: true },
    attemptsRemaining: {
      type: Number,
      required: true,
      min: 0,
      max: 10,
      validate: Number.isSafeInteger,
    },
    nextAttemptAt: { type: Date, default: null },
  },
  { _id: false, strict: 'throw' },
);

const workerExecutionOwnership = new MongoSchema<WorkerExecutionOwnership>(
  {
    attemptId: {
      type: String,
      required: true,
      match:
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    },
    machineId: {
      type: String,
      required: true,
      match:
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    },
    workerId: {
      type: String,
      required: true,
      match:
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    },
    sessionId: {
      type: String,
      required: true,
      match:
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    },
    incarnation: {
      type: String,
      required: true,
      match:
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    },
    leaseExpiresAt: { type: Date, required: true },
    deadlineAt: { type: Date, required: true },
  },
  { _id: false, strict: 'throw' },
);

@Schema({
  collection: 'audio_jobs',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class Job {
  _id!: Types.ObjectId;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  userId!: Types.ObjectId;
  @Prop({ required: true, immutable: true, maxlength: 36 }) requestId!: string;
  @Prop({ required: true, immutable: true, match: /^[a-f0-9]{64}$/ })
  requestHash!: string;
  @Prop({ type: MongoSchema.Types.ObjectId, default: null, immutable: true })
  retryOfJobId!: Types.ObjectId | null;
  @Prop({
    type: MongoSchema.Types.ObjectId,
    required: true,
    immutable: true,
    default: function (this: { _id: Types.ObjectId }) {
      return this._id;
    },
  })
  logicalAudioId!: Types.ObjectId;
  @Prop({ type: Number, default: 0, min: 0, validate: Number.isSafeInteger })
  uploadAttemptCount!: number;
  @Prop({
    type: String,
    default: null,
    validate: (v: string | null) => v === null || isAudioName(v),
  })
  sourceTitle!: string | null;
  @Prop({
    type: String,
    default: null,
    validate: (v: string | null) => v === null || isAudioName(v),
  })
  displayName!: string | null;
  @Prop({ type: String, default: null, enum: ['url', 'file', null] })
  sourceKind!: 'url' | 'file' | null;
  @Prop({
    type: String,
    default: null,
    maxlength: 64,
    match: YOUTUBE_SOURCE_URL_PATTERN,
  })
  sourceUrl!: string | null;
  @Prop({ type: Date, default: null }) clientStartedAt!: Date | null;
  @Prop({ type: Date, default: null }) deletedAt!: Date | null;
  @Prop({ type: Date, default: null })
  reservationCleanupScheduledAt!: Date | null;
  @Prop({ type: Date, default: null }) cleanupNextAt!: Date | null;
  @Prop({ type: Date, default: null }) cleanupLeaseUntil!: Date | null;
  @Prop({ type: String, default: null, maxlength: 36 }) cleanupToken!:
    string | null;
  @Prop({ type: Number, default: 0, min: 0, validate: Number.isSafeInteger })
  cleanupAttempts!: number;
  @Prop({ type: Date, default: null }) cleanupCompletedAt!: Date | null;
  @Prop({
    type: String,
    enum: JOB_STATUSES,
    required: true,
    default: 'awaiting_upload',
  })
  status!: JobStatus;
  @Prop({ type: inputReservation, required: true, immutable: true })
  inputReservation!: InputReservation;
  @Prop({ type: admissionSnapshot, default: null, immutable: true })
  admissionSnapshot!: AdmissionSnapshot | null;
  @Prop({ type: objectIdentity, default: null })
  inputObject!: ObjectIdentity | null;
  @Prop({ type: Date, default: null })
  confirmedUploadAccountedAt!: Date | null;
  @Prop({ type: String, default: null, match: /^\d{4}-\d{2}$/ })
  confirmedUploadPeriodKey!: string | null;
  @Prop({
    type: Number,
    default: null,
    min: 1,
    validate: (value: number | null) =>
      value === null || Number.isSafeInteger(value),
  })
  confirmedUploadBytes!: number | null;
  @Prop({ type: objectIdentity, default: null })
  outputObject!: ObjectIdentity | null;
  @Prop({ type: Date, default: null })
  retainedOutputAccountedAt!: Date | null;
  @Prop({ type: Date, default: null })
  retainedOutputReleasedAt!: Date | null;
  @Prop({ type: workerRecipeSnapshot, default: null, immutable: true })
  recipeSnapshot!: WorkerRecipeSnapshot | null;
  @Prop({ type: workerRetryEligibility, default: null })
  retryEligibility!: WorkerRetryEligibility | null;
  @Prop({ type: Number, default: 0, min: 0, validate: Number.isSafeInteger })
  attemptNumber!: number;
  @Prop({ type: workerExecutionOwnership, default: null })
  currentExecution!: WorkerExecutionOwnership | null;
  @Prop({ type: Date, default: null }) queuedAt!: Date | null;
  @Prop({ type: safeError, default: null }) lastError!: SafeJobError | null;
  @Prop({ type: Date, default: null }) finishedAt!: Date | null;
  @Prop({ type: Date, default: null }) validatingAt!: Date | null;
  @Prop({ type: Date, default: null }) processingStartedAt!: Date | null;
  @Prop({ type: Date, default: null }) processingFinishedAt!: Date | null;
  @Prop({
    type: Number,
    default: null,
    validate: (value: number | null) =>
      value === null || (Number.isFinite(value) && value > 0 && value <= 1_200),
  })
  measuredDurationSeconds!: number | null;
  @Prop({ type: Date, default: null }) uploadingResultAt!: Date | null;
  @Prop({ type: Date, default: null })
  processingIntervalStartedAt!: Date | null;
  @Prop({ type: Date, default: null }) processingObservedAt!: Date | null;
  @Prop({
    type: Number,
    default: null,
    min: 0,
    validate: (v: number | null) => v === null || Number.isSafeInteger(v),
  })
  processingAccumulatedMs!: number | null;
  @Prop({ type: Boolean, default: false })
  processingElapsedApproximate!: boolean;
  @Prop({ min: 0, default: 0, validate: Number.isSafeInteger })
  revision!: number;
  @Prop({ type: Number, min: 0, default: 0, validate: Number.isSafeInteger })
  adminRevision!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export const JobSchema = SchemaFactory.createForClass(Job);
// Keep the public administrative CAS authority synchronized across document and query writers.
// Save uses the driver collection directly, so it does not also invoke query middleware.
const adminVisibleFields = new Set([
  'revision',
  'status',
  'deletedAt',
  'inputObject',
  'outputObject',
  'admissionSnapshot',
  'displayName',
  'sourceTitle',
  'sourceUrl',
  'queuedAt',
  'finishedAt',
  'validatingAt',
  'processingStartedAt',
  'processingFinishedAt',
  'measuredDurationSeconds',
  'uploadingResultAt',
  'lastError',
  'recipeSnapshot',
  'retryEligibility',
  'attemptNumber',
  'currentExecution',
]);
JobSchema.pre('save', function () {
  if (
    !this.isNew &&
    this.modifiedPaths().some((path) =>
      adminVisibleFields.has(path.split('.')[0]!),
    )
  )
    this.adminRevision = (this.adminRevision ?? 0) + 1;
});
for (const method of ['updateOne', 'updateMany', 'findOneAndUpdate'] as const) {
  JobSchema.pre(method, function () {
    const update = this.getUpdate();
    if (!update) return;
    if (Array.isArray(update))
      throw new Error('Job lifecycle writes require explicit update operators');
    const paths = Object.entries(update).flatMap(([key, value]) =>
      key.startsWith('$') && value && typeof value === 'object'
        ? Object.keys(value)
        : [key],
    );
    if (paths.some((path) => adminVisibleFields.has(path.split('.')[0]!))) {
      update.$inc = { ...update.$inc, adminRevision: 1 };
      this.setUpdate(update);
    }
  });
}
JobSchema.index({ createdAt: -1, _id: -1 }, { name: 'admin_jobs_created' });
JobSchema.index({ finishedAt: -1, _id: -1 }, { name: 'admin_jobs_finished' });
JobSchema.index(
  { status: 1, createdAt: -1, _id: -1 },
  { name: 'admin_jobs_status_created' },
);
JobSchema.index(
  { userId: 1, requestId: 1 },
  { unique: true, name: 'jobs_owner_request_unique' },
);
JobSchema.index(
  { userId: 1, createdAt: -1, _id: -1 },
  { name: 'jobs_owner_history' },
);
JobSchema.index({ userId: 1, status: 1 }, { name: 'jobs_owner_running' });
JobSchema.index(
  {
    status: 1,
    reservationCleanupScheduledAt: 1,
    'admissionSnapshot.reservationExpiresAt': 1,
  },
  { name: 'jobs_expired_upload_cleanup' },
);
JobSchema.index(
  { status: 1, reservationCleanupScheduledAt: 1, finishedAt: 1, _id: 1 },
  { name: 'jobs_terminal_input_cleanup' },
);
JobSchema.index(
  { cleanupNextAt: 1, cleanupLeaseUntil: 1 },
  {
    name: 'jobs_cleanup_due',
    partialFilterExpression: { deletedAt: { $type: 'date' } },
  },
);
JobSchema.index(
  {
    status: 1,
    queuedAt: 1,
    'recipeSnapshot.recipeId': 1,
    'currentExecution.attemptId': 1,
    _id: 1,
  },
  { name: 'jobs_worker_claim_eligibility' },
);
JobSchema.index(
  { 'currentExecution.leaseExpiresAt': 1, _id: 1 },
  {
    name: 'jobs_worker_lease_expiry',
    partialFilterExpression: {
      'currentExecution.leaseExpiresAt': { $type: 'date' },
    },
  },
);
JobSchema.index(
  { 'currentExecution.attemptId': 1 },
  {
    unique: true,
    name: 'jobs_worker_attempt_unique',
    partialFilterExpression: {
      'currentExecution.attemptId': { $type: 'string' },
    },
  },
);

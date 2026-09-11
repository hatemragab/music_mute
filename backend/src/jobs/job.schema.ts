import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema, type Types } from 'mongoose';
import { AUDIO_TYPES, JOB_FAILURE_CODES, JOB_STATUSES } from './job.types.js';
import type {
  InputReservation,
  AdmissionSnapshot,
  JobStatus,
  ObjectIdentity,
  OutputReservation,
  SafeJobError,
} from './job.types.js';
import { isSha256 } from './job-state.js';
import { isAudioName, YOUTUBE_SOURCE_URL_PATTERN } from './job-metadata.js';

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
      max: 29_999_999,
      validate: Number.isInteger,
    },
    durationSeconds: {
      type: Number,
      required: true,
      validate: (v: number) => Number.isFinite(v) && v > 0 && v < 600,
    },
    sha256: { type: String, required: true, validate: isSha256 },
  },
  { _id: false, strict: 'throw' },
);

const admissionSnapshot = new MongoSchema<AdmissionSnapshot>(
  {
    settingsRevision: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isSafeInteger,
    },
    maxInputBytesExclusive: {
      type: Number,
      required: true,
      min: 2,
      max: 30_000_000,
      validate: Number.isSafeInteger,
    },
    maxDurationSecondsExclusive: {
      type: Number,
      required: true,
      min: Number.MIN_VALUE,
      max: 600,
    },
    maxActiveJobsPerUser: {
      type: Number,
      default: null,
      min: 1,
      max: 100,
      validate: (value: number | null) =>
        value === null || Number.isSafeInteger(value),
    },
    reservationExpiresAt: { type: Date, required: true },
  },
  { _id: false, strict: 'throw' },
);

export const OutputReservationSchema = new MongoSchema<OutputReservation>(
  {
    key: { type: String, required: true, maxlength: 1024 },
    attemptId: { type: String, required: true, maxlength: 36 },
    bytes: {
      type: Number,
      required: true,
      min: 1,
      max: 99_999_999,
      validate: Number.isInteger,
    },
    durationSeconds: {
      type: Number,
      required: true,
      validate: (v: number) => Number.isFinite(v) && v > 0 && v < 600,
    },
    sha256: { type: String, required: true, validate: isSha256 },
    contentType: { type: String, required: true, enum: ['audio/mpeg'] },
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

@Schema({
  collection: 'audio_jobs',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class Job {
  _id!: Types.ObjectId;
  @Prop({ type: String, default: null, match: /^[a-z0-9][a-z0-9-]{0,63}$/ })
  workerId!: string | null;
  @Prop({ type: MongoSchema.Types.ObjectId, required: true, immutable: true })
  userId!: Types.ObjectId;
  @Prop({ required: true, immutable: true, maxlength: 36 }) requestId!: string;
  @Prop({ required: true, immutable: true, match: /^[a-f0-9]{64}$/ })
  requestHash!: string;
  @Prop({ type: MongoSchema.Types.ObjectId, default: null, immutable: true })
  retryOfJobId!: Types.ObjectId | null;
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
  @Prop({ type: Date, default: null }) cleanupNextAt!: Date | null;
  @Prop({ type: Date, default: null }) cleanupLeaseUntil!: Date | null;
  @Prop({ type: String, default: null, maxlength: 36 }) cleanupToken!:
    string | null;
  @Prop({ type: Number, default: 0, min: 0, validate: Number.isSafeInteger })
  cleanupAttempts!: number;
  @Prop({ type: MongoSchema.Types.ObjectId, default: null })
  cleanupCursor!: Types.ObjectId | null;
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
  @Prop({ type: admissionSnapshot, default: null })
  admissionSnapshot!: AdmissionSnapshot | null;
  @Prop({ type: objectIdentity, default: null })
  inputObject!: ObjectIdentity | null;
  @Prop({ type: OutputReservationSchema, default: null })
  outputReservation!: OutputReservation | null;
  @Prop({ type: objectIdentity, default: null })
  outputObject!: ObjectIdentity | null;
  @Prop({ type: BigInt, default: null }) queueOrder!: bigint | null;
  @Prop({ type: Date, default: null }) queuedAt!: Date | null;
  @Prop({ type: String, default: null, maxlength: 36 }) attemptId!:
    string | null;
  @Prop({ type: String, default: null, maxlength: 36 }) sessionId!:
    string | null;
  @Prop({ min: 0, default: 0, validate: Number.isSafeInteger })
  generation!: number;
  @Prop({ type: Date, default: null }) leaseExpiresAt!: Date | null;
  @Prop({ type: safeError, default: null }) lastError!: SafeJobError | null;
  @Prop({ type: Date, default: null }) finishedAt!: Date | null;
  @Prop({ type: Date, default: null }) validatingAt!: Date | null;
  @Prop({ type: Date, default: null }) processingStartedAt!: Date | null;
  @Prop({ type: Date, default: null }) processingFinishedAt!: Date | null;
  @Prop({
    type: Number,
    default: null,
    validate: (value: number | null) =>
      value === null || (Number.isFinite(value) && value > 0 && value < 600),
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
  'workerId',
  'attemptId',
  'sessionId',
  'generation',
  'inputObject',
  'outputObject',
  'outputReservation',
  'admissionSnapshot',
  'displayName',
  'sourceTitle',
  'sourceUrl',
  'queuedAt',
  'queueOrder',
  'finishedAt',
  'validatingAt',
  'processingStartedAt',
  'processingFinishedAt',
  'measuredDurationSeconds',
  'uploadingResultAt',
  'lastError',
  'leaseExpiresAt',
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
  { workerId: 1, createdAt: -1, _id: -1 },
  { name: 'admin_jobs_worker_created' },
);
JobSchema.index(
  { userId: 1, requestId: 1 },
  { unique: true, name: 'jobs_owner_request_unique' },
);
JobSchema.index(
  { userId: 1, createdAt: -1, _id: -1 },
  { name: 'jobs_owner_history' },
);
JobSchema.index({ status: 1, queueOrder: 1 }, { name: 'jobs_fifo' });
JobSchema.index(
  { cleanupNextAt: 1, cleanupLeaseUntil: 1 },
  {
    name: 'jobs_cleanup_due',
    partialFilterExpression: { deletedAt: { $type: 'date' } },
  },
);

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongoSchema } from 'mongoose';
import type { ObjectIdentity } from '../../jobs/job.types.js';
import { isSha256 } from '../../jobs/job-state.js';
import {
  SHA256_HEX_PATTERN,
  UUID_V4_PATTERN,
  WORKER_INSTALLATION_PHASES,
  type WorkerInstallationPhase,
} from '../worker-fleet.types.js';
import {
  WorkerCapabilitySchema,
  WorkerHardwareReportSchema,
  WorkerRuntimeIdentitySchema,
  type WorkerCapability,
  type WorkerHardwareReport,
  type WorkerRuntimeIdentity,
} from '../machines/worker-machine.schema.js';

export const WORKER_INVITATION_STATES = [
  'active',
  'consumed',
  'expired',
  'revoked',
] as const;
export type WorkerInvitationState = (typeof WORKER_INVITATION_STATES)[number];

export interface WorkerQualificationReservation {
  key: string;
  bytes: number;
  sha256: string;
  contentType: 'audio/mpeg';
}

const qualificationReservation =
  new MongoSchema<WorkerQualificationReservation>(
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
    },
    { _id: false, strict: 'throw' },
  );

const qualificationObject = new MongoSchema<ObjectIdentity>(
  {
    key: { type: String, required: true, maxlength: 1024 },
    versionId: { type: String, required: true, maxlength: 1024 },
    bytes: {
      type: Number,
      required: true,
      min: 1,
      max: 30_000_000,
      validate: Number.isSafeInteger,
    },
    sha256: { type: String, required: true, validate: isSha256 },
    contentType: { type: String, required: true, enum: ['audio/mpeg'] },
  },
  { _id: false, strict: 'throw' },
);

@Schema({
  collection: 'worker_enrollment_invitations',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class WorkerEnrollmentInvitation {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: UUID_V4_PATTERN,
  })
  _id!: string;
  @Prop({ required: true, immutable: true, match: SHA256_HEX_PATTERN })
  codeDigest!: string;
  @Prop({ required: true, immutable: true, maxlength: 128 })
  createdByUid!: string;
  @Prop({ type: String, default: null, maxlength: 100 })
  initialPolicyId!: string | null;
  @Prop({ type: String, required: true, enum: WORKER_INVITATION_STATES })
  state!: WorkerInvitationState;
  @Prop({ required: true, immutable: true }) expiresAt!: Date;
  @Prop({ type: Date, default: null }) consumedAt!: Date | null;
  @Prop({ type: Date, default: null }) revokedAt!: Date | null;
  @Prop({
    type: Number,
    default: 0,
    min: 0,
    max: 1,
    validate: Number.isSafeInteger,
  })
  useCount!: number;
  @Prop({ type: String, default: null, match: UUID_V4_PATTERN })
  exchangeRequestId!: string | null;
  @Prop({ type: String, default: null, match: UUID_V4_PATTERN })
  installationSessionId!: string | null;
  @Prop({ type: Number, default: 0, min: 0, validate: Number.isSafeInteger })
  revision!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WorkerEnrollmentInvitationSchema = SchemaFactory.createForClass(
  WorkerEnrollmentInvitation,
);
WorkerEnrollmentInvitationSchema.index(
  { codeDigest: 1 },
  { unique: true, name: 'worker_invitation_digest_unique' },
);
WorkerEnrollmentInvitationSchema.index(
  { state: 1, expiresAt: 1 },
  { name: 'worker_invitation_lifecycle' },
);

@Schema({
  collection: 'worker_installation_sessions',
  strict: 'throw',
  versionKey: false,
  timestamps: true,
})
export class WorkerInstallationSession {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    match: UUID_V4_PATTERN,
  })
  _id!: string;
  @Prop({ required: true, immutable: true, match: UUID_V4_PATTERN })
  invitationId!: string;
  @Prop({ required: true, immutable: true, match: SHA256_HEX_PATTERN })
  credentialDigest!: string;
  @Prop({ required: true, immutable: true, match: UUID_V4_PATTERN })
  exchangeRequestId!: string;
  @Prop({ type: String, required: true, enum: WORKER_INSTALLATION_PHASES })
  phase!: WorkerInstallationPhase;
  @Prop({ type: String, default: null, maxlength: 100 })
  outcomeCode!: string | null;
  @Prop({ type: Number, default: 0, min: 0, validate: Number.isSafeInteger })
  acknowledgedSequence!: number;
  @Prop({ type: Date, default: null }) lastSeenAt!: Date | null;
  @Prop({ type: String, default: null, maxlength: 2000 })
  reportSummary!: string | null;
  @Prop({ type: String, default: null, match: SHA256_HEX_PATTERN })
  reportDigest!: string | null;
  @Prop({ type: String, default: null, match: UUID_V4_PATTERN })
  reportRequestId!: string | null;
  @Prop({ type: qualificationReservation, default: null })
  qualificationReservation!: WorkerQualificationReservation | null;
  @Prop({ type: qualificationObject, default: null })
  qualificationObject!: ObjectIdentity | null;
  @Prop({ type: String, default: null, match: UUID_V4_PATTERN })
  qualificationGrantRequestId!: string | null;
  @Prop({ type: String, default: null, match: UUID_V4_PATTERN })
  qualificationConfirmRequestId!: string | null;
  @Prop({ type: String, default: null, maxlength: 120 }) label!: string | null;
  @Prop({ type: String, default: null, maxlength: 100 }) groupId!:
    string | null;
  @Prop({ type: WorkerHardwareReportSchema, default: null })
  hardwareReport!: WorkerHardwareReport | null;
  @Prop({ type: WorkerRuntimeIdentitySchema, default: null })
  runtimeIdentity!: WorkerRuntimeIdentity | null;
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
  capabilities!: WorkerCapability[];
  @Prop({ type: String, default: null, match: UUID_V4_PATTERN })
  machineId!: string | null;
  @Prop({ type: String, default: null, match: UUID_V4_PATTERN })
  activationRequestId!: string | null;
  @Prop({ type: Date, default: null }) activatedAt!: Date | null;
  @Prop({ type: Date, default: null }) revokedAt!: Date | null;
  @Prop({ required: true, immutable: true }) expiresAt!: Date;
  @Prop({ type: Number, default: 0, min: 0, validate: Number.isSafeInteger })
  revision!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WorkerInstallationSessionSchema = SchemaFactory.createForClass(
  WorkerInstallationSession,
);
WorkerInstallationSessionSchema.index(
  { invitationId: 1 },
  { unique: true, name: 'worker_installation_invitation_unique' },
);
WorkerInstallationSessionSchema.index(
  { credentialDigest: 1 },
  { unique: true, name: 'worker_installation_credential_unique' },
);
WorkerInstallationSessionSchema.index(
  { phase: 1, expiresAt: 1 },
  { name: 'worker_installation_lifecycle' },
);

import { Schema } from 'mongoose';
import type {
  PublicationReceipt,
  WorkerReleaseTarget,
} from './publication-receipt.js';
export interface WorkerRelease {
  _id: string;
  revision: number;
  state: 'draft' | 'published' | 'withdrawn';
  metadata: PublicationReceipt;
  buildNumber: number;
}
export interface WorkerGroup {
  _id: string;
  revision: number;
  fence: number;
  label: string;
  workerIds: string[];
}
export interface ReleasePolicy {
  _id: string;
  revision: number;
  fence: number;
  maximumBuild: number;
  stableReleaseId: string | null;
}
export interface WorkerRollout {
  _id: string;
  revision: number;
  paused: boolean;
  releaseId: string;
  workerIds: string[];
  groupRevisions: Record<string, number>;
  createdAt: Date;
}
export interface WorkerUpdatePolicy {
  _id: string;
  revision: number;
  rolloutId: string;
  target: WorkerReleaseTarget;
  minimumClaimBuild: number;
  allowedFallbackReleaseIds: string[];
  stage: string;
  paused: boolean;
  runningAt: Date | null;
  verifiedAttemptId: string | null;
  observedBuild: number | null;
  receivedAt: Date | null;
  eventId: string | null;
  eventHash: string | null;
}
const options = (collection: string) => ({
  collection,
  strict: 'throw' as const,
  versionKey: false as const,
});
const id = { type: String, required: true };
const revision = {
  type: Number,
  required: true,
  default: 0,
  min: 0,
  validate: Number.isSafeInteger,
};
export const WorkerReleaseSchema = new Schema<WorkerRelease>(
  {
    _id: id,
    revision,
    state: {
      type: String,
      enum: ['draft', 'published', 'withdrawn'],
      required: true,
    },
    metadata: { type: Schema.Types.Mixed, required: true },
    buildNumber: { type: Number, required: true },
  },
  options('worker_releases'),
);
WorkerReleaseSchema.index({ buildNumber: 1 }, { unique: true });
export const WorkerGroupSchema = new Schema<WorkerGroup>(
  {
    _id: id,
    revision,
    fence: { type: Number, default: 0 },
    label: { type: String, required: true, maxlength: 100 },
    workerIds: { type: [String], required: true },
  },
  options('worker_groups'),
);
export const ReleasePolicySchema = new Schema<ReleasePolicy>(
  {
    _id: id,
    revision,
    fence: { type: Number, default: 0 },
    maximumBuild: { type: Number, default: 0 },
    stableReleaseId: { type: String, default: null },
  },
  options('worker_release_policy'),
);
export const WorkerRolloutSchema = new Schema<WorkerRollout>(
  {
    _id: id,
    revision,
    paused: { type: Boolean, default: false },
    releaseId: id,
    workerIds: { type: [String], required: true },
    groupRevisions: { type: Schema.Types.Mixed, required: true },
    createdAt: { type: Date, required: true },
  },
  options('worker_rollouts'),
);
export const WorkerUpdatePolicySchema = new Schema<WorkerUpdatePolicy>(
  {
    _id: id,
    revision,
    rolloutId: id,
    target: { type: Schema.Types.Mixed, required: true },
    minimumClaimBuild: { type: Number, required: true },
    allowedFallbackReleaseIds: { type: [String], required: true },
    stage: { type: String, required: true },
    paused: { type: Boolean, default: false },
    runningAt: { type: Date, default: null },
    verifiedAttemptId: { type: String, default: null },
    observedBuild: { type: Number, default: null },
    receivedAt: { type: Date, default: null },
    eventId: { type: String, default: null },
    eventHash: { type: String, default: null },
  },
  options('worker_update_policy'),
);
WorkerUpdatePolicySchema.index({ rolloutId: 1, _id: 1 });
export const WORKER_RELEASE_MODELS = [
  { name: 'WorkerRelease', schema: WorkerReleaseSchema },
  { name: 'WorkerGroup', schema: WorkerGroupSchema },
  { name: 'ReleasePolicy', schema: ReleasePolicySchema },
  { name: 'WorkerRollout', schema: WorkerRolloutSchema },
  { name: 'WorkerUpdatePolicy', schema: WorkerUpdatePolicySchema },
];

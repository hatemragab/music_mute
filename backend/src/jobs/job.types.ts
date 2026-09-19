export type InputSource = 'audio_file' | 'video_file' | 'youtube';
export const PREPARATION_PROFILE_ID = 'preserve-or-aac-lc-256-v1';
export const JOB_STATUSES = [
  'awaiting_upload',
  'queued',
  'validating',
  'processing',
  'uploading_result',
  'interrupted',
  'cancel_requested',
  'ready',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const AUDIO_TYPES = {
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  webm: 'audio/webm',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
} as const;
export interface InputDeclaration {
  extension: keyof typeof AUDIO_TYPES;
  contentType: string;
  bytes: number;
  durationSeconds: number;
  sha256: string;
}
export interface InputReservation extends InputDeclaration {
  key: string;
}
export interface AdmissionSnapshot {
  policyVersion: 2;
  maxDurationSeconds: number;
  maxInputBytes: number;
  preparationProfileId: string;
  source: InputSource;

  settingsRevision: number;
  maxActiveJobsPerUser: number | null;
  reservationExpiresAt: Date;
}
export interface ObjectIdentity {
  key: string;
  versionId: string;
  bytes: number;
  sha256: string;
  contentType: string;
}
export interface UploadGrant {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}
export interface DownloadGrant {
  url: string;
  expiresAt: string;
}

export const JOB_FAILURE_CODES = [
  'UPLOAD_EXPIRED',
  'INVALID_AUDIO',
  'INPUT_TOO_LONG',
  'INPUT_CHECKSUM_MISMATCH',
  'SEPARATOR_FAILED',
  'OUTPUT_INVALID',
  'DOWNLOAD_FAILED',
  'OUTPUT_UPLOAD_FAILED',
] as const;
export type JobFailureCode = (typeof JOB_FAILURE_CODES)[number];
export interface SafeJobError {
  code: JobFailureCode;
  message: string;
  at: Date;
}

export interface WorkerRecipeSnapshot {
  recipeId: 'kim-vocal-2-v1';
  recipeRevision: number;
  protocolVersion: 1;
  modelDigest: string;
  modelBytes: number;
  trimEnabled: boolean;
  denoiseEnabled: boolean;
  outputFormat: 'mp3';
  outputBitrateKbps: 192;
}

export interface WorkerRetryEligibility {
  eligible: boolean;
  attemptsRemaining: number;
  nextAttemptAt: Date | null;
}

export interface WorkerExecutionOwnership {
  attemptId: string;
  machineId: string;
  workerId: string;
  sessionId: string;
  incarnation: string;
  leaseExpiresAt: Date;
  deadlineAt: Date;
}

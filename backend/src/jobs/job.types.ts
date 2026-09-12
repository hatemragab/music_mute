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
  settingsRevision: number;
  maxInputBytesExclusive: number;
  maxDurationSecondsExclusive: number;
  maxActiveJobsPerUser: number | null;
  reservationExpiresAt: Date;
}
export interface OutputReservation {
  key: string;
  bytes: number;
  durationSeconds: number;
  sha256: string;
  contentType: 'audio/mpeg';
  attemptId: string;
}
export interface ObjectIdentity {
  key: string;
  versionId: string;
  bytes: number;
  sha256: string;
  contentType: string;
}
export interface WorkerSelector {
  jobId: string;
  attemptId: string;
  sessionId: string;
  generation: number;
}
export interface WorkerAssignment extends WorkerSelector {
  leaseExpiresAt: string;
}
export interface WorkerEvent extends WorkerSelector {
  eventId: string;
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
export const WORKER_FAILURE_CODES = [
  'INVALID_AUDIO',
  'INPUT_TOO_LONG',
  'INPUT_CHECKSUM_MISMATCH',
  'SEPARATOR_FAILED',
  'OUTPUT_INVALID',
  'DOWNLOAD_FAILED',
  'OUTPUT_UPLOAD_FAILED',
] as const satisfies readonly JobFailureCode[];
export type WorkerFailureCode = (typeof WORKER_FAILURE_CODES)[number];
export interface SafeJobError {
  code: JobFailureCode;
  message: string;
  at: Date;
}

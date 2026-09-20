export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export const WORKER_MACHINE_STATUSES = [
  'pending',
  'active',
  'paused',
  'draining',
  'revoked',
] as const;
export type WorkerMachineStatus = (typeof WORKER_MACHINE_STATUSES)[number];

export const WORKER_INSTALLATION_PHASES = [
  'restricted',
  'reported',
  'activated',
  'failed',
  'expired',
  'revoked',
] as const;
export type WorkerInstallationPhase =
  (typeof WORKER_INSTALLATION_PHASES)[number];

export const WORKER_SLOT_STATES = [
  'offline',
  'idle',
  'reserved',
  'busy',
  'draining',
  'failed',
] as const;
export type WorkerSlotState = (typeof WORKER_SLOT_STATES)[number];

export const WORKER_ATTEMPT_STATES = [
  'claimed',
  'running',
  'uploading',
  'succeeded',
  'failed',
  'lost',
  'cancelled',
] as const;
export type WorkerAttemptState = (typeof WORKER_ATTEMPT_STATES)[number];

export const WORKER_ATTEMPT_STAGES = [
  'claimed',
  'downloading',
  'validating',
  'separating',
  'trimming',
  'denoising',
  'encoding',
  'uploading',
  'finalizing',
] as const;
export type WorkerAttemptStage = (typeof WORKER_ATTEMPT_STAGES)[number];

export const WORKER_DIAGNOSTIC_KINDS = [
  'installation_log',
  'runtime_log',
  'heartbeat',
  'doctor',
  'benchmark',
] as const;
export type WorkerDiagnosticKind = (typeof WORKER_DIAGNOSTIC_KINDS)[number];

export function isBoundedStringArray(
  value: unknown,
  maxItems: number,
  maxLength: number,
): boolean {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every(
      (item) =>
        typeof item === 'string' && item.length > 0 && item.length <= maxLength,
    )
  );
}

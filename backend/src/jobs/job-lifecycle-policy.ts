import {
  JOB_FAILURE_CODES,
  JOB_STATUSES,
  type JobFailureCode,
  type JobStatus,
} from './job.types.js';

export const JOB_CAPACITY_GROUPS = [
  'preparing',
  'queued',
  'processing',
  'terminal',
] as const;
export type JobCapacityGroup = (typeof JOB_CAPACITY_GROUPS)[number];

export const JOB_CAPACITY_GROUP_BY_STATUS = Object.freeze({
  awaiting_upload: 'preparing',
  queued: 'queued',
  validating: 'processing',
  processing: 'processing',
  uploading_result: 'processing',
  interrupted: 'processing',
  cancel_requested: 'processing',
  ready: 'terminal',
  failed: 'terminal',
  cancelled: 'terminal',
} satisfies Record<JobStatus, JobCapacityGroup>);

export const PREPARING_CAPACITY_STATUSES = ['awaiting_upload'] as const;
export const QUEUED_CAPACITY_STATUSES = ['queued'] as const;
export const WAITING_CAPACITY_STATUSES: readonly JobStatus[] = [
  ...PREPARING_CAPACITY_STATUSES,
  ...QUEUED_CAPACITY_STATUSES,
];
export const PROCESSING_CAPACITY_STATUSES: readonly JobStatus[] = [
  'validating',
  'processing',
  'uploading_result',
  'interrupted',
  'cancel_requested',
];
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  'ready',
  'failed',
  'cancelled',
];
export const ACTIVE_ADMISSION_STATUSES: readonly JobStatus[] = [
  ...WAITING_CAPACITY_STATUSES,
  ...PROCESSING_CAPACITY_STATUSES,
];

export function capacityGroupForStatus(status: JobStatus): JobCapacityGroup {
  return JOB_CAPACITY_GROUP_BY_STATUS[status];
}

export type ProcessingSettlement = 'preserve' | 'consume' | 'release' | 'none';

export function settlementForStatus(status: JobStatus): ProcessingSettlement {
  if (status === 'ready') return 'consume';
  if (status === 'failed' || status === 'cancelled') return 'release';
  return 'preserve';
}

export const JOB_FAILURE_CLASSES = [
  'infrastructure_transient',
  'infrastructure_terminal',
  'client_input',
  'user_action',
  'policy',
] as const;
export type JobFailureClass = (typeof JOB_FAILURE_CLASSES)[number];

export const SERVER_LIFECYCLE_FAILURE_SOURCES = [
  'LEASE_EXPIRED',
  'USER_CANCELLED',
  'ACCOUNT_DELETED',
  'PROCESSING_QUOTA_DENIED',
  'ACCOUNT_RESTRICTED',
  'ACCOUNT_DELETING',
  'QUEUE_FULL',
] as const;
export type ServerLifecycleFailureSource =
  (typeof SERVER_LIFECYCLE_FAILURE_SOURCES)[number];
export type JobFailureSource = JobFailureCode | ServerLifecycleFailureSource;

export const JOB_FAILURE_SOURCES: readonly JobFailureSource[] = [
  ...JOB_FAILURE_CODES,
  ...SERVER_LIFECYCLE_FAILURE_SOURCES,
];

export type TemporaryObjectAction = 'preserve_for_retry' | 'cleanup' | 'none';
export type PublicFailureAction =
  'retry_automatically' | 'replace_input' | 'retry_later' | 'none';

interface FailureDefinition {
  classification: JobFailureClass;
  mayRetryInfrastructure: boolean;
  settlement: ProcessingSettlement;
  cleanup: TemporaryObjectAction;
  publicFailureCode: JobFailureCode | null;
  publicMessage: string | null;
  publicAction: PublicFailureAction;
}

export interface InfrastructureRetryContext {
  retryEligible: boolean;
  attemptsRemaining: number;
  attemptNumber: number;
  maxAttempts: number;
}

export interface JobFailureResolution extends FailureDefinition {
  source: JobFailureSource;
  automaticRetry: boolean;
}

export const SAFE_JOB_FAILURE_MESSAGES: Readonly<
  Record<JobFailureCode, string>
> = Object.freeze({
  UPLOAD_EXPIRED: 'The upload reservation expired before it was completed.',
  INVALID_AUDIO: 'The file does not contain supported playable audio.',
  INPUT_TOO_LONG: 'Audio must be 20 minutes or less.',
  INPUT_CHECKSUM_MISMATCH: 'The audio file failed its integrity check.',
  SEPARATOR_FAILED: 'Voice separation failed. You can retry this job.',
  OUTPUT_INVALID: 'The voice-only result could not be validated.',
  DOWNLOAD_FAILED: 'The audio could not be downloaded for processing.',
  OUTPUT_UPLOAD_FAILED: 'The processed result could not be uploaded.',
});

const definitions = Object.freeze({
  UPLOAD_EXPIRED: clientInput('UPLOAD_EXPIRED'),
  INVALID_AUDIO: clientInput('INVALID_AUDIO'),
  INPUT_TOO_LONG: clientInput('INPUT_TOO_LONG'),
  INPUT_CHECKSUM_MISMATCH: clientInput('INPUT_CHECKSUM_MISMATCH'),
  SEPARATOR_FAILED: infrastructureTransient('SEPARATOR_FAILED'),
  OUTPUT_INVALID: infrastructureTerminal('OUTPUT_INVALID'),
  DOWNLOAD_FAILED: infrastructureTransient('DOWNLOAD_FAILED'),
  OUTPUT_UPLOAD_FAILED: infrastructureTransient('OUTPUT_UPLOAD_FAILED'),
  LEASE_EXPIRED: infrastructureTransient(
    'SEPARATOR_FAILED',
    'Processing worker became unavailable.',
  ),
  USER_CANCELLED: userAction(),
  ACCOUNT_DELETED: userAction(),
  PROCESSING_QUOTA_DENIED: policyFailure(),
  ACCOUNT_RESTRICTED: policyFailure(),
  ACCOUNT_DELETING: policyFailure(),
  QUEUE_FULL: policyFailure(),
} satisfies Record<JobFailureSource, FailureDefinition>);

export function resolveJobFailure(
  source: JobFailureSource,
  retryContext?: InfrastructureRetryContext,
): JobFailureResolution {
  const definition = definitions[source];
  if (!definition.mayRetryInfrastructure)
    return { source, ...definition, automaticRetry: false };
  if (!retryContext)
    throw new TypeError('Infrastructure retry context is required');
  assertRetryContext(retryContext);
  const automaticRetry =
    retryContext.retryEligible &&
    retryContext.attemptsRemaining > 1 &&
    retryContext.attemptNumber < retryContext.maxAttempts;
  if (automaticRetry) return { source, ...definition, automaticRetry: true };
  return {
    source,
    ...definition,
    classification: 'infrastructure_terminal',
    mayRetryInfrastructure: false,
    settlement: 'release',
    cleanup: 'cleanup',
    publicAction: 'retry_later',
    automaticRetry: false,
  };
}

export function safeJobFailureMessage(code: JobFailureCode): string {
  return SAFE_JOB_FAILURE_MESSAGES[code];
}

function infrastructureTransient(
  publicFailureCode: JobFailureCode,
  publicMessage = SAFE_JOB_FAILURE_MESSAGES[publicFailureCode],
): FailureDefinition {
  return {
    classification: 'infrastructure_transient',
    mayRetryInfrastructure: true,
    settlement: 'preserve',
    cleanup: 'preserve_for_retry',
    publicFailureCode,
    publicMessage,
    publicAction: 'retry_automatically',
  };
}

function infrastructureTerminal(
  publicFailureCode: JobFailureCode,
): FailureDefinition {
  return {
    classification: 'infrastructure_terminal',
    mayRetryInfrastructure: false,
    settlement: 'release',
    cleanup: 'cleanup',
    publicFailureCode,
    publicMessage: SAFE_JOB_FAILURE_MESSAGES[publicFailureCode],
    publicAction: 'retry_later',
  };
}

function clientInput(publicFailureCode: JobFailureCode): FailureDefinition {
  return {
    classification: 'client_input',
    mayRetryInfrastructure: false,
    settlement: 'release',
    cleanup: 'cleanup',
    publicFailureCode,
    publicMessage: SAFE_JOB_FAILURE_MESSAGES[publicFailureCode],
    publicAction: 'replace_input',
  };
}

function userAction(): FailureDefinition {
  return {
    classification: 'user_action',
    mayRetryInfrastructure: false,
    settlement: 'release',
    cleanup: 'cleanup',
    publicFailureCode: null,
    publicMessage: null,
    publicAction: 'none',
  };
}

function policyFailure(): FailureDefinition {
  return {
    classification: 'policy',
    mayRetryInfrastructure: false,
    settlement: 'none',
    cleanup: 'none',
    publicFailureCode: null,
    publicMessage: null,
    publicAction: 'none',
  };
}

function assertRetryContext(context: InfrastructureRetryContext): void {
  if (
    !Number.isSafeInteger(context.attemptsRemaining) ||
    context.attemptsRemaining < 0 ||
    !Number.isSafeInteger(context.attemptNumber) ||
    context.attemptNumber < 1 ||
    !Number.isSafeInteger(context.maxAttempts) ||
    context.maxAttempts < 1
  )
    throw new TypeError('Invalid infrastructure retry context');
}

if (Object.keys(JOB_CAPACITY_GROUP_BY_STATUS).length !== JOB_STATUSES.length)
  throw new Error('Incomplete job capacity contract');
